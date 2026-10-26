import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { imageDimensions } from "./scripts/image-dimensions.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(ROOT, "web");
/* 版本号单一来源：package.json（启动时读一次，读失败退回 "0.0.0"） */
const APP_VERSION = await fs
  .readFile(path.join(ROOT, "package.json"), "utf8")
  .then(function (s) { return JSON.parse(s).version; })
  .catch(function () { return "0.0.0"; });
/* 数据目录默认 <root>/data；测试用 ZXT_DATA 指到临时目录，避免把用户的提示词/风格预设写脏 */
const DATA = process.env.ZXT_DATA ? path.resolve(process.env.ZXT_DATA) : path.join(ROOT, "data");
/* 目录与配置允许环境变量覆盖：自检/测试用临时端口 + 临时目录，不碰真实配置和输出 */
const OUT = process.env.ZXT_OUT ? path.resolve(process.env.ZXT_OUT) : path.join(ROOT, "output");
const CONFIG_FILE = process.env.ZXT_CONFIG ? path.resolve(process.env.ZXT_CONFIG) : path.join(ROOT, "config.json");
const PORT = Number(process.env.PORT || 8787);
/* 只监听本机；URL 只写一份，--open 时也用它打开浏览器 */
const HOST = "127.0.0.1";
const BASE_URL = "http://" + HOST + ":" + PORT;
/* 双击「启动.bat」会带 --open：等 server.listen 真正成功后再开浏览器，避免固定秒数抢跑导致"无法访问此网站" */
const OPEN_BROWSER = process.argv.includes("--open") || process.env.ZXT_OPEN === "1";
const ARCHIVE_DIRS = ["人物/男", "人物/女", "人物/中性"];
const TRASH = path.join(OUT, "_回收站");
const TRASH_IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

/* ---------- 密钥：唯一存放地是 .env ----------
   config.json 只存「结构」（地址 / 名称 / 开关 / 模型目录），密钥永不写盘。
   网页服务商弹窗里填的密钥会写回 .env（POST /api/providers/key，立即生效）；
   手动改 .env 同样有效，改完重启定妆间。 */
function providerEnvName(p) {
  return "ZXT_KEY_" + String((p && p.id) || "").toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function keyMissingMessage(p) {
  return "服务商「" + ((p && p.name) || (p && p.id) || "") + "」没有密钥：请在项目根目录的 .env 里加一行 " +
    providerEnvName(p) + "=你的密钥，然后重启定妆间（密钥只从 .env 读取，不会写进 config.json）";
}

/* 读进来的 config.json 就算残留了 apiKey 也一律丢掉，再从环境变量补。
   两类服务商（生图 / LLM 反推）共用同一套密钥约定：ZXT_KEY_<id 大写>。 */
function applyEnvKeys(cfg) {
  if (!Array.isArray(cfg.providers)) cfg.providers = [];
  if (!Array.isArray(cfg.llmProviders)) cfg.llmProviders = [];
  cfg.providers.concat(cfg.llmProviders).forEach(function (p) {
    delete p.apiKey;
    const key = String(process.env[providerEnvName(p)] || "").trim();
    if (key) p.apiKey = key;
  });
  return cfg;
}

/* 写盘时统一剥掉密钥：任何路径都不可能把 apiKey 写进 config.json */
function omitSecrets(k, v) {
  return k === "apiKey" ? undefined : v;
}

async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    const cfg = JSON.parse(raw);
    if (!Array.isArray(cfg.providers) || cfg.providers.length === 0) throw new Error("empty");
    return applyEnvKeys(cfg);
  } catch {
    const cfg = applyEnvKeys(seedConfig());
    try { await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, omitSecrets, 2), "utf8"); } catch (e) {}
    return cfg;
  }
}

/* 没有 config.json 时的默认结构。密钥来自 .env，这里不读任何密钥文件。 */
function seedConfig() {
  return { providers: [], llmProviders: [], settings: { downloadDir: "output", hiddenModels: {} } };
}

/* .env 必须在读 config 之前加载：密钥要靠它注入。
   ZXT_ENV 可指向另一份 .env（测试用，避免读到本机真实密钥）。 */
const ENV_FILE = process.env.ZXT_ENV ? path.resolve(process.env.ZXT_ENV) : path.join(ROOT, ".env");
try {
  process.loadEnvFile(ENV_FILE);
} catch (e) {
  /* 没有 .env 就安静跳过；缺哪个密钥会在下面逐条提示 */
}

/* 网页弹窗里填的密钥：写回 .env（唯一存放地）。保留文件里的注释和其它服务商，
   只替换同名变量那一行；没有就追加一行。值里不能有换行（调用处已校验）。 */
async function saveEnvKey(name, value) {
  let text = "";
  try {
    text = await fs.readFile(ENV_FILE, "utf8");
  } catch (e) {
    text = "";
  }
  const eol = text.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
  const line = name + "=" + (/^[A-Za-z0-9_\-./+=]+$/.test(value) ? value : JSON.stringify(value));
  const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /* g：同名变量万一被写了多行，全部替换成一行，避免 Node 读哪一行不确定 */
  const re = new RegExp("^[ \\t]*(?:export[ \\t]+)?" + safeName + "[ \\t]*=.*$", "gm");
  if (re.test(text)) {
    text = text.replace(re, function () { return line; });
  } else {
    if (text && !/\r?\n$/.test(text)) text += eol;
    text += line + eol;
  }
  await fs.writeFile(ENV_FILE, text, "utf8");
}

let config = await loadConfig();

/* 启动时就把缺密钥的服务商列出来，省得点到「生成」才发现（生图 / LLM 都查） */
(config.providers || []).concat(config.llmProviders || []).forEach(function (p) {
  if (!p.apiKey) {
    console.warn("[密钥缺失] " + (p.name || p.id) + " → 请在 .env 写 " + providerEnvName(p) + "=你的密钥，然后重启");
  }
});

async function saveConfig() {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, omitSecrets, 2), "utf8");
}

/* ---------- 运行参数与批次注册表 ---------- */
/* config.settings 里的数值项：非法或 <=0 回退默认值 */
function settingsNum(key, def) {
  const raw = config && config.settings ? config.settings[key] : null;
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return def;
  return n;
}

/* 服务端批次状态：只放内存，进程重启即清空；页面刷新后靠它恢复进度 */
const batches = new Map();

function newBatchId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let tail = "";
  for (let i = 0; i < 4; i++) tail += chars[Math.floor(Math.random() * chars.length)];
  return "b-" + Date.now().toString(36) + "-" + tail;
}

/* 新建批次时清理：过期记录按 batchKeepMs 删掉，总量超过 50 时按插入序删最旧的 */
function pruneBatches() {
  const now = Date.now();
  const keep = settingsNum("batchKeepMs", 3600000);
  batches.forEach(function (b) {
    if (b.finishedAt && now - b.finishedAt > keep) batches.delete(b.id);
  });
  while (batches.size > 50) {
    const oldest = batches.keys().next();
    if (oldest.done) break;
    batches.delete(oldest.value);
  }
}

/* 给前端的批次快照：不含 prompt 与密钥，job 只回粗粒度进度 */
function batchSnapshot(b) {
  return {
    id: b.id,
    startedAt: b.startedAt,
    finishedAt: b.finishedAt,
    total: b.total,
    concurrency: b.concurrency,
    done: b.done,
    ok: b.ok,
    fail: b.fail,
    cancelledCount: b.cancelledCount,
    active: b.active,
    cancelled: b.cancelled,
    detached: b.detached,
    jobs: b.jobs.map(function (j) {
      return { idx: j.idx, state: j.state, ms: j.ms, code: j.code, error: j.error, file: j.file, rel: j.rel };
    })
  };
}

/* ---------- 画幅（版面模板）：默认读 data/templates.json，改过就落到 data/layouts.json ---------- */
const TEMPLATES_FILE = path.join(DATA, "templates.json");
const LAYOUTS_FILE = path.join(DATA, "layouts.json");
const LAYOUT_KEYS = ["format", "layout", "style", "negative"];

async function defaultLayouts() {
  try {
    const j = JSON.parse(await fs.readFile(TEMPLATES_FILE, "utf8"));
    return Array.isArray(j.templates) ? j.templates : [];
  } catch (e) { return []; }
}

async function loadLayouts() {
  try {
    const j = JSON.parse(await fs.readFile(LAYOUTS_FILE, "utf8"));
    if (j && Array.isArray(j.layouts) && j.layouts.length) return j.layouts;
  } catch (e) {}
  return defaultLayouts();
}

async function saveLayouts(list) {
  await fs.writeFile(LAYOUTS_FILE, JSON.stringify({ version: 1, layouts: list }, null, 2), "utf8");
}

function cleanLayout(b) {
  const label = String((b && b.label) || "").trim().slice(0, 24);
  if (!label) throw new Error("画幅名称不能为空");
  const structure = {};
  LAYOUT_KEYS.forEach(function (k) {
    const s = ((b && b.structure) || {})[k] || {};
    structure[k] = { label: String(s.label || "").slice(0, 24), text: String(s.text || "") };
  });
  const id = String((b && b.id) || "").trim() || ("layout_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const out = { id: id, label: label, structure: structure };
  if (b && b.requiresEra === true) out.requiresEra = true;
  if (b && ["landscape", "portrait", "square", "any"].indexOf(b.orient) >= 0) out.orient = b.orient;
  /* vars：本画幅对共用内容段的取值改写（如九宫格用九格表情矩阵代替单一表情）；
     suppress：本画幅不参与拼装的段落 id。改名/新建时都要原样保住，丢了会静默回到共用文案。 */
  if (b && b.vars && typeof b.vars === "object") {
    const vars = {};
    Object.keys(b.vars).forEach(function (k) {
      if (typeof b.vars[k] === "string") vars[String(k).slice(0, 40)] = String(b.vars[k]).slice(0, 4000);
    });
    if (Object.keys(vars).length) out.vars = vars;
  }
  if (b && Array.isArray(b.suppress)) {
    const suppress = b.suppress.filter(function (x) { return typeof x === "string" && x; })
      .map(function (x) { return String(x).slice(0, 40); })
      .slice(0, 24);
    if (suppress.length) out.suppress = suppress;
  }
  return out;
}

function maskKey(k) {
  k = k || "";
  if (!k) return "";
  if (k.length <= 10) return "••••";
  return k.slice(0, 4) + "••••••••" + k.slice(-4);
}

function publicProvider(p, kind) {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    keyMask: maskKey(p.apiKey),
    hasKey: !!p.apiKey,
    envKey: providerEnvName(p),
    enabled: p.enabled !== false,
    kind: kind,
    authHeader: p.authHeader || "Authorization",
    strengthParam: p.strengthParam == null ? "reasoning_effort" : String(p.strengthParam)
  };
}

/* 生图服务商：/v1/images/generations；LLM 服务商：/v1/chat/completions（参考图反推用）。
   两套列表分开存，避免 LLM 模型混进生图模型下拉。 */
function publicProviders() {
  return (config.providers || []).map(function (p) { return publicProvider(p, "image"); });
}
function publicLlmProviders() {
  return (config.llmProviders || []).map(function (p) { return publicProvider(p, "llm"); });
}

/* 生图专用：/api/generate、批次、密钥缺失提示都只认这一套 */
function findProvider(id) {
  return (config.providers || []).find(function (p) { return p.id === id; });
}
function findLlmProvider(id) {
  return (config.llmProviders || []).find(function (p) { return p.id === id; });
}
/* 拉模型 / 写密钥两类服务商都支持 */
function findProviderAnywhere(id) {
  return findProvider(id) || findLlmProvider(id);
}

/* 接口地址允许粘贴成 …/v1 或 …/v1/models：本程序自己会拼 /v1/models 和 /v1/images/generations，
   先去重，否则会拼成 …/v1/v1/models 拉不到模型 */
function normalizeBaseUrl(raw) {
  let s = String(raw || "").trim().replace(/\/+$/, "");
  s = s.replace(/\/v1\/models$/i, "").replace(/\/models$/i, "").replace(/\/v1$/i, "");
  return s.replace(/\/+$/, "");
}

/* 生图接口前缀：优先用「拉模型」时命中的那个（…/v1、…/canvas/v1 或裸域名），
   还没拉过模型就按 …/v1 兜底 */
function providerApiBase(p) {
  const hit = String((p && p.modelBase) || "").replace(/\/+$/, "");
  return hit || normalizeBaseUrl(p.baseUrl) + "/v1";
}

function authHeaders(p) {
  const h = {};
  const prefix = p.authPrefix == null ? "Bearer " : p.authPrefix;
  h[p.authHeader || "Authorization"] = prefix + p.apiKey;
  return h;
}

function send(res, status, obj, extra) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  const headers = Object.assign(
    {
      "Content-Type": typeof obj === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    extra || {}
  );
  res.writeHead(status, headers);
  res.end(body);
}

async function readJsonBody(req, limit) {
  limit = limit || 64 * 1024 * 1024;
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on("data", function (c) {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", function () {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sniffMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF") return "image/webp";
  return "image/png";
}

async function nextSeq(dir) {
  try {
    const files = await fs.readdir(dir);
    const nums = files
      .map(function (f) { const m = f.match(/^(\d{3})_/); return m ? Number(m[1]) : 0; })
      .filter(function (n) { return n > 0; });
    return (nums.length ? Math.max.apply(null, nums) : 0) + 1;
  } catch (e) {
    return 1;
  }
}

/* 只填域名也能拉模型：按「{base}/v1/models」→「{base}/models」依次试，
   命中哪个就把前缀记到 provider.modelBase，生图接口复用同一个前缀 */
function modelCatalogCandidates(p) {
  const base = normalizeBaseUrl(p.baseUrl);
  const list = [base + "/v1/models", base + "/models"];
  return list.filter(function (u, i) { return list.indexOf(u) === i; });
}

function modelListFromJson(j) {
  let arr = null;
  if (Array.isArray(j)) arr = j;
  else if (j && Array.isArray(j.data)) arr = j.data;
  else if (j && Array.isArray(j.models)) arr = j.models;
  if (!arr) return null;
  return arr
    .map(function (m) {
      if (typeof m === "string") return { id: m, display: m, type: "" };
      return { id: m.id || m.name, display: m.display_name || m.id || m.name, type: m.type || "" };
    })
    .filter(function (m) { return m.id; });
}

async function handleModels(url, res) {
  /* 生图 / LLM 两类服务商都走这个接口：/v1/models 是两家共用的 */
  const p = findProviderAnywhere(url.searchParams.get("provider"));
  if (!p) return send(res, 404, { ok: false, error: "provider not found" });
  if (!p.apiKey) return send(res, 400, { ok: false, error: keyMissingMessage(p) });
  const started = Date.now();
  const tried = [];
  for (const candidate of modelCatalogCandidates(p)) {
    tried.push(candidate);
    let r = null;
    let text = "";
    try {
      r = await fetch(candidate, {
        headers: Object.assign({ Accept: "application/json" }, authHeaders(p))
      });
      text = await r.text();
    } catch (e) {
      return send(res, 502, { ok: false, error: "无法连接上游：" + String(e.message || e), tried: tried });
    }
    const ct = String(r.headers.get("content-type") || "");
    const looksHtml = /text\/html/i.test(ct) || /^\s*</.test(text.slice(0, 60));
    /* 密钥 / 限流 / 服务端错误和“路径”无关：立刻如实上报，不靠换地址掩盖 */
    if (r.status === 401 || r.status === 403 || r.status === 429 || r.status >= 500) {
      return send(res, 502, { ok: false, error: "上游返回 " + r.status, detail: text.slice(0, 300), tried: tried });
    }
    if (r.status === 404 || looksHtml) continue; /* 目录路径不对，换下一条 */
    if (!r.ok) return send(res, 502, { ok: false, error: "上游返回 " + r.status, detail: text.slice(0, 300), tried: tried });
    let models = null;
    try {
      models = modelListFromJson(JSON.parse(text));
    } catch (e) {
      models = null; /* 200 但不是 JSON（登录页 / SPA），换下一条 */
    }
    if (models === null) continue;
    const prefix = candidate.replace(/\/models$/i, "");
    if (p.modelBase !== prefix) {
      p.modelBase = prefix;
      try { await saveConfig(); } catch (e) {}
    }
    return send(res, 200, {
      ok: true, provider: p.id, models: models, catalog: candidate, tried: tried, ms: Date.now() - started
    });
  }
  return send(res, 502, {
    ok: false,
    error: "拉取模型失败：试过的地址都不是模型目录（" + tried.join("、") + "）",
    tried: tried
  });
}

/* ======================================================================
   参考图复刻（图 → 提示词 / 风格）
   - 系统提示词：data/reverse-prompts.json，可在网页里增删改选
   - 风格预设：data/styles.json，保存反推结果，随时套到别的角色上
   - 调用：LLM 服务商（config.llmProviders）的 /v1/chat/completions，图片走 image_url
   ====================================================================== */
const REVERSE_PROMPTS_FILE = path.join(DATA, "reverse-prompts.json");
const STYLES_FILE = path.join(DATA, "styles.json");
const STRENGTH_OPTIONS = ["auto", "low", "medium", "high"];
const MAX_FETCH_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REVERSE_IMAGE_CHARS = 30 * 1024 * 1024;
/* 默认禁止抓本机/内网（SSRF）；离线测试可以用 ZXT_ALLOW_LOCAL_IMAGE_FETCH=1 放开 */
const ALLOW_LOCAL_IMAGE_FETCH = process.env.ZXT_ALLOW_LOCAL_IMAGE_FETCH === "1";

/* 出厂系统提示词：用户第一次打开就有东西可用；可以在网页里改成自己的版本 */
const DEFAULT_REVERSE_PROMPT_TEXT = [
  "你是「定妆间」的视觉反推助手。用户会给你一张参考图，请把它反推成一段可直接用于文生图模型的中文提示词。",
  "",
  "先拆解画面：画幅与构图、机位与焦段、主体姿态与取景、光线方向与色温、材质与质感、色彩与后期、背景与环境、整体风格流派。只写画面里能看到的视觉事实，不猜测姓名、身份、剧情，不复述图中文字内容。",
  "",
  "写作要求：",
  "1. 输出一段连续的中文提示词，分句写，每句以中文标点结尾；不要标题、不要编号、不要 markdown、不要解释。",
  "2. 先写画面与主体，再写光线、材质、色彩和镜头，最后写质感与风格；少用空泛形容词，多写可执行的具体描述（例如「柔光从左上 45 度打入」「哑光丝绸，只有微弱高光」）。",
  "3. 若图中有人物：只描述外形与神态里可复现的特征，保持中性、可替换，不指认真实人物；遇到裸露或敏感内容改成得体的服装描述。",
  "4. 若图中有文字、水印、logo：不要复述文字，在提示词末尾写「不要任何文字、水印、logo」。",
  "",
  "最后另起一段，以「风格与质感：」开头，写 2–4 句与具体人物无关、可以套用到其它角色身上的风格描述（光线、色调、质感、镜头、后期、氛围）。这一段会被单独保存成风格模板。",
  "",
  "只输出提示词本身，不要任何前后缀说明。"
].join("\n");

function defaultReversePrompts() {
  return {
    version: 1,
    defaultId: "default",
    prompts: [{ id: "default", name: "默认 · 参考图复刻", builtin: true, text: DEFAULT_REVERSE_PROMPT_TEXT }]
  };
}

function cleanStoredPrompt(p) {
  if (!p || typeof p !== "object") return null;
  const id = String(p.id || "").trim();
  const text = String(p.text || "");
  if (!id || !text.trim()) return null;
  return {
    id: id.slice(0, 40),
    name: String(p.name || "未命名系统提示词").trim().slice(0, 40) || "未命名系统提示词",
    text: text.slice(0, 60000),
    builtin: p.builtin === true
  };
}

async function loadReversePrompts() {
  try {
    const j = JSON.parse(await fs.readFile(REVERSE_PROMPTS_FILE, "utf8"));
    const prompts = (Array.isArray(j && j.prompts) ? j.prompts : []).map(cleanStoredPrompt).filter(Boolean);
    if (prompts.length) {
      const defaultId = prompts.some(function (p) { return p.id === j.defaultId; }) ? j.defaultId : prompts[0].id;
      return { version: 1, defaultId: defaultId, prompts: prompts };
    }
  } catch (e) {}
  return defaultReversePrompts();
}

async function saveReversePrompts(data) {
  await fs.writeFile(REVERSE_PROMPTS_FILE, JSON.stringify(data, null, 2), "utf8");
}

function cleanStyle(b) {
  const prompt = String((b && b.prompt) || "").trim();
  if (!prompt) throw new Error("复刻提示词不能为空");
  if (prompt.length > 30000) throw new Error("复刻提示词太长（上限 30000 字）");
  const styleSuffix = String((b && b.styleSuffix) || "").trim().slice(0, 12000);
  const name = String((b && b.name) || "").trim().slice(0, 40) || "未命名风格";
  const tags = (Array.isArray(b && b.tags) ? b.tags : [])
    .map(function (x) { return String(x || "").trim().slice(0, 20); })
    .filter(Boolean).slice(0, 8);
  const thumb = String((b && b.thumb) || "");
  if (thumb && (!/^data:image\/(png|jpeg|webp);base64,/i.test(thumb) || thumb.length > 512000)) {
    throw new Error("缩略图不合法（只接受 png/jpeg/webp，且不超过 500KB）");
  }
  const source = b && b.source && typeof b.source === "object"
    ? { kind: String(b.source.kind || "").slice(0, 16), url: String(b.source.url || "").slice(0, 2000) }
    : null;
  const llm = b && b.llm && typeof b.llm === "object"
    ? {
        providerId: String(b.llm.providerId || "").slice(0, 40),
        providerName: String(b.llm.providerName || "").slice(0, 60),
        model: String(b.llm.model || "").slice(0, 80),
        strength: STRENGTH_OPTIONS.indexOf(b.llm.strength) >= 0 ? b.llm.strength : "auto",
        systemPromptId: String(b.llm.systemPromptId || "").slice(0, 40)
      }
    : null;
  const id = String((b && b.id) || "").trim();
  return {
    id: /^[a-z0-9_-]{1,40}$/.test(id) ? id : "",
    name: name,
    prompt: prompt,
    styleSuffix: styleSuffix,
    tags: tags,
    thumb: thumb,
    source: source,
    llm: llm
  };
}

async function loadStyles() {
  try {
    const j = JSON.parse(await fs.readFile(STYLES_FILE, "utf8"));
    const styles = [];
    (Array.isArray(j && j.styles) ? j.styles : []).forEach(function (raw) {
      if (!raw || typeof raw !== "object") return;
      let s;
      try { s = cleanStyle(raw); } catch (e) { return; }
      if (!s.id) s.id = "st-" + (styles.length + 1);
      s.createdAt = typeof raw.createdAt === "string" ? raw.createdAt : null;
      s.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : null;
      styles.push(s);
    });
    return { version: 1, styles: styles };
  } catch (e) {
    return { version: 1, styles: [] };
  }
}

async function saveStyles(data) {
  await fs.writeFile(STYLES_FILE, JSON.stringify(data, null, 2), "utf8");
}

/* ---------- LLM 调用：OpenAI 兼容 /v1/chat/completions，图片用 image_url ---------- */
function messageText(j) {
  const msg = j && Array.isArray(j.choices) && j.choices[0] ? j.choices[0].message : null;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(function (part) {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      return "";
    }).join("");
  }
  return "";
}

async function callUpstreamChat(p, body) {
  const started = Date.now();
  const systemPrompt = String(body.systemPrompt || "").trim();
  const instruction = String(body.instruction || "").trim() || "请按系统提示词复刻这张参考图。";
  const strength = STRENGTH_OPTIONS.indexOf(body.strength) >= 0 ? body.strength : "auto";
  /* 强度参数名可配置；填 none（或空）表示完全不发这个字段 */
  const rawParam = p.strengthParam == null ? "reasoning_effort" : String(p.strengthParam).trim();
  const strengthParam = rawParam.toLowerCase() === "none" ? "" : rawParam;
  const timeoutMs = Math.max(5000, Math.min(600000, Number(body.timeoutMs) || settingsNum("llmTimeoutMs", 180000)));
  const payload = {
    model: body.model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: instruction },
          { type: "image_url", image_url: { url: body.imageDataUrl } }
        ]
      }
    ],
    stream: false
  };
  if (strength !== "auto" && strengthParam) payload[strengthParam] = strength;
  let strengthIgnored = false;
  let r = null;
  let text = "";
  let lastStatus = 0;
  try {
    r = await fetch(providerApiBase(p) + "/chat/completions", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders(p)),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
    text = await r.text();
    lastStatus = r.status;
    /* 部分中转不认 reasoning_effort：去掉强度参数再试一次，别让一个可选开关把整次反推打死 */
    if (!r.ok && r.status === 400 && payload[strengthParam]) {
      delete payload[strengthParam];
      strengthIgnored = true;
      r = await fetch(providerApiBase(p) + "/chat/completions", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders(p)),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
      text = await r.text();
      lastStatus = r.status;
    }
    if (!r.ok) {
      const info = upstreamErrorInfo(lastStatus, text);
      return { ok: false, status: lastStatus, code: info.code, error: info.msg, ms: Date.now() - started };
    }
    let j = null;
    try { j = JSON.parse(text); } catch (e) {}
    if (!j) return { ok: false, code: "bad_response", error: "上游返回非 JSON", ms: Date.now() - started };
    const content = messageText(j).trim();
    if (!content) {
      return { ok: false, code: "bad_response", error: "上游没有返回提示词文本", detail: text.slice(0, 400), ms: Date.now() - started };
    }
    return {
      ok: true,
      text: content.slice(0, 60000),
      meta: {
        model: j.model || body.model,
        usage: j.usage || null,
        strength: strength,
        strengthIgnored: strengthIgnored,
        ms: Date.now() - started
      }
    };
  } catch (e) {
    const timedOut = !!(e && (e.name === "TimeoutError" || e.name === "AbortError"));
    return {
      ok: false,
      code: timedOut ? "timeout" : "network_error",
      error: timedOut ? "上游超过 " + timeoutMs + "ms 未响应" : "请求失败：" + String(e.message || e),
      ms: Date.now() - started
    };
  }
}

async function handleReverse(req, res) {
  let body = {};
  try {
    body = await readJsonBody(req, MAX_REVERSE_IMAGE_CHARS + 2 * 1024 * 1024);
  } catch (e) {
    return send(res, 400, { ok: false, error: "请求体太大或不是合法 JSON" });
  }
  const p = findLlmProvider(body.providerId);
  if (!p) return send(res, 400, { ok: false, error: "未找到反推服务商：先在「以图复刻」里接入一个 LLM 服务商" });
  if (!p.apiKey) return send(res, 400, { ok: false, error: keyMissingMessage(p) });
  if (!body.model) return send(res, 400, { ok: false, error: "未选择反推模型" });
  const systemPrompt = String(body.systemPrompt || "").trim();
  if (!systemPrompt) return send(res, 400, { ok: false, error: "系统提示词为空：先选一个或写一个" });
  const image = String(body.imageDataUrl || "");
  if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(image)) {
    return send(res, 400, { ok: false, error: "参考图不合法：只接受 png / jpeg / webp 的 base64 data URL" });
  }
  if (image.length > MAX_REVERSE_IMAGE_CHARS) {
    return send(res, 400, { ok: false, error: "参考图太大（上限约 20MB）" });
  }
  const out = await callUpstreamChat(p, {
    model: body.model,
    systemPrompt: systemPrompt,
    instruction: body.instruction,
    imageDataUrl: image,
    strength: body.strength,
    timeoutMs: body.timeoutMs
  });
  if (!out.ok) {
    return send(res, 200, { ok: false, code: out.code, status: out.status, error: out.error, detail: out.detail, ms: out.ms });
  }
  return send(res, 200, { ok: true, text: out.text, meta: out.meta });
}

/* ---------- 图片链接 → data URL（浏览器跨域拿不到像素，统一由本机服务代抓） ---------- */
function isBlockedImageHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "0.0.0.0") return true;
  if (h === "::1" || h === "::") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function detectImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

async function handleFetchImage(req, res) {
  let body = {};
  try {
    body = await readJsonBody(req, 16 * 1024);
  } catch (e) {
    return send(res, 400, { ok: false, error: "请求不合法" });
  }
  const raw = String(body.url || "").trim();
  let u = null;
  try { u = new URL(raw); } catch (e) {}
  if (!u) return send(res, 400, { ok: false, error: "图片链接不合法" });
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return send(res, 400, { ok: false, error: "只支持 http / https 的图片链接" });
  }
  if (!ALLOW_LOCAL_IMAGE_FETCH && isBlockedImageHost(u.hostname)) {
    return send(res, 400, { ok: false, error: "不允许抓取本机或内网地址" });
  }
  let r = null;
  try {
    /* 手动跟跳转：每一跳都重新校验协议与主机，避免 public → 127.0.0.1 的 SSRF 绕过 */
    let current = u;
    for (let hop = 0; hop < 4; hop++) {
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        return send(res, 400, { ok: false, error: "跳转后的地址不是 http / https" });
      }
      if (!ALLOW_LOCAL_IMAGE_FETCH && isBlockedImageHost(current.hostname)) {
        return send(res, 400, { ok: false, error: "不允许抓取本机或内网地址" });
      }
      r = await fetch(current.href, {
        redirect: "manual",
        headers: { Accept: "image/*,*/*;q=0.8", "User-Agent": "dingzhuangjian/1.0" },
        signal: AbortSignal.timeout(20000)
      });
      if (r.status < 300 || r.status >= 400) break;
      const loc = r.headers.get("location");
      if (!loc) break;
      try { current = new URL(loc, current); } catch (e) {
        return send(res, 400, { ok: false, error: "图片链接的跳转地址不合法" });
      }
    }
  } catch (e) {
    const timedOut = !!(e && (e.name === "TimeoutError" || e.name === "AbortError"));
    return send(res, 502, { ok: false, error: timedOut ? "图片链接超过 20 秒没有响应" : "抓取图片失败：" + String(e.message || e) });
  }
  if (!r.ok) return send(res, 502, { ok: false, error: "图片链接返回 HTTP " + r.status });
  const ct = String(r.headers.get("content-type") || "").toLowerCase();
  const declared = Number(r.headers.get("content-length") || 0);
  if (declared && declared > MAX_FETCH_IMAGE_BYTES) {
    return send(res, 400, { ok: false, error: "图片太大（上限 15MB）" });
  }
  let buf = null;
  try {
    buf = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    return send(res, 502, { ok: false, error: "读取图片失败：" + String(e.message || e) });
  }
  if (!buf.length) return send(res, 400, { ok: false, error: "链接返回了空内容" });
  if (buf.length > MAX_FETCH_IMAGE_BYTES) return send(res, 400, { ok: false, error: "图片太大（上限 15MB）" });
  const mime = detectImageMime(buf);
  if (!mime) {
    return send(res, 400, { ok: false, error: "链接内容不是 png / jpeg / webp 图片" + (ct ? "（Content-Type: " + ct.slice(0, 60) + "）" : "") });
  }
  let dims = null;
  try { dims = imageDimensions(buf); } catch (e) { dims = null; }
  return send(res, 200, {
    ok: true,
    dataUrl: "data:" + mime + ";base64," + buf.toString("base64"),
    mime: mime,
    bytes: buf.length,
    width: dims ? dims.width : null,
    height: dims ? dims.height : null,
    finalUrl: r.url || u.href
  });
}

/* ---------- 上游重试策略 ---------- */
/* 每个模型允许同时打到上游的请求数：账号少的模型降并发，避免把账号一次打到冷却 */
const MODEL_CONCURRENCY = { "gpt-image-2.5-sunburst": 4 };
const DEFAULT_MODEL_CONCURRENCY = 10;
function modelConcurrency(model) {
  const custom = (config.settings && config.settings.modelConcurrency) || {};
  const raw = custom[model] != null ? custom[model] : MODEL_CONCURRENCY[model];
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return DEFAULT_MODEL_CONCURRENCY;
  return Math.max(1, Math.min(10, Math.floor(n)));
}

const RETRIABLE_STATUS = [429, 500, 502, 503, 504];
/* “账号池里没有可用账号”的报错：512 中转常见 503 + 这句话 */
const NO_ACCOUNT_RE = /no available\s+(compatible\s+)?(accounts?|channels?)/i;
/* 普通限流/5xx：短退避；多试几次 */
const RETRY_DELAYS_MS = [1500, 4000, 10000];
/* 账号池无号：等冷却，别猛敲（一次 10s / 30s / 60s） */
const NO_ACCOUNT_DELAYS_MS = [10000, 30000, 60000];

function upstreamErrorInfo(status, text) {
  let msg = String(text || "").slice(0, 500);
  try {
    const j = JSON.parse(text);
    if (j && j.error && j.error.message) msg = String(j.error.message);
  } catch (e) {}
  const noAccounts = NO_ACCOUNT_RE.test(msg);
  return { msg: msg, noAccounts: noAccounts, code: noAccounts ? "no_accounts" : "upstream_error" };
}

/* 只负责“向上游要一张图”（含重试）：单张接口和批量接口共用这一段 */
async function callUpstreamImage(p, body) {
  const payload = { model: body.model, prompt: body.prompt, n: 1 };
  if (body.size) payload.size = body.size;
  if (body.quality) payload.quality = body.quality;
  if (body.outputFormat) payload.output_format = body.outputFormat;
  if (body.background) payload.background = body.background;

  const started = Date.now();
  /* 单次上游请求超时与单张总预算：config.settings 可覆盖，job 自带的优先 */
  const timeoutMs = Number(body.timeoutMs) || settingsNum("jobTimeoutMs", 180000);
  const deadlineMs = Number(body.deadlineMs) || settingsNum("jobDeadlineMs", 240000);
  const maxAttempts = Math.max(1, Math.min(4, Number(body.retries) || 3));
  let attempts = 0;
  let lastStatus = 0;
  let text = "";
  let lastInfo = null;
  let r = null;
  try {
    for (attempts = 1; attempts <= maxAttempts; attempts++) {
      /* 重试与退避都计入单张总预算：剩余预算不够一次完整尝试时，就把这次超时压到剩余量，保证整张不超预算 */
      const remaining = deadlineMs - (Date.now() - started);
      if (remaining <= 0) {
        return { ok: false, code: "timeout", error: "超过单张总预算 " + deadlineMs + "ms", attempts: attempts - 1, ms: Date.now() - started };
      }
      const attemptTimeout = Math.max(200, Math.min(timeoutMs, remaining));
      r = await fetch(providerApiBase(p) + "/images/generations", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders(p)),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(attemptTimeout)
      });
      text = await r.text();
      lastStatus = r.status;
      if (r.ok) break;
      lastInfo = upstreamErrorInfo(lastStatus, text);
      const retriable = lastInfo.noAccounts || RETRIABLE_STATUS.indexOf(lastStatus) >= 0;
      if (!retriable || attempts === maxAttempts) break;
      const delays = lastInfo.noAccounts ? NO_ACCOUNT_DELAYS_MS : RETRY_DELAYS_MS;
      const delay = delays[Math.min(attempts - 1, delays.length - 1)];
      await new Promise(function (ok) { setTimeout(ok, delay + Math.random() * 800); });
    }
    if (!r || !r.ok) {
      const info = lastInfo || upstreamErrorInfo(lastStatus, text);
      return { ok: false, status: lastStatus, code: info.code, error: info.msg, attempts: attempts, ms: Date.now() - started };
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch (e) {
      return { ok: false, code: "bad_response", error: "上游返回非 JSON", attempts: attempts, ms: Date.now() - started };
    }
    const d = (j.data || [])[0] || {};
    if (!d.b64_json && !d.url) return { ok: false, code: "bad_response", error: "上游未返回图像", attempts: attempts, ms: Date.now() - started };
    let mime = "image/png";
    if (d.b64_json) mime = sniffMime(Buffer.from(d.b64_json.slice(0, 32), "base64"));
    const dataUrl = d.b64_json ? "data:" + mime + ";base64," + d.b64_json : d.url;
    return {
      ok: true,
      dataUrl: dataUrl,
      mime: mime,
      meta: {
        model: j.model || body.model,
        size: j.size || body.size,
        quality: j.quality || body.quality,
        usage: j.usage || null,
        attempts: attempts,
        ms: Date.now() - started
      }
    };
  } catch (e) {
    /* 超时（AbortSignal.timeout / 连接被中断）单独归为 timeout：界面能区分“上游太慢”和“网络错”，测试也能断言 */
    const timedOut = !!(e && (e.name === "TimeoutError" || e.name === "AbortError"));
    return {
      ok: false,
      code: timedOut ? "timeout" : "network_error",
      error: timedOut ? "上游超过 " + timeoutMs + "ms 未响应" : "请求失败：" + String(e.message || e),
      attempts: attempts,
      ms: Date.now() - started
    };
  }
}

async function handleGenerate(req, res) {
  const body = await readJsonBody(req);
  const p = findProvider(body.providerId);
  if (!p) return send(res, 400, { ok: false, error: "未找到该服务商" });
  if (!p.apiKey) return send(res, 400, { ok: false, error: keyMissingMessage(p) });
  if (!body.model) return send(res, 400, { ok: false, error: "未选择模型" });
  if (!body.prompt) return send(res, 400, { ok: false, error: "提示词为空" });

  const gen = await callUpstreamImage(p, body);
  if (!gen.ok) {
    return send(res, 200, { ok: false, status: gen.status, code: gen.code, error: gen.error, attempts: gen.attempts, ms: gen.ms });
  }
  return send(res, 200, { ok: true, dataUrl: gen.dataUrl, mime: gen.mime, meta: gen.meta });
}

let indexLock = Promise.resolve();

// index.json 读-改-写串行化，避免保存与删除并发时互相覆盖
function withIndexLock(task) {
  const next = indexLock.then(function () { return task(); }, function () { return task(); });
  indexLock = next.then(function () {}, function () {});
  return next;
}

// 读存档索引：文件不存在视为空数组；存在但解析失败则抛错，避免误清空索引
async function readIndexStrict() {
  try {
    const raw = await fs.readFile(path.join(OUT, "index.json"), "utf8");
    const idx = JSON.parse(raw);
    return Array.isArray(idx) ? idx : [];
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw new Error("index.json 解析失败");
  }
}

// 先写 index.json.tmp 再 rename 原子替换；Windows 上偶发被杀毒/索引服务短暂占用（EPERM/EBUSY），重试几次
async function writeIndexAtomic(idx) {
  const idxPath = path.join(OUT, "index.json");
  const tmpPath = idxPath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(idx, null, 2), "utf8");
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rename(tmpPath, idxPath);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 4) await new Promise(function (ok) { setTimeout(ok, 40 * (attempt + 1)); });
    }
  }
  try { await fs.unlink(tmpPath); } catch (e) {}
  throw lastErr;
}

/* 把一张图写进存档（图片 + 同名 JSON + index.json）。
   序号分配、写文件、写索引都放在同一把 index 锁里：并发生成时不会抢到同一个 001 编号 */
async function saveImageRecord(body) {
  const dataUrl = body.dataUrl;
  if (!dataUrl) throw new Error("没有图像");

  let buf, mime;
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(dataUrl);
  if (m) {
    mime = m[1];
    buf = Buffer.from(m[2], "base64");
  } else {
    /* 上游回的是临时 URL：必须带超时和大小上限，避免挂死或把内存打爆 */
    const r = await fetch(dataUrl, { signal: AbortSignal.timeout(60000) });
    buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 40 * 1024 * 1024) throw new Error("图片超过 40MB 上限");
    mime = sniffMime(buf);
  }
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  /* gender 会拼进文件路径：只认这三个目录名，避免 /api/save 把文件写到输出目录之外 */
  const genderDir = ["男", "女", "中性"].indexOf(body.gender) >= 0 ? body.gender : "中性";

  return withIndexLock(async function () {
    const dir = path.join(OUT, "人物", genderDir);
    await fs.mkdir(dir, { recursive: true });
    const seq = await nextSeq(dir);
    const hint = String(body.filenameHint || "设定卡").replace(/[\\/:*?"<>|]/g, "_");
    const base = String(seq).padStart(3, "0") + "_" + hint;
    const imgPath = path.join(dir, base + "." + ext);
    const jsonPath = path.join(dir, base + ".json");
    await fs.writeFile(imgPath, buf);
    /* prompt 落盘：出图后能复现当时的提示词（旧记录没有这些字段，读的时候按空处理） */
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const actual = imageDimensions(buf);
    const actualSize = actual ? actual.width + "x" + actual.height : null;
    const requestedSize = (body.promptMeta && body.promptMeta.size) || (body.meta && body.meta.size) || null;
    const record = {
      schemaVersion: prompt ? 4 : 2,
      id: base,
      file: base + "." + ext,
      createdAt: new Date().toISOString(),
      seed: body.character ? body.character.seed : null,
      character: body.character || null,
      prompt: prompt,
      promptHash: prompt ? crypto.createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 16) : "",
      promptMeta: body.promptMeta || null,
      imageDimensions: actual,
      requestedSize: requestedSize,
      actualSize: actualSize,
      sizeMatchesRequest: actualSize && requestedSize ? actualSize === requestedSize : null,
      meta: body.meta || null
    };
    await fs.writeFile(jsonPath, JSON.stringify(record, null, 2), "utf8");

    const idxPath = path.join(OUT, "index.json");
    let idx = [];
    try {
      idx = JSON.parse(await fs.readFile(idxPath, "utf8"));
      if (!Array.isArray(idx)) idx = [];
    } catch (e) {}
    idx.push({
      id: base,
      dir: "人物/" + genderDir,
      file: base + "." + ext,
      seed: record.seed,
      createdAt: record.createdAt,
      model: record.meta ? record.meta.model : "",
      size: record.meta ? record.meta.size : "",
      actualSize: actualSize
    });
    await writeIndexAtomic(idx);

    return { ok: true, dir: "output/人物/" + genderDir, rel: "人物/" + genderDir, file: base + "." + ext, json: base + ".json" };
  });
}

async function handleSave(req, res) {
  const body = await readJsonBody(req);
  try {
    const saved = await saveImageRecord(body);
    send(res, 200, saved);
  } catch (e) {
    send(res, 200, { ok: false, error: String((e && e.message) || e) });
  }
}

/* 批量并发生成：一个请求带 N 个任务，服务端同时向上游发起 N 个请求；
   每画完一张就立即存档，并往响应里写一行 NDJSON，客户端边收边更新进度。
   进度同时登记在 batches 注册表：页面刷新（响应 close）只标 detached，服务端照常画完存档；
   GET /api/batch/active、GET /api/batch/:id 查进度，POST /api/batch/:id/cancel 取消未开始的任务 */
async function handleGenerateBatch(req, res) {
  let b = null;
  let hb = null;
  /* 客户端断开后写 NDJSON 会失败：静默跳过，但绝不影响继续干活 */
  function write(obj) {
    if (!res.headersSent || res.writableEnded || res.destroyed) return;
    try { res.write(JSON.stringify(obj) + "\n"); } catch (e) {}
  }
  try {
    const body = await readJsonBody(req, 4 * 1024 * 1024);
    const p = findProvider(body.providerId);
    if (!p) return send(res, 400, { ok: false, error: "未找到该服务商" });
    if (!p.apiKey) return send(res, 400, { ok: false, error: keyMissingMessage(p) });
    const jobs = Array.isArray(body.jobs) ? body.jobs.slice(0, 10) : [];
    if (!jobs.length) return send(res, 400, { ok: false, error: "没有任务" });
    for (let i = 0; i < jobs.length; i++) {
      if (!jobs[i] || !jobs[i].model || !jobs[i].prompt) {
        return send(res, 400, { ok: false, error: "第 " + (i + 1) + " 个任务缺少 model 或 prompt" });
      }
    }

    const limit = Math.min(modelConcurrency(jobs[0].model), jobs.length);
    const jobTimeoutMs = settingsNum("jobTimeoutMs", 180000);
    const jobDeadlineMs = settingsNum("jobDeadlineMs", 240000);
    const startedAt = Date.now();
    b = {
      id: newBatchId(),
      startedAt: startedAt,
      finishedAt: null,
      total: jobs.length,
      concurrency: limit,
      done: 0,
      ok: 0,
      fail: 0,
      cancelledCount: 0,
      active: 0,
      cancelled: false,
      detached: false,
      jobs: jobs.map(function (job, idx) {
        return { idx: idx, state: "pending", startedAt: 0, endedAt: 0, ms: 0, code: "", error: "", rel: "", file: "" };
      })
    };
    batches.set(b.id, b);
    pruneBatches();

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no"
    });
    /* 刷新页面只代表没人看进度，不代表不要这批图：只记 detached，不取消、不中断 */
    res.on("close", function () { b.detached = true; });

    write({
      type: "batch-start",
      batchId: b.id,
      total: jobs.length,
      concurrency: limit,
      deadlineMs: Math.ceil(jobs.length / limit) * jobDeadlineMs + 60000
    });

    hb = setInterval(function () {
      write({
        type: "heartbeat",
        batchId: b.id,
        done: b.done,
        ok: b.ok,
        fail: b.fail,
        active: b.active,
        elapsedMs: Date.now() - startedAt
      });
    }, 5000);

    let nextIdx = 0;
    async function worker() {
      while (true) {
        if (b.cancelled) return;
        const idx = nextIdx++;
        if (idx >= jobs.length) return;
        const job = jobs[idx];
        const rec = b.jobs[idx];
        const t0 = Date.now();
        rec.state = "running";
        rec.startedAt = t0;
        b.active++;
        console.log("[batch] " + b.id + " #" + idx + " state=running ms=0");
        write({ type: "job-start", batchId: b.id, idx: idx });
        const gen = await callUpstreamImage(
          p,
          Object.assign({}, job, {
            timeoutMs: Number(job.timeoutMs) || jobTimeoutMs,
            deadlineMs: Number(job.deadlineMs) || jobDeadlineMs
          })
        );
        b.active--;
        b.done++;
        if (!gen.ok) {
          b.fail++;
          rec.state = "fail";
          rec.code = gen.code || "upstream_error";
          rec.error = gen.error ? String(gen.error) : "";
          rec.endedAt = Date.now();
          rec.ms = rec.endedAt - t0;
          console.log("[batch] " + b.id + " #" + idx + " state=" + rec.state + " ms=" + rec.ms);
          write({ type: "job-done", batchId: b.id, idx: idx, ok: false, code: gen.code || "upstream_error", error: gen.error, attempts: gen.attempts, ms: Date.now() - t0 });
          continue;
        }
        try {
          const saved = await saveImageRecord({
            dataUrl: gen.dataUrl,
            gender: job.gender,
            filenameHint: job.filenameHint,
            character: job.character,
            prompt: job.prompt,
            promptMeta: job.promptMeta,
            meta: gen.meta
          });
          b.ok++;
          rec.state = "ok";
          rec.rel = saved.rel || "";
          rec.file = saved.file || "";
          rec.endedAt = Date.now();
          rec.ms = rec.endedAt - t0;
          console.log("[batch] " + b.id + " #" + idx + " state=" + rec.state + " ms=" + rec.ms);
          write({ type: "job-done", batchId: b.id, idx: idx, ok: true, dir: saved.dir, rel: saved.rel, file: saved.file, json: saved.json, attempts: gen.meta ? gen.meta.attempts : null, ms: Date.now() - t0, meta: gen.meta });
        } catch (e) {
          b.fail++;
          rec.state = "fail";
          rec.code = "save_error";
          rec.error = "出图成功，但存档失败：" + String((e && e.message) || e);
          rec.endedAt = Date.now();
          rec.ms = rec.endedAt - t0;
          console.log("[batch] " + b.id + " #" + idx + " state=" + rec.state + " ms=" + rec.ms);
          write({ type: "job-done", batchId: b.id, idx: idx, ok: false, code: "save_error", error: "出图成功，但存档失败：" + String((e && e.message) || e), ms: Date.now() - t0 });
        }
      }
    }

    const workers = [];
    for (let w = 0; w < limit; w++) workers.push(worker());
    await Promise.all(workers);

    /* 取消后没来得及开跑的 job：统一标 cancelled，batch-done 里体现数量 */
    for (let i = 0; i < b.jobs.length; i++) {
      if (b.jobs[i].state === "pending") {
        b.jobs[i].state = "cancelled";
        b.jobs[i].endedAt = Date.now();
        b.cancelledCount++;
      }
    }

    write({
      type: "batch-done",
      batchId: b.id,
      total: jobs.length,
      ok: b.ok,
      fail: b.fail,
      cancelled: b.cancelledCount,
      elapsedMs: Date.now() - startedAt,
      finishedAt: Date.now()
    });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { ok: false, error: String((e && e.message) || e) });
    else write({ type: "batch-error", batchId: b ? b.id : null, error: String((e && e.message) || e) });
  } finally {
    if (hb) clearInterval(hb);
    if (b) b.finishedAt = b.finishedAt || Date.now();
    try { res.end(); } catch (e) {}
  }
}

async function handleArchive(res) {
  try {
    const idx = JSON.parse(await fs.readFile(path.join(OUT, "index.json"), "utf8"));
    const items = (Array.isArray(idx) ? idx : []).map(function (it) {
      if (it && it.dir && it.dir.indexOf("/") < 0) it.dir = "人物/" + it.dir;
      return it;
    });
    send(res, 200, { ok: true, items: items.slice().reverse() });
  } catch (e) {
    send(res, 200, { ok: true, items: [] });
  }
}

function normalizeArchiveDir(input) {
  let d = String(input == null ? "" : input).trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  d = d.replace(/^\/+|\/+$/g, "");
  if (!d || d === "人物") return null;
  if (d.indexOf("人物/") !== 0) d = "人物/" + d;
  if (ARCHIVE_DIRS.indexOf(d) < 0) return null;
  const abs = path.resolve(OUT, d);
  const rel = path.relative(path.resolve(OUT), abs);
  if (!rel || rel.indexOf("..") === 0 || path.isAbsolute(rel)) return null;
  return { dir: d, abs: abs };
}

function normalizeArchiveFile(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return null;
  if (raw.indexOf("/") >= 0 || raw.indexOf("\\") >= 0 || raw.indexOf("..") >= 0) return null;
  const base = path.basename(raw);
  if (!base || base === "." || base === "..") return null;
  return base;
}

function indexEntryMatches(entry, dir, file, id) {
  if (!entry || typeof entry !== "object") return false;
  const eDir = normalizeArchiveDir(entry.dir);
  if (!eDir || eDir.dir !== dir) return false;
  const eFile = entry.file == null ? "" : String(entry.file);
  if (eFile === file) return true;
  if (id && String(entry.id == null ? "" : entry.id) === id) return true;
  return false;
}

function toDisplayPath(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch (e) {
    return false;
  }
}

// 把 dir 下 fileName 及其同名 .json 移入回收站目录；目标已存在时图片与 json 使用同一时间戳后缀避免覆盖
async function movePairToTrash(sourceDirAbs, fileName, trashDirAbs, stamp) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  const imgSrc = path.join(sourceDirAbs, fileName);
  const jsonName = base ? base + ".json" : null;
  const jsonSrc = jsonName ? path.join(sourceDirAbs, jsonName) : null;
  const imgExists = await pathExists(imgSrc);
  const jsonExists = jsonSrc ? await pathExists(jsonSrc) : false;
  if (!imgExists && !jsonExists) return { moved: [] };
  await fs.mkdir(trashDirAbs, { recursive: true });
  let imgTarget = path.join(trashDirAbs, fileName);
  let jsonTarget = jsonName ? path.join(trashDirAbs, jsonName) : null;
  const imgCollide = imgExists && (await pathExists(imgTarget));
  const jsonCollide = jsonExists && jsonTarget ? await pathExists(jsonTarget) : false;
  if (imgCollide || jsonCollide) {
    const suffix = "__" + stamp;
    imgTarget = path.join(trashDirAbs, base + suffix + ext);
    if (jsonTarget) jsonTarget = path.join(trashDirAbs, base + suffix + ".json");
    let n = 1;
    while ((imgExists && (await pathExists(imgTarget))) || (jsonExists && jsonTarget && (await pathExists(jsonTarget)))) {
      const suffix2 = "_" + n;
      imgTarget = path.join(trashDirAbs, base + suffix + suffix2 + ext);
      if (jsonTarget) jsonTarget = path.join(trashDirAbs, base + suffix + suffix2 + ".json");
      n++;
    }
  }
  const moved = [];
  if (imgExists) {
    await fs.rename(imgSrc, imgTarget);
    moved.push({ from: imgSrc, to: imgTarget, kind: "image" });
  }
  if (jsonExists) {
    await fs.rename(jsonSrc, jsonTarget);
    moved.push({ from: jsonSrc, to: jsonTarget, kind: "json" });
  }
  return { moved: moved };
}

async function handleArchiveDelete(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 1 << 20);
  } catch (e) {
    return send(res, 400, { ok: false, error: "请求体不是合法 JSON" });
  }
  const list = body && Array.isArray(body.items) ? body.items : null;
  if (!list) return send(res, 400, { ok: false, error: "items 必须为数组" });
  if (list.length < 1 || list.length > 50) return send(res, 400, { ok: false, error: "单次可删除 1-50 条" });

  const result = { ok: true, deleted: [], moved: [], missing: [], failed: [], remaining: 0, trashDir: toDisplayPath(TRASH) };
  try {
    result.remaining = await withIndexLock(async function () {
      let idx = await readIndexStrict();
      let indexChanged = false;
      const tasks = [];
      list.forEach(function (raw) {
        const item = raw && typeof raw === "object" ? raw : {};
        const dirInfo = normalizeArchiveDir(item.dir);
        if (!dirInfo) return result.failed.push({ item: raw, error: "目录不合法，仅支持 人物/男、人物/女、人物/中性" });
        const file = normalizeArchiveFile(item.file);
        if (!file) return result.failed.push({ item: raw, error: "文件名不合法" });
        tasks.push({ raw: raw, dir: dirInfo.dir, abs: dirInfo.abs, file: file, id: item.id == null ? "" : String(item.id) });
      });
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        try {
          const trashDirAbs = path.join(TRASH, t.dir);
          const relTrash = path.relative(path.resolve(TRASH), path.resolve(trashDirAbs));
          if (relTrash.indexOf("..") === 0 || path.isAbsolute(relTrash)) throw new Error("回收站目录不合法");
          const stamp = Date.now();
          const movedFiles = [];
          const pair = await movePairToTrash(t.abs, t.file, trashDirAbs, stamp);
          for (let k = 0; k < pair.moved.length; k++) movedFiles.push(pair.moved[k]);
          const matched = idx.filter(function (ent) { return indexEntryMatches(ent, t.dir, t.file, t.id); });
          for (let k = 0; k < matched.length; k++) {
            // 请求 file 与索引记录不一致（例如只传了 id）时，按索引里的真实文件名一并移入回收站
            const entFile = normalizeArchiveFile(matched[k].file);
            if (!entFile || entFile === t.file) continue;
            const pair2 = await movePairToTrash(t.abs, entFile, trashDirAbs, stamp);
            for (let m = 0; m < pair2.moved.length; m++) movedFiles.push(pair2.moved[m]);
          }
          if (matched.length) {
            idx = idx.filter(function (ent) { return !indexEntryMatches(ent, t.dir, t.file, t.id); });
            indexChanged = true;
          }
          if (movedFiles.length) {
            const primary = movedFiles.find(function (mf) { return path.basename(mf.from) === t.file; }) || movedFiles[0];
            result.deleted.push({ dir: t.dir, file: t.file, trashPath: toDisplayPath(primary.to) });
            for (let k = 0; k < movedFiles.length; k++) {
              result.moved.push({
                dir: t.dir,
                file: t.file,
                kind: movedFiles[k].kind,
                from: toDisplayPath(movedFiles[k].from),
                to: toDisplayPath(movedFiles[k].to)
              });
            }
          } else {
            result.missing.push({ dir: t.dir, file: t.file });
          }
        } catch (e) {
          result.failed.push({ item: t.raw, error: String((e && e.message) || e) });
        }
      }
      if (indexChanged) await writeIndexAtomic(idx);
      return idx.length;
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: "删除失败：" + String(e.message || e) });
  }
  send(res, 200, result);
}

async function handleArchiveOpen(res) {
  const dir = path.join(OUT, "人物");
  try {
    await fs.mkdir(dir, { recursive: true });
    const shell = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(shell, [dir], { detached: true, stdio: "ignore" });
    child.on("error", function () {});
    child.unref();
    send(res, 200, { ok: true, path: dir });
  } catch (e) {
    send(res, 500, { ok: false, error: "无法打开存档目录：" + String(e.message || e) });
  }
}

function displayRel(base, target) {
  return path.relative(base, target).split(path.sep).join("/");
}

async function walkFiles(dir, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (let i = 0; i < entries.length; i++) {
    const ent = entries[i];
    if (ent.isSymbolicLink()) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) await walkFiles(abs, out);
    else if (ent.isFile()) out.push(abs);
  }
}

async function handleTrashList(res) {
  const trashDir = toDisplayPath(TRASH);
  try {
    const files = [];
    await walkFiles(TRASH, files);
    const rows = [];
    for (let i = 0; i < files.length; i++) {
      const abs = files[i];
      const ext = path.extname(abs).toLowerCase();
      if (TRASH_IMAGE_EXTS.indexOf(ext) < 0) continue;
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch (e) {
        continue;
      }
      const file = path.basename(abs);
      const baseName = path.basename(abs, path.extname(abs));
      const jsonAbs = path.join(path.dirname(abs), baseName + ".json");
      let hasJson = false;
      let name = "";
      let model = "";
      let createdAt = "";
      try {
        const j = JSON.parse(await fs.readFile(jsonAbs, "utf8"));
        hasJson = true;
        if (j && j.character && j.character.meta && j.character.meta.name) name = String(j.character.meta.name);
        if (j && j.meta && j.meta.model) model = String(j.meta.model);
        if (j && j.createdAt) createdAt = String(j.createdAt);
      } catch (e) {}
      rows.push({
        ms: stat.mtimeMs,
        item: {
          rel: displayRel(OUT, abs),
          dir: displayRel(TRASH, path.dirname(abs)),
          file: file,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          hasJson: hasJson,
          name: name,
          model: model,
          createdAt: createdAt
        }
      });
    }
    rows.sort(function (a, b) { return b.ms - a.ms; });
    const items = rows.map(function (r) { return r.item; });
    send(res, 200, { ok: true, trashDir: trashDir, count: items.length, items: items });
  } catch (e) {
    send(res, 200, { ok: true, trashDir: trashDir, count: 0, items: [] });
  }
}

async function handleTrashEmpty(req, res) {
  const trashDir = toDisplayPath(TRASH);
  try {
    await readJsonBody(req, 1 << 20);
  } catch (e) {}
  try {
    const removed = await withIndexLock(async function () {
      const files = [];
      await walkFiles(TRASH, files);
      await fs.rm(TRASH, { recursive: true, force: true });
      return files.length;
    });
    send(res, 200, { ok: true, removed: removed, trashDir: trashDir });
  } catch (e) {
    send(res, 500, { ok: false, error: "清空回收站失败：" + String(e.message || e) });
  }
}

async function handleTrashOpen(res) {
  const dir = TRASH;
  try {
    await fs.mkdir(dir, { recursive: true });
    const shell = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(shell, [dir], { detached: true, stdio: "ignore" });
    child.on("error", function () {});
    child.unref();
    send(res, 200, { ok: true, path: dir });
  } catch (e) {
    send(res, 500, { ok: false, error: "无法打开回收站目录：" + String(e.message || e) });
  }
}

async function handleFile(url, res) {
  const rel = decodeURIComponent(url.pathname.replace(/^\/files\//, ""));
  const outRoot = path.resolve(OUT);
  const target = path.resolve(outRoot, rel);
  if (target !== outRoot && !target.startsWith(outRoot + path.sep)) return send(res, 403, "forbidden");
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return send(res, 404, "not found");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store"
    });
    createReadStream(target).pipe(res);
  } catch (e) {
    send(res, 404, "not found");
  }
}

async function serveStatic(url, res) {
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const webRoot = path.resolve(WEB);
  const target = path.resolve(webRoot, "." + (p.startsWith("/") ? p : "/" + p));
  if (target !== webRoot && !target.startsWith(webRoot + path.sep)) return send(res, 403, "forbidden");
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("dir");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store"
    });
    createReadStream(target).pipe(res);
  } catch (e) {
    send(res, 404, "not found");
  }
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  try {
    if (url.pathname === "/api/health") return send(res, 200, { ok: true, version: APP_VERSION, ts: Date.now() });
    if (url.pathname === "/api/config" && req.method === "GET")
      return send(res, 200, {
        ok: true,
        providers: publicProviders(),
        llmProviders: publicLlmProviders(),
        settings: config.settings || {},
        hiddenModels: (config.settings && config.settings.hiddenModels) || {}
      });
    if (url.pathname === "/api/providers" && req.method === "GET")
      return send(res, 200, { ok: true, providers: publicProviders(), llmProviders: publicLlmProviders() });
    if (url.pathname === "/api/providers" && req.method === "POST") {
      const b = await readJsonBody(req, 1 << 20);
      /* kind=llm 是「参考图反推」用的 LLM 服务商；不传按生图服务商处理，兼容旧页面 */
      const kind = b.kind === "llm" ? "llm" : "image";
      const list = kind === "llm" ? (config.llmProviders = config.llmProviders || []) : config.providers;
      if (!b.baseUrl) return send(res, 400, { ok: false, error: "接口地址不能为空" });
      const givenId = String(b.id || "").trim().toLowerCase();
      /* id 会拼进环境变量名，只允许小写字母/数字/_/-，其余一律重新生成 */
      const id = /^[a-z0-9_-]{1,32}$/.test(givenId) ? givenId : "p" + Math.random().toString(36).slice(2, 8);
      const existing = list.find(function (p) { return p.id === id; });
      /* 同一个 id 不能同时属于两类服务商：.env 变量名会撞 */
      if (!existing) {
        const other = kind === "llm" ? findProvider(id) : findLlmProvider(id);
        if (other) return send(res, 400, { ok: false, error: "标识「" + id + "」已被另一类服务商占用，换一个" });
      }
      /* 密钥只进 .env：这个接口不再接收 apiKey（网页弹窗走 /api/providers/key） */
      const rawKey = String(b.apiKey == null ? "" : b.apiKey).trim();
      if (rawKey) {
        return send(res, 400, {
          ok: false,
          error: "这个接口不再接收密钥：请用服务商弹窗的「密钥」框保存（会写入 .env 并立即生效），或手动在 .env 写一行 " + providerEnvName({ id: id }) + "=你的密钥"
        });
      }
      const baseUrl = normalizeBaseUrl(b.baseUrl);
      if (!baseUrl) return send(res, 400, { ok: false, error: "接口地址不合法" });
      const name = String(b.name || "").trim() || (existing ? existing.name : (kind === "llm" ? "未命名反推服务商" : "未命名服务商"));
      /* 编辑：密钥不在网页里改（只改名称/地址）；改了地址就把上次命中的模型目录清掉，下次重新探测 */
      if (existing) {
        const baseChanged = baseUrl !== String(existing.baseUrl || "").replace(/\/+$/, "");
        existing.name = name;
        existing.baseUrl = baseUrl;
        existing.authHeader = b.authHeader || existing.authHeader || "Authorization";
        if (b.authPrefix != null) existing.authPrefix = b.authPrefix;
        else if (existing.authPrefix == null) existing.authPrefix = "Bearer ";
        existing.enabled = existing.enabled !== false;
        if (kind === "llm" && b.strengthParam != null) {
          const sp = String(b.strengthParam).trim().slice(0, 40);
          if (sp) existing.strengthParam = sp;
          else delete existing.strengthParam;
        }
        if (baseChanged) delete existing.modelBase;
      } else {
        const item = {
          id: id,
          name: name,
          baseUrl: baseUrl,
          authHeader: b.authHeader || "Authorization",
          authPrefix: b.authPrefix == null ? "Bearer " : b.authPrefix,
          enabled: true
        };
        if (kind === "llm") {
          const sp = String(b.strengthParam == null ? "" : b.strengthParam).trim().slice(0, 40);
          if (sp) item.strengthParam = sp;
        }
        list.push(item);
      }
      await saveConfig();
      return send(res, 200, { ok: true, kind: kind, id: id, providers: publicProviders(), llmProviders: publicLlmProviders() });
    }
    /* 网页弹窗里填的密钥：写进 .env 并立即生效（config.json 仍然不落盘）。
       只接受本机页面（同源）发起的写入，避免任意网站跨站改密钥。 */
    if (url.pathname === "/api/providers/key" && req.method === "POST") {
      const origin = String(req.headers.origin || "");
      const sameOrigin = !origin || origin === BASE_URL || origin === "http://localhost:" + PORT;
      if (!sameOrigin) return send(res, 403, { ok: false, error: "拒绝跨站写入密钥" });
      const b = await readJsonBody(req, 64 * 1024);
      const id = String(b.providerId || "").trim().toLowerCase();
      const p = findProviderAnywhere(id);
      if (!p) return send(res, 404, { ok: false, error: "没有这个服务商：" + (id || "（空）") });
      const key = String(b.apiKey == null ? "" : b.apiKey).trim();
      if (!key) return send(res, 400, { ok: false, error: "密钥不能为空" });
      if (/[\r\n]/.test(key)) return send(res, 400, { ok: false, error: "密钥不能包含换行" });
      if (key.length > 512) return send(res, 400, { ok: false, error: "密钥太长（上限 512 字符）" });
      const envName = providerEnvName(p);
      try {
        await saveEnvKey(envName, key);
      } catch (e) {
        return send(res, 500, { ok: false, error: "写 .env 失败：" + String((e && e.message) || e) });
      }
      process.env[envName] = key;
      p.apiKey = key;
      return send(res, 200, { ok: true, providers: publicProviders(), llmProviders: publicLlmProviders(), envKey: envName });
    }
    if (url.pathname === "/api/providers" && req.method === "DELETE") {
      const id = url.searchParams.get("id");
      const kind = url.searchParams.get("kind") === "llm" ? "llm" : "image";
      if (kind === "llm") config.llmProviders = (config.llmProviders || []).filter(function (p) { return p.id !== id; });
      else config.providers = config.providers.filter(function (p) { return p.id !== id; });
      await saveConfig();
      return send(res, 200, { ok: true, kind: kind, providers: publicProviders(), llmProviders: publicLlmProviders() });
    }
    /* ---------- 参考图复刻：系统提示词 / 风格预设 / 反推 / 抓图 ---------- */
    if (url.pathname === "/api/reverse-prompts" && req.method === "GET")
      return send(res, 200, Object.assign({ ok: true }, await loadReversePrompts()));
    if (url.pathname === "/api/reverse-prompts" && req.method === "POST") {
      const b = await readJsonBody(req, 512 * 1024);
      const data = await loadReversePrompts();
      const text = String(b.text || "").trim();
      const name = String(b.name || "").trim().slice(0, 40);
      if (!text) return send(res, 400, { ok: false, error: "系统提示词不能为空" });
      if (text.length > 60000) return send(res, 400, { ok: false, error: "系统提示词太长（上限 60000 字）" });
      const id = String(b.id || "").trim();
      const at = data.prompts.findIndex(function (p) { return p.id === id; });
      let item;
      if (at >= 0) {
        item = data.prompts[at];
        item.name = name || item.name;
        item.text = text;
      } else {
        if (data.prompts.length >= 20) return send(res, 400, { ok: false, error: "系统提示词最多 20 条" });
        item = {
          id: "rp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          name: name || "未命名系统提示词",
          text: text,
          builtin: false
        };
        data.prompts.push(item);
      }
      data.defaultId = item.id;
      await saveReversePrompts(data);
      return send(res, 200, Object.assign({ ok: true, prompt: item }, data));
    }
    if (url.pathname === "/api/reverse-prompts/reset" && req.method === "POST") {
      const data = await loadReversePrompts();
      const def = defaultReversePrompts().prompts[0];
      const at = data.prompts.findIndex(function (p) { return p.id === def.id; });
      if (at >= 0) data.prompts[at] = def;
      else data.prompts.unshift(def);
      data.defaultId = def.id;
      await saveReversePrompts(data);
      return send(res, 200, Object.assign({ ok: true }, data));
    }
    if (url.pathname === "/api/reverse-prompts" && req.method === "DELETE") {
      const id = url.searchParams.get("id");
      const data = await loadReversePrompts();
      if (data.prompts.length <= 1) return send(res, 400, { ok: false, error: "至少要保留一条系统提示词" });
      const next = data.prompts.filter(function (p) { return p.id !== id; });
      if (next.length === data.prompts.length) return send(res, 404, { ok: false, error: "没有这条系统提示词" });
      data.prompts = next;
      if (data.defaultId === id) data.defaultId = next[0].id;
      await saveReversePrompts(data);
      return send(res, 200, Object.assign({ ok: true }, data));
    }
    if (url.pathname === "/api/styles" && req.method === "GET")
      return send(res, 200, Object.assign({ ok: true }, await loadStyles()));
    if (url.pathname === "/api/styles" && req.method === "POST") {
      const b = await readJsonBody(req, 2 * 1024 * 1024);
      let item;
      try { item = cleanStyle(b); } catch (e) { return send(res, 400, { ok: false, error: String((e && e.message) || e) }); }
      const data = await loadStyles();
      const now = new Date().toISOString();
      if (item.id) {
        const at = data.styles.findIndex(function (s) { return s.id === item.id; });
        if (at < 0) return send(res, 404, { ok: false, error: "没有这个风格预设" });
        item.createdAt = data.styles[at].createdAt || now;
        item.updatedAt = now;
        data.styles[at] = item;
      } else {
        item.id = "st-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        item.createdAt = now;
        item.updatedAt = now;
        data.styles.unshift(item);
        if (data.styles.length > 60) data.styles.length = 60;
      }
      await saveStyles(data);
      return send(res, 200, { ok: true, style: item, styles: data.styles });
    }
    if (url.pathname === "/api/styles" && req.method === "DELETE") {
      const id = url.searchParams.get("id");
      const data = await loadStyles();
      const next = data.styles.filter(function (s) { return s.id !== id; });
      if (next.length === data.styles.length) return send(res, 404, { ok: false, error: "没有这个风格预设" });
      data.styles = next;
      await saveStyles(data);
      return send(res, 200, { ok: true, styles: next });
    }
    if (url.pathname === "/api/reverse" && req.method === "POST") return await handleReverse(req, res);
    if (url.pathname === "/api/fetch-image" && req.method === "POST") return await handleFetchImage(req, res);
    if (url.pathname === "/api/layouts" && req.method === "GET")
      return send(res, 200, { ok: true, layouts: await loadLayouts() });
    if (url.pathname === "/api/layouts/reset" && req.method === "POST") {
      try { await fs.unlink(LAYOUTS_FILE); } catch (e) {}
      return send(res, 200, { ok: true, layouts: await loadLayouts() });
    }
    if (url.pathname === "/api/layouts" && req.method === "POST") {
      const b = await readJsonBody(req, 1 << 20);
      let item;
      try { item = cleanLayout(b); } catch (e) { return send(res, 400, { ok: false, error: String((e && e.message) || e) }); }
      const list = await loadLayouts();
      const at = list.findIndex(function (t) { return t.id === item.id; });
      if (at >= 0) list[at] = item; else list.push(item);
      await saveLayouts(list);
      return send(res, 200, { ok: true, layouts: list, layout: item });
    }
    if (url.pathname === "/api/layouts" && req.method === "DELETE") {
      const id = url.searchParams.get("id");
      const list = await loadLayouts();
      const next = list.filter(function (t) { return t.id !== id; });
      if (!next.length) return send(res, 400, { ok: false, error: "至少要保留一个画幅" });
      if (next.length === list.length) return send(res, 404, { ok: false, error: "没有这个画幅" });
      await saveLayouts(next);
      return send(res, 200, { ok: true, layouts: next });
    }
    if (url.pathname === "/api/models") return await handleModels(url, res);
    if (url.pathname === "/api/models/hide" && req.method === "POST") {
      const b = await readJsonBody(req, 1 << 20);
      if (!b.providerId || !b.modelId) return send(res, 400, { ok: false, error: "参数不全" });
      config.settings = config.settings || {};
      const hm = (config.settings.hiddenModels = config.settings.hiddenModels || {});
      const arr = (hm[b.providerId] = hm[b.providerId] || []);
      const at = arr.indexOf(b.modelId);
      if (b.hidden) { if (at < 0) arr.push(b.modelId); }
      else if (at >= 0) arr.splice(at, 1);
      await saveConfig();
      return send(res, 200, { ok: true, hiddenModels: hm });
    }
    if (url.pathname === "/api/generate" && req.method === "POST") return await handleGenerate(req, res);
    if (url.pathname === "/api/generate-batch" && req.method === "POST") return await handleGenerateBatch(req, res);
    /* 批次状态：页面刷新后靠这些接口恢复进度；/api/batch/active 必须先命中，别被下面的正则吞掉 */
    if (url.pathname === "/api/batch/active" && req.method === "GET") {
      const list = [];
      batches.forEach(function (b) { if (!b.finishedAt) list.push(batchSnapshot(b)); });
      list.sort(function (a, c) { return a.startedAt - c.startedAt; });
      return send(res, 200, { ok: true, batches: list });
    }
    const batchRoute = /^\/api\/batch\/([A-Za-z0-9-]+)(\/cancel)?$/.exec(url.pathname);
    if (batchRoute) {
      const batch = batches.get(batchRoute[1]);
      if (!batch) return send(res, 404, { ok: false, error: "batch not found" });
      if (batchRoute[2]) {
        if (req.method !== "POST") return send(res, 405, { ok: false, error: "method not allowed" });
        batch.cancelled = true;
        return send(res, 200, { ok: true, cancelled: true });
      }
      if (req.method !== "GET") return send(res, 405, { ok: false, error: "method not allowed" });
      return send(res, 200, { ok: true, batch: batchSnapshot(batch) });
    }
    if (url.pathname === "/api/save" && req.method === "POST") return await handleSave(req, res);
    if (url.pathname === "/api/archive") return await handleArchive(res);
    if (url.pathname === "/api/archive/delete" && req.method === "POST") return await handleArchiveDelete(req, res);
    if (url.pathname === "/api/archive/open" && req.method === "POST") return await handleArchiveOpen(res);
    if (url.pathname === "/api/trash" && req.method === "GET") return await handleTrashList(res);
    if (url.pathname === "/api/trash/empty" && req.method === "POST") return await handleTrashEmpty(req, res);
    if (url.pathname === "/api/trash/open" && req.method === "POST") return await handleTrashOpen(res);
    if (url.pathname.startsWith("/files/")) return await handleFile(url, res);
    if (url.pathname.startsWith("/data/")) {
      /* decodeURIComponent 之后的 ../ 不能再交给 path.join：必须 resolve + 前缀校验，
         否则 /data/%2e%2e%2fconfig.json 能读到项目根目录里的 config.json（含 API Key） */
      const rel = decodeURIComponent(url.pathname.slice(6));
      const dataRoot = path.resolve(DATA);
      const target = path.resolve(dataRoot, rel);
      if (target !== dataRoot && !target.startsWith(dataRoot + path.sep)) return send(res, 403, "forbidden");
      try {
        const stat = await fs.stat(target);
        if (!stat.isFile()) throw new Error("no");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": stat.size, "Cache-Control": "no-store" });
        return createReadStream(target).pipe(res);
      } catch (e) {
        return send(res, 404, "not found");
      }
    }
    return await serveStatic(url, res);
  } catch (e) {
    /* async handler 的异常也会走到这里：响应头已发出就只能收尾，否则补一个 500 */
    if (res.headersSent) {
      try { res.end(); } catch (err) {}
    } else {
      send(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  }
});

/* 打开系统默认浏览器；失败也不影响服务本身 */
function openBrowser(url) {
  const shell = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(shell, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", function () { console.error("没能自动打开浏览器，请手动访问：" + url); });
    child.unref();
  } catch (e) {
    console.error("没能自动打开浏览器，请手动访问：" + url);
  }
}

/* 端口被占用时，判断占用者是不是定妆间自己：GET / 返回 200 且页面里带应用名 */
function probeRunningApp(callback) {
  let done = false;
  function finish(ok) {
    if (done) return;
    done = true;
    callback(ok);
  }
  const req = http.get({ hostname: HOST, port: PORT, path: "/", timeout: 1500 }, function (res) {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", function (chunk) {
      body += chunk;
      if (body.length > 65536) { finish(false); res.destroy(); }
    });
    res.on("end", function () { finish(res.statusCode === 200 && body.indexOf("定妆间") >= 0); });
    res.on("error", function () { finish(false); });
  });
  req.on("timeout", function () { req.destroy(); finish(false); });
  req.on("error", function () { finish(false); });
}

server.on("error", function (e) {
  if (e.code !== "EADDRINUSE") {
    console.error("服务启动失败：", e);
    process.exit(1);
    return;
  }
  probeRunningApp(function (ours) {
    if (ours) {
      console.log("定妆间工作台已经在运行：" + BASE_URL);
      if (OPEN_BROWSER) {
        openBrowser(BASE_URL);
        console.log("已在浏览器打开；这个窗口可以直接关掉。");
      } else {
        console.log("直接打开 " + BASE_URL + " 即可，不用重复启动。");
      }
      console.log("要重启服务（比如刚改过代码）：先关掉原来那个黑窗口，再双击「启动.bat」。");
      process.exit(0);
      return;
    }
    console.error("端口 " + PORT + " 已被其他程序占用，定妆间工作台起不来。");
    console.error("处理办法：关掉占用 " + PORT + " 端口的程序，或用环境变量 PORT 换一个端口再启动。");
    process.exit(1);
  });
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;

try {
  await fs.mkdir(OUT, { recursive: true });
} catch (e) {
  console.error("创建输出目录失败：" + OUT + "（" + String((e && e.message) || e) + "）");
  process.exit(1);
}
server.listen(PORT, HOST, function () {
  console.log("定妆间工作台已启动：" + BASE_URL);
  if (OPEN_BROWSER) {
    console.log("浏览器会自动打开；关掉这个窗口就是停止定妆间工作台。");
    openBrowser(BASE_URL);
  } else {
    console.log("直接打开 " + BASE_URL + " 即可；关掉这个窗口就是停止定妆间工作台。");
  }
});
