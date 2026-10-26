'use strict';

/* ---------- tiny helpers ---------- */
const $ = function (s, r) { return (r || document).querySelector(s); };
const el = function (tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

/* 8 个比例；每个档位的实际像素都满足：每边 16 的倍数、短边 ≥720、长边 ≤3840、总像素 ≥786432 */
const RATIOS = [
  { id: "1:1", label: "1:1", sizes: { "1K": [1024, 1024], "2K": [2048, 2048], "4K": [3072, 3072] } },
  { id: "3:2", label: "3:2", sizes: { "1K": [1536, 1024], "2K": [2304, 1536], "4K": [3456, 2304] } },
  { id: "2:3", label: "2:3", sizes: { "1K": [1024, 1536], "2K": [1536, 2304], "4K": [2304, 3456] } },
  { id: "4:3", label: "4:3", sizes: { "1K": [1024, 768], "2K": [2048, 1536], "4K": [3072, 2304] } },
  { id: "3:4", label: "3:4", sizes: { "1K": [768, 1024], "2K": [1536, 2048], "4K": [2304, 3072] } },
  { id: "16:9", label: "16:9", sizes: { "1K": [1280, 720], "2K": [2048, 1152], "4K": [3840, 2160] } },
  { id: "9:16", label: "9:16", sizes: { "1K": [720, 1280], "2K": [1152, 2048], "4K": [2160, 3840] } },
  { id: "21:9", label: "21:9", sizes: { "1K": [1680, 720], "2K": [2688, 1152], "4K": [3808, 1632] } }
];
const RES_LIST = ["1K", "2K", "4K"];
const BATCH_LIST = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const QUALITIES = [["auto", "默认"], ["high", "高"], ["medium", "中"], ["low", "低"]];
const STORE_KEY = "zaoxiangtai.v1"; /* 历史键名：显示名改「定妆间」后保持不动，避免丢用户编辑 */

const state = {
  providers: [],
  providerId: null,
  models: [],
  allModels: [],
  modelId: null,
  ratio: "16:9",
  res: "2K",
  batchCount: 1, /* 一次生成几张（原 state.batch；state.batch 现在留给“进行中批次”） */
  hidden: {},
  quality: "high",
  templateId: "sheet_2view",
  params: {},
  locks: new Set(),
  seed: 0,
  activeGen: 0,
  meta: { name: "", identity: "", personality: "", trait: "", bio: "", styleKeywords: [] },
  highlights: [],
  /* 当前套用的身份卡 id（只用于「随机人物」后把发型/胡须等硬约束再压回去） */
  lookId: "",
  /* 用户手动改过、由身份卡管辖的参数：下一次「随机人物」/换卡时清空 */
  lookCustomized: {},
  /* 用户手动改过的派生目标（发长/刘海/身形等）：本次会话内不让派生规则再改回去 */
  manualOverrides: {},
  /* 本次提交里被锁/硬约束拦下的派生调整（只用于体检，不持久化） */
  derivedConflicts: [],
  /* 手动「掷」的计数器：保证连续掷会换值，又不推进 state.seed */
  rollTick: 0,
  /* 每次参数提交 +1，提示词快照与 UI 都以它为准 */
  paramRevision: 0,
  detailPreset: "detailed",
  /* 默认只展开「身份」「骨架」，其余组折叠（P0 减密） */
  collapsedGroups: ["body", "face", "hair", "mark", "mood"],
  paramQuery: "",
  /* 默认不过滤层级（组默认折叠，首屏只看到两组的 13 行）；核心/进阶用作筛子 */
  tierFilter: "all",
  blocks: [],
  templateText: {},
  busy: false,
  lastError: "",
  /* 词句默认不再独占一行；「词句」按钮打开后在摘要行下方显示一行省略文本 */
  showPhrases: false,
  /* 左栏密度：summary（默认，一行 30px）/ full（旧观感，逃生舱） */
  viewDensity: "summary",
  /* 当前就地展开编辑体的参数 id（P0 渐进披露） */
  openParams: [],
  /* 界面状态版本：<2 的老 localStorage 做一次性迁移 */
  uiVersion: 2,
  archives: [],
  /* 进行中批次（服务端 batch 的本地镜像）；null = 当前空闲 */
  batch: null,
  /* 生成中是否让画布跟随最新出图；生成中点存档看旧图会临时关掉，可用「↩ 回到最新」开回来 */
  followLatest: true,
  /* 参考图复刻：LLM 服务商（与生图服务商分开） */
  llmProviders: [],
  llmProviderId: null,
  llmModels: [],
  llmModelsFor: "",
  llmModelId: null,
  llmStrength: "auto",
  /* 系统提示词（可增删改选）与风格预设 */
  reversePrompts: [],
  reversePromptId: "default",
  stylePresets: [],
  /* 当前生效的复刻提示词 / 风格：{ id, name, mode: "full" | "suffix", prompt, styleSuffix } */
  activeStyle: null,
  /* 复刻弹窗里的临时状态（不持久化） */
  revImage: null,
  revBusy: false
};

function defaultMeta() {
  return { name: "", identity: "", personality: "", trait: "", bio: "", styleKeywords: [] };
}

let DATA = { params: null, names: null, order: [], content: {}, layouts: [], presets: [], eras: null };
let paramIndex = {};
let paramGroupIndex = {};
let toastTimer = null;

/* ---------- seeded random ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function randInt(rng, a, b) { return a + Math.floor(rng() * (b - a + 1)); }

/* ---------- data ---------- */
async function loadData() {
  const list = await Promise.all([
    fetch("/data/params.json").then(function (r) { return r.json(); }),
    fetch("/data/templates.json").then(function (r) { return r.json(); }),
    fetch("/data/names.json").then(function (r) { return r.json(); }),
    // 画幅是可以在界面上增删的，走接口；服务还没重启（没这个接口）时退回文件里的默认 5 个
    fetch("/api/layouts")
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),
    // 画幅预设是内置只读数据；文件缺失时回落到空列表
    fetch("/data/presets.json")
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),
    // 朝代 / 服饰词表：文件缺失时整套服饰功能自动降级为「素体」
    fetch("/data/eras.json")
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),
    // 参考图复刻：系统提示词 + 已保存的风格预设（服务端 data/*.json）
    fetch("/api/reverse-prompts")
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),
    fetch("/api/styles")
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
  ]);
  DATA.params = list[0];
  DATA.names = list[2];
  DATA.order = (list[1] && list[1].order) || [];
  DATA.content = (list[1] && list[1].content) || {};
  const lay = list[3];
  DATA.layouts = lay && lay.ok && Array.isArray(lay.layouts) && lay.layouts.length
    ? lay.layouts
    : ((list[1] && list[1].templates) || []);
  DATA.presets = (list[4] && Array.isArray(list[4].presets)) ? list[4].presets : [];
  DATA.eras = list[5] || null;
  const rp = list[6];
  if (rp && rp.ok && Array.isArray(rp.prompts) && rp.prompts.length) {
    state.reversePrompts = rp.prompts;
    if (!state.reversePromptId) state.reversePromptId = rp.defaultId || rp.prompts[0].id;
  }
  state.stylePresets = (list[7] && list[7].ok && Array.isArray(list[7].styles)) ? list[7].styles : [];
  DATA.params.groups.forEach(function (g) {
    g.params.forEach(function (p) { paramIndex[p.id] = p; });
  });
  buildParamGroupIndex();
}

/* ---------- persistence ---------- */
function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      providerId: state.providerId,
      modelId: state.modelId,
      ratio: state.ratio,
      res: state.res,
      batch: state.batchCount,
      quality: state.quality,
      showPhrases: state.showPhrases,
      viewDensity: state.viewDensity,
      openParams: state.openParams,
      uiVersion: state.uiVersion,
      templateId: state.templateId,
      lookId: state.lookId,
      lookCustomized: state.lookCustomized || {},
      evidenceFilter: state.evidenceFilter || "all",
      params: state.params,
      locks: Array.from(state.locks),
      seed: state.seed,
      meta: state.meta,
      highlights: state.highlights,
      detailPreset: state.detailPreset,
      collapsedGroups: state.collapsedGroups,
      blocks: state.blocks,
      templateText: state.templateText,
      llmProviderId: state.llmProviderId,
      llmModelId: state.llmModelId,
      llmStrength: state.llmStrength,
      reversePromptId: state.reversePromptId,
      activeStyle: state.activeStyle
    }));
  } catch (e) {}
}
function restoreState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    state.providerId = s.providerId || null;
    state.modelId = s.modelId || null;
    state.ratio = s.ratio || state.ratio;
    state.res = s.res || state.res;
    state.batchCount = Math.max(1, Math.min(10, Number(s.batch) || 1));
    state.quality = s.quality || state.quality;
    /* 一次性迁移：旧版默认「词句常开 + 全部组展开」，会把减密效果吃掉 */
    state.uiVersion = Number(s.uiVersion) || 1;
    state.showPhrases = state.uiVersion < 2 ? false : s.showPhrases === true;
    state.viewDensity = s.viewDensity === "full" ? "full" : "summary";
    state.openParams = Array.isArray(s.openParams) ? s.openParams.slice(0, 30) : [];
    state.templateId = s.templateId || state.templateId;
    state.lookId = s.lookId || "";
    state.lookCustomized = (s.lookCustomized && typeof s.lookCustomized === "object") ? s.lookCustomized : {};
    state.evidenceFilter = ["all", "documented", "realistic", "interpretation"].indexOf(s.evidenceFilter) >= 0 ? s.evidenceFilter : "all";
    state.params = Object.assign(defaultParams(), s.params || {});
    state.locks = new Set(s.locks || []);
    state.seed = s.seed || 0;
    state.meta = Object.assign(defaultMeta(), s.meta || {});
    if (!Array.isArray(state.meta.styleKeywords)) state.meta.styleKeywords = [];
    state.highlights = Array.isArray(s.highlights) ? s.highlights.slice(0, 3) : [];
    state.detailPreset = s.detailPreset || "detailed";
    const DEFAULT_COLLAPSED = ["body", "face", "hair", "mark", "mood"];
    state.collapsedGroups = Array.isArray(s.collapsedGroups) ? s.collapsedGroups.slice() : DEFAULT_COLLAPSED.slice();
    if (state.uiVersion < 2 && !state.collapsedGroups.length) state.collapsedGroups = DEFAULT_COLLAPSED.slice();
    state.uiVersion = 2;
    state.llmProviderId = s.llmProviderId || null;
    state.llmModelId = s.llmModelId || null;
    state.llmStrength = ["auto", "low", "medium", "high"].indexOf(s.llmStrength) >= 0 ? s.llmStrength : "auto";
    state.reversePromptId = s.reversePromptId || "default";
    state.activeStyle = (s.activeStyle && typeof s.activeStyle === "object" && (s.activeStyle.prompt || s.activeStyle.styleSuffix))
      ? {
          id: String(s.activeStyle.id || ""),
          name: String(s.activeStyle.name || ""),
          mode: s.activeStyle.mode === "suffix" ? "suffix" : "full",
          prompt: String(s.activeStyle.prompt || ""),
          styleSuffix: String(s.activeStyle.styleSuffix || "")
        }
      : null;
    restoreBlocks(s);
    return true;
  } catch (e) { return false; }
}

/* 旧版按画幅各存一份 blocks；这里把结构段拆到 templateText、内容段并成一份 */
const OLD_STRUCT_IDS = ["format", "layout2", "layout3", "layoutPortrait", "layoutFull", "layoutGrid", "style", "negative"];

function migrateBlocksByTemplate(map, tid) {
  const templateText = {};
  const content = {};
  const custom = [];
  Object.keys(map || {}).forEach(function (k) {
    (map[k] || []).forEach(function (b) {
      if (!b || OLD_STRUCT_IDS.indexOf(b.id) < 0) return;
      const key = b.id.indexOf("layout") === 0 ? "layout" : b.id;
      const box = templateText[k] || (templateText[k] = {});
      box[key] = { text: b.text, enabled: b.enabled !== false };
    });
  });
  const src = (map && (map[tid] || map[Object.keys(map)[0]])) || [];
  src.forEach(function (b) {
    if (!b) return;
    if (isContentBlock(b.id)) content[b.id] = { text: b.text, enabled: b.enabled !== false };
    else if (b.kind === "free" || String(b.id).indexOf("free_") === 0) {
      custom.push({ id: b.id, kind: "free", label: b.label || "自定义段落", text: b.text, enabled: b.enabled !== false });
    }
  });
  return { templateText: templateText, content: content, custom: custom };
}

function restoreBlocks(s) {
  state.templateText = {};
  state.blocks = [];
  if (Array.isArray(s.blocks) && s.blocks.length) {
    state.blocks = s.blocks;
    state.templateText = s.templateText || {};
    return;
  }
  if (s.blocksByTemplate && Object.keys(s.blocksByTemplate).length) {
    const mig = migrateBlocksByTemplate(s.blocksByTemplate, state.templateId);
    state.templateText = mig.templateText;
    state.blocks = [];
    defaultBlocks().forEach(function (b) {
      const c = mig.content[b.id];
      if (c) { b.text = c.text; b.enabled = c.enabled; }
      state.blocks.push(b);
    });
    mig.custom.forEach(function (b) { state.blocks.push(b); });
  }
}

/* ---------- names ---------- */
function genMeta(rng, sex) {
  const N = DATA.names;
  const given = sex === "female" ? N.givenFemale : sex === "male" ? N.givenMale : N.givenNeutral;
  const name = pick(rng, N.surnames) + pick(rng, given);
  /* 时代包里带自己的身份词库，避免「游侠」配补服 */
  const eraForName = eraDef(state.params.era);
  const idPool = (eraForName && Array.isArray(eraForName.identities) && eraForName.identities.length) ? eraForName.identities : N.identities;
  const identity = pick(rng, idPool);
  const personality = pick(rng, N.personalities || N.traits);
  const trait = pick(rng, N.traits);
  const pool = (N.styleKeywords || []).slice();
  const picked = [];
  while (picked.length < 2 && pool.length) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  const templates = (N.bioTemplates && N.bioTemplates.length) ? N.bioTemplates : ["{identity}，{personality}，{trait}。"];
  const bio = pick(rng, templates)
    .replace(/\{identity\}/g, identity)
    .replace(/\{personality\}/g, personality)
    .replace(/\{trait\}/g, trait);
  return { name: name, identity: identity, personality: personality, trait: trait, bio: bio, styleKeywords: picked };
}

/* ---------- sex logic ---------- */
function currentSex() { return state.params.sex || "male"; }
function sexMeta() {
  const p = paramIndex.sex;
  return p.options.find(function (o) { return o.value === currentSex(); }) || p.options[0];
}
/* 选项级门控：g 里每个键都要命中当前上下文（键间 AND，数组内 OR）。
   置灰、随机候选、clamp 三处共用这一个判定。 */
function gateOk(o) {
  if (o && o.requiresLook) {
    const look = currentLook();
    if (!look || o.requiresLook.indexOf(look.id) < 0) return false;
  }
  const g = o && o.g;
  if (!g) return true;
  for (const k in g) {
    const v = state.params[k];
    if (!v || g[k].indexOf(v) < 0) return false;
  }
  return true;
}
function weightOf(o, sex) {
  if (!o || !o.w) return 1;
  if (!gateOk(o)) return 0;
  const v = o.w[sex];
  return typeof v === "number" ? v : 1;
}
function allowedOptions(p, sex) {
  return p.options.filter(function (o) { return weightOf(o, sex) > 0; });
}
function pickSex(rng) {
  const p = paramIndex.sex;
  const w = p.weights || {};
  let total = 0;
  for (let i = 0; i < p.options.length; i++) total += (w[p.options[i].value] || 1);
  let r = rng() * total;
  for (let i = 0; i < p.options.length; i++) {
    r -= (w[p.options[i].value] || 1);
    if (r <= 0) return p.options[i].value;
  }
  return p.options[p.options.length - 1].value;
}

function pickWeighted(rng, opts, sex) {
  let total = 0;
  for (let i = 0; i < opts.length; i++) total += weightOf(opts[i], sex);
  let r = rng() * total;
  for (let i = 0; i < opts.length; i++) {
    r -= weightOf(opts[i], sex);
    if (r <= 0) return opts[i];
  }
  return opts[opts.length - 1];
}
function sexRange(p, sex) {
  if (p && p.sexRanges && p.sexRanges[sex]) return p.sexRanges[sex];
  return p ? [p.min, p.max] : [0, 0];
}
function defaultParams() {
  const o = {};
  DATA.params.groups.forEach(function (g) {
    g.params.forEach(function (p) { o[p.id] = p.default; });
  });
  return o;
}
function clampToSex() {
  const sex = currentSex();
  DATA.params.groups.forEach(function (g) {
    g.params.forEach(function (p) {
      if (p.id === "sex") return;
      if (p.type === "number") {
        const r = sexRange(p, sex);
        if (state.params[p.id] == null) state.params[p.id] = p.default;
        if (state.params[p.id] < r[0]) state.params[p.id] = r[0];
        if (state.params[p.id] > r[1]) state.params[p.id] = r[1];
      } else if (p.type === "choice") {
        const ok = p.options.some(function (o) { return o.value === state.params[p.id] && weightOf(o, sex) > 0; });
        if (!ok) {
          const rng = mulberry32((state.seed + p.id.length * 977) >>> 0);
          state.params[p.id] = g.id === "costume" ? "none" : pickWeighted(rng, allowedOptions(p, sex), sex).value;
        }
      }
    });
  });
}

/* ======================================================================
   参数求值管线
   所有入口（改值 / 掷 / 随机人物 / 换卡 / 切性别 / 切时代）都只调 commitParams，
   顺序固定：上下文 → 硬约束（性别/门控）→ 身份卡 → 相关性 → 派生 → 清理。
   优先级：硬约束 > 锁定 > 派生 > 相关性 > 随机；被更高优先级拦下的调整进体检。
   ====================================================================== */

/* 当前有效的身份卡：era / sex / role / community 任一不符都视为失效。
   gateOk / 随机人物 / 卡片覆盖 / 证据 / 槽位清理 共用这一个判定。 */
function currentLook() {
  if (!eraOn()) return null;
  const looks = (DATA.eras && DATA.eras.looks) || [];
  const look = looks.find(function (item) { return item.id === state.lookId; });
  if (!look) return null;
  if (look.era !== state.params.era) return null;
  if (look.sex && look.sex !== currentSex()) return null;
  if (look.role && look.role !== state.params.role) return null;
  if (look.community && look.community !== state.params.community) return null;
  return look;
}

/* 身份卡当前管辖的参数值 */
function cardOverrides() {
  const look = currentLook();
  return (look && look.overrides) || {};
}

/* 该参数是否由身份卡固定、且用户没有手动改过 */
function cardOwned(id) {
  const own = cardOverrides();
  if (!Object.prototype.hasOwnProperty.call(own, id)) return false;
  return !(state.lookCustomized && state.lookCustomized[id]);
}

/* 身份词：必须是名词短语（正一品文官 / 旗人贵妇），不能是卡片形制名 */
function identityPhrase() {
  const role = state.params.role;
  if (!role || role === "none") return (state.meta && state.meta.identity) || "游民";
  const base = costumeRolePhrase() || optionLabel("role") || "游民";
  const rank = currentRankInfo();
  const rankLabel = optionLabel("rank");
  if (rank && rankLabel && rankLabel !== "无品级" && (role === "official_civil" || role === "official_military")) {
    return rankLabel + base;
  }
  return base;
}

function clearCostumeSlots() {
  ((DATA.eras && DATA.eras.slots) || []).forEach(function (slot) { state.params[slot.id] = "none"; });
}

function hashId(text) {
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* 身份卡覆盖：跳过用户手动改过的参数；硬约束优先于锁 */
function applyIdentityCard() {
  const look = currentLook();
  if (!look) return;
  const own = look.overrides || {};
  Object.keys(own).forEach(function (k) {
    if (state.lookCustomized && state.lookCustomized[k]) return;
    const p = paramIndex[k];
    if (p && p.options && p.options.some(function (o) { return o.value === own[k]; })) state.params[k] = own[k];
  });
}
function applyLookOverrides() { applyIdentityCard(); }

/* 派生：确定性联动。优先于相关性，但让位给锁与身份卡；被拦下的写进 derivedConflicts。 */
function applyDerived() {
  const P = state.params;
  const cards = cardOverrides();
  function want(id, value, why) {
    if (P[id] === value) return;
    if (state.locks.has(id) || (state.manualOverrides && state.manualOverrides[id]) || (cards[id] && !(state.lookCustomized && state.lookCustomized[id]))) {
      state.derivedConflicts.push({ id: id, wanted: value, reason: why });
      return;
    }
    P[id] = value;
  }
  const shortHair = P.hairStyle === "buzz" || P.hairStyle === "slick" || P.hairStyle === "shaved";
  if (shortHair) {
    want("hairLength", "buzz", "短发/剃发");
    want("bangs", "none", "短发/剃发");
    want("parting", "none", "短发/剃发");
    want("hairTexture", "straight", "短发/剃发");
    want("flyaways", "none", "短发/剃发");
  }
  if (P.hairStyle === "queue" || P.hairStyle === "qipan" || P.hairStyle === "hanji_hair" || P.hairStyle === "updo" || P.hairStyle === "bun") {
    want("bangs", "none", "发髻/辫发");
    want("parting", "none", "发髻/辫发");
  }
  if (P.hairStyle === "long" || P.hairStyle === "lowpony" || P.hairStyle === "braid") {
    if (P.hairLength === "buzz" || P.hairLength === "ear") want("hairLength", "chest", "长发");
  }
  if (P.hairStyle === "bob" || P.hairStyle === "short_messy" || P.hairStyle === "wolf") {
    if (P.hairLength === "chest" || P.hairLength === "waist") want("hairLength", "ear", "短发");
  }
  if (P.bangs === "full" || P.bangs === "air") want("parting", "none", "有刘海");
  if ((P.hairStyle === "buzz" || P.hairStyle === "slick") && P.hairline === "widow") want("hairline", "mid", "短发");
  if ((P.headBodyRatio === "eight" || P.headBodyRatio === "eight_half") && P.legRatio === "short") want("legRatio", "long", "头身比");
  if (P.headBodyRatio === "six_half" && P.legRatio === "long") want("legRatio", "mid", "头身比");
  if (P.bodyBuild === "slim") {
    want("bodyShape", "flat", "纤瘦体型");
    if (P.chest === "full") want("chest", "medium", "纤瘦体型");
  }
  if (P.bodyBuild === "plump" || P.bodyBuild === "soft") want("bodyShape", "round", "圆身体型");
  if (P.age < 30) want("faceLines", "none", "年龄");
  if (P.age < 22 && P.beard === "full") want("beard", "stubble", "年龄");
}

/* 选项存在性 / 数值范围 / 服饰槽位门控的兜底；旧存档里的非法值不静默随机，直接回默认 */
function sanitizeParams() {
  const sex = currentSex();
  DATA.params.groups.forEach(function (g) {
    g.params.forEach(function (p) {
      if (p.virtual) return;
      if (p.type === "number") {
        const v = Number(state.params[p.id]);
        const range = p.sexRanges && p.sexRanges[sex] ? p.sexRanges[sex] : [p.min, p.max];
        if (!isFinite(v)) state.params[p.id] = p.default;
        else if (v < range[0]) state.params[p.id] = range[0];
        else if (v > range[1]) state.params[p.id] = range[1];
      } else if (p.type === "choice" || p.type === "sex") {
        const ok = (p.options || []).some(function (o) { return o.value === state.params[p.id]; });
        if (!ok) state.params[p.id] = p.default;
      }
    });
  });
}

/* 同一时代/性别下最贴近当前上下文的身份卡（切身份/品级/场合时自动换卡用） */
function matchingLook() {
  const looks = ((DATA.eras && DATA.eras.looks) || []).filter(function (l) { return l.era === state.params.era; });
  const bySex = looks.filter(function (l) { return !l.sex || l.sex === currentSex(); });
  function sameCommunity(l) { return !l.community || l.community === state.params.community; }
  return bySex.find(function (l) {
    return l.role === state.params.role &&
      String(l.rank || "none") === String(state.params.rank) &&
      sameCommunity(l) &&
      (!l.occasion || l.occasion === state.params.occasion);
  }) || bySex.find(function (l) {
    return l.role === state.params.role && sameCommunity(l);
  }) || null;
}

/* 上下文：时代 / 性别 / 身份 / 旗分 / 品级 / 场合。素体态清空槽位，卡片失效也清空。 */
function normalizeContext(changed) {
  if (!eraOn()) {
    state.lookId = "";
    clearCostumeSlots();
    return;
  }
  if (changed === "era") {
    const next = matchingLook() || ((DATA.eras && DATA.eras.looks) || []).filter(function (l) { return l.era === state.params.era && (!l.sex || l.sex === currentSex()); }).find(function (l) { return l.evidence && l.evidence.mode === "documented"; });
    if (next) applyLookData(next, { silent: true });
    else { state.lookId = ""; clearCostumeSlots(); }
    return;
  }
  if (changed === "sex") {
    state.lookId = "";
    clearCostumeSlots();
    return;
  }
  /* 品级是修正层：不换卡，只同步补子/顶珠/朝珠资格（保留用户已改的槽位） */
  if (changed === "rank") {
    const rank = currentRankInfo();
    if (rank) {
      state.params.pattern = state.params.role === "official_military" ? "buzi_military" : "buzi_civil";
      if (rank.pearls) state.params.accessory = "chaozhu";
      else if (state.params.accessory === "chaozhu") state.params.accessory = "none";
    }
    return;
  }
  /* 身份 / 旗分 / 场合变了：当前卡失效，优先换到同上下文的那张卡，换不到就清空槽位 */
  if (changed === "role" || changed === "community" || changed === "occasion") {
    const next = matchingLook();
    if (next) applyLookData(next, { silent: true });
    else { state.lookId = ""; clearCostumeSlots(); }
    return;
  }
  if (state.lookId && !currentLook()) {
    state.lookId = "";
    clearCostumeSlots();
  }
}

/* 唯一提交入口：改完字段后调这里，不要再各自 syncAll */
function commitParams(opts) {
  opts = opts || {};
  const reason = opts.reason || "";
  const changed = opts.changed || "";
  const rng = opts.rng || mulberry32((state.seed + 13) >>> 0);
  state.derivedConflicts = [];
  normalizeContext(changed);
  clampToSex();
  applyIdentityCard();
  applyCorrelations(rng);
  applyDerived();
  sanitizeParams();
  if (reason === "reroll" || reason === "card" || reason === "sex" || changed === "era" || changed === "role" || changed === "rank" || changed === "community") {
    if (state.params.role && state.params.role !== "none") state.meta.identity = identityPhrase();
  }
  state.paramRevision = (state.paramRevision || 0) + 1;
  if (opts.silent) return;
  syncAll();
}

/* ---------- rolling ---------- */

/* 服饰槽位 id（以 eras.json 为准） */
function costumeSlotIds() {
  return ((DATA.eras && DATA.eras.slots) || []).map(function (s) { return s.id; });
}
function lockedCostumeSlots() {
  return costumeSlotIds().filter(function (id) { return state.locks.has(id); });
}
/* 随机人物时可选的身份卡：时代 + 锁定的性别/旗分/身份/品级/场合/槽位都要对上 */
function rerollLookCandidates(era) {
  const L = state.locks;
  const sex = currentSex();
  const slotLocks = lockedCostumeSlots();
  return ((DATA.eras && DATA.eras.looks) || []).filter(function (look) {
    if (look.era !== era) return false;
    /* 性别先随机好，卡片只在同性别里挑，避免卡片张数把性别比例带偏 */
    if (look.sex && look.sex !== sex) return false;
    if (L.has("community") && String(look.community || "none") !== String(state.params.community || "none")) return false;
    if (L.has("role") && String(look.role || "none") !== String(state.params.role || "none")) return false;
    if (L.has("rank") && String(look.rank || "none") !== String(state.params.rank || "none")) return false;
    if (L.has("occasion") && String(look.occasion || "daily") !== String(state.params.occasion || "daily")) return false;
    for (let i = 0; i < slotLocks.length; i++) {
      if (String((look.slots || {})[slotLocks[i]]) !== String(state.params[slotLocks[i]])) return false;
    }
    return true;
  });
}
/* 一次合法取值：没有可用选项时退回默认值，避免随机人物在空数组上崩 */
function rollOptionValue(rng, p) {
  const sex = currentSex();
  const opts = allowedOptions(p, sex);
  if (!opts.length) return p.default;
  return pickWeighted(rng, opts, sex).value;
}
/* 随机人物选性别时避开与锁定值冲突的性别：锁了女性旗头就不随机成男性 */
function lockedValueFitsSex(id, sex) {
  const p = paramIndex[id];
  if (!p || p.id === "sex") return true;
  if (p.type === "number") {
    const range = sexRange(p, sex);
    const v = Number(state.params[id]);
    return !isFinite(v) || (v >= range[0] && v <= range[1]);
  }
  if (p.type === "choice" || p.type === "sex") {
    const o = (p.options || []).find(function (x) { return x.value === state.params[id]; });
    if (!o || !o.w) return true;
    const w = o.w[sex];
    return typeof w !== "number" || w > 0;
  }
  return true;
}
function pickRerollSex(rng) {
  const sp = paramIndex.sex;
  const locked = Array.from(state.locks);
  const opts = sp.options.filter(function (o) {
    return locked.every(function (id) { return lockedValueFitsSex(id, o.value); });
  });
  if (!opts.length) return currentSex();
  const weights = sp.weights || {};
  let total = 0;
  opts.forEach(function (o) { total += weights[o.value] || 1; });
  let r = rng() * total;
  for (let i = 0; i < opts.length; i++) {
    r -= weights[opts[i].value] || 1;
    if (r <= 0) return opts[i].value;
  }
  return opts[opts.length - 1].value;
}
/* 试一个上下文值，看它会不会让别的锁定项失去合法选项（例如锁了品级又随机身份） */
function contextValueKeepsLocks(id, value) {
  const prev = state.params[id];
  state.params[id] = value;
  let safe = true;
  state.locks.forEach(function (lid) {
    if (lid === id || !paramIndex[lid]) return;
    const lp = paramIndex[lid];
    if (lp.type !== "choice" && lp.type !== "sex") return;
    const o = (lp.options || []).find(function (x) { return x.value === state.params[lid]; });
    if (o && weightOf(o, currentSex()) === 0) safe = false;
  });
  state.params[id] = prev;
  return safe;
}
/* 上下文兜底：没有身份卡时，按门控逐项随机（时代已经定好，不在这里改） */
function randomizeContextParams(rng) {
  ["community", "role", "rank", "occasion"].forEach(function (id) {
    if (state.locks.has(id)) return;
    const p = paramIndex[id];
    if (!p) return;
    const opts = allowedOptions(p, currentSex()).filter(function (o) {
      return contextValueKeepsLocks(id, o.value);
    });
    if (!opts.length) return;
    state.params[id] = pickWeighted(rng, opts, currentSex()).value;
  });
}
/* 没有身份卡时逐槽位随机（门控 + 性别权重） */
function randomizeCostumeSlots(rng) {
  if (!eraOn()) { clearCostumeSlots(); return; }
  costumeSlotIds().forEach(function (id) {
    if (state.locks.has(id)) return;
    const p = paramIndex[id];
    if (!p) return;
    state.params[id] = rollOptionValue(rng, p);
  });
}
/* 随机人物：时代 / 身份卡 / 服饰 / 人物参数一起换；锁定的项不动；结果仍受门控与派生约束 */
function rerollAll(seed, opts) {
  state.seed = (seed == null ? Math.floor(Math.random() * 4294967296) : seed) >>> 0;
  const rng = mulberry32(state.seed);
  const L = state.locks;
  const slotLocks = lockedCostumeSlots();

  /* 0) 性别：不锁就先随机定下来；锁定值不兼容的性别跳过，避免锁被性别硬约束改掉 */
  if (!L.has("sex")) state.params.sex = pickRerollSex(rng);

  /* 1) 时代：不锁就随机。锁了服饰槽位时保持当前时代，否则槽位锁会被素体或门控清掉。 */
  if (!L.has("era") && !slotLocks.length) {
    state.params.era = pickWeighted(rng, paramIndex.era.options, currentSex()).value;
  }

  /* 2) 身份卡：按锁定条件随机一张；选不到卡时走无卡兜底 */
  let look = null;
  if (eraOn()) {
    let cands = rerollLookCandidates(state.params.era);
    if (cands.length > 1 && state.lookId) {
      const others = cands.filter(function (l) { return l.id !== state.lookId; });
      if (others.length) cands = others;
    }
    if (cands.length) look = cands[Math.floor(rng() * cands.length)];
  }

  if (look) {
    applyLookData(look, { silent: true, respectLocks: true });
    /* 卡片没覆盖到的槽位补随机；卡片覆盖到的整套槽位保持整卡形制 */
    costumeSlotIds().forEach(function (id) {
      if (L.has(id)) return;
      if (look.slots && Object.prototype.hasOwnProperty.call(look.slots, id)) return;
      const p = paramIndex[id];
      if (p) state.params[id] = rollOptionValue(rng, p);
    });
  } else {
    /* 无卡兜底也要保住锁定的槽位：先记下来，清空后再放回去 */
    const keptSlots = {};
    if (eraOn()) {
      costumeSlotIds().forEach(function (id) {
        if (L.has(id)) keptSlots[id] = state.params[id];
      });
    }
    state.lookId = "";
    state.lookCustomized = {};
    state.manualOverrides = {};
    clearCostumeSlots();
    Object.keys(keptSlots).forEach(function (k) { state.params[k] = keptSlots[k]; });
    /* 锁了槽位又没有匹配的卡：身份上下文不动，免得把锁定槽位的门控弄失效 */
    if (!slotLocks.length) randomizeContextParams(rng);
    if (eraOn()) randomizeCostumeSlots(rng);
  }

  /* 3) 其余参数全量重掷：上下文（virtual）与服饰槽位已经单独处理 */
  DATA.params.groups.forEach(function (g) {
    if (g.id === "costume") return;
    g.params.forEach(function (p) {
      if (p.id === "sex" || p.virtual) return;
      if (L.has(p.id)) return;
      state.params[p.id] = rollParam(rng, p);
    });
  });

  /* 4) 锁定 + 身份卡管辖：标记成自定义，commit 时不再让卡片压回去 */
  const own = cardOverrides();
  Object.keys(own).forEach(function (k) {
    if (L.has(k)) {
      state.lookCustomized = state.lookCustomized || {};
      state.lookCustomized[k] = true;
    }
  });

  state.meta = genMeta(rng, currentSex());
  state.meta.identity = identityPhrase();
  commitParams({ reason: "reroll", rng: rng, silent: !!(opts && opts.silent) });
}

function rollParam(rng, p) {
  const sex = currentSex();
  if (p.type === "choice") {
    const opts = allowedOptions(p, sex);
    if (!opts.length) return p.default;
    return pickWeighted(rng, opts, sex).value;
  }
  if (p.id === "age") {
    const r = Math.pow(rng(), 1.55);
    return Math.round(p.min + r * (p.max - p.min));
  }
  if (p.id === "presentation") {
    const r = sexRange(p, sex);
    const t = (rng() + rng()) / 2;
    return Math.round(r[0] + t * (r[1] - r[0]));
  }
  if (p.id === "height") {
    const r = sexRange(p, sex);
    return randInt(rng, r[0], r[1]);
  }
  if (p.id === "asymmetry") {
    return rng() < 0.65 ? 0 : randInt(rng, 5, 55);
  }
  return randInt(rng, p.min, p.max);
}

/* 软相关性：概率项。硬联动（发型→发长等）在 applyDerived 里，这里只处理随机倾向。 */
function applyCorrelations(rng) {
  const P = state.params;
  const sex = currentSex();
  const cards = cardOverrides();
  function free(id) {
    if (state.locks.has(id)) return false;
    if (state.manualOverrides && state.manualOverrides[id]) return false;
    return !(cards[id] && !(state.lookCustomized && state.lookCustomized[id]));
  }
  if (P.age > 55 && free("hairColor") && rng() < 0.62) P.hairColor = "grey";
  if (P.age < 24 && free("hairColor") && P.hairColor === "grey") P.hairColor = "black";
  if (P.bodyBuild === "plump" && P.muscle === "clear" && free("muscle")) P.muscle = "light";
  /* 女性不留男性胡型：硬约束，优先于锁 */
  if (sex === "female" && (P.beard === "full" || P.beard === "goatee" || P.beard === "stubble")) P.beard = "peachfuzz";
  if (free("scar") && rng() < 0.72) P.scar = "none";
  if (free("tattoo") && rng() < 0.84) P.tattoo = "none";
  if (free("birthmark") && rng() < 0.74) P.birthmark = "none";
  if (free("missing") && rng() < 0.9) P.missing = "none";
}

function rollOne(id) {
  const p = paramIndex[id];
  if (!p || p.id === "sex") return;
  const salt = (state.rollTick = (state.rollTick || 0) + 1);
  const rng = mulberry32((state.seed ^ hashId(id) ^ Math.imul(salt, 2654435761)) >>> 0);
  /* 拒绝采样：连续掷必须换一个值（只有一个合法选项时才允许不变） */
  let next = state.params[id];
  for (let i = 0; i < 30; i++) {
    const v = rollParam(rng, p);
    if (v !== next) { next = v; break; }
  }
  state.params[id] = next;
  state.manualOverrides = state.manualOverrides || {};
  state.manualOverrides[id] = true;
  if (Object.prototype.hasOwnProperty.call(cardOverrides(), id)) {
    state.lookCustomized = state.lookCustomized || {};
    state.lookCustomized[id] = true;
  }
  commitParams({ reason: "rollOne", changed: id, rng: rng });
}

function setSex(value) {
  if (state.params.sex === value) return;
  state.params.sex = value;
  state.meta = genMeta(mulberry32((state.seed + 99) >>> 0), value);
  commitParams({ reason: "sex", changed: "sex" });
  toast("已切换为「" + sexMeta().label + "」，不适用的特征已自动调整");
}

/* ---------- phrases / prompt ---------- */
function bandFor(p, value) {
  if (!p.bands) return String(value);
  for (let i = 0; i < p.bands.length; i++) {
    if (value <= p.bands[i].max) return p.bands[i].phrase;
  }
  return p.bands[p.bands.length - 1].phrase;
}

/* ---------- 时代 / 服饰（P1） ---------- */
function eraDef(id) {
  const list = (DATA.eras && DATA.eras.eras) || [];
  return list.find(function (e) { return e.id === id; }) || null;
}
function eraOn() {
  const v = state.params.era;
  return !!v && v !== "none";
}
function optionLabel(paramId) {
  const p = paramIndex[paramId];
  if (!p) return "";
  const o = (p.options || []).find(function (x) { return x.value === state.params[paramId]; });
  return o ? o.label : "";
}
/* 身份词在提示词里的写法：女性按「妻/妇」处理，避免「士人」配女装 */
function costumeRolePhrase() {
  const role = state.params.role;
  if (!role || role === "none") return "";
  const sex = currentSex();
  const community = state.params.community;
  if (role === "ruler") return sex === "female" ? "皇后" : "皇帝";
  if (role === "noble" && sex !== "female") return state.params.outer === "qinwang_bufu" ? "宗室亲王" : "宗室成员";
  if (role === "merchant" && state.params.rank && state.params.rank !== "none") return "捐纳职衔商人";
  if (sex === "female") {
    if (role === "noble") return (community === "manchu" || community === "han_banner") ? "旗人贵妇" : "贵妇";
    if (role === "literati") return "士人妻";
    if (role === "farmer") return "农妇";
    if (role === "merchant") return "商贾之妻";
    if (role === "artisan") return "匠妇";
  }
  return optionLabel("role");
}
function currentRankInfo() {
  const role = state.params.role;
  const rank = state.params.rank;
  if (!rank || rank === "none") return null;
  /* 捐纳职衔商人按其捐得的文官品级使用补子、顶珠与朝珠资格。
     身份卡已明确“捐纳”，不把普通商人误当作有品级官员。 */
  const kind = role === "official_military" ? "military" : (role === "official_civil" || role === "merchant") ? "civil" : null;
  if (!kind) return null;
  const table = (DATA.eras && DATA.eras.ranks) || {};
  return (table[kind] && table[kind][String(rank)]) || null;
}
/* 把 9 个槽位拼成一句形制描述；半身像/九宫格只取头颈（不写鞋与下装，免得模型拉远镜头） */
function costumeText() {
  const era = eraDef(state.params.era);
  if (!era) return "";
  const tpl = currentTemplate();
  const headOnly = !!tpl && (tpl.id === "portrait" || tpl.id === "expression_grid");
  const rank = currentRankInfo();
  const bits = [];
  let lead = era.promptLead || era.label;
  const role = costumeRolePhrase();
  const rankLbl = optionLabel("rank");
  if (role) lead += (rankLbl && rankLbl !== "无品级" ? rankLbl : "") + role;
  bits.push(lead);
  const order = headOnly
    ? ["headwear", "accessory"]
    : ["headwear", "outer", "inner", "lower", "shoes", "accessory", "pattern", "material", "color"];
  const slotMeta = (DATA.eras && DATA.eras.slots) || [];
  order.forEach(function (sid) {
    const val = state.params[sid];
    if (!val || val === "none") return;
    const p = paramIndex[sid];
    if (!p) return;
    const o = (p.options || []).find(function (x) { return x.value === val; });
    if (!o || !o.phrase) return;
    if (sid === "accessory" && val === "chaozhu" && rank && !rank.pearls) return;
    let ph = o.phrase;
    if (headOnly && sid === "accessory") {
      ph = o.headPhrase === undefined ? o.phrase : o.headPhrase;
      if (!ph) return;
    }
    if (sid === "headwear" && rank && (val === "nuanmao" || val === "liangmao" || val === "chaoguan")) ph += "，帽顶嵌" + rank.jewel + "顶珠";
    if (sid === "pattern" && rank && (val === "buzi_civil" || val === "buzi_military")) ph += "，绣一只" + rank.badge;
    const meta = slotMeta.find(function (s) { return s.id === sid; });
    bits.push((meta && meta.lead ? meta.lead : "") + ph);
  });
  if (!bits.length) return "";
  return bits.join("，").replace(/，+/g, "，").replace(/，$/, "");
}
function eraNegative() {
  if (!eraOn()) return "";
  const era = eraDef(state.params.era);
  return (era && era.negative) || "";
}
function budgetFor(orient) {
  const o = orient || "any";
  if (o === "landscape") return eraOn() ? 2300 : 2100;
  return eraOn() ? 2000 : 1800;
}
function expandCovers(set, vars) {
  if (!eraOn()) return;
  /* 服饰句真的有内容时，9 个槽位才算「写进提示词」 */
  if (vars && !String(vars.costume || "")) return;
  state.blocks.forEach(function (b) {
    if (!b.enabled || isBlockSuppressed(b.id)) return;
    const c = DATA.content && DATA.content[b.id];
    if (!c || !Array.isArray(c.covers)) return;
    c.covers.forEach(function (k) { set.add(k); });
  });
}
function applyLookData(look, opts) {
  if (!look) return false;
  const respectLocks = !!(opts && opts.respectLocks);
  const L = state.locks;
  const keptSlots = {};
  if (respectLocks) {
    ((DATA.eras && DATA.eras.slots) || []).forEach(function (s) {
      if (L.has(s.id)) keptSlots[s.id] = state.params[s.id];
    });
  }
  const nextSex = (look.sex && !(respectLocks && L.has("sex"))) ? look.sex : currentSex();
  const sexChanged = nextSex !== currentSex();
  state.lookId = look.id;
  if (look.sex && !(respectLocks && L.has("sex"))) state.params.sex = look.sex;
  if (!(respectLocks && L.has("era"))) state.params.era = look.era;
  if (!(respectLocks && L.has("community"))) state.params.community = look.community || "none";
  if (!(respectLocks && L.has("role"))) state.params.role = look.role || "none";
  if (!(respectLocks && L.has("rank"))) state.params.rank = look.rank ? String(look.rank) : "none";
  if (!(respectLocks && L.has("occasion"))) state.params.occasion = look.occasion || "daily";
  /* 换卡 = 重新受这张卡约束：清掉手动自定义与派生豁免，槽位先清空再按卡填。
     随机人物走 respectLocks：被锁的项保留原值，不跟卡走。 */
  state.lookCustomized = {};
  state.manualOverrides = {};
  clearCostumeSlots();
  Object.keys(keptSlots).forEach(function (k) { state.params[k] = keptSlots[k]; });
  Object.keys(look.slots || {}).forEach(function (k) {
    if (respectLocks && L.has(k)) return;
    state.params[k] = look.slots[k];
  });
  Object.keys(look.overrides || {}).forEach(function (k) {
    if (respectLocks && L.has(k)) return;
    const p = paramIndex[k];
    if (p && p.options && p.options.some(function (o) { return o.value === look.overrides[k]; })) state.params[k] = look.overrides[k];
  });
  /* 卡片换了性别：姓名/性格/简介必须跟着换，不能留男名配女卡 */
  if (sexChanged) state.meta = genMeta(mulberry32((state.seed + 99) >>> 0), nextSex);
  state.meta.identity = identityPhrase();
  return true;
}
function lookFilled() {
  return ["headwear","outer","inner","lower","shoes","accessory","pattern","material","color"].some(function (k) {
    return state.params[k] && state.params[k] !== "none";
  });
}
/* 选了时代但一个槽位都没设时，自动套第一张同代身份卡（不然只出现一句空身份） */
function maybeDressEra() {
  if (!eraOn() || lookFilled()) return;
  const looks = (DATA.eras && DATA.eras.looks) || [];
  const sex = currentSex();
  const sameEra = looks.filter(function (l) { return l.era === state.params.era; });
  const look = sameEra.find(function (l) { return !l.sex || l.sex === sex; }) || sameEra[0];
  if (look) applyLookData(look);
}
/* 兼容旧调用名：统一走 normalizeContext */
function normalizeCostumeContext(changed) { normalizeContext(changed); }
function currentLookEvidence() {
  if (!eraOn()) return null;
  const look = ((DATA.eras && DATA.eras.looks) || []).find(function (item) { return item.id === state.lookId; });
  if (!look) return { lookId: "", level: "自定义·待核", refs: [], note: "当前组合未匹配已核身份卡", modified: true };
  const evidence = look.evidence || {};
  const modified = ["era", "community", "role", "rank", "occasion", "sex"].some(function (key) { return String(state.params[key] || "none") !== String(look[key] || "none"); }) || Object.keys(look.slots || {}).some(function (key) { return state.params[key] !== look.slots[key]; });
  const rank = currentRankInfo();
  const refs = evidence.refs || look.refs || [];
  const sources = refs.map(function (ref) { return Object.assign({ id: ref, title: ((DATA.eras || {}).refs || {})[ref] || "待核" }, ((DATA.eras || {}).sources || {})[ref] || {}); });
  return { lookId: look.id, mode: evidence.mode || "documented", level: modified ? "自定义·待核" : evidence.level || look.confidence || "", refs: refs, sources: sources, note: (modified ? "已修改身份卡，来源仅作基线参考。" : "") + (evidence.note || "") + (state.params.role === "official_military" && state.params.rank === "7" ? " 武七补子存在犀牛/彪异说。" : ""), modified: modified, rankRule: rank ? { badge: rank.badge, jewel: rank.jewel, pearls: rank.pearls } : null };
}
function applyLookPreset(id) {
  const looks = (DATA.eras && DATA.eras.looks) || [];
  const look = looks.find(function (l) { return l.id === id; });
  if (!look) { toast("没有这张身份卡"); return; }
  const sexBefore = currentSex();
  applyLookData(look, { silent: true });
  commitParams({ reason: "card", changed: "card" });
  const evidence = look.evidence || {};
  const sexNote = look.sex && look.sex !== sexBefore
    ? "；性别已改为" + (look.sex === "female" ? "女" : look.sex === "male" ? "男" : "中性") + "，姓名与档案已重建"
    : "";
  toast("已套用「" + look.label + "」" + (evidence.level ? " · 证据 " + evidence.level : "") + sexNote);
}
function lookEvidenceText(look) {
  const evidence = (look && look.evidence) || {};
  const level = evidence.level || look.confidence || "未分级";
  const refs = (evidence.refs || look.refs || []).map(function (ref) { return ref + "：" + (((DATA.eras || {}).refs || {})[ref] || "待核"); }).join("；");
  return "证据 " + level + (refs ? " · " + refs : "") + (evidence.note ? "。" + evidence.note : "");
}

function buildVars() {
  const v = {};
  DATA.params.groups.forEach(function (g) {
    g.params.forEach(function (p) {
      const val = state.params[p.id];
      if (p.type === "choice") {
        const opt = p.options.find(function (o) { return o.value === val; });
        v[p.id] = opt ? opt.label : "";
        v[p.id + "Phrase"] = opt ? opt.phrase : "";
      } else {
        v[p.id] = String(val);
        v[p.id + "Phrase"] = bandFor(p, val);
      }
    });
  });
  v.ethnicity = (function () {
    const p = paramIndex.ethnicity;
    const opt = p.options.find(function (o) { return o.value === state.params.ethnicity; });
    return opt ? opt.phrase : "";
  })();
  v.presentation = bandFor(paramIndex.presentation, state.params.presentation);
  v.masculinity = v.presentation;
  v.sexPhrase = sexMeta().phrase;
  v.aspectText = aspectText();
  v.aspectRatio = state.ratio;
  v.sizePx = sizeString();
  v.underTop = currentSex() === "male"
    ? "上身赤裸"
    : "上身只穿一件肉色无缝抹胸，抹胸与肤色接近、没有图案";
  v.outfitExtra = "，下身只穿一条肉色无缝紧身短裤，没有其他衣物、没有鞋、没有配饰，身体轮廓清楚可见";
  v.sexLabel = sexMeta().label;
  v.ageLook = bandFor(paramIndex.age, state.params.age);
  v.asymmetry = bandFor(paramIndex.asymmetry, state.params.asymmetry);
  v.name = state.meta.name || "无名";
  v.identity = state.meta.identity || "游民";
  v.trait = state.meta.trait || "无";
  v.personality = state.meta.personality || "";
  v.bio = state.meta.bio || "";
  const keywords = Array.isArray(state.meta.styleKeywords) ? state.meta.styleKeywords : [];
  v.styleKeywords = keywords.join("、");
  const profileParts = [];
  if (v.identity) profileParts.push(v.identity);
  if (v.personality) profileParts.push("性格" + v.personality);
  if (v.trait) profileParts.push(v.trait);
  v.profileText = profileParts.length ? "人物档案：" + profileParts.join("，") + "。" : "";
  if (v.styleKeywords) v.profileText += "风格关键词：" + v.styleKeywords + "。";
  /* 画幅可以 vars 覆盖某些参数（九宫格的表情/视线等）；这些参数不能再经「记忆点」句
     把单一取值写回提示词，否则九宫格又会出现「表情平静」这种全局表情 */
  const tpl = (DATA.layouts && DATA.layouts.length) ? currentTemplate() : null;
  const tplVars = (tpl && tpl.vars) || {};
  const signaturePhrases = [];
  (state.highlights || []).forEach(function (id) {
    const p = paramIndex[id];
    if (!p || p.type !== "choice") return;
    if (Object.prototype.hasOwnProperty.call(tplVars, id)) return;
    const o = p.options.find(function (x) { return x.value === state.params[id]; });
    if (!o || o.value === "none" || !o.phrase) return;
    if (signaturePhrases.indexOf(o.phrase) < 0) signaturePhrases.push(o.phrase);
  });
  v.signatureSentence = signaturePhrases.length
    ? "最具辨识度的特征：" + signaturePhrases.join("；") + "。"
    : "";
  DATA.params.groups.forEach(function (g) {
    g.params.forEach(function (p) {
      if (p.type === "choice") {
        const opt = p.options.find(function (o) { return o.value === state.params[p.id]; });
        v[p.id] = opt ? opt.phrase : v[p.id];
      }
    });
  });
  /* 时代 / 服饰：先把素体遮挡与体表描述改掉，再让版面 vars 覆盖（半身像与九宫格的裁切句要保留） */
  const eraId = state.params.era;
  const eraMode = !!eraId && eraId !== "none";
  if (eraMode) {
    v.underTop = "";
    v.outfitExtra = "";
    const eraObj = eraDef(eraId);
    const para = (eraObj && eraObj.paraphrases) || {};
    Object.keys(para).forEach(function (k) {
      v[k] = para[k];
      v[k + "Phrase"] = para[k];
    });
  }
  /* 版面改写：画幅可以在 vars 里覆盖共用内容段的取值（例如九宫格用九格表情矩阵代替单一表情） */
  Object.keys(tplVars).forEach(function (k) {
    if (typeof tplVars[k] === "string") v[k] = tplVars[k];
  });
  v.costume = eraMode ? costumeText() : "";
  v.costumeNeg = eraMode ? eraNegative() : "";
  /* 素体态或槽位为「无」时，槽位变量必须输出空串：
     否则自定义段里的 {{headwear}} 会把上一个时代残留的「暖帽」写进提示词 */
  ((DATA.eras && DATA.eras.slots) || []).forEach(function (slot) {
    const id = slot.id;
    if (!eraMode || !state.params[id] || state.params[id] === "none") {
      v[id] = "";
      v[id + "Phrase"] = "";
    }
  });
  return v;
}

/* 编译一段：未知变量剥掉（不再把 {{foo}} 发给模型） */
function compileBlockText(b, vars) {
  return String(b.text).replace(/\{\{(\w+)\}\}/g, function (m, k) {
    if (!Object.prototype.hasOwnProperty.call(vars, k)) return "";
    const v = vars[k];
    return v == null ? "" : String(v);
  });
}

/* ======================================================================
   复刻提示词 / 风格预设（叠加在常规提示词之上）
   full   = 整段替换本次提示词（左栏参数与右栏段落都不参与）
   suffix = 把风格段追加到常规提示词末尾（保留当前人物）
   ====================================================================== */
function activeStyle() {
  const s = state.activeStyle;
  if (!s) return null;
  if (s.mode === "suffix") return String(s.styleSuffix || "").trim() ? s : null;
  return String(s.prompt || "").trim() ? s : null;
}
function updateStyleChip() {
  const chip = $("#activeStyleChip");
  if (!chip) return;
  const s = activeStyle();
  if (!s) {
    chip.hidden = true;
    chip.textContent = "";
    return;
  }
  chip.hidden = false;
  chip.textContent = (s.mode === "suffix" ? "风格：" : "复刻提示词：") + (s.name || "未命名") + " ✕";
  chip.title = s.mode === "suffix"
    ? "已把风格段追加到当前提示词末尾；点一下清除，回到纯参数提示词"
    : "本次生成使用整段复刻提示词，左栏参数与右栏段落都不参与；点一下清除";
}
function setActiveStyle(style) {
  state.activeStyle = style || null;
  updateStyleChip();
  updatePromptPreview();
  saveState();
}
function clearActiveStyle() {
  state.activeStyle = null;
  syncStage();
  saveState();
  toast("已清除复刻提示词 / 风格，回到参数生成的提示词");
}

/* ======================================================================
   提示词快照：预览 / 复制 / 生成发送 共用这一份，谁也不许再单独拼一遍
   ====================================================================== */
function buildPromptSnapshot() {
  const vars = buildVars();
  const tpl = currentTemplate();
  const tplVars = (tpl && tpl.vars) || {};
  const style = activeStyle();
  /* 整段复刻：直接返回复刻提示词，不拼左栏参数；预览和实际发送仍然共用这一份 */
  if (style && style.mode === "full") {
    const externalText = String(style.prompt || "").trim();
    return {
      text: externalText,
      vars: vars,
      segments: [{ id: "__style_full", kind: "custom", label: "复刻提示词", raw: externalText, text: externalText, emptyKeys: [], literal: true }],
      used: new Set(),
      empty: [],
      unknown: [],
      overrides: Object.keys(tplVars),
      external: true,
      style: { id: style.id || "", name: style.name || "", mode: "full" },
      stats: { chars: externalText.length, vars: 0, empty: 0, unknown: 0 }
    };
  }
  const segments = [];
  const used = new Set();
  const empty = [];
  const unknown = [];
  state.blocks.forEach(function (b) {
    if (!b.enabled || isBlockSuppressed(b.id)) return;
    const raw = String(b.text);
    const segEmpty = [];
    (raw.match(/\{\{(\w+)\}\}/g) || []).forEach(function (token) {
      const key = token.slice(2, -2);
      if (!Object.prototype.hasOwnProperty.call(vars, key)) {
        let u = unknown.find(function (item) { return item.key === key; });
        if (!u) { u = { key: key, blocks: [] }; unknown.push(u); }
        if (b.label && u.blocks.indexOf(b.label) < 0) u.blocks.push(b.label);
        return;
      }
      const val = vars[key];
      if (val == null || String(val) === "") {
        if (segEmpty.indexOf(key) < 0) segEmpty.push(key);
        if (empty.indexOf(key) < 0) empty.push(key);
      } else {
        used.add(key);
      }
    });
    const text = compileBlockText(b, vars);
    if (!text.trim()) return;
    segments.push({ id: b.id, kind: b.kind, label: b.label, raw: raw, text: text, emptyKeys: segEmpty });
  });
  /* 只套风格：把风格段作为最后一段正文追加，时代负向词仍然压在最后 */
  if (style && style.mode === "suffix") {
    const suffix = String(style.styleSuffix || "").trim();
    if (suffix) {
      segments.push({
        id: "__style_suffix",
        kind: "custom",
        label: "风格预设 · " + (style.name || ""),
        raw: "",
        text: "风格与质感：" + suffix,
        emptyKeys: [],
        literal: true
      });
    }
  }
  const tail = eraNegative();
  const body = segments.map(function (seg) { return seg.text.trim(); }).join("\n\n");
  const text = tail ? (body ? body + "\n\n" + tail : tail) : body;
  const usedSet = new Set(used);
  expandCovers(usedSet, vars);
  return {
    text: text,
    vars: vars,
    segments: segments,
    used: usedSet,
    empty: empty,
    unknown: unknown,
    overrides: Object.keys(tplVars),
    external: false,
    style: style ? { id: style.id || "", name: style.name || "", mode: style.mode } : null,
    stats: { chars: text.length, vars: usedSet.size, empty: empty.length, unknown: unknown.length }
  };
}

function compilePrompt() {
  return buildPromptSnapshot().text;
}


/* ======================================================================
   变量映射：左栏参数 / 顶栏设置 ⇄ 右侧提示词里的 {{变量}}
   ====================================================================== */
const CANVAS_VARS = {
  aspectText: { label: "画幅描述（比例 + 横竖）", source: "顶栏 · 比例 + 清晰度", group: "画布", target: "ratio" },
  aspectRatio: { label: "画幅比例", source: "顶栏 · 比例", group: "画布", target: "ratio" },
  sizePx: { label: "实际像素", source: "顶栏 · 比例 + 清晰度", group: "画布", target: "size" },
  sexPhrase: { label: "性别描述", source: "左栏 · 性别", group: "身份", target: "sex" },
  sexLabel: { label: "性别", source: "左栏 · 性别", group: "身份", target: "sex" },
  underTop: { label: "上身着装（按性别自动）", source: "左栏 · 性别（遮挡规则）", group: "自动生成", target: "sex" },
  outfitExtra: { label: "服装补充（下身）", source: "画幅 · 版面改写", group: "自动生成", target: "ratio" },
  costume: { label: "朝代服饰形制句", source: "左栏 · 时代与身份 / 服饰", group: "服饰", target: "costume" },
  costumeNeg: { label: "时代负向词", source: "data/eras.json 的时代包", group: "服饰", target: "costume" },
  ageLook: { label: "年龄感", source: "左栏 · 身份 · 年龄", group: "面目", target: "ratio" },
  name: { label: "姓名", source: "「随机人物」随机生成", group: "自动生成", target: "stage" },
  identity: { label: "身份", source: "「随机人物」随机生成", group: "自动生成", target: "stage" },
  trait: { label: "标签", source: "「随机人物」随机生成", group: "自动生成", target: "stage" },
  masculinity: { label: "气质（presentation 的别名）", source: "左栏 · 身份 · 气质", group: "身份", target: "ratio" }
};

const META_VARS = {
  profileText: { label: "人物档案整句", source: "人物档案 · 身份/性格/标签/风格关键词", target: "profile" },
  signatureSentence: { label: "记忆点整句", source: "左栏参数 · ☆ 记忆点", target: "signature" },
  personality: { label: "性格", source: "人物档案 · 性格", target: "profile" },
  styleKeywords: { label: "风格关键词", source: "人物档案 · 风格关键词", target: "profile" },
  bio: { label: "简介（仅存档）", source: "人物档案 · 简介", target: "profile" }
};

function buildParamGroupIndex() {
  paramGroupIndex = {};
  DATA.params.groups.forEach(function (g) {
    g.params.forEach(function (p) { paramGroupIndex[p.id] = g.label; });
  });
}

function varMetaFor(key) {
  if (CANVAS_VARS[key]) {
    const m = CANVAS_VARS[key];
    return { key: key, kind: "canvas", label: m.label, source: m.source, group: m.group, target: m.target };
  }
  if (META_VARS[key]) {
    const m = META_VARS[key];
    return { key: key, kind: "meta", label: m.label, source: m.source, group: "档案", target: m.target };
  }
  if (paramIndex[key] && key !== "sex") {
    const p = paramIndex[key];
    return { key: key, kind: "param", paramId: p.id, label: p.label, source: "左栏 · " + (paramGroupIndex[p.id] || "参数"), group: paramGroupIndex[p.id] || "参数" };
  }
  const pm = /^(\w+)Phrase$/.exec(key);
  if (pm && paramIndex[pm[1]]) {
    const p = paramIndex[pm[1]];
    return { key: key, kind: "param", paramId: p.id, label: p.label + " · 词句", source: "左栏 · " + (paramGroupIndex[p.id] || "参数"), group: paramGroupIndex[p.id] || "参数" };
  }
  return { key: key, kind: "unknown", label: "未定义", source: "没有这个变量", group: "未定义" };
}

function phraseForParam(p) {
  const val = state.params[p.id];
  if (p.type === "choice") {
    const o = p.options.find(function (x) { return x.value === val; });
    return o ? (o.phrase || o.label) : "";
  }
  if (p.id === "height") return "身高约 " + val + " 厘米";
  return bandFor(p, val);
}

/* 有效引用：只有「段生效 + 值非空」的变量才算写进提示词；空值与未知变量不算 */
function effectiveUsage() {
  return new Set(buildPromptSnapshot().used);
}
function usedVarKeys() {
  return effectiveUsage();
}

function blockVarUsage() {
  const usage = {};
  state.blocks.forEach(function (b) {
    if (!b.enabled || isBlockSuppressed(b.id)) return;
    const re = /\{\{(\w+)\}\}/g;
    let m;
    while ((m = re.exec(String(b.text)))) {
      const k = m[1];
      usage[k] = usage[k] || [];
      if (usage[k].indexOf(b.label) < 0) usage[k].push(b.label);
    }
  });
  return usage;
}

function buildVarRows() {
  const vars = buildVars();
  const used = usedVarKeys();
  const usage = blockVarUsage();
  const keys = [];
  state.blocks.forEach(function (b) {
    String(b.text).replace(/\{\{(\w+)\}\}/g, function (m, k) {
      if (keys.indexOf(k) < 0) keys.push(k);
      return m;
    });
  });
  Object.keys(vars).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
  return keys.map(function (k) {
    return {
      key: k,
      value: vars[k] == null ? "" : String(vars[k]),
      meta: varMetaFor(k),
      used: used.has(k),
      blocks: usage[k] || []
    };
  });
}

function varGroupOrder() {
  const order = ["画布"];
  DATA.params.groups.forEach(function (g) { if (order.indexOf(g.label) < 0) order.push(g.label); });
  ["档案", "自动生成", "未定义"].forEach(function (g) { if (order.indexOf(g) < 0) order.push(g); });
  return order;
}

function shortVal(v, n) {
  n = n || 18;
  v = String(v);
  return v.length > n ? v.slice(0, n) + "…" : v;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/* 把一段含 {{变量}} 的模板渲染成带高亮的 HTML。
   mode=exact：用于「最终提示词」——空值不写任何可见文字，保证预览 === 实际发送；
   mode=rich：用于说明性预览，空值显示「（空）」、未知变量标红。 */
function renderTemplateHTML(text, vars, opts) {
  const mode = (opts && opts.mode) || "rich";
  let out = "";
  let last = 0;
  const re = /\{\{(\w+)\}\}/g;
  let m;
  while ((m = re.exec(text))) {
    out += escapeHtml(text.slice(last, m.index));
    const key = m[1];
    const meta = varMetaFor(key);
    const val = vars[key];
    if (val == null) {
      if (mode === "exact") {
        last = re.lastIndex;
        continue;
      }
      out += '<span class="pvar unknown" data-var="' + escapeAttr(key) + '" title="' + escapeAttr("未定义的变量 {{" + key + "}}：右侧没有这个变量，可能是手误") + '">' + escapeHtml(m[0]) + "</span>";
    } else if (String(val) === "" && mode === "exact") {
      out += '<span class="pvar empty" data-var="' + escapeAttr(key) + '" title="' + escapeAttr("{{" + key + "}} 当前为空，不会输出文字") + '"></span>';
    } else {
      const shown = String(val) === "" ? "（空）" : val;
      const title = "{{" + key + "}}\n" + meta.label + " · 来源：" + meta.source + "\n当前值：" + (String(val) === "" ? "（空，不输出文字）" : val) + "\n点击定位来源";
      out += '<span class="pvar' + (String(val) === "" ? " empty" : "") + '" data-var="' + escapeAttr(key) + '" title="' + escapeAttr(title) + '">' + escapeHtml(shown) + "</span>";
    }
    last = re.lastIndex;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

function compilePromptHTML(opts) {
  const snap = buildPromptSnapshot();
  const parts = snap.segments.map(function (seg) {
    return seg.literal ? escapeHtml(seg.text) : renderTemplateHTML(seg.raw, snap.vars, opts);
  });
  const tail = snap.external ? "" : eraNegative();
  if (tail) parts.push(escapeHtml(tail));
  return parts.join("\n\n");
}

function highlightVars(keys, on) {
  keys.forEach(function (k) {
    const nodes = document.querySelectorAll('#promptPreview .pvar[data-var="' + k + '"]');
    for (let i = 0; i < nodes.length; i++) nodes[i].classList.toggle("hover", on);
  });
}
function highlightParamRow(paramId, on) {
  const row = document.querySelector('#paramGroups .param[data-id="' + paramId + '"]');
  if (row) row.classList.toggle("hover", on);
}
function flashEl(node) {
  if (!node) return;
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
  setTimeout(function () { node.classList.remove("flash"); }, 2300);
}
function flashVar(key) {
  let nodes = document.querySelectorAll('#promptPreview .pvar[data-var="' + key + '"]');
  if (!nodes.length) nodes = document.querySelectorAll('#blockList .vchip[data-var="' + key + '"]');
  if (nodes.length) ensurePanelVisible("right");
  if (!nodes.length) {
    toast("当前提示词里没有 {{" + key + "}}：包含它的段可能被停用，或它当前是空值");
    return;
  }
  for (let i = 0; i < nodes.length; i++) nodes[i].classList.add("flash");
  try { nodes[0].scrollIntoView({ block: "nearest" }); } catch (e) {}
  setTimeout(function () {
    for (let i = 0; i < nodes.length; i++) nodes[i].classList.remove("flash");
  }, 2200);
}

/* 从提示词 / 变量表反查来源：左栏参数 or 顶栏设置 */
function locateSource(key) {
  const meta = varMetaFor(key);
  if (meta.kind === "param") {
    ensurePanelVisible("left");
    if (meta.paramId === "sex") flashEl(document.querySelector(".sex-box"));
    else revealParam(meta.paramId);
  } else if (meta.kind === "canvas") {
    if (meta.target === "stage") flashEl(document.querySelector(".who"));
    else if (meta.target === "sex") flashEl(document.querySelector(".sex-box"));
    else if (meta.target === "size") flashEl(document.getElementById("sizeReadout"));
    else { flashEl(document.getElementById("ratioSeg")); flashEl(document.getElementById("resSeg")); }
  } else if (meta.kind === "meta") {
    if (meta.target === "profile") openProfileModal();
    else if (meta.target === "signature") flashHighlights();
  }
  flashVar(key);
}

function flashHighlights() {
  (state.highlights || []).forEach(function (id) { revealParam(id); });
}

/* 左栏标记的原因说明：先解释「为什么不在提示词里」，再说怎么恢复 */
function offHint(id, snap) {
  snap = snap || buildPromptSnapshot();
  if (isBlockSuppressed(id)) return "本画幅「" + currentTemplate().label + "」的版面停用了这一段；切到其它画幅就会生效";
  const tplVars = (currentTemplate() && currentTemplate().vars) || {};
  if (Object.prototype.hasOwnProperty.call(tplVars, id)) {
    return "本画幅的版面改写覆盖了它：" + tplVars[id] + "（左栏取值只在别的画幅生效）";
  }
  if (snap.empty.indexOf(id) >= 0 || snap.empty.indexOf(id + "Phrase") >= 0) {
    return "它被引用了，但当前取值没有词句（空），所以提示词里不出现文字";
  }
  if (cardOwned(id)) {
    const look = currentLook();
    return "由身份卡「" + (look ? look.label : "") + "」固定；手动掷/改值会让卡片不再覆盖这一项";
  }
  if (eraOn()) {
    const covered = Object.keys(DATA.content || {}).some(function (k) {
      const c = DATA.content[k];
      return c && Array.isArray(c.covers) && c.covers.indexOf(id) >= 0;
    });
    if (covered && String(snap.vars.costume || "")) return "经「着装」段的 {{costume}} 间接写进提示词（当前时代已启用）";
    if (covered) return "时代已启用，但 9 个服饰槽位都是「无」，所以服饰句里没有它";
  }
  const re = new RegExp("\\{\\{" + id + "(Phrase)?\\}\\}");
  const off = state.blocks.find(function (b) { return !b.enabled && re.test(String(b.text)); });
  if (off) return "「" + off.label + "」这一段被停用了；在右侧「提示词编排」里打开就恢复";
  return "当前提示词里没有这一项；可以在右侧「提示词编排」里加一段 {{" + id + "}}";
}

/* 左栏四态：未用 / 空值 / 本画幅改写 / 正常（身份卡固定另加「卡」徽标） */
function updateParamUsage(snap) {
  snap = snap || buildPromptSnapshot();
  const used = snap.used;
  const empty = snap.empty;
  const overrides = (currentTemplate() && currentTemplate().vars) || {};
  document.querySelectorAll("#paramGroups .param").forEach(function (row) {
    const id = row.dataset.id;
    const pp = paramIndex[id];
    const on = (pp && pp.virtual) || used.has(id) || used.has(id + "Phrase");
    const blank = empty.indexOf(id) >= 0 || empty.indexOf(id + "Phrase") >= 0;
    const overridden = Object.prototype.hasOwnProperty.call(overrides, id);
    row.classList.toggle("unused", !on && !blank);
    row.classList.toggle("empty-value", blank);
    row.classList.toggle("overridden", !!overridden);
    const tag = row.querySelector(".param-use");
    if (tag) {
      tag.textContent = blank ? "空" : !on ? "未用" : overridden ? "改写" : "";
      tag.title = (blank || !on || overridden) ? offHint(id, snap) : "";
    }
    row.title = (blank || !on || overridden) ? offHint(id, snap) : "";
  });
  const sexOn = used.has("sexPhrase") || used.has("sexLabel") || used.has("underTop");
  const sp = document.querySelector(".sex-phrase");
  if (sp) {
    sp.classList.toggle("unused", !sexOn);
    const t = sp.querySelector(".param-use");
    if (t) t.textContent = sexOn ? "" : "未用";
  }
}

/* 内容块里的「变量 chips + 解析预览」 */
function renderBlockMeta(card, b, vars) {
  const chipHost = card.querySelector(".block-vars");
  const parsed = card.querySelector(".block-parsed");
  const head = card.querySelector(".block-vcount");
  if (!chipHost || !parsed) return;
  vars = vars || buildVars();
  const keys = [];
  String(b.text).replace(/\{\{(\w+)\}\}/g, function (m, k) {
    if (keys.indexOf(k) < 0) keys.push(k);
    return m;
  });
  const emptyKeys = keys.filter(function (k) { return Object.prototype.hasOwnProperty.call(vars, k) && String(vars[k]) === ""; });
  const unknownKeys = keys.filter(function (k) { return !Object.prototype.hasOwnProperty.call(vars, k); });
  if (head) {
    head.textContent = keys.length
      ? keys.length + " 变量" + (emptyKeys.length ? " · 空 " + emptyKeys.length : "") + (unknownKeys.length ? " · 未知 " + unknownKeys.length : "")
      : "无变量";
    head.title = keys.length ? keys.map(function (k) { return "{{" + k + "}}"; }).join(" ") : "这一段是固定文字";
  }
  chipHost.textContent = "";
  if (!keys.length) {
    chipHost.appendChild(el("span", "var-note", "固定文字，没有变量"));
  }
  keys.forEach(function (k) {
    const meta = varMetaFor(k);
    const val = vars[k];
    const blank = val != null && String(val) === "";
    const chip = el("button", "vchip" + (val == null ? " unknown" : blank ? " empty" : ""), "{{" + k + "}}");
    chip.dataset.var = k;
    if (val != null && !blank) chip.appendChild(el("b", null, shortVal(val, 14)));
    chip.title = "{{" + k + "}}\n" + meta.label + " · 来源：" + meta.source + "\n当前值：" + (val == null ? "（未定义）" : blank ? "（空，不输出文字）" : val) + "\n点击定位来源";
    chip.addEventListener("click", function (e) {
      e.stopPropagation();
      locateSource(k);
    });
    chip.addEventListener("mouseenter", function () {
      highlightVars([k], true);
      if (meta.paramId) highlightParamRow(meta.paramId, true);
    });
    chip.addEventListener("mouseleave", function () {
      highlightVars([k], false);
      if (meta.paramId) highlightParamRow(meta.paramId, false);
    });
    chipHost.appendChild(chip);
  });
  parsed.classList.toggle("off", !b.enabled);
  parsed.innerHTML = '<div class="block-parsed-head"><span>解析预览 · 鼠标悬停看变量来源，点击高亮词定位</span><span>' + (b.enabled ? "已启用" : "已停用") + "</span></div>" + renderTemplateHTML(String(b.text), vars, { mode: "exact" });
}

function varRowEl(r) {
  const row = el("div", "var-row" + (r.used ? "" : " unused") + (r.meta.kind === "unknown" ? " unknown" : ""));
  row.dataset.key = r.key;
  row.appendChild(el("code", null, "{{" + r.key + "}}"));
  row.appendChild(el("span", "var-value", r.value === "" ? "（空）" : shortVal(r.value, 40)));
  row.appendChild(el("span", "var-source", r.meta.label && r.meta.label !== r.key ? r.meta.label : ""));
  row.appendChild(el("span", "var-usage", r.blocks.length ? r.blocks.slice(0, 2).join(" / ") + (r.blocks.length > 2 ? " …" : "") : (r.used ? "" : "未使用")));
  const copy = el("button", "var-copy", "⧉");
  copy.title = "复制 {{" + r.key + "}} 到剪贴板";
  copy.addEventListener("click", function (e) {
    e.stopPropagation();
    if (navigator.clipboard) navigator.clipboard.writeText("{{" + r.key + "}}");
    toast("已复制 {{" + r.key + "}}");
  });
  row.appendChild(copy);
  row.title = "{{" + r.key + "}}\n" + r.meta.label + "\n来源：" + r.meta.source + (r.blocks.length ? "\n用于：" + r.blocks.join(" / ") : "\n当前提示词未使用") + "\n点击定位";
  row.addEventListener("click", function () {
    document.getElementById("varModal").classList.remove("on");
    locateSource(r.key);
  });
  return row;
}

let varScope = "used";
let varQuery = "";

function renderVarTable() {
  const host = document.getElementById("varList");
  if (!host) return;
  host.textContent = "";
  const all = buildVarRows();
  const rows = all.filter(function (r) {
    if (varScope === "used" && !r.used) return false;
    if (!varQuery) return true;
    const q = varQuery.toLowerCase();
    return (r.key + " " + r.value + " " + r.meta.label + " " + r.meta.source).toLowerCase().indexOf(q) >= 0;
  });
  const tabs = document.getElementById("varTabs");
  if (tabs) {
    tabs.querySelectorAll("[data-scope]").forEach(function (b) {
      b.classList.toggle("on", b.dataset.scope === varScope);
      b.textContent = b.dataset.scope === "used" ? "当前提示词用到的（" + all.filter(function (r) { return r.used; }).length + "）" : "全部变量（" + all.length + "）";
    });
  }
  if (!rows.length) {
    host.appendChild(el("p", "var-note", varQuery ? "没有匹配的变量" : "当前提示词还没有用到变量"));
    return;
  }
  const groups = {};
  rows.forEach(function (r) {
    const g = r.meta.group || "其他";
    (groups[g] = groups[g] || []).push(r);
  });
  varGroupOrder().forEach(function (g) {
    const list = groups[g];
    if (!list) return;
    list.sort(function (a, b) { return (b.used ? 1 : 0) - (a.used ? 1 : 0); });
    const gh = el("div", "var-group", g);
    gh.appendChild(el("span", null, list.length + " 个"));
    host.appendChild(gh);
    list.forEach(function (r) { host.appendChild(varRowEl(r)); });
  });
}

function openVarTable() {
  varScope = "used";
  varQuery = "";
  const search = document.getElementById("varSearch");
  if (search) search.value = "";
  renderVarTable();
  document.getElementById("varModal").classList.add("on");
}

/* 通用确认框（Promise） */
let confirmResolver = null;
function askConfirm(opts) {
  return new Promise(function (resolve) {
    if (confirmResolver) confirmResolver(false);
    confirmResolver = resolve;
    document.getElementById("confirmTitle").textContent = opts.title || "确认操作";
    document.getElementById("confirmNote").textContent = opts.note || "";
    const ok = document.getElementById("confirmOk");
    ok.textContent = opts.okText || "确定";
    ok.className = "btn " + (opts.danger ? "danger-solid" : "primary");
    document.getElementById("confirmModal").classList.add("on");
  });
}
function closeConfirm(value) {
  document.getElementById("confirmModal").classList.remove("on");
  const r = confirmResolver;
  confirmResolver = null;
  if (r) r(value);
}



/* ---------- size ---------- */
function currentRatio() {
  return RATIOS.find(function (r) { return r.id === state.ratio; }) || RATIOS[0];
}
function sizeString() {
  const s = currentRatio().sizes[state.res] || currentRatio().sizes["2K"];
  return s[0] + "x" + s[1];
}
function aspectText() {
  const s = currentRatio().sizes[state.res] || currentRatio().sizes["2K"];
  const dir = s[0] > s[1] ? " 横版" : s[0] < s[1] ? " 竖版" : " 方形";
  return state.ratio + dir;
}
function renderSizeControls() {
  const rs = $("#ratioSeg");
  if (rs) {
    rs.textContent = "";
    RATIOS.forEach(function (r) {
      const allowed = ratioAllowed(r.id);
      const b = el("button", "chip" + (state.ratio === r.id ? " on" : "") + (allowed ? "" : " off"), r.label);
      b.disabled = !allowed;
      b.dataset.ratio = r.id;
      if (!allowed) {
        const o = templateOrient();
        b.title = "「" + currentTemplate().label + "」的版面是" + (o === "landscape" ? "横版（左右并排）" : o === "square" ? "方形（3×3 矩阵）" : "竖版") + "的，不能配 " + r.label + " 画布";
      }
      b.addEventListener("click", function () {
        if (!ratioAllowed(r.id)) { toast("「" + currentTemplate().label + "」的版面与 " + r.label + " 画布方向不符"); return; }
        state.ratio = r.id;
        saveState();
        renderSizeControls();
        updatePromptPreview();
      });
      rs.appendChild(b);
    });
  }
  const es = $("#resSeg");
  if (es) {
    es.textContent = "";
    RES_LIST.forEach(function (k) {
      const b = el("button", "chip" + (state.res === k ? " on" : ""), k);
      b.addEventListener("click", function () {
        state.res = k;
        saveState();
        renderSizeControls();
        updatePromptPreview();
      });
      es.appendChild(b);
    });
  }
  const ro = $("#sizeReadout");
  if (ro) ro.textContent = sizeString().replace("x", " × ");
}

/* ---------- params UI ---------- */
function renderSexSelector(host, used) {
  used = used || usedVarKeys();
  const box = el("div", "sex-box");
  const top = el("div", "sex-top");
  top.appendChild(el("span", "sex-title", "性别"));
  top.appendChild(el("span", "sex-note", sexMeta().desc || ""));

  const tools = el("div", "param-tools sex-tools");
  const dice = el("button", "mini", "掷");
  dice.title = "随机换一个性别";
  dice.addEventListener("click", function () {
    const opts = paramIndex.sex.options;
    const others = opts.filter(function (o) { return o.value !== state.params.sex; });
    const next = others[Math.floor(Math.random() * others.length)];
    if (next) setSex(next.value);
  });
  const lock = el("button", "mini", "锁");
  lock.title = "锁定后「随机人物」不会改变性别";
  if (state.locks.has("sex")) lock.classList.add("on");
  lock.addEventListener("click", function () {
    if (state.locks.has("sex")) state.locks.delete("sex");
    else state.locks.add("sex");
    saveState();
    renderParams();
  });
  tools.appendChild(dice);
  tools.appendChild(lock);
  top.appendChild(tools);

  box.appendChild(top);
  const seg = el("div", "sex-seg");
  paramIndex.sex.options.forEach(function (o) {
    const b = el("button", "sex-btn" + (currentSex() === o.value ? " on" : ""), o.label);
    b.title = o.desc || "";
    b.addEventListener("click", function () { setSex(o.value); });
    seg.appendChild(b);
  });
  box.appendChild(seg);

  const sexOn = used.has("sexPhrase") || used.has("sexLabel") || used.has("underTop");
  const sp = el("div", "sex-phrase" + (sexOn ? "" : " unused"));
  sp.appendChild(el("span", "phrase-text", "→ 性别词句：" + (sexMeta().phrase || sexMeta().label)));
  sp.appendChild(el("span", "param-use", sexOn ? "" : "未用"));
  sp.title = "{{sexPhrase}} 会写进提示词；点击在右侧提示词里定位";
  sp.addEventListener("click", function () { locateSource("sexPhrase"); });
  box.appendChild(sp);
  box.addEventListener("mouseenter", function () { highlightVars(["sexPhrase", "sexLabel", "underTop"], true); });
  box.addEventListener("mouseleave", function () { highlightVars(["sexPhrase", "sexLabel", "underTop"], false); });

  host.appendChild(box);
}

function paramMatches(p, q) {
  if (!q) return true;
  const hay = [p.id, p.label, p.note || "", p.impact || "", phraseForParam(p)];
  (p.options || []).forEach(function (o) { hay.push(o.label, o.phrase || "", o.desc || ""); });
  return hay.join(" ").toLowerCase().indexOf(q) >= 0;
}

function paramPassesFilter(p, used) {
  /* 搜索时跨层：命中优先，不被「核心/进阶」挡掉（否则搜「眼」只出来 6 项） */
  if (!state.paramQuery) {
    const tier = state.tierFilter;
    if (tier === "core" && p.tier !== "core") return false;
    if (tier === "advanced" && p.tier !== "advanced") return false;
    if (tier === "unused" && (used.has(p.id) || used.has(p.id + "Phrase"))) return false;
  }
  return paramMatches(p, state.paramQuery.toLowerCase());
}

function toggleGroup(id) {
  const i = state.collapsedGroups.indexOf(id);
  if (i >= 0) state.collapsedGroups.splice(i, 1);
  else state.collapsedGroups.push(id);
  saveState();
  renderParams();
}

function renderParamToolbar() {
  const search = $("#paramSearch");
  if (search && document.activeElement !== search && search.value !== state.paramQuery) search.value = state.paramQuery;
  const filters = $("#paramFilters");
  if (filters) {
    filters.querySelectorAll("[data-tier]").forEach(function (b) {
      b.classList.toggle("on", b.dataset.tier === state.tierFilter);
    });
  }
  const preset = $("#presetSeg");
  if (preset) {
    preset.querySelectorAll("[data-preset]").forEach(function (b) {
      b.classList.toggle("on", b.dataset.preset === state.detailPreset);
    });
  }
  const dens = $("#densitySeg");
  if (dens) {
    dens.querySelectorAll("[data-density]").forEach(function (b) {
      b.classList.toggle("on", (state.viewDensity === "full" ? "full" : "summary") === b.dataset.density);
    });
  }
  updateHealthBadge();
}

function renderProfileCard() {
  const host = $("#profileCard");
  if (!host) return;
  host.textContent = "";
  const m = state.meta || {};
  const card = el("div", "profile-card-inner");
  const name = el("strong", "profile-name", m.name || "未命名");
  card.appendChild(name);
  const meta = el("span", "profile-meta");
  const parts = [];
  if (m.identity) parts.push(m.identity);
  if (m.personality) parts.push(m.personality);
  if (state.params.age) parts.push(state.params.age + " 岁");
  if (state.params.height) parts.push(state.params.height + " cm");
  meta.textContent = parts.join(" · ");
  card.appendChild(meta);
  const kw = el("span", "profile-keywords", (m.styleKeywords || []).join(" / "));
  card.appendChild(kw);
  const edit = el("span", "profile-edit", "编辑");
  card.appendChild(edit);
  card.title = "点击编辑人物档案：姓名 / 身份 / 性格 / 标签 / 简介 / 风格关键词";
  card.addEventListener("click", openProfileModal);
  host.appendChild(card);
}

/* ---------- P0 · 左栏渐进披露（摘要行 / 懒渲染 / 值浮层） ---------- */

function paramValueText(p) {
  if (!p) return "";
  const v = state.params[p.id];
  if (p.type === "choice" || p.type === "sex") {
    const o = (p.options || []).find(function (x) { return x.value === v; });
    return o ? o.label : String(v == null ? "" : v);
  }
  return String(v) + (p.unit || "");
}

function isParamOpen(id) {
  return (state.openParams || []).indexOf(id) >= 0;
}

function paramGroupOf(id) {
  const g = DATA.params.groups.find(function (grp) {
    return grp.params.some(function (x) { return x.id === id; });
  });
  return g ? g.id : "";
}

function paramFlags(p) {
  const box = el("span", "param-flags");
  if ((state.highlights || []).indexOf(p.id) >= 0) box.appendChild(el("span", "pf-star", "★"));
  if (state.locks.has(p.id)) {
    const lock = el("span", "pf-lock", "锁");
    if (cardOwned(p.id)) lock.title = "身份卡优先：手动换卡时会按卡片改它；随机人物会保留锁值";
    box.appendChild(lock);
  }
  if (cardOwned(p.id)) {
    const look = currentLook();
    const card = el("span", "pf-card", "卡");
    card.title = "由身份卡「" + (look ? look.label : "") + "」固定";
    box.appendChild(card);
  }
  return box;
}

function buildParamMain(p) {
  const main = el("div", "param-main");
  const name = el("span", "param-name");
  name.appendChild(document.createTextNode(p.label));
  name.title = (p.note || "") + (p.impact ? "\n" + p.impact : "") + "\n点击展开 / 收起";
  main.appendChild(name);
  const val = el("button", "param-value");
  val.type = "button";
  val.textContent = paramValueText(p);
  val.title = "点击选值（1 次点击完成改值）";
  val.addEventListener("click", function (e) { e.stopPropagation(); openParamPop(p.id, val); });
  main.appendChild(val);
  main.appendChild(paramFlags(p));
  main.addEventListener("click", function () { toggleParamOpen(p.id); });
  return main;
}

function buildPhraseLine(p) {
  const used = usedVarKeys();
  const on = used.has(p.id) || used.has(p.id + "Phrase");
  const ph = el("div", "param-phrase" + (on ? "" : " unused"));
  ph.dataset.var = p.id;
  ph.appendChild(el("span", "phrase-text", "→ " + phraseForParam(p)));
  ph.appendChild(el("span", "param-use", on ? "" : "未用"));
  ph.title = "会写进提示词的词句；点击可在右侧提示词里定位";
  ph.addEventListener("click", function (e) { e.stopPropagation(); locateSource(p.id); });
  return ph;
}

function buildParamBody(p) {
  const body = el("div", "param-body");
  const head = el("div", "param-head");
  const varTag = el("span", "param-var", "{{" + p.id + "}}");
  varTag.title = "点击查看参数详情：" + p.label;
  varTag.addEventListener("click", function (e) { e.stopPropagation(); openParamDetail(p.id); });
  head.appendChild(varTag);
  const tools = el("div", "param-tools");
  const starred = (state.highlights || []).indexOf(p.id) >= 0;
  const star = el("button", "mini star" + (starred ? " on" : ""), starred ? "★" : "☆");
  star.title = "设为记忆点（最多 3 个）";
  star.addEventListener("click", function (e) { e.stopPropagation(); toggleHighlight(p.id); });
  const dice = el("button", "mini", "掷");
  dice.title = "单独重掷这一项";
  dice.addEventListener("click", function (e) { e.stopPropagation(); rollOne(p.id); });
  const lock = el("button", "mini" + (state.locks.has(p.id) ? " on" : ""), "锁");
  lock.title = "锁定后「随机人物」不会改动";
  lock.addEventListener("click", function (e) {
    e.stopPropagation();
    if (state.locks.has(p.id)) state.locks.delete(p.id); else state.locks.add(p.id);
    saveState();
    renderParams();
  });
  const info = el("button", "mini", "说明");
  info.title = "参数说明、可用性别、用在哪些段";
  info.addEventListener("click", function (e) { e.stopPropagation(); openParamDetail(p.id); });
  tools.appendChild(star);
  tools.appendChild(dice);
  tools.appendChild(lock);
  tools.appendChild(info);
  head.appendChild(tools);
  body.appendChild(head);
  body.appendChild(p.type === "choice" ? renderChoice(p) : renderNumber(p));
  body.appendChild(buildPhraseLine(p));
  return body;
}

function toggleParamOpen(id) {
  const p = paramIndex[id];
  if (!p) return;
  const row = document.querySelector('#paramGroups .param[data-id="' + id + '"]');
  if (!row) return;
  if (isParamOpen(id)) {
    const i = state.openParams.indexOf(id);
    if (i >= 0) state.openParams.splice(i, 1);
    const old = row.querySelector(".param-body");
    if (old) old.remove();
    row.classList.remove("expanded");
  } else {
    const arr = state.openParams || (state.openParams = []);
    if (arr.length >= 12) {
      const drop = arr.shift();
      const other = document.querySelector('#paramGroups .param[data-id="' + drop + '"]');
      if (other) { const b = other.querySelector(".param-body"); if (b) b.remove(); other.classList.remove("expanded"); }
    }
    arr.push(id);
    row.classList.add("expanded");
    row.appendChild(buildParamBody(p));
  }
  saveState();
}

let paramPopEl = null;
function closeParamPop() {
  if (paramPopEl) { paramPopEl.remove(); paramPopEl = null; }
}
function openParamPop(id, anchor) {
  closeParamPop();
  const p = paramIndex[id];
  if (!p || !anchor) return;
  const pop = el("div", "param-pop");
  pop.appendChild(el("div", "param-pop-head", p.label));
  const list = el("div", "param-pop-list");
  if (p.type === "choice" || p.type === "sex") {
    (p.options || []).forEach(function (o) {
      const on = state.params[id] === o.value;
      const b = el("button", "param-pop-opt" + (on ? " on" : ""));
      b.type = "button";
      b.textContent = o.label;
      const allowed = weightOf(o, currentSex()) > 0;
      if (!allowed) { b.classList.add("off"); b.disabled = true; }
      b.title = (o.desc ? o.label + "：" + o.desc : (o.phrase || o.label));
      b.addEventListener("click", function () {
        if (!allowed) return;
        setParamValue(id, o.value);
        closeParamPop();
      });
      list.appendChild(b);
    });
  } else {
    const r = sexRange(p, currentSex());
    const wrap = el("div", "param-pop-range");
    const input = document.createElement("input");
    input.type = "range";
    input.min = r[0]; input.max = r[1]; input.step = p.step || 1;
    input.value = state.params[id];
    const out = el("span", "range-val", String(state.params[id]) + (p.unit || ""));
    input.addEventListener("input", function () {
      state.params[id] = Number(input.value);
      out.textContent = String(input.value) + (p.unit || "");
      updateValueChip(id);
      syncStage();
      updatePromptPreview();
    });
    input.addEventListener("change", function () {
      applyCorrelations(mulberry32((state.seed + 13) >>> 0));
      saveState();
    });
    wrap.appendChild(input); wrap.appendChild(out);
    list.appendChild(wrap);
  }
  pop.appendChild(list);
  const actions = el("div", "param-pop-actions");
  const roll = el("button", "mini", "掷");
  roll.type = "button";
  roll.title = "单独重掷这一项";
  roll.addEventListener("click", function () { rollOne(id); closeParamPop(); });
  const lock = el("button", "mini" + (state.locks.has(id) ? " on" : ""), "锁");
  lock.type = "button";
  lock.title = "锁定后「随机人物」不会改动";
  lock.addEventListener("click", function () {
    if (state.locks.has(id)) state.locks.delete(id); else state.locks.add(id);
    saveState();
    renderParams();
  });
  const info = el("button", "mini", "说明");
  info.type = "button";
  info.addEventListener("click", function () { closeParamPop(); openParamDetail(id); });
  actions.appendChild(roll);
  actions.appendChild(lock);
  actions.appendChild(info);
  pop.appendChild(actions);
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left - 8));
  let top = rect.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  paramPopEl = pop;
  setTimeout(function () {
    document.addEventListener("mousedown", function onDoc(e) {
      if (!paramPopEl) { document.removeEventListener("mousedown", onDoc); return; }
      if (paramPopEl.contains(e.target)) return;
      closeParamPop();
      document.removeEventListener("mousedown", onDoc);
    });
  }, 0);
}

function updateValueChip(id) {
  const row = document.querySelector('#paramGroups .param[data-id="' + id + '"]');
  if (!row) return;
  const chip = row.querySelector(".param-value");
  const p = paramIndex[id];
  if (chip && p) chip.textContent = paramValueText(p);
}

function setParamValue(id, value) {
  const p = paramIndex[id];
  if (!p) return;
  if (id === "sex") { setSex(value); return; }
  if (p.type === "number") value = Number(value);
  state.params[id] = value;
  if (!p.virtual && paramGroupOf(id) !== "costume") {
    state.manualOverrides = state.manualOverrides || {};
    state.manualOverrides[id] = true;
  }
  /* 手动改卡片管辖的参数：记成已自定义，卡片不再覆盖它 */
  if (Object.prototype.hasOwnProperty.call(cardOverrides(), id)) {
    state.lookCustomized = state.lookCustomized || {};
    state.lookCustomized[id] = true;
  }
  commitParams({ reason: "set", changed: id });
}

function revealParam(id) {
  const p = paramIndex[id];
  if (!p) return;
  ensurePanelVisible("left");
  state.paramQuery = "";
  state.tierFilter = "all";
  const inp = $("#paramSearch");
  if (inp) inp.value = "";
  const gi = DATA.params.groups.find(function (g) { return g.params.some(function (x) { return x.id === id; }); });
  if (gi) {
    const ci = state.collapsedGroups.indexOf(gi.id);
    if (ci >= 0) { state.collapsedGroups.splice(ci, 1); saveState(); }
  }
  renderParams();
  const row = document.querySelector('#paramGroups .param[data-id="' + id + '"]');
  if (!row) { toast("「" + p.label + "」在当前筛选下不可见，已切回全部"); return; }
  if (state.viewDensity !== "full" && !isParamOpen(id)) toggleParamOpen(id);
  flashEl(row);
  try { row.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
}

function renderParams() {
  const host = $("#paramGroups");
  host.textContent = "";
  const panel = host.closest(".param-panel");
  if (panel) {
    panel.classList.toggle("phrases-on", state.showPhrases);
    panel.classList.toggle("density-full", state.viewDensity === "full");
  }
  const used = usedVarKeys();
  const tgl = $("#togglePhrases");
  if (tgl) tgl.classList.toggle("on", state.showPhrases);
  renderParamToolbar();
  renderProfileCard();
  renderSexSelector(host, used);
  const full = state.viewDensity === "full";
  const searching = !!state.paramQuery;
  let visible = 0;
  DATA.params.groups.forEach(function (g) {
    /* 服饰组：有时代时正常渲染；素体态显示一行提示（否则用户发现不了这个功能） */
    const hidden = !!(g.ctx && g.ctx.indexOf(state.params.era) < 0);
    if (hidden && g.id !== "costume") return;
    const items = g.params.filter(function (p) { return p.id !== "sex" && paramPassesFilter(p, used); });
    if (!items.length && !hidden) return;
    visible += Math.max(items.length, 1);
    const collapsed = !full && !searching && state.collapsedGroups.indexOf(g.id) >= 0;
    const wrap = el("section", "group" + (collapsed ? " collapsed" : ""));
    const head = el("div", "group-head");
    head.appendChild(el("span", "group-chevron", collapsed ? "▸" : "▾"));
    if (g.layer) head.appendChild(el("span", "layer-tag", g.layer));
    head.appendChild(el("span", "group-title", g.label));
    if (g.hint) head.appendChild(el("span", "group-hint", g.hint));
    head.appendChild(el("span", searching && !hidden ? "group-hit" : "group-count",
      hidden ? "素体" : (searching ? items.length + " 项命中" : items.length + " 项")));
    head.title = collapsed ? "展开「" + g.label + "」" : "收起「" + g.label + "」";
    head.addEventListener("click", function () { toggleGroup(g.id); });
    wrap.appendChild(head);

    if (hidden && g.id === "costume") {
      const tip = el("div", "costume-hint");
      tip.appendChild(el("p", null, "当前是素体模式。选择清·盛清或清·晚清，使用服饰槽位与分级身份卡。"));
      const go = el("button", "text-btn", "选时代 ›");
      go.type = "button";
      go.addEventListener("click", function (e) { e.stopPropagation(); revealParam("era"); });
      tip.appendChild(go);
      wrap.appendChild(tip);
    }
    /* 身份卡：服饰组展开时显示；折叠时和 9 个槽位一起收起 */
    if (g.id === "costume" && !hidden) {
      const looks = ((DATA.eras && DATA.eras.looks) || []).filter(function (look) { return look.era === state.params.era; });
      if (looks.length) {
        const filter = el("div", "look-filters");
        [["all", "全部"], ["documented", "典制"], ["realistic", "写实"], ["interpretation", "演绎"]].forEach(function (entry) {
          const button = el("button", "chip" + ((state.evidenceFilter || "all") === entry[0] ? " on" : ""), entry[1]);
          button.type = "button";
          button.addEventListener("click", function (event) { event.stopPropagation(); state.evidenceFilter = entry[0]; syncAll(); });
          filter.appendChild(button);
        });
        wrap.appendChild(filter);
        const evidence = currentLookEvidence();
        if (evidence) {
          const summary = el("details", "look-evidence-summary");
          summary.appendChild(el("summary", null, evidence.level + (evidence.modified ? " · 自定义组合" : " · 来源与限制")));
          summary.appendChild(el("p", null, evidence.note));
          evidence.refs.forEach(function (ref) {
            const source = ((DATA.eras || {}).sources || {})[ref];
            const label = ref + " · " + (source ? source.title : ((DATA.eras || {}).refs || {})[ref] || "待核");
            if (source && /^https:\/\//.test(source.url)) {
              const a = el("a", null, label); a.href = source.url; a.target = "_blank"; a.rel = "noopener noreferrer"; summary.appendChild(a);
            } else summary.appendChild(el("p", null, label));
          });
          wrap.appendChild(summary);
        }
        const grid = el("div", "look-grid");
        looks.forEach(function (lk) {
          if (state.evidenceFilter && state.evidenceFilter !== "all" && ((lk.evidence || {}).mode || "documented") !== state.evidenceFilter) return;
          const b = el("button", "look-card");
          b.appendChild(el("span", "look-card-label", lk.label));
          b.appendChild(el("span", "look-card-evidence", (lk.evidence && lk.evidence.level) || lk.confidence || "未分级"));
          b.type = "button";
          b.title = "套用这张身份卡（套完还能手改任意槽位）。" + lookEvidenceText(lk);
          b.addEventListener("click", function (e) { e.stopPropagation(); applyLookPreset(lk.id); });
          grid.appendChild(b);
        });
        wrap.appendChild(grid);
      }
    }

    const body = el("div", "group-body");
    items.forEach(function (p) {
      const row = el("div", "param");
      row.dataset.id = p.id;
      if (p.tier) row.dataset.tier = p.tier;
      if (state.locks.has(p.id)) row.classList.add("locked");
      if ((state.highlights || []).indexOf(p.id) >= 0) row.classList.add("highlighted");
      const isUsed = p.virtual || used.has(p.id) || used.has(p.id + "Phrase");
      if (!isUsed) row.classList.add("unused");
      row.appendChild(buildParamMain(p));
      if (full || isParamOpen(p.id)) {
        row.classList.add("expanded");
        row.appendChild(buildParamBody(p));
      } else if (state.showPhrases) {
        row.appendChild(buildPhraseLine(p));
      }
      row.addEventListener("mouseenter", function () { highlightVars([p.id, p.id + "Phrase"], true); });
      row.addEventListener("mouseleave", function () { highlightVars([p.id, p.id + "Phrase"], false); });
      body.appendChild(row);
    });
    wrap.appendChild(body);
    host.appendChild(wrap);
  });
  if (!visible) {
    host.appendChild(el("p", "param-empty", state.paramQuery ? "没有匹配「" + state.paramQuery + "」的参数" : "没有符合筛选条件的参数"));
  }
  updateHealthBadge();
}

function renderChoice(p) {
  const seg = el("div", "seg");
  const sex = currentSex();
  p.options.forEach(function (o) {
    const allowed = weightOf(o, sex) > 0;
    const b = el("button", null, o.label);
    b.dataset.on = state.params[p.id] === o.value ? "1" : "0";
    const tip = o.desc ? o.label + "：" + o.desc : (o.phrase || o.label);
    if (!allowed) {
      const sexOk = !!o.w && (o.w[sex] || 0) > 0;
      b.classList.add("off");
      b.disabled = true;
      b.title = (sexOk ? "当前时代 / 身份下不适用" : "当前性别下不适用") + (o.desc ? "\n" + o.label + "：" + o.desc : "");
    } else {
      b.title = tip;
      b.addEventListener("click", function () {
        setParamValue(p.id, o.value);
      });
    }
    seg.appendChild(b);
  });
  return seg;
}

function renderNumber(p) {
  const row = el("div", "range-row");
  const input = document.createElement("input");
  const r = sexRange(p, currentSex());
  input.type = "range";
  input.min = r[0]; input.max = r[1]; input.step = p.step || 1;
  input.value = state.params[p.id];
  const val = el("span", "range-val", String(state.params[p.id]) + (p.unit || ""));
  input.addEventListener("input", function () {
    state.params[p.id] = Number(input.value);
    val.textContent = String(input.value) + (p.unit || "");
    const row = input.closest(".param");
    if (row) {
      const ph = row.querySelector(".phrase-text");
      if (ph) ph.textContent = "→ " + phraseForParam(p);
    }
    syncStage();
    updatePromptPreview();
  });
  input.addEventListener("change", function () { saveState(); });
  row.appendChild(input);
  row.appendChild(val);
  return row;
}

/* ---------- 参数详情 / 词典 / 档案 / 记忆点 / 体检 ---------- */
function toggleHighlight(id) {
  const p = paramIndex[id];
  if (!p || p.type !== "choice") { toast("只有选项型参数可以做记忆点"); return; }
  const i = (state.highlights || []).indexOf(id);
  if (i >= 0) {
    state.highlights.splice(i, 1);
  } else {
    if (state.highlights.length >= 3) { toast("最多选 3 个记忆点；先取消一个再选"); return; }
    state.highlights.push(id);
  }
  saveState();
  renderParams();
  updatePromptPreview();
}

function markDetailCustom() {
  if (state.detailPreset === "custom") return;
  state.detailPreset = "custom";
  saveState();
  renderParamToolbar();
}

const DETAIL_PRESETS = {
  simple: { detailFace: false, detailBody: false, profile: false, signature: false },
  standard: { detailFace: false, detailBody: false, profile: true, signature: true },
  detailed: { detailFace: true, detailBody: true, profile: true, signature: true }
};

function applyDetailPresetFlags(level) {
  const map = DETAIL_PRESETS[level];
  if (!map) return;
  state.blocks.forEach(function (b) {
    if (Object.prototype.hasOwnProperty.call(map, b.id)) b.enabled = map[b.id];
  });
}

function applyDetailPreset(level) {
  const map = DETAIL_PRESETS[level];
  if (!map) return;
  state.detailPreset = level;
  applyDetailPresetFlags(level);
  persistBlocks();
  renderBlocks();
  renderParams();
  updatePromptPreview();
  toast(level === "detailed" ? "已切到详细档：面部进阶 + 体表与毛发进阶已打开" : level === "standard" ? "已切到标准档：只保留人物档案与记忆点" : "已切到简洁档：进阶段全部关闭");
}

function locateParam(id) {
  revealParam(id);
}

function openParamDetail(id) {
  const p = paramIndex[id];
  if (!p) return;
  const sex = currentSex();
  const label = { male: "男", female: "女", neutral: "中性" };
  const vars = buildVars();
  const currentPhrase = phraseForParam(p);
  let usage = [];
  const tplVars = (currentTemplate() && currentTemplate().vars) || {};
  const overridden = Object.prototype.hasOwnProperty.call(tplVars, p.id);
  state.blocks.forEach(function (b) {
    const re = new RegExp("\\{\\{" + p.id + "(Phrase)?\\}\\}");
    if (!re.test(String(b.text))) return;
    if (isBlockSuppressed(b.id)) return;
    usage.push(b.label + (b.enabled ? "" : "（已停用）") + (overridden ? "（本画幅被版面改写）" : ""));
  });
  if (overridden && !usage.length) usage.push("本画幅的版面 vars 改写了 {{" + p.id + "}}（" + tplVars[p.id] + "）");
  if (p.virtual) usage.push("控制项：不直接进提示词，决定其它参数是否可用");
  if (!usage.length && eraOn()) {
    const isCovered = Object.keys(DATA.content || {}).some(function (k) {
      const c = DATA.content[k];
      return c && Array.isArray(c.covers) && c.covers.indexOf(p.id) >= 0;
    });
    if (isCovered) usage.push("经「着装」段的 {{costume}} 间接写进提示词");
  }
  let html = '<div class="pd-head"><strong>' + escapeHtml(p.label) + '</strong><code>{{' + escapeHtml(p.id) + '}}</code>'
    + (p.tier ? '<span class="tier-badge tier-' + p.tier + '">' + (p.tier === "core" ? "核心" : "进阶") + '</span>' : "")
    + '</div>';
  html += '<p class="pd-phrase">当前词句：' + escapeHtml(currentPhrase || "（空）") + '</p>';
  html += '<div class="pd-note"><b>它管什么</b><p>' + escapeHtml(p.note || "—") + '</p><b>影响画面哪里</b><p>' + escapeHtml(p.impact || "—") + '</p></div>';
  html += '<div class="pd-options"><div class="pd-row pd-row-head"><span>选项</span><span>说明</span><span>可用性别</span></div>';
  (p.options || []).forEach(function (o) {
    const allowed = ["male", "female", "neutral"].filter(function (s) { return weightOf(o, s) > 0; }).map(function (s) { return label[s]; }).join(" / ") || "—";
    const on = state.params[p.id] === o.value;
    const off = weightOf(o, sex) > 0 ? "" : " off";
    html += '<button type="button" class="pd-row' + (on ? " on" : "") + off + '" data-value="' + escapeAttr(o.value) + '"><span>' + escapeHtml(o.label) + '</span><span>'
      + escapeHtml(o.desc || o.phrase || "") + '</span><span>' + escapeHtml(allowed) + '</span></button>';
  });
  html += '</div>';
  html += '<div class="pd-usage"><b>用在哪些段</b><p>' + (usage.length ? usage.map(escapeHtml).join(" / ") : "没有任何内容段引用它（数据待修）") + '</p></div>';
  html += '<div class="modal-actions pd-actions"><button class="btn ghost" id="pdRoll">掷一次</button><button class="btn ghost" id="pdStar">'
    + ((state.highlights || []).indexOf(p.id) >= 0 ? "取消记忆点" : "设为记忆点") + '</button><button class="btn primary" id="pdClose">关闭</button></div>';
  const host = $("#paramDetail");
  if (!host) return;
  host.innerHTML = html;
  $("#paramModal").classList.add("on");
  $("#pdRoll").addEventListener("click", function () { rollOne(p.id); openParamDetail(p.id); });
  $("#pdStar").addEventListener("click", function () { toggleHighlight(p.id); openParamDetail(p.id); });
  $("#pdClose").addEventListener("click", function () { $("#paramModal").classList.remove("on"); });
  /* P0：详情里的选项行可点，直接改值（看说明 → 改值 ≤ 2 次点击，不必关窗） */
  host.querySelectorAll(".pd-row[data-value]").forEach(function (r) {
    r.addEventListener("click", function () {
      if (r.classList.contains("off")) return;
      setParamValue(p.id, r.dataset.value);
      openParamDetail(p.id);
    });
  });
}

let dictScope = "all";
let dictQuery = "";

function renderDict() {
  const host = $("#dictList");
  if (!host) return;
  host.textContent = "";
  const used = usedVarKeys();
  DATA.params.groups.forEach(function (g) {
    const items = g.params.filter(function (p) {
      if (p.id === "sex") return false;
      if (dictScope === "core" && p.tier !== "core") return false;
      if (dictScope === "advanced" && p.tier !== "advanced") return false;
      if (dictQuery && !paramMatches(p, dictQuery.toLowerCase())) return false;
      return true;
    });
    if (!items.length) return;
    const gh = el("div", "var-group", g.label);
    gh.appendChild(el("span", null, items.length + " 项"));
    host.appendChild(gh);
    items.forEach(function (p) {
      const row = el("div", "dict-row");
      const title = el("div", "dict-title");
      title.appendChild(el("strong", null, p.label));
      title.appendChild(el("code", null, "{{" + p.id + "}}"));
      if (p.tier) title.appendChild(el("span", "tier-badge tier-" + p.tier, p.tier === "core" ? "核心" : "进阶"));
      const on = used.has(p.id) || used.has(p.id + "Phrase");
      title.appendChild(el("span", "dict-use" + (on ? "" : " off"), on ? "已用" : "未用"));
      row.appendChild(title);
      row.appendChild(el("p", "dict-note", p.note || "—"));
      row.appendChild(el("p", "dict-phrase", "→ " + (phraseForParam(p) || "（空）")));
      row.addEventListener("click", function () {
        $("#dictModal").classList.remove("on");
        locateParam(p.id);
      });
      host.appendChild(row);
    });
  });
  if (!host.childNodes.length) host.appendChild(el("p", "var-note", "没有匹配的参数"));
}

function openDict() {
  dictScope = "all";
  dictQuery = "";
  const search = $("#dictSearch");
  if (search) search.value = "";
  const tabs = $("#dictTabs");
  if (tabs) tabs.querySelectorAll("[data-scope]").forEach(function (b) { b.classList.toggle("on", b.dataset.scope === "all"); });
  renderDict();
  $("#dictModal").classList.add("on");
}

function collectHealthIssues() {
  const snap = buildPromptSnapshot();
  const issues = {
    conflicts: [],
    cards: [],
    notIntegrated: [],
    offCount: 0,
    unknown: snap.unknown.map(function (u) { return u.key; }),
    len: snap.stats.chars,
    highlights: (state.highlights || []).length
  };
  const rules = (DATA.params.conflictRules || []);
  rules.forEach(function (rule) {
    const ok = Object.keys(rule.when).every(function (id) {
      return (rule.when[id] || []).indexOf(String(state.params[id])) >= 0;
    });
    if (ok) issues.conflicts.push({ id: rule.id, reason: rule.reason, fix: rule.fix, params: Object.keys(rule.when) });
  });
  if (state.params.age < 30 && state.params.faceLines !== "none") {
    issues.conflicts.push({ id: "young-face-lines", reason: "30 岁以下配明显面部纹路，年龄感会打架。", fix: { faceLines: "none" }, params: ["faceLines"] });
  }
  if (state.params.headBodyRatio === "eight_half" && state.params.height < 160) {
    issues.conflicts.push({ id: "short-tall-ratio", reason: "8.5 头身配 160cm 以下，比例会显得失真。", fix: null, params: ["headBodyRatio", "height"] });
  }
  /* 联动被锁/身份卡挡下的调整：进冲突区，给出「解锁/改派生源」的语义 */
  (state.derivedConflicts || []).forEach(function (c) {
    const p = paramIndex[c.id];
    issues.conflicts.push({
      id: "derived-" + c.id,
      reason: "「" + (p ? p.label : c.id) + "」本应随" + c.reason + "调成「" + c.wanted + "」，但被锁或身份卡挡住了。",
      fix: null,
      params: [c.id]
    });
  });
  state.locks.forEach(function (id) {
    if (!cardOwned(id)) return;
    const look = currentLook();
    const p = paramIndex[id];
    issues.cards.push({
      id: "card-lock-" + id,
      reason: "「" + (p ? p.label : id) + "」的锁会被身份卡「" + (look ? look.label : "") + "」覆盖：手动换卡时按卡片改；随机人物会保留锁值。",
      fix: { unlock: [id] },
      params: [id]
    });
  });
  const used = snap.used;
  const covered = new Set();
  if (state.params.era && state.params.era !== "none" && String(snap.vars.costume || "")) {
    state.blocks.forEach(function (b) {
      if (!b.enabled || isBlockSuppressed(b.id)) return;
      const c = DATA.content && DATA.content[b.id];
      if (c && Array.isArray(c.covers)) c.covers.forEach(function (k) { covered.add(k); });
    });
  }
  DATA.params.groups.forEach(function (g) {
    if (g.ctx && g.ctx.indexOf(state.params.era) < 0) return;
    g.params.forEach(function (p) {
      if (p.id === "sex" || p.virtual) return;
      const re = new RegExp("\\{\\{" + p.id + "(Phrase)?\\}\\}");
      const inAny = state.blocks.some(function (b) { return re.test(String(b.text)); }) || covered.has(p.id);
      if (!inAny) issues.notIntegrated.push(p.id);
      else if (!used.has(p.id) && !used.has(p.id + "Phrase") && !covered.has(p.id)) issues.offCount++;
    });
  });
  return issues;
}

function updateHealthBadge() {
  const badge = $("#healthBadge");
  if (!badge) return;
  let n = 0;
  try {
    const issues = collectHealthIssues();
    const hb = budgetFor(templateOrient());
    n = issues.conflicts.length + issues.notIntegrated.length + issues.unknown.length + (issues.len > hb ? 1 : 0);
  } catch (e) { n = 0; }
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

function applyHealthFix(fix) {
  if (!fix) return;
  if (Array.isArray(fix.unlock)) fix.unlock.forEach(function (id) { state.locks.delete(id); });
  Object.keys(fix).forEach(function (id) {
    if (id === "unlock") return;
    if (paramIndex[id]) state.params[id] = fix[id];
  });
  commitParams({ reason: "healthFix" });
  openHealth();
  toast("已按建议修正；不满意可以再改回来");
}

function openHealth() {
  const host = $("#healthBody");
  if (!host) return;
  const issues = collectHealthIssues();
  host.textContent = "";
  const sec = function (title, note) {
    const box = el("section", "health-sec");
    box.appendChild(el("h4", null, title));
    if (note) box.appendChild(el("p", "health-note", note));
    host.appendChild(box);
    return box;
  };
  const cbox = sec("参数冲突（" + issues.conflicts.length + "）", issues.conflicts.length ? "这些组合会互相抵消或被硬约束挡住；有「修正」按钮的可以一键改。" : "没有发现明显冲突。");
  issues.conflicts.forEach(function (c) {
    const row = el("div", "health-row");
    const txt = el("div", "health-text");
    txt.appendChild(el("strong", null, c.reason));
    txt.appendChild(el("span", "health-params", c.params.map(function (id) { return (paramIndex[id] ? paramIndex[id].label : id); }).join(" / ")));
    row.appendChild(txt);
    if (c.fix) {
      const b = el("button", "mini", "修正");
      b.addEventListener("click", function () { applyHealthFix(c.fix); });
      row.appendChild(b);
    }
    cbox.appendChild(row);
  });
  if (issues.cards.length) {
    const kbox = sec("身份卡与解锁（" + issues.cards.length + "）", "锁在身份卡面前不生效；想手改就解锁并在左栏掷/改值（会记为自定义）。");
    issues.cards.forEach(function (c) {
      const row = el("div", "health-row");
      const txt = el("div", "health-text");
      txt.appendChild(el("strong", null, c.reason));
      row.appendChild(txt);
      if (c.fix) {
        const b = el("button", "mini", "解锁");
        b.addEventListener("click", function () { applyHealthFix(c.fix); });
        row.appendChild(b);
      }
      kbox.appendChild(row);
    });
  }
  const nbox = sec("数据未接入（" + issues.notIntegrated.length + "）", issues.notIntegrated.length ? "这些参数没有被任何内容段引用，需要补模板或检查 id。" : "所有参数都能在内容段里找到落点。");
  if (issues.notIntegrated.length) {
    const p = el("p", "health-params", issues.notIntegrated.map(function (id) { return (paramIndex[id] ? paramIndex[id].label + " {{" + id + "}}" : id); }).join("、"));
    nbox.appendChild(p);
  }
  const obox = sec("所在段已关闭（" + issues.offCount + "）", "不是错误：这些参数当前被「简洁/标准」预设或手动关段挡在提示词外。");
  obox.appendChild(el("p", "health-note", "想全部启用就切「详细」档。"));
  const hb = budgetFor(templateOrient());
  const bbox = sec("提示词预算", "当前画幅建议 ≤" + hb + " 字；超过 " + (hb + 400) + " 字模型更容易忽略细节。");
  bbox.appendChild(el("p", "health-budget" + (issues.len > hb + 400 ? " over" : issues.len > hb ? " warn" : ""), "当前 " + issues.len + " 字 · 预算 " + hb));
  const hbox = sec("记忆点", "最多 3 个；会单独写进「记忆点」段。");
  hbox.appendChild(el("p", "health-note", "已选 " + issues.highlights + " / 3"));
  if (issues.unknown.length) {
    const ubox = sec("未定义变量（" + issues.unknown.length + "）", "这些变量在参数表/元变量里找不到，发送前已被移除并拦截生成；请改成正确变量或删掉。");
    ubox.appendChild(el("p", "health-params", issues.unknown.map(function (k) { return "{{" + k + "}}"; }).join("、")));
  }
  $("#healthModal").classList.add("on");
}

/* ---------- 人物档案 ---------- */
function openProfileModal() {
  const m = state.meta || {};
  $("#pfName").value = m.name || "";
  $("#pfIdentity").value = m.identity || "";
  $("#pfPersonality").value = m.personality || "";
  $("#pfTrait").value = m.trait || "";
  $("#pfStyle").value = (m.styleKeywords || []).join("、");
  $("#pfBio").value = m.bio || "";
  $("#profileModal").classList.add("on");
}

function pickFromPool(pool) {
  if (!pool || !pool.length) return "";
  return pool[Math.floor(Math.random() * pool.length)];
}

function generateBioText() {
  const N = DATA.names || {};
  const identity = $("#pfIdentity").value.trim() || "游民";
  const personality = $("#pfPersonality").value.trim() || "沉静";
  const trait = $("#pfTrait").value.trim() || "无";
  const tpl = pickFromPool(N.bioTemplates) || "{identity}，{personality}，{trait}。";
  return tpl.replace(/\{identity\}/g, identity).replace(/\{personality\}/g, personality).replace(/\{trait\}/g, trait);
}

function saveProfileModal() {
  const keywords = $("#pfStyle").value.split(/[,，、\s\/]+/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 4);
  state.meta = {
    name: $("#pfName").value.trim() || "无名",
    identity: $("#pfIdentity").value.trim() || "游民",
    personality: $("#pfPersonality").value.trim(),
    trait: $("#pfTrait").value.trim(),
    bio: $("#pfBio").value.trim(),
    styleKeywords: keywords
  };
  $("#profileModal").classList.remove("on");
  syncAll();
  toast("人物档案已保存");
}

/* ---------- blocks UI ----------
   结构段（画幅 / 版面 / 质感 / 负面）跟着画幅走；
   内容段只有一份，所有画幅共用，改一次处处生效。 */
function currentTemplate() {
  return DATA.layouts.find(function (t) { return t.id === state.templateId; }) || DATA.layouts[0];
}

/* 画幅级「停用段」：某些版面（如九宫格）不需要某段内容，例如画面里不能有任何文字。
   这是显示/拼装层的过滤，不改内容段本身的开关，切到别的画幅照常生效。 */
function templateSuppressedIds() {
  const t = currentTemplate();
  return (t && Array.isArray(t.suppress)) ? t.suppress : [];
}
function isBlockSuppressed(id) {
  /* 只有内容段可以被画幅停用；手改 data 时误把 format/layout 写进 suppress 也不会把结构段拼丢 */
  return isContentBlock(id) && templateSuppressedIds().indexOf(id) >= 0;
}

/* 画幅方向：正背卡 / 三视图的版面是左右三分、横向并排写的，只能配横版画布；
   九宫格要 3×3 正方形格子，只能配 1:1；其它画幅不限。 */
function ratioOrient(id) {
  const p = String(id || "").split(":");
  const w = Number(p[0]), h = Number(p[1]);
  if (!w || !h) return "any";
  return w > h ? "landscape" : w < h ? "portrait" : "square";
}
function templateOrient() {
  const t = DATA.layouts && DATA.layouts.length ? currentTemplate() : null;
  return (t && t.orient) || "any";
}
function ratioAllowed(id) {
  const o = templateOrient();
  return o === "any" || o === ratioOrient(id);
}
function ensureRatioForTemplate() {
  if (ratioAllowed(state.ratio)) return;
  const pref = ["16:9", "3:2", "4:3", "21:9", "3:4", "2:3", "9:16", "1:1"];
  const next = pref.find(function (x) { return ratioAllowed(x); }) || "16:9";
  state.ratio = next;
  saveState();
  if ($("#ratioSeg")) renderSizeControls();
  const o = templateOrient();
  toast("「" + currentTemplate().label + "」的版面是" + (o === "landscape" ? "横版" : o === "square" ? "方形" : "竖版") + "的，比例已切到 " + next, 4200);
}

function isContentBlock(id) {
  return Object.prototype.hasOwnProperty.call(DATA.content, id);
}

function defaultBlocks() {
  const t = currentTemplate();
  return DATA.order.map(function (id) {
    if (isContentBlock(id)) {
      const c = DATA.content[id];
      return { id: id, kind: "content", label: c.label, text: c.text, enabled: c.enabledDefault !== false };
    }
    const s = t.structure[id] || { label: id, text: "" };
    return { id: id, kind: "structure", label: s.label, text: s.text, enabled: true };
  });
}

/* 把当前结构段的改动存回它所属的画幅 */
function stashTemplateStructure() {
  const t = currentTemplate();
  const box = state.templateText[t.id] || (state.templateText[t.id] = {});
  state.blocks.forEach(function (b) {
    if (isContentBlock(b.id) || !t.structure[b.id]) return;
    box[b.id] = { text: b.text, enabled: b.enabled !== false };
  });
}

/* 把当前画幅的结构段文字铺回列表；内容段、自定义段原样不动 */
function applyTemplateStructure() {
  const t = currentTemplate();
  const saved = state.templateText[t.id] || {};
  state.blocks.forEach(function (b) {
    if (isContentBlock(b.id) || !t.structure[b.id]) return;
    const s = t.structure[b.id];
    const keep = saved[b.id];
    b.kind = "structure";
    b.label = s.label;
    b.text = keep && typeof keep.text === "string" ? keep.text : s.text;
    /* 结构段的开关跟着画幅走：这个画幅存过就用自己的，没存过就回默认「开」。
       否则在正背卡里关掉负面段，切到立绘会连同开关一起带过去（提示词缺段） */
    b.enabled = keep && typeof keep.enabled === "boolean" ? keep.enabled : true;
  });
  ensureRatioForTemplate();
  /* 比例 chip 的可用状态取决于当前画幅的 orient：切完画幅必须重画一遍，
     否则会留下上一个画幅的禁用/可选状态（还能点出「横版版面 + 竖版画布」） */
  if ($("#ratioSeg")) renderSizeControls();
}

/* 列表缺段时补齐内置段（老存档、或者以后加新段用） */
function ensureBlockSkeleton() {
  const have = {};
  state.blocks.forEach(function (b) { have[b.id] = true; });
  const t = currentTemplate();
  DATA.order.forEach(function (id, i) {
    if (have[id]) return;
    const src = (isContentBlock(id) ? DATA.content[id] : t.structure[id]) || { label: id, text: "" };
    state.blocks.splice(Math.min(i, state.blocks.length), 0, {
      id: id,
      kind: isContentBlock(id) ? "content" : "structure",
      label: src.label,
      text: src.text,
      enabled: isContentBlock(id) ? (DATA.content[id].enabledDefault !== false) : true
    });
  });
}

/* 老存档迁移：内容段的默认文案改过（着装 / 左上角文字），老存档里存的是旧文案。
   只在「和旧默认一字不差」（说明用户没改过这一段）时才换成新文案，不覆盖手改内容。 */
const LEGACY_CONTENT = {
  /* 数组：更旧的一版 + 当前这一版；两版都只在「一字未改」时才迁移，不覆盖手改内容 */
  outfit: [
    "服装：{{underTop}}，下身只穿一条肉色无缝紧身短裤，没有其他衣物、没有鞋、没有配饰，身体轮廓清楚可见。",
    "服装：{{underTop}}{{outfitExtra}}。"
  ],
  realism: "真实质感：可见毛孔与细小绒毛，肤色自然不均匀，鼻翼有自然油光，唇部有细纹与轻微干纹，眉毛毛流清晰，额前有几缕碎发，发丝边缘不规则，眼神有自然高光与轻微红血丝。",
  info: "在画面左上方的空白区域内，水平居中排一行清晰的黑色中文黑体文字。这一行文字的中心大约位于画面宽度的 22%、画面高度的 10% 处，四周留白充足，绝不贴边、绝不被裁切、不被人物遮挡：\n{{name}} · {{age}}岁 · {{height}}cm · {{identity}}"
};
function migrateLegacyContent() {
  state.blocks.forEach(function (b) {
    const old = LEGACY_CONTENT[b.id];
    const cur = DATA.content[b.id];
    if (!old || !cur) return;
    const hit = Array.isArray(old) ? old.indexOf(String(b.text)) >= 0 : String(b.text) === old;
    if (hit) b.text = cur.text;
  });
}

/* 老存档迁移（结构段）：这一版把五个画幅的「画幅 / 版面 / 质感 / 负面」整体重写过。
   只要以前动过任何一段，persistBlocks 就会把这四段全量抄进 localStorage（state.templateText），
   旧文案会盖住新默认。这里只在「缓存文本 == 旧默认原文」时把 text 摘掉（保留开关状态），
   让它回落到 data 里的新文案；用户真正手改过的内容不受影响。 */
const LEGACY_STRUCT = {
  format: "一张 {{aspectText}}画面，纯白色背景，干净均匀的影棚柔光，没有场景、没有道具、没有边框。",
  style: "写实摄影质感，85mm 镜头，柔和均匀的棚拍光，解剖结构正确，左右对称，轮廓干净，皮肤与发丝细节丰富，高分辨率。",
  negative: "不要让文字贴边、出画或被裁切；不要：除左上角那一行人物信息之外的任何文字、字幕、标题、水印、logo、边框、带颜色的背景、场景与道具；不要在背景上画地面线、水平线或任何参考线；不要拐杖、轮椅、义肢、绷带等任何外物；不要多余的手指或肢体；不要裁切掉脚部；不要卡通、动漫、3D 渲染假人感。",
  layout: {
    sheet_2view: "版式：画面上方留出约 12% 高的空白区域，不放人物。画面左侧三分之一处是一个人物的大头像，四分之三侧脸，面部细节清晰锐利。画面右侧三分之二是同一个人的两张全身像并排——左边是正面全身，右边是背面全身；两张的脚底处在完全相同的水平高度，身高完全一致，A-pose 站姿，双臂自然向外张开约 20 度，手掌放松。",
    sheet_3view: "版式：画面上方留出约 12% 高的空白区域，不放人物。画面横向依次并排三张全身像，分别是正面、侧面、背面；三张同一比例、同一身高，脚底处在完全相同的水平高度，A-pose 站姿，双臂自然离开身体约 20 度。",
    fullbody: "版式：单张全身立绘，人物居中站立，A-pose，从头到脚完整不裁切，双脚自然平放，脚底齐平。",
    portrait: "版式：单张半身肖像，取景到胸口以上，四分之三侧脸，浅景深，面部占据画面主要位置，背景干净。",
    expression_grid: "版式：3×3 九宫格，同一个人的同一张脸出现九次，每一格只拍到头部与肩部；九格的脸型、发型、光源、服装完全一致，只有表情不同；格与格之间用极细的浅灰线分隔。"
  }
};
function migrateLegacyStructure() {
  const map = state.templateText || {};
  Object.keys(map).forEach(function (tid) {
    const box = map[tid];
    if (!box || typeof box !== "object") return;
    Object.keys(box).forEach(function (k) {
      const item = box[k];
      if (!item || typeof item.text !== "string") return;
      const old = k === "layout" ? (LEGACY_STRUCT.layout[tid] || "") : (LEGACY_STRUCT[k] || "");
      if (old && item.text === old) delete item.text;
    });
  });
}

function loadBlocks() {
  if (!state.blocks.length) state.blocks = defaultBlocks();
  migrateLegacyContent();
  migrateLegacyStructure();
  ensureBlockSkeleton();
  if (state.detailPreset !== "custom") applyDetailPresetFlags(state.detailPreset);
  applyTemplateStructure();
}

function persistBlocks() {
  // 结构段的改动先回写到它所属的画幅，否则刷新后会被画幅默认文字盖掉
  stashTemplateStructure();
  saveState();
}

/* ---------- 画幅管理 ---------- */
function normalizeTemplate() {
  if (!DATA.layouts.length) return;
  if (DATA.layouts.some(function (t) { return t.id === state.templateId; })) return;
  state.templateId = DATA.layouts[0].id;
  applyTemplateStructure();
}

function renderTemplateOptions() {
  const sel = $("#templateSel");
  if (!sel) return;
  sel.textContent = "";
  DATA.layouts.forEach(function (t) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.label;
    sel.appendChild(o);
  });
  sel.value = state.templateId;
}

function layoutSubText(t) {
  const txt = (((t.structure || {}).layout || {}).text || "").replace(/\s+/g, " ");
  return txt.slice(0, 40) + (txt.length > 40 ? "…" : "");
}

function renderLayoutList() {
  const host = $("#layoutList");
  if (!host) return;
  host.textContent = "";
  const n = $("#layoutCount");
  if (n) n.textContent = DATA.layouts.length + " 个";
  DATA.layouts.forEach(function (t) {
    const row = el("div", "manage-row");
    const info = el("div", "manage-info");
    info.appendChild(el("strong", null, t.label + (t.id === state.templateId ? " · 当前" : "")));
    info.appendChild(el("span", "manage-sub", layoutSubText(t)));
    row.appendChild(info);

    const tools = el("div", "manage-tools");
    const ren = el("button", "text-btn", "改名");
    ren.title = "只改显示名，存档里记的 id 不变";
    ren.addEventListener("click", function () { renameLayout(t); });
    tools.appendChild(ren);

    const del = el("button", "text-btn danger", "删除");
    if (DATA.layouts.length <= 1) {
      del.disabled = true;
      del.title = "至少要保留一个画幅";
    } else {
      del.title = "删掉这个画幅的 4 个结构段；人物内容段和已生成的存档不受影响";
      del.addEventListener("click", function () { deleteLayout(t); });
    }
    tools.appendChild(del);
    row.appendChild(tools);
    host.appendChild(row);
  });
}

/* ---------- 画幅预设（内置只读：data/presets.json） ---------- */
function presetSizeText(p) {
  const r = RATIOS.find(function (x) { return x.id === p.ratio; });
  const s = r && r.sizes ? (r.sizes[p.res] || r.sizes["2K"]) : null;
  return s ? (s[0] + "×" + s[1]) : "—";
}

function presetActive(p) {
  return p.layoutId === state.templateId && p.ratio === state.ratio && p.res === state.res;
}

function renderPresetList() {
  const host = $("#presetList");
  if (!host) return;
  host.textContent = "";
  const sec = $("#presetSection");
  if (sec) sec.hidden = !(DATA.presets && DATA.presets.length);
  (DATA.presets || []).forEach(function (p) {
    const hasLayout = DATA.layouts.some(function (t) { return t.id === p.layoutId; });
    const btn = el("button", "preset-item" + (presetActive(p) ? " on" : ""));
    btn.type = "button";
    btn.disabled = !hasLayout;
    btn.title = hasLayout
      ? (p.note || "")
      : "对应的画幅已被删除；在「画幅管理」里恢复默认画幅后可用";
    btn.appendChild(el("strong", null, p.label));
    btn.appendChild(el("span", "preset-meta", p.ratio + " · " + p.res + " · " + presetSizeText(p) + (p.note ? " — " + p.note : "")));
    btn.addEventListener("click", function () { applyPreset(p); });
    host.appendChild(btn);
  });
}

function applyPreset(p) {
  const layout = DATA.layouts.find(function (t) { return t.id === p.layoutId; });
  if (!layout) {
    toast("预设对应的画幅已被删除；先在「画幅管理」里恢复默认画幅");
    return;
  }
  stashTemplateStructure();
  state.templateId = p.layoutId;
  const sel = $("#templateSel");
  if (sel) sel.value = p.layoutId;
  applyTemplateStructure();
  state.ratio = p.ratio;
  state.res = p.res;
  /* 预设是权威组合（validate 已校验方向），万一画幅 orient 被手改坏也不让比例越界 */
  if (!ratioAllowed(state.ratio)) ensureRatioForTemplate();
  saveState();
  renderSizeControls();
  renderBlocks();
  renderParams();
  updatePromptPreview();
  closeLayoutModal();
  toast("已应用预设：" + p.label + "（" + p.ratio + " · " + p.res + "）");
}

function openLayoutModal() {
  renderPresetList();
  renderLayoutList();
  $("#layoutModal").classList.add("on");
}
function closeLayoutModal() { $("#layoutModal").classList.remove("on"); }

async function postLayout(payload) {
  try {
    const r = await fetch("/api/layouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: "连不上本地服务；重启一下启动.bat，确认新接口已生效" };
  }
}

async function applyLayoutsResponse(j) {
  if (!j || !j.ok) {
    toast((j && j.error) || "操作失败：服务端没有响应，重启一下启动.bat 再试", 4600);
    return false;
  }
  if (Array.isArray(j.layouts) && j.layouts.length) DATA.layouts = j.layouts;
  renderLayoutList();
  renderTemplateOptions();
  return true;
}

/* 新建画幅时用它复制当前 4 个结构段（用屏幕上正在编辑的文字，不是文件里的） */
function structurePayload(label) {
  const cur = currentTemplate();
  const out = {};
  ["format", "layout", "style", "negative"].forEach(function (k) {
    const b = state.blocks.find(function (x) { return x.id === k; });
    const fallback = ((cur && cur.structure) || {})[k] || { label: k, text: "" };
    out[k] = {
      label: k === "layout" ? "版面 · " + label : fallback.label,
      text: b ? b.text : fallback.text
    };
  });
  return out;
}

async function createLayout() {
  stashTemplateStructure();
  const label = "新画幅 " + (DATA.layouts.length + 1);
  const id = "layout_" + Date.now().toString(36);
  const j = await postLayout({ id: id, label: label, structure: structurePayload(label) });
  if (!(await applyLayoutsResponse(j))) return;
  state.templateId = id;
  $("#templateSel").value = id;
  applyTemplateStructure();
  renderBlocks();
  renderParams();
  updatePromptPreview();
  saveState();
  renderLayoutList();
  closeLayoutModal();
  toast("已新建「" + label + "」；右侧「版面」那一段已经展开，改成这个画幅的取景就行", 5200);
  openLayoutBlock();
}

async function renameLayout(t) {
  const v = window.prompt("画幅名称", t.label);
  if (v == null) return;
  const label = String(v).trim().slice(0, 24);
  if (!label) return toast("名字不能为空");
  if (label === t.label) return;
  const payload = JSON.parse(JSON.stringify(t));
  payload.label = label;
  if (payload.structure && payload.structure.layout) payload.structure.layout.label = "版面 · " + label;
  const j = await postLayout(payload);
  if (!(await applyLayoutsResponse(j))) return;
  if (t.id === state.templateId) {
    applyTemplateStructure();
    renderBlocks();
    updatePromptPreview();
    saveState();
  }
  renderLayoutList();
  toast("已改名为「" + label + "」");
}

async function deleteLayout(t) {
  const ok = await askConfirm({
    title: "删除画幅「" + t.label + "」",
    note: "删掉的只是这个画幅的 4 个结构段（画幅 / 版面 / 质感 / 负面）。\n人物内容段和已经生成的存档都不受影响。",
    okText: "删除",
    danger: true
  });
  if (!ok) return;
  let j;
  try {
    const r = await fetch("/api/layouts?id=" + encodeURIComponent(t.id), { method: "DELETE" });
    j = await r.json();
  } catch (e) {
    j = { ok: false, error: "连不上本地服务；重启一下启动.bat" };
  }
  if (!(await applyLayoutsResponse(j))) return;
  /* 画幅删了，它在 localStorage 里的结构段缓存也一起删：否则以后同 id 重建会读到旧文案 */
  if (state.templateText) delete state.templateText[t.id];
  if (t.id === state.templateId) {
    state.templateId = DATA.layouts[0].id;
    $("#templateSel").value = state.templateId;
    applyTemplateStructure();
    renderBlocks();
    renderParams();
    updatePromptPreview();
    saveState();
  }
  renderLayoutList();
  toast("已删除画幅「" + t.label + "」");
}

async function resetLayouts() {
  const ok = await askConfirm({
    title: "恢复默认画幅",
    note: "会删掉 data/layouts.json，画幅回到出厂 5 个。\n新建、改名过的画幅都会消失，各画幅结构段改过的文字也回默认；人物内容段保留。",
    okText: "恢复默认",
    danger: true
  });
  if (!ok) return;
  let j;
  try {
    const r = await fetch("/api/layouts/reset", { method: "POST" });
    j = await r.json();
  } catch (e) {
    j = { ok: false, error: "连不上本地服务；重启一下启动.bat" };
  }
  if (!(await applyLayoutsResponse(j))) return;
  const saved = {};
  state.blocks.forEach(function (b) { saved[b.id] = b; });
  const customs = state.blocks.filter(function (b) { return b.kind === "free"; });
  state.templateText = {};
  state.templateId = DATA.layouts[0].id;
  $("#templateSel").value = state.templateId;
  state.blocks = defaultBlocks();
  state.blocks.forEach(function (b) {
    const p = saved[b.id];
    if (p && isContentBlock(b.id)) { b.text = p.text; b.enabled = p.enabled; }
  });
  customs.forEach(function (b) { state.blocks.push(b); });
  renderBlocks();
  renderParams();
  updatePromptPreview();
  saveState();
  renderLayoutList();
  toast("已恢复默认画幅");
}

function openLayoutBlock() {
  const idx = state.blocks.findIndex(function (b) { return b.id === "layout"; });
  const card = document.querySelector('#blockList .block[data-idx="' + idx + '"]');
  if (!card) return;
  card.classList.add("open");
  try { card.scrollIntoView({ block: "nearest" }); } catch (e) {}
  const ta = card.querySelector("textarea");
  if (ta) {
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
  }
}

function renderBlocks() {
  const host = $("#blockList");
  host.textContent = "";
  state.blocks.forEach(function (b, idx) {
    const card = el("div", "block");
    card.dataset.idx = String(idx);
    card.draggable = true;
    const suppressed = isBlockSuppressed(b.id);
    if (suppressed) card.classList.add("suppressed");

    const head = el("div", "block-head");
    head.appendChild(el("span", "block-grip", "⠿"));

    const kind = el("span", "block-kind kind-" + b.kind, b.kind === "structure" ? "结构" : b.kind === "content" ? "内容" : "自定义");
    head.appendChild(kind);
    head.appendChild(el("span", "block-name", b.label));
    if (suppressed) head.appendChild(el("span", "block-offtag", "本画幅不用"));
    head.appendChild(el("span", "block-vcount", ""));

    const tog = el("div", "block-toggle");
    tog.dataset.on = (b.enabled && !suppressed) ? "1" : "0";
    tog.title = suppressed
      ? "本画幅「" + currentTemplate().label + "」的版面不需要这一段，它在这里不参与拼装；切到其它画幅照常生效"
      : "启用 / 停用；停用后这一段不进最终提示词";
    tog.addEventListener("click", function (e) {
      e.stopPropagation();
      if (suppressed) { toast("「" + b.label + "」在本画幅里被版面停用；切到其它画幅即可开关它", 4200); return; }
      b.enabled = !b.enabled;
      markDetailCustom();
      persistBlocks(); renderBlocks(); updatePromptPreview();
    });
    head.appendChild(tog);

    // 内置段不给删：删掉整份提示词就缺块，也没有恢复入口；只有自己加的段落能移除
    if (b.kind === "free") {
      const del = el("button", "block-del", "×");
      del.title = "移除这一段（只有自定义段落可以删）";
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        state.blocks.splice(idx, 1);
        persistBlocks(); renderBlocks(); updatePromptPreview();
      });
      head.appendChild(del);
    }

    head.addEventListener("click", function () { card.classList.toggle("open"); });
    card.appendChild(head);

    const body = el("div", "block-body");
    body.appendChild(el("div", "block-vars"));
    const ta = document.createElement("textarea");
    ta.value = b.text;
    ta.addEventListener("input", function () {
      b.text = ta.value;
      persistBlocks();
      updatePromptPreview();
    });
    body.appendChild(ta);
    const parsed = el("div", "block-parsed");
    body.appendChild(parsed);
    card.appendChild(body);

    card.addEventListener("dragstart", function (e) {
      e.dataTransfer.setData("text/plain", String(idx));
      card.style.opacity = "0.4";
    });
    card.addEventListener("dragend", function () { card.style.opacity = ""; });
    card.addEventListener("dragover", function (e) { e.preventDefault(); });
    card.addEventListener("drop", function (e) {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData("text/plain"));
      if (isNaN(from) || from === idx) return;
      const moved = state.blocks.splice(from, 1)[0];
      state.blocks.splice(idx, 0, moved);
      persistBlocks(); renderBlocks(); updatePromptPreview();
    });

    host.appendChild(card);
    renderBlockMeta(card, b);
  });
}

let metaRefreshRaf = 0;
function refreshBlockMetas() {
  const snap = buildPromptSnapshot();
  const vars = snap.vars;
  const cards = document.querySelectorAll("#blockList .block");
  for (let i = 0; i < cards.length; i++) {
    const idx = Number(cards[i].dataset.idx);
    const b = state.blocks[idx];
    if (b) renderBlockMeta(cards[i], b, vars);
  }
}
function scheduleBlockMetaRefresh() {
  if (metaRefreshRaf) return;
  metaRefreshRaf = requestAnimationFrame(function () {
    metaRefreshRaf = 0;
    refreshBlockMetas();
  });
}

function updatePromptPreview() {
  const snap = buildPromptSnapshot();
  const pre = $("#promptPreview");
  if (!pre) return;
  const prevScroll = pre.scrollTop;
  pre.innerHTML = snap.segments
    .map(function (seg) {
      /* 复刻提示词 / 风格段是外部原文，不解析 {{变量}}，原样转义 */
      if (seg.literal) return escapeHtml(seg.text);
      return renderTemplateHTML(seg.raw, snap.vars, { mode: "exact" });
    })
    .join("\n\n");
  /* 整段复刻时不再追加时代负向词：那段原文就是这次要发的全部内容 */
  const eraTailText = snap.external ? "" : eraNegative();
  if (eraTailText) pre.innerHTML += "\n\n" + escapeHtml(eraTailText);
  pre.scrollTop = prevScroll;
  const len = snap.stats.chars;
  /* 预算按画幅分档；清装态多一档（服饰句约 +100 字） */
  const budget = budgetFor(templateOrient());
  const budgetClass = len > budget + 400 ? "over" : len > budget ? "warn" : "ok";
  const meta = $("#promptMeta");
  if (meta) {
    if (snap.external) {
      meta.innerHTML = "复刻提示词 · " + len + " 字" + (snap.style && snap.style.name ? " · " + escapeHtml(snap.style.name) : "");
      meta.title = "本次生成直接使用参考图复刻出来的提示词；左栏参数和右栏段落都不参与。点画布上方的「复刻提示词：… ✕」恢复。";
    } else {
      meta.innerHTML = snap.stats.vars + " 变量"
        + (snap.stats.empty ? " · 空 " + snap.stats.empty : "")
        + " · " + len + " 字 · <span class=\"budget budget-" + budgetClass + "\">预算 " + budget + "</span>"
        + (snap.style ? " · 风格 " + escapeHtml(snap.style.name || "未命名") : "");
      meta.title = "提示词里的高亮词就是被替换的变量：悬停看来源，点击定位。点「变量表」看全部映射。\n空值不输出文字；未知变量会在发送前剥掉并拦截生成。\n预算：素体态单图 1800 / 多视图 2100；清装态 2000 / 2300（多约 100 字的服饰句）。";
    }
  }
  const warn = $("#promptWarn");
  if (warn) {
    if (snap.external) {
      warn.hidden = false;
      warn.className = "prompt-warn";
      warn.textContent = "正在用「" + ((snap.style && snap.style.name) || "复刻提示词") + "」整段生成：左栏参数与右栏段落都不参与本次提示词。点画布上方的风格标签可清除。";
    } else if (snap.unknown.length) {
      warn.hidden = false;
      warn.className = "prompt-warn bad";
      warn.textContent = "已移除 " + snap.unknown.length + " 个未知变量：" + snap.unknown.map(function (u) { return "{{" + u.key + "}}"; }).join(" ") + "；先到「体检」修正再生成";
    } else if (snap.stats.empty) {
      warn.hidden = false;
      warn.className = "prompt-warn";
      warn.textContent = "有 " + snap.stats.empty + " 个变量当前为空，不会输出文字（见段头的「空」标记）";
    } else {
      warn.hidden = true;
      warn.textContent = "";
    }
  }
  updateParamUsage(snap);
  updateStyleChip();
  scheduleBlockMetaRefresh();
}

/* ---------- stage ---------- */
function syncStage() {
  const m = state.meta;
  $("#charName").textContent = m.name || "尚未成形";
  $("#charName").title = "点击编辑人物档案";
  $("#charMeta").title = "点击编辑人物档案";
  const parts = [];
  parts.push(sexMeta().label);
  if (m.identity) parts.push(m.identity);
  if (state.params.age) parts.push(state.params.age + " 岁");
  if (state.params.height) parts.push(state.params.height + " cm");
  if (m.trait) parts.push(m.trait);
  $("#charMeta").textContent = parts.join(" · ");
  $("#seedInput").value = String(state.seed);
  updatePromptPreview();
}

function syncAll() {
  renderParams();
  syncStage();
  updatePromptPreview();
  saveState();
}

/* ---------- models ---------- */
async function api(path, opt) {
  let r;
  try {
    r = await fetch(path, opt);
  } catch (e) {
    // fetch 自己抛错（服务重启 / 断网 / 页面休眠后唤醒）：不能让它冒泡，否则调用方会卡死
    return { ok: false, error: "连不上本地服务（" + String((e && e.message) || e) + "）；确认 启动.bat 的窗口还开着" };
  }
  let text = "";
  try {
    text = await r.text();
  } catch (e) {
    return { ok: false, error: "读取服务端响应失败" };
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      status: r.status,
      error: r.status === 404
        ? "服务端没有这个接口（404），重启一下 启动.bat"
        : "HTTP " + r.status + " · " + text.slice(0, 160)
    };
  }
}

async function loadProviders() {
  const j = await api("/api/config");
  state.providers = (j && j.providers) || [];
  state.llmProviders = (j && j.llmProviders) || [];
  state.hidden = (j && j.hiddenModels) || {};
  const sel = $("#providerSel");
  sel.textContent = "";
  state.providers.forEach(function (p) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name + "  (" + p.keyMask + ")";
    sel.appendChild(o);
  });
  const add = document.createElement("option");
  add.value = "__add__";
  add.textContent = "＋ 接入新的接口…";
  sel.appendChild(add);

  if (!state.providerId || !state.providers.some(function (p) { return p.id === state.providerId; })) {
    state.providerId = state.providers[0] ? state.providers[0].id : null;
  }
  if (state.providerId) sel.value = state.providerId;
  if (!state.llmProviderId || !state.llmProviders.some(function (p) { return p.id === state.llmProviderId; })) {
    state.llmProviderId = state.llmProviders[0] ? state.llmProviders[0].id : null;
    state.llmModelId = null;
    state.llmModels = [];
    state.llmModelsFor = "";
  }
  const rev = $("#reverseModal");
  if (rev && rev.classList.contains("on")) renderReverseProviders();
}

async function loadModels() {
  if (!state.providerId || state.providerId === "__add__") return;
  const sel = $("#modelSel");
  sel.disabled = true;
  sel.textContent = "";
  const loading = document.createElement("option");
  loading.textContent = "拉取中…";
  sel.appendChild(loading);
  setStatus("正在从服务商拉取模型列表…");
  const j = await api("/api/models?provider=" + encodeURIComponent(state.providerId));
  sel.disabled = false;
  sel.textContent = "";
  if (!j || !j.ok) {
    const e = document.createElement("option");
    e.textContent = "拉取失败";
    sel.appendChild(e);
    state.allModels = [];
    state.models = [];
    setStatus("模型拉取失败：" + ((j && j.error) || "未知错误"), true);
    updateGenButton();
    return;
  }
  state.allModels = j.models || [];
  const hidden = state.hidden[state.providerId] || [];
  state.models = state.allModels.filter(function (m) { return hidden.indexOf(m.id) < 0; });

  if (!state.models.length) {
    const e = document.createElement("option");
    e.textContent = state.allModels.length ? "模型都被隐藏了" : "没有可用模型";
    sel.appendChild(e);
    state.modelId = null;
    setStatus("当前服务商没有可显示的模型，点「⋯」去启用", true);
    updateGenButton();
    return;
  }
  state.models.forEach(function (m) {
    const opt = document.createElement("option");
    opt.value = m.id;
    /* 显示上游的真实模型名（请求里真正发出去的 id）；display_name 只作悬停提示，
       避免把网关的展示名误当成模型名 */
    opt.textContent = m.id;
    if (m.display && m.display !== m.id) opt.title = "上游显示名：" + m.display;
    sel.appendChild(opt);
  });
  if (!state.modelId || !state.models.some(function (m) { return m.id === state.modelId; })) {
    state.modelId = state.models[0].id;
  }
  sel.value = state.modelId;
  setStatus("已连接「" + providerName() + "」，可用模型 " + state.models.length + " 个");
  updateGenButton();
}

/* ---------- model management ---------- */
function openManage() {
  renderManage();
  $("#manageModal").classList.add("on");
}

function renderLlmProviders() {
  const host = $("#llmProviderList");
  if (!host) return;
  host.textContent = "";
  if (!state.llmProviders.length) {
    host.appendChild(el("p", "manage-empty", "还没有反推服务商：点右上角「＋ 新增反推服务商」"));
    return;
  }
  state.llmProviders.forEach(function (p) {
    const row = el("div", "manage-row");
    const info = el("div", "manage-info");
    info.appendChild(el("strong", null, p.name));
    info.appendChild(el("span", "manage-sub", p.baseUrl + " · " + (p.hasKey ? p.keyMask : "⚠ 未配置密钥（点「编辑」填入，或写 .env 的 " + (p.envKey || "ZXT_KEY_" + String(p.id).toUpperCase()) + "）")));
    row.appendChild(info);
    const acts = el("div", "manage-actions");
    const edit = el("button", "text-btn", "编辑");
    edit.title = "修改名称 / 接口地址 / 密钥 / 强度参数名";
    edit.addEventListener("click", function () {
      $("#manageModal").classList.remove("on");
      openModal("edit", p, { kind: "llm", fromManage: true });
    });
    acts.appendChild(edit);
    const del = el("button", "text-btn danger", "删除");
    del.addEventListener("click", async function () {
      if (!window.confirm("删除反推服务商「" + p.name + "」？")) return;
      const r = await api("/api/providers?kind=llm&id=" + encodeURIComponent(p.id), { method: "DELETE" });
      if (r && r.ok) {
        state.llmProviders = r.llmProviders || [];
        if (state.llmProviderId === p.id) {
          state.llmProviderId = null;
          state.llmModelId = null;
          state.llmModels = [];
          state.llmModelsFor = "";
        }
        await loadProviders();
        renderReverseProviders();
        renderManage();
        toast("已删除反推服务商「" + p.name + "」");
      }
    });
    acts.appendChild(del);
    row.appendChild(acts);
    host.appendChild(row);
  });
}

function renderManage() {
  const pl = $("#providerList");
  pl.textContent = "";
  if (!state.providers.length) {
    pl.appendChild(el("p", "manage-empty", "还没有服务商，点右上角「＋ 新增服务商」"));
  }
  state.providers.forEach(function (p) {
    const row = el("div", "manage-row");
    const info = el("div", "manage-info");
    info.appendChild(el("strong", null, p.name));
    info.appendChild(el("span", "manage-sub", p.baseUrl + " · " + (p.hasKey ? p.keyMask : "⚠ 未配置密钥（点「编辑」填入，或写 .env 的 " + (p.envKey || "ZXT_KEY_" + String(p.id).toUpperCase()) + "）")));
    row.appendChild(info);
    const acts = el("div", "manage-actions");
    const edit = el("button", "text-btn", "编辑");
    edit.title = "修改名称 / 接口地址 / 密钥；密钥会写入 .env";
    edit.addEventListener("click", function () {
      /* 先收起管理面板，否则两个弹窗层叠（同一个 z-index，后出现的会盖住编辑框） */
      $("#manageModal").classList.remove("on");
      openModal("edit", p, { fromManage: true });
    });
    acts.appendChild(edit);
    const del = el("button", "text-btn danger", "删除");
    del.addEventListener("click", async function () {
      if (!window.confirm("删除服务商「" + p.name + "」？")) return;
      const r = await api("/api/providers?id=" + encodeURIComponent(p.id), { method: "DELETE" });
      if (r && r.ok) {
        state.providers = r.providers;
        await loadProviders();
        state.modelId = null;
        await loadModels();
        renderManage();
        toast("已删除服务商「" + p.name + "」");
      }
    });
    acts.appendChild(del);
    row.appendChild(acts);
    pl.appendChild(row);
  });

  renderLlmProviders();

  $("#manageProviderName").textContent = providerName();
  const ml = $("#modelList");
  ml.textContent = "";
  if (!state.allModels.length) {
    ml.appendChild(el("p", "manage-empty", "没有拉到模型，点「重新拉取」再试"));
    return;
  }
  const hidden = state.hidden[state.providerId] || [];
  state.allModels.forEach(function (m) {
    const isHidden = hidden.indexOf(m.id) >= 0;
    const row = el("div", "manage-row");
    const info = el("div", "manage-info");
    info.appendChild(el("strong", null, m.id));
    info.appendChild(el("span", "manage-sub", m.display && m.display !== m.id ? "上游显示名：" + m.display : (m.type || "model")));
    row.appendChild(info);
    const btn = el("button", "text-btn" + (isHidden ? " danger" : " on"), isHidden ? "已隐藏" : "显示中");
    btn.title = isHidden ? "点一下恢复显示" : "点一下从下拉里隐藏";
    btn.addEventListener("click", async function () {
      await api("/api/models/hide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: state.providerId, modelId: m.id, hidden: !isHidden })
      });
      const cfg = await api("/api/config");
      if (cfg && cfg.ok) state.hidden = cfg.hiddenModels || {};
      await loadModels();
      renderManage();
    });
    row.appendChild(btn);
    ml.appendChild(row);
  });
}

function providerName() {
  const p = state.providers.find(function (x) { return x.id === state.providerId; });
  return p ? p.name : "—";
}

/* ======================================================================
   参考图复刻：LLM 服务商 / 系统提示词 / 反推 / 风格预设
   ====================================================================== */
let reverseEditingNew = false;

function revProvider() {
  return state.llmProviders.find(function (p) { return p.id === state.llmProviderId; }) || null;
}
function revProviderName() {
  const p = revProvider();
  return p ? p.name : "—";
}
function reversePromptsList() {
  return Array.isArray(state.reversePrompts) ? state.reversePrompts : [];
}
function selectedReversePrompt() {
  const list = reversePromptsList();
  if (!list.length) return null;
  return list.find(function (p) { return p.id === state.reversePromptId; }) || list[0];
}
function setRevHint(text, isErr) {
  const el = $("#revStatus");
  if (!el) return;
  el.textContent = text || "";
  el.className = "rev-hint" + (isErr ? " err" : "");
}

function renderReverseProviders() {
  const sel = $("#revProviderSel");
  if (!sel) return;
  sel.textContent = "";
  if (!state.llmProviders.length) {
    const o = el("option", null, "还没有反推服务商");
    o.value = "";
    sel.appendChild(o);
    sel.disabled = true;
  } else {
    sel.disabled = false;
    state.llmProviders.forEach(function (p) {
      const o = el("option", null, p.name + (p.hasKey ? "  (" + p.keyMask + ")" : "  ⚠ 缺密钥"));
      o.value = p.id;
      sel.appendChild(o);
    });
    if (!state.llmProviderId || !state.llmProviders.some(function (p) { return p.id === state.llmProviderId; })) {
      state.llmProviderId = state.llmProviders[0].id;
      state.llmModelId = null;
      state.llmModels = [];
      state.llmModelsFor = "";
    }
    sel.value = state.llmProviderId;
  }
  renderReversePromptSelect();
  renderReverseModelOptions();
}

function renderReverseModelOptions() {
  const sel = $("#revModelSel");
  if (!sel) return;
  sel.textContent = "";
  if (!state.llmProviderId) {
    const o = el("option", null, "先选服务商");
    o.value = "";
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  if (state.llmModelsFor !== state.llmProviderId) {
    const o = el("option", null, "点 ↻ 拉取模型");
    o.value = "";
    sel.appendChild(o);
    sel.disabled = false;
    return;
  }
  sel.disabled = false;
  if (!state.llmModels.length) {
    const o = el("option", null, "没有可用模型");
    o.value = "";
    sel.appendChild(o);
    return;
  }
  state.llmModels.forEach(function (m) {
    const opt = el("option", null, m.id);
    opt.value = m.id;
    if (m.display && m.display !== m.id) opt.title = "上游显示名：" + m.display;
    sel.appendChild(opt);
  });
  if (!state.llmModelId || !state.llmModels.some(function (m) { return m.id === state.llmModelId; })) {
    state.llmModelId = state.llmModels[0].id;
  }
  sel.value = state.llmModelId;
}

async function loadReverseModels() {
  const id = state.llmProviderId;
  if (!id) { renderReverseModelOptions(); return; }
  const sel = $("#revModelSel");
  if (sel) {
    sel.disabled = true;
    sel.textContent = "";
    const loading = el("option", null, "拉取中…");
    loading.value = "";
    sel.appendChild(loading);
  }
  setRevHint("正在从反推服务商拉取模型列表…");
  const j = await api("/api/models?provider=" + encodeURIComponent(id));
  if (!j || !j.ok) {
    state.llmModels = [];
    state.llmModelsFor = id;
    renderReverseModelOptions();
    setRevHint("模型拉取失败：" + ((j && j.error) || "未知错误"), true);
    return;
  }
  state.llmModels = j.models || [];
  state.llmModelsFor = id;
  if (!state.llmModelId || !state.llmModels.some(function (m) { return m.id === state.llmModelId; })) {
    state.llmModelId = state.llmModels[0] ? state.llmModels[0].id : null;
  }
  renderReverseModelOptions();
  setRevHint("已连接「" + revProviderName() + "」，模型 " + state.llmModels.length + " 个");
}

function renderReversePromptSelect() {
  const list = reversePromptsList();
  const sel = $("#revSysSel");
  const editSel = $("#revSysEditSel");
  if (!sel) return;
  sel.textContent = "";
  if (editSel) editSel.textContent = "";
  if (!list.length) {
    const o = el("option", null, "（没有系统提示词）");
    o.value = "";
    sel.appendChild(o);
    sel.disabled = true;
    if (editSel) { const e2 = el("option", null, "（没有系统提示词）"); e2.value = ""; editSel.appendChild(e2); editSel.disabled = true; }
    renderReverseSysEditor();
    return;
  }
  sel.disabled = false;
  if (editSel) editSel.disabled = false;
  list.forEach(function (p) {
    const label = p.name + (p.builtin ? "（内置）" : "");
    const o = el("option", null, label);
    o.value = p.id;
    sel.appendChild(o);
    if (editSel) {
      const o2 = el("option", null, label);
      o2.value = p.id;
      editSel.appendChild(o2);
    }
  });
  const cur = selectedReversePrompt();
  if (cur) {
    if (!reverseEditingNew) state.reversePromptId = cur.id;
    sel.value = state.reversePromptId;
    if (editSel) editSel.value = state.reversePromptId;
  }
  renderReverseSysEditor();
}

function renderReverseSysEditor() {
  const nameEl = $("#revSysName");
  const textEl = $("#revSysText");
  if (!nameEl || !textEl) return;
  if (reverseEditingNew) return;
  const p = selectedReversePrompt();
  const delBtn = $("#revSysDelete");
  if (!p) {
    nameEl.value = "";
    textEl.value = "";
    if (delBtn) delBtn.disabled = true;
    return;
  }
  nameEl.value = p.name;
  textEl.value = p.text;
  if (delBtn) {
    delBtn.disabled = reversePromptsList().length <= 1;
    delBtn.title = p.builtin ? "内置提示词也能删；删掉后用「恢复默认」找回" : "";
  }
}

function selectReversePrompt(id) {
  if (!reversePromptsList().some(function (p) { return p.id === id; })) return;
  state.reversePromptId = id;
  reverseEditingNew = false;
  const sel = $("#revSysSel"), editSel = $("#revSysEditSel");
  if (sel) sel.value = id;
  if (editSel) editSel.value = id;
  renderReverseSysEditor();
  saveState();
}

async function saveReversePromptFromEditor() {
  const name = $("#revSysName").value.trim();
  const text = $("#revSysText").value.trim();
  if (!text) { toast("系统提示词不能为空"); return; }
  const cur = reverseEditingNew ? null : selectedReversePrompt();
  const payload = { id: cur ? cur.id : "", name: name || (cur ? cur.name : "未命名系统提示词"), text: text };
  const j = await api("/api/reverse-prompts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!j || !j.ok) { toast("保存失败：" + ((j && j.error) || "未知错误"), 5000); return; }
  state.reversePrompts = j.prompts || [];
  state.reversePromptId = (j.prompt && j.prompt.id) || j.defaultId || state.reversePromptId;
  reverseEditingNew = false;
  renderReversePromptSelect();
  saveState();
  toast("系统提示词已保存");
}

async function deleteReversePrompt() {
  const p = reverseEditingNew ? null : selectedReversePrompt();
  if (!p) { toast("没有选中系统提示词"); return; }
  if (!window.confirm("删除系统提示词「" + p.name + "」？")) return;
  const j = await api("/api/reverse-prompts?id=" + encodeURIComponent(p.id), { method: "DELETE" });
  if (!j || !j.ok) { toast("删除失败：" + ((j && j.error) || "未知错误")); return; }
  state.reversePrompts = j.prompts || [];
  state.reversePromptId = j.defaultId || (state.reversePrompts[0] && state.reversePrompts[0].id) || "default";
  reverseEditingNew = false;
  renderReversePromptSelect();
  saveState();
  toast("已删除系统提示词");
}

async function resetReversePrompts() {
  const j = await api("/api/reverse-prompts/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!j || !j.ok) { toast("恢复默认失败：" + ((j && j.error) || "未知错误")); return; }
  state.reversePrompts = j.prompts || [];
  state.reversePromptId = j.defaultId || "default";
  reverseEditingNew = false;
  renderReversePromptSelect();
  saveState();
  toast("内置系统提示词已恢复出厂文字");
}

/* ----- 参考图 ----- */
function setRevImageMeta(text, isErr) {
  const el = $("#revImgMeta");
  if (!el) return;
  el.textContent = text || "";
  el.className = "rev-hint" + (isErr ? " err" : "");
}

function setReverseImage(dataUrl, meta) {
  state.revImage = {
    dataUrl: dataUrl,
    mime: (meta && meta.mime) || "",
    width: (meta && meta.width) || 0,
    height: (meta && meta.height) || 0,
    source: (meta && meta.source) || null
  };
  const img = $("#revPreview");
  if (img) { img.src = dataUrl; img.hidden = false; }
  const empty = $("#revDropEmpty");
  if (empty) empty.hidden = true;
  const dims = state.revImage.width && state.revImage.height ? " · " + state.revImage.width + "×" + state.revImage.height : "";
  const size = meta && meta.bytes ? " · " + Math.round(meta.bytes / 1024) + "KB" : "";
  setRevImageMeta("参考图已就绪" + dims + size);
}

function clearReverseImage() {
  state.revImage = null;
  const img = $("#revPreview");
  if (img) { img.hidden = true; img.removeAttribute("src"); }
  const empty = $("#revDropEmpty");
  if (empty) empty.hidden = false;
  setRevImageMeta("还没有参考图");
}

/* 统一缩到最长边 1536：既省 token，也避免上游限制 base64 体积 */
function downscaleForReverse(dataUrl) {
  return new Promise(function (resolve) {
    const img = new Image();
    img.onload = function () {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const scale = Math.min(1, 1536 / Math.max(w, h));
      if (scale >= 1 && dataUrl.length < 4 * 1024 * 1024) {
        const m = /^data:([^;]+);/.exec(dataUrl);
        resolve({ dataUrl: dataUrl, mime: m ? m[1] : "image/png", width: w, height: h });
        return;
      }
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
      resolve({ dataUrl: canvas.toDataURL("image/jpeg", 0.9), mime: "image/jpeg", width: cw, height: ch });
    };
    img.onerror = function () { resolve(null); };
    img.src = dataUrl;
  });
}

async function handleReverseFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type || "")) {
    toast("只支持 png / jpeg / webp 图片");
    return;
  }
  if (file.size > 15 * 1024 * 1024) { toast("图片太大（上限 15MB）"); return; }
  setRevImageMeta("正在读图…");
  let dataUrl = "";
  try {
    dataUrl = await new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || "")); };
      fr.onerror = function () { reject(new Error("读图失败")); };
      fr.readAsDataURL(file);
    });
  } catch (e) {
    setRevImageMeta("读图失败，换一张试试", true);
    return;
  }
  const out = await downscaleForReverse(dataUrl);
  if (!out) { setRevImageMeta("这张图读不出来，换一张试试", true); return; }
  setReverseImage(out.dataUrl, {
    mime: out.mime,
    width: out.width,
    height: out.height,
    bytes: Math.round(out.dataUrl.length * 0.75),
    source: { kind: "upload", url: file.name || "" }
  });
}

async function loadReverseFromUrl() {
  const input = $("#revUrl");
  const url = input ? input.value.trim() : "";
  if (!url) { toast("先粘贴图片链接"); return; }
  setRevImageMeta("正在抓取图片链接…");
  const j = await api("/api/fetch-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url })
  });
  if (!j || !j.ok) { setRevImageMeta("抓取失败：" + ((j && j.error) || "未知错误"), true); return; }
  const out = await downscaleForReverse(j.dataUrl);
  if (!out) { setRevImageMeta("图片抓下来了但读不出来", true); return; }
  setReverseImage(out.dataUrl, {
    mime: out.mime,
    width: out.width,
    height: out.height,
    bytes: j.bytes,
    source: { kind: "url", url: j.finalUrl || url }
  });
}

/* ----- 反推 ----- */
function splitReverseResult(text) {
  const m = /(?:^|\n)\s*风格与质感\s*[：:]\s*/.exec(text);
  if (!m) return { style: "" };
  return { style: text.slice(m.index + m[0].length).trim() };
}

function defaultReverseName() {
  const d = new Date();
  const pad = function (n) { return String(n).padStart(2, "0"); };
  return "复刻风格 " + (d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function showReverseResult(text, meta) {
  const full = String(text || "").trim();
  const parts = splitReverseResult(full);
  $("#revResult").value = full;
  $("#revStyleText").value = parts.style || "";
  $("#revName").value = defaultReverseName();
  $("#revTags").value = "";
  $("#revResultWrap").hidden = false;
  const note = (meta && meta.strengthIgnored) ? "（服务商不支持强度参数，已自动忽略）" : "";
  setRevHint("复刻完成" + note + " · " + full.length + " 字；可以改完再保存或套用");
  try { $("#revResultWrap").scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) {}
}

async function runReverse() {
  if (state.revBusy) return;
  const p = revProvider();
  if (!p) { toast("先接入一个反推服务商（LLM）"); return; }
  if (!p.hasKey) {
    toast("这个服务商还没有密钥：点「＋」编辑填入，或写 .env 的 " + (p.envKey || "ZXT_KEY_…"), 6000);
    return;
  }
  if (!state.revImage || !state.revImage.dataUrl) { toast("先给一张参考图：上传 / 拖入 / 粘贴 / 链接都行"); return; }
  const sys = selectedReversePrompt();
  if (!sys || !String(sys.text || "").trim()) { toast("先选一个系统提示词（点「编辑」可以新增或修改）"); return; }
  const model = $("#revModelSel").value || state.llmModelId;
  if (!model) { toast("先选反推模型"); return; }

  state.revBusy = true;
  const btn = $("#revRun");
  if (btn) { btn.disabled = true; btn.textContent = "复刻中…"; }
  setRevHint("正在把参考图发给「" + p.name + " · " + model + "」…");
  try {
    const j = await api("/api/reverse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: p.id,
        model: model,
        systemPrompt: sys.text,
        systemPromptId: sys.id,
        imageDataUrl: state.revImage.dataUrl,
        instruction: $("#revInstruction").value.trim(),
        strength: state.llmStrength
      })
    });
    if (!j || !j.ok) {
      const msg = (j && j.error) || "未知错误";
      setRevHint("复刻失败：" + msg, true);
      toast("复刻失败：" + msg, 6000);
      return;
    }
    showReverseResult(j.text, j.meta);
  } finally {
    state.revBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = "开始复刻"; }
  }
}

/* ----- 风格预设 ----- */
function makeThumb(dataUrl) {
  if (!dataUrl) return Promise.resolve("");
  return new Promise(function (resolve) {
    const img = new Image();
    img.onload = function () {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const scale = Math.min(1, 320 / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = function () { resolve(""); };
    img.src = dataUrl;
  });
}

async function saveReverseAsStyle() {
  const prompt = $("#revResult").value.trim();
  if (!prompt) { toast("先反推出一段提示词"); return; }
  const name = $("#revName").value.trim() || defaultReverseName();
  const styleSuffix = $("#revStyleText").value.trim();
  const tags = $("#revTags").value.split(/[、,，;；\s]+/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 8);
  const p = revProvider();
  const sys = selectedReversePrompt();
  setRevHint("正在保存风格预设…");
  const thumb = await makeThumb(state.revImage ? state.revImage.dataUrl : "");
  const j = await api("/api/styles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: name,
      prompt: prompt,
      styleSuffix: styleSuffix,
      tags: tags,
      thumb: thumb,
      source: state.revImage ? state.revImage.source : null,
      llm: {
        providerId: p ? p.id : "",
        providerName: p ? p.name : "",
        model: state.llmModelId || "",
        strength: state.llmStrength,
        systemPromptId: sys ? sys.id : ""
      }
    })
  });
  if (!j || !j.ok) { setRevHint("保存失败：" + ((j && j.error) || "未知错误"), true); toast("保存失败：" + ((j && j.error) || ""), 5000); return; }
  state.stylePresets = j.styles || [];
  renderReverseStyles();
  setRevHint("已保存风格预设「" + name + "」");
  toast("已保存为风格预设「" + name + "」");
}

function useReverseResult(mode) {
  const prompt = $("#revResult").value.trim();
  const styleText = $("#revStyleText").value.trim();
  if (mode === "full" && !prompt) { toast("提示词是空的"); return; }
  if (mode === "suffix" && !styleText) { toast("风格段是空的：填一段，或改用「用这段提示词生成」"); return; }
  setActiveStyle({
    id: "",
    name: $("#revName").value.trim() || defaultReverseName(),
    mode: mode,
    prompt: prompt,
    styleSuffix: styleText
  });
  closeReverseModal();
  toast(mode === "full" ? "已切换为整段复刻提示词，点「生成」出图" : "已把风格段套到当前人物提示词末尾，点「生成」出图", 5000);
}

function applyStylePreset(s, mode) {
  if (mode === "suffix" && !String(s.styleSuffix || "").trim()) {
    toast("这条预设没有风格段，只能用「整段生成」");
    return;
  }
  setActiveStyle({ id: s.id || "", name: s.name || "", mode: mode, prompt: s.prompt || "", styleSuffix: s.styleSuffix || "" });
  closeReverseModal();
  toast(mode === "full" ? "已切换为预设「" + s.name + "」的整段提示词" : "已把「" + s.name + "」的风格段套到当前提示词末尾", 5000);
}

async function deleteStylePreset(s) {
  if (!window.confirm("删除风格预设「" + s.name + "」？")) return;
  const j = await api("/api/styles?id=" + encodeURIComponent(s.id), { method: "DELETE" });
  if (!j || !j.ok) { toast("删除失败：" + ((j && j.error) || "未知错误")); return; }
  state.stylePresets = j.styles || [];
  if (state.activeStyle && state.activeStyle.id === s.id) setActiveStyle(null);
  renderReverseStyles();
  toast("已删除风格预设");
}

function renderReverseStyles() {
  const host = $("#revStyleList");
  if (!host) return;
  host.textContent = "";
  const list = Array.isArray(state.stylePresets) ? state.stylePresets : [];
  const count = $("#revStyleCount");
  if (count) count.textContent = list.length ? list.length + " 个" : "—";
  if (!list.length) {
    host.appendChild(el("p", "rev-empty", "还没有保存的风格预设：反推完点「保存为风格预设」"));
    return;
  }
  list.forEach(function (s) {
    const row = el("div", "manage-row rev-style-row");
    if (s.thumb) {
      const img = document.createElement("img");
      img.className = "rev-thumb";
      img.alt = "";
      img.src = s.thumb;
      row.appendChild(img);
    } else {
      row.appendChild(el("div", "rev-thumb"));
    }
    const info = el("div", "manage-info rev-style-meta");
    info.appendChild(el("strong", null, s.name || "未命名风格"));
    const when = s.createdAt ? new Date(s.createdAt).toLocaleString() : "";
    const tags = (s.tags || []).join("、");
    const model = s.llm && s.llm.model ? s.llm.model : "";
    info.appendChild(el("span", "manage-sub", [tags, model, when].filter(Boolean).join(" · ") || "—"));
    row.appendChild(info);
    const acts = el("div", "rev-style-actions");
    const bFull = el("button", "text-btn", "整段生成");
    bFull.title = "用这条预设的完整提示词生图";
    bFull.addEventListener("click", function () { applyStylePreset(s, "full"); });
    const bSuffix = el("button", "text-btn", "套用风格");
    bSuffix.title = "只把风格段追加到当前人物提示词";
    bSuffix.addEventListener("click", function () { applyStylePreset(s, "suffix"); });
    const bDel = el("button", "text-btn danger", "删除");
    bDel.addEventListener("click", function () { deleteStylePreset(s); });
    acts.appendChild(bFull);
    acts.appendChild(bSuffix);
    acts.appendChild(bDel);
    row.appendChild(acts);
    host.appendChild(row);
  });
}

function openReverseModal() {
  reverseEditingNew = false;
  renderReverseProviders();
  renderReverseStyles();
  const strength = $("#revStrengthSel");
  if (strength) strength.value = state.llmStrength;
  $("#reverseModal").classList.add("on");
  if (state.llmProviderId && (state.llmModelsFor !== state.llmProviderId || !state.llmModels.length)) {
    loadReverseModels();
  }
}
function closeReverseModal() {
  $("#reverseModal").classList.remove("on");
}


/* ---------- archive ---------- */
function historyEmptyText() {
  return "生成的图会自动存进「output / 人物 / 男｜女｜中性」；悬停缩略图可移到回收站";
}
function renderArchive(items) {
  const strip = $("#historyStrip");
  strip.textContent = "";
  $("#archiveCount").textContent = items.length + " 张";
  if (!items.length) {
    strip.appendChild(el("p", "history-empty", historyEmptyText()));
    return;
  }
  items.slice(0, 40).forEach(function (it) {
    const wrap = el("div", "history-item");
    const img = document.createElement("img");
    img.src = "/files/" + encodeURIComponent(it.dir) + "/" + encodeURIComponent(it.file);
    img.loading = "lazy";
    const when = it.createdAt ? new Date(it.createdAt).toLocaleString() : "";
    img.title = when + "  " + (it.model || "") + (it.seed != null ? "  seed " + it.seed : "") + "\n点击在画布上预览，右上角 × 可移到回收站";
    img.addEventListener("click", function () {
      /* 生成中也可以点存档看旧图：先关掉“跟随最新”，免得下一张出来把画面抢走 */
      if (state.batch) {
        state.followLatest = false;
        updateFollowButton();
      }
      setPreviewImage(img.src);
    });
    wrap.appendChild(img);
    const del = el("button", "history-del", "×");
    del.title = "移到回收站（图片 + 同名 JSON，可恢复）";
    del.addEventListener("click", function (e) {
      e.stopPropagation();
      deleteArchiveItem(it);
    });
    wrap.appendChild(del);
    strip.appendChild(wrap);
  });
}

/* 存档列表会并发刷新（job-done 节流 + 批次结束 + 删除）：只认最后一次请求的结果，
   否则慢的旧响应回来会把刚出的图盖掉 */
let archiveSeq = 0;
let archiveFailToastAt = 0;
async function loadArchive() {
  const seq = ++archiveSeq;
  const j = await api("/api/archive");
  if (seq !== archiveSeq) return state.archives;
  const items = j && j.ok !== false && Array.isArray(j.items) ? j.items : null;
  if (!items) {
    /* 失败保留现有缩略图；一分钟内只提示一次，别刷屏 */
    if (Date.now() - archiveFailToastAt > 60000) {
      archiveFailToastAt = Date.now();
      toast("存档列表暂时没刷新出来（" + ((j && j.error) || "服务端没有返回结果") + "），稍后会自动再试", 5200);
    }
    return state.archives;
  }
  state.archives = items;
  renderArchive(items);
  return items;
}

/* ---------- 中栏画布：滚轮缩放 / 拖动平移 / 双击还原 ---------- */
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.25;
const zoom = {
  scale: 1, tx: 0, ty: 0, base: null,
  dragging: false, startX: 0, startY: 0, startTx: 0, startTy: 0
};

function previewReady() {
  const img = $("#preview");
  return !!(img && img.getAttribute("src") && img.naturalWidth);
}

/* 记录“整张适配”状态下图片在画布里的位置和尺寸，缩放/平移都基于它算 */
function measurePreview() {
  const sheet = $("#sheet"), img = $("#preview");
  if (!sheet || !img || !img.naturalWidth) { zoom.base = null; return null; }
  const W = sheet.clientWidth, H = sheet.clientHeight;
  const w = img.offsetWidth, h = img.offsetHeight;
  if (!W || !H || !w || !h) { zoom.base = null; return null; }
  zoom.base = { W: W, H: H, w: w, h: h, left: (W - w) / 2, top: (H - h) / 2 };
  return zoom.base;
}

/* 放大后画面不能拖丢：比画布大的一边贴边裁切，比画布小的一边保持居中 */
function clampZoomPan() {
  const b = zoom.base;
  if (!b) return;
  const w = b.w * zoom.scale, h = b.h * zoom.scale;
  if (w <= b.W) zoom.tx = (b.W - w) / 2 - b.left;
  else zoom.tx = Math.min(-b.left, Math.max(b.W - w - b.left, zoom.tx));
  if (h <= b.H) zoom.ty = (b.H - h) / 2 - b.top;
  else zoom.ty = Math.min(-b.top, Math.max(b.H - h - b.top, zoom.ty));
}

function applyZoom() {
  const img = $("#preview"), sheet = $("#sheet"), pct = $("#zoomPct");
  if (img) {
    img.style.transform = "translate(" + zoom.tx.toFixed(2) + "px," + zoom.ty.toFixed(2) + "px) scale(" + zoom.scale.toFixed(4) + ")";
  }
  if (sheet) sheet.classList.toggle("zoomed", zoom.scale > 1.0001);
  if (pct) {
    pct.textContent = Math.round(zoom.scale * 100) + "%";
    pct.classList.toggle("fit", Math.abs(zoom.scale - 1) < 0.001);
  }
  const out = $("#zoomOut"), inc = $("#zoomIn");
  if (out) out.disabled = zoom.scale <= ZOOM_MIN + 1e-6;
  if (inc) inc.disabled = zoom.scale >= ZOOM_MAX - 1e-6;
}

function resetZoom() {
  zoom.scale = 1;
  zoom.tx = 0;
  zoom.ty = 0;
  zoom.dragging = false;
  const sheet = $("#sheet");
  if (sheet) sheet.classList.remove("panning");
  measurePreview();
  applyZoom();
}

/* 以 (clientX, clientY) 为锚点缩放；不传坐标时以画布中心为锚点 */
function setZoom(next, clientX, clientY) {
  if (!previewReady()) { resetZoom(); return; }
  const b = measurePreview();
  if (!b) return;
  next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
  if (Math.abs(next - zoom.scale) < 1e-5) return;
  const sheet = $("#sheet");
  const rect = sheet.getBoundingClientRect();
  /* 整页缩放时 getBoundingClientRect 给的是缩放后的屏幕像素，先折回布局像素再算锚点 */
  const s = uiScale();
  const ox = clientX == null ? b.W / 2 : (clientX - rect.left) / s - sheet.clientLeft;
  const oy = clientY == null ? b.H / 2 : (clientY - rect.top) / s - sheet.clientTop;
  const u = ox - b.left;   /* 鼠标在“缩放前”图像坐标系里的位置 */
  const v = oy - b.top;
  const k = next / zoom.scale;
  zoom.tx = zoom.tx * k + u * (1 - k);
  zoom.ty = zoom.ty * k + v * (1 - k);
  zoom.scale = next;
  clampZoomPan();
  applyZoom();
}

function syncZoomTools() {
  const sheet = $("#sheet"), img = $("#preview"), tools = $("#zoomTools");
  const on = !!(sheet && img && sheet.classList.contains("has-image") && img.getAttribute("src"));
  if (tools) tools.hidden = !on;
  if (!on) {
    zoom.base = null;
    zoom.scale = 1;
    zoom.tx = 0;
    zoom.ty = 0;
    zoom.dragging = false;
    if (sheet) sheet.classList.remove("panning");
  } else {
    measurePreview();
    applyZoom();
  }
}

/* 所有“把图放到中栏”的地方都走这里：换图先回到整张适配 */
function setPreviewImage(src) {
  const img = $("#preview");
  if (!img || !src) return;
  img.src = src;
  $("#sheet").classList.add("has-image");
  resetZoom();
  syncZoomTools();
}

function clearPreview() {
  const p = $("#preview");
  p.removeAttribute("src");
  $("#sheet").classList.remove("has-image");
  resetZoom();
  syncZoomTools();
}

function initZoom() {
  const sheet = $("#sheet"), img = $("#preview");
  if (!sheet || !img) return;

  img.draggable = false;
  img.addEventListener("load", function () {
    resetZoom();
    syncZoomTools();
  });
  img.addEventListener("error", function () {
    zoom.base = null;
    syncZoomTools();
  });

  /* 滚轮：以鼠标为锚点放大/缩小；触控板捏合（ctrl+wheel）走同一条路 */
  sheet.addEventListener("wheel", function (e) {
    if (!previewReady()) return;
    e.preventDefault();
    const raw = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    setZoom(zoom.scale * Math.exp(-raw * 0.0018), e.clientX, e.clientY);
  }, { passive: false });

  /* 双击画面还原为整张适配 */
  sheet.addEventListener("dblclick", function () {
    if (previewReady()) resetZoom();
  });

  /* 放大后按住左键拖动平移 */
  img.addEventListener("pointerdown", function (e) {
    if (e.button !== 0 || zoom.scale <= 1.0001 || !previewReady()) return;
    zoom.dragging = true;
    zoom.startX = e.clientX;
    zoom.startY = e.clientY;
    zoom.startTx = zoom.tx;
    zoom.startTy = zoom.ty;
    sheet.classList.add("panning");
    try { img.setPointerCapture(e.pointerId); } catch (err) {}
  });
  img.addEventListener("pointermove", function (e) {
    if (!zoom.dragging) return;
    const s = uiScale();
    zoom.tx = zoom.startTx + (e.clientX - zoom.startX) / s;
    zoom.ty = zoom.startTy + (e.clientY - zoom.startY) / s;
    clampZoomPan();
    applyZoom();
    e.preventDefault();
  });
  function endDrag(e) {
    if (!zoom.dragging) return;
    zoom.dragging = false;
    sheet.classList.remove("panning");
    try { img.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  img.addEventListener("pointerup", endDrag);
  img.addEventListener("pointercancel", endDrag);

  $("#zoomIn").addEventListener("click", function () { setZoom(zoom.scale * ZOOM_STEP); });
  $("#zoomOut").addEventListener("click", function () { setZoom(zoom.scale / ZOOM_STEP); });
  $("#zoomPct").addEventListener("click", resetZoom);
  $("#zoomFit").addEventListener("click", resetZoom);

  /* 窗口尺寸变化后按新画布重新测量，并把平移量夹回可见范围 */
  window.addEventListener("resize", function () {
    if (!previewReady()) return;
    measurePreview();
    clampZoomPan();
    applyZoom();
  });

  applyZoom();
}

let archiveDeleting = false;
async function deleteArchiveItem(it) {
  if (archiveDeleting) return;
  const name = it.file || it.id || "这张图";
  let ok = false;
  try {
    ok = await askConfirm({
      title: "移到回收站？",
      note: name + "\n\n图片和同名 JSON 会移到「output / _回收站 / 人物」里，存档列表与 index.json 同步移除。需要恢复时，把文件从回收站移回原目录即可。",
      okText: "移到回收站",
      danger: true
    });
  } catch (e) {
    ok = false;
  }
  if (!ok) return;
  archiveDeleting = true;
  try {
    const j = await api("/api/archive/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ dir: it.dir, file: it.file, id: it.id }] })
    });
    if (!j || !j.ok) {
      toast("删除失败：" + ((j && j.error) || "服务端没有返回结果，重启一下启动.bat 再试"), 4600);
      return;
    }
    const moved = (j.deleted && j.deleted.length) || 0;
    const missing = (j.missing && j.missing.length) || 0;
    const failed = (j.failed && j.failed.length) ? j.failed[0] : null;
    if (failed) {
      toast("删除失败：" + (failed.error || "未知原因"), 4600);
    } else if (!moved && missing) {
      toast("服务端那边文件已经不在了，已刷新存档列表", 3600);
    } else {
      const trashPath = (j.trashPath || j.trashDir) || "output/_回收站";
      toast("已移到回收站：" + name + "（" + trashPath + "）", 4200);
      const cur = $("#preview").getAttribute("src") || "";
      if (cur && cur.indexOf(encodeURIComponent(it.file)) >= 0) clearPreview();
    }
    await loadArchive();
    if ($("#trashModal") && $("#trashModal").classList.contains("on")) loadTrash();
  } catch (e) {
    toast("删除失败：" + String((e && e.message) || e), 4600);
  } finally {
    // 无论成功、失败还是异常都要解锁，否则之后点 × 会“完全没反应”
    archiveDeleting = false;
  }
}

/* ---------- trash（回收站） ---------- */
let trashItems = [];
function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
async function openTrash() {
  $("#trashModal").classList.add("on");
  await loadTrash();
}
async function loadTrash() {
  const list = $("#trashList");
  const countEl = $("#trashCount");
  if (!list) return;
  const j = await api("/api/trash");
  if (!j || !j.ok) {
    trashItems = [];
    if (countEl) countEl.textContent = "—";
    list.innerHTML = '<p class="trash-empty-note">读取回收站失败：' + escapeHtml((j && j.error) || "服务端还没有这个接口，重启一下启动.bat 再试") + "</p>";
    return;
  }
  trashItems = j.items || [];
  if (countEl) countEl.textContent = trashItems.length + " 个文件 · " + (j.trashDir || "output/_回收站");
  if (!trashItems.length) {
    list.innerHTML = '<p class="trash-empty-note">回收站是空的。删除存档时文件会先放到这里，不会立刻消失。</p>';
    return;
  }
  list.textContent = "";
  trashItems.forEach(function (it) {
    const row = el("div", "trash-row");
    const img = document.createElement("img");
    img.className = "trash-thumb";
    img.loading = "lazy";
    img.alt = "";
    img.src = "/files/" + encodeURIComponent(it.rel || "");
    img.addEventListener("error", function () {
      img.style.display = "none";
    });
    row.appendChild(img);
    const info = el("div", "trash-info");
    const title = el("div", "trash-name", (it.name ? it.name + " · " : "") + (it.file || ""));
    title.title = it.rel || it.file || "";
    info.appendChild(title);
    const bits = [];
    if (it.dir) bits.push("原目录 " + it.dir);
    if (it.mtime) bits.push(new Date(it.mtime).toLocaleString());
    if (it.size != null) bits.push(fmtSize(it.size));
    info.appendChild(el("div", "trash-meta", bits.join(" · ")));
    row.appendChild(info);
    if (it.hasJson) row.appendChild(el("span", "trash-badge", "含 JSON"));
    list.appendChild(row);
  });
}
async function emptyTrash() {
  if (!trashItems.length) {
    toast("回收站已经是空的");
    return;
  }
  const ok = await askConfirm({
    title: "清空回收站？",
    note: "回收站里的 " + trashItems.length + " 项（图片 + 同名 JSON）将被永久删除，清空后无法恢复。",
    okText: "清空",
    danger: true
  });
  if (!ok) return;
  const j = await api("/api/trash/empty", { method: "POST" });
  if (!j || !j.ok) {
    toast("清空失败：" + ((j && j.error) || "服务端还没有这个接口，重启一下启动.bat 再试"));
    return;
  }
  toast("已清空回收站：" + ((j && j.removed) || trashItems.length) + " 个文件已永久删除", 4200);
  await loadTrash();
}
async function openTrashDir() {
  const j = await api("/api/trash/open", { method: "POST" });
  if (j && j.ok) toast("已打开回收站目录：" + j.path);
  else toast("回收站目录：本目录 / output / _回收站");
}

/* ---------- status ---------- */
function setStatus(text, isErr) {
  const n = $("#statusText");
  n.textContent = text;
  n.className = isErr ? "err" : "";
}
function toast(text, ms) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove("on"); }, ms || 3200);
}
function setBusy(on) {
  state.busy = on;
  $("#sheet").classList.toggle("loading-on", on);
  const b = $("#generateBtn");
  if (!b) return;
  b.textContent = on ? "停 止" : "生 成";
  b.classList.toggle("stopping", on);
  b.disabled = !on && !state.modelId;
  if (on) {
    const lt = $("#loadingText");
    if (lt) lt.textContent = "正在生成…";
  }
}
/* 生成按钮 = 批次开关：有批次（本机发起的或刷新后接管的）就是「停 止」 */
function updateGenButton() {
  const b = $("#generateBtn");
  if (!b) return;
  const running = !!(state.batch && !state.batch.finished) || state.busy;
  b.textContent = running ? "停 止" : "生 成";
  b.classList.toggle("stopping", running);
  b.disabled = !running && !state.modelId;
  updateBatchStatus();
}

/* ---------- gender dir ---------- */
function genderDir() {
  const s = currentSex();
  return s === "female" ? "女" : s === "male" ? "男" : "中性";
}

/* ---------- generate ---------- */
function batchLimit() {
  return Math.max(1, Math.min(10, Number(state.batchCount) || 1));
}

function fileUrlOf(rel, file) {
  const parts = String(rel || "").split("/").filter(function (x) { return x; }).map(encodeURIComponent);
  return "/files/" + parts.join("/") + "/" + encodeURIComponent(file);
}

/* 发请求前把这一张要用的状态拍成快照：并发生成时，后面的 reroll 不会影响前面这一张 */
function snapshotJob(idx, total) {
  const size = sizeString();
  /* 一张图只算一次提示词：prompt / 字数 / 段列表都来自同一份快照 */
  const snap = buildPromptSnapshot();
  return {
    idx: idx,
    total: total,
    providerId: state.providerId,
    model: state.modelId,
    prompt: snap.text,
    size: size,
    quality: state.quality === "auto" ? undefined : state.quality,
    retries: 3,
    gender: genderDir(),
    /* 存档里要记下这一张当时的画幅/比例/细节档，便于事后复现提示词 */
    promptMeta: {
      layout: state.templateId,
      layoutLabel: currentTemplate().label,
      ratio: state.ratio,
      res: state.res,
      size: size,
      detailPreset: state.detailPreset,
      blocksEnabled: state.blocks.filter(function (b) { return b.enabled && !isBlockSuppressed(b.id); }).map(function (b) { return b.id; }),
      length: snap.stats.chars,
      era: state.params.era || "none",
      role: state.params.role || "none",
      rank: state.params.rank || "none",
      costumeChars: (buildVars().costume || "").length,
      evidence: currentLookEvidence(),
      /* 存档里记下这次用的是复刻提示词还是风格段，便于事后复现 */
      style: snap.style || null,
      externalPrompt: !!snap.external
    },
    filenameHint: (state.meta.name || "无名") + "_" + state.params.height + "cm_" + currentTemplate().label,
    character: {
      seed: state.seed,
      params: JSON.parse(JSON.stringify(state.params)),
      meta: JSON.parse(JSON.stringify(state.meta)),
      highlights: JSON.parse(JSON.stringify(state.highlights || [])),
      lookId: state.lookId || "",
      template: state.templateId,
      size: size
    }
  };
}

/* 服务端批量接口：一个请求带 N 个任务，服务端同时向上游发起 N 个请求；
   响应是逐行 NDJSON（batch-start / job-start / job-done / batch-done），边收边更新进度 */
async function streamBatch(jobs, onEvent, signal) {
  function isAbort(e) { return !!(e && (e.name === "AbortError" || e.code === 20)); }
  let res;
  try {
    res = await fetch("/api/generate-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: jobs[0].providerId, jobs: jobs }),
      signal: signal
    });
  } catch (e) {
    /* 「停止」会 abort 这条流：这是正常收尾，不要把 AbortError 抛给上层 */
    if (isAbort(e)) return { aborted: true };
    throw e;
  }
  if (!res.ok) {
    let msg = "HTTP " + res.status;
    try {
      const j = JSON.parse(await res.text());
      if (j && j.error) msg = j.error;
    } catch (e) {}
    throw new Error(msg);
  }
  if (!res.body || !res.body.getReader) {
    let text = "";
    try { text = await res.text(); } catch (e) {
      if (isAbort(e)) return { aborted: true };
      throw e;
    }
    text.split("\n").forEach(function (line) {
      if (!line.trim()) return;
      try { onEvent(JSON.parse(line)); } catch (e) {}
    });
    return { aborted: false };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.value) buf += dec.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try { onEvent(JSON.parse(line)); } catch (e) {}
      }
      if (chunk.done) break;
    }
  } catch (e) {
    if (isAbort(e)) return { aborted: true };
    throw e;
  } finally {
    try { reader.cancel().catch(function () {}); } catch (e) {}
  }
  return { aborted: false };
}

/* 上一批失败的 job 快照，供「重试失败张」用 */
let failedJobs = [];

function updateRetryButton() {
  const b = $("#retryFailed");
  if (!b) return;
  const n = failedJobs.length;
  b.hidden = state.busy || !!state.batch || n === 0;
  if (n) b.textContent = "↻ 重试失败 " + n + " 张";
}

/* ---------- 批次状态机 ----------
   state.batch 是服务端批次在页面里的镜像：batch-start 建立，batch-done / 停止 / 超时 / 404 收尾。
   所有收尾都走 finalizeBatch（幂等），保证任何异常都不会把「生成中」卡死。
   刷新页面后由 boot() 调 /api/batch/active 接管还在跑的批次（owned:false）。 */
let activeStream = null;     /* 当前 NDJSON 流：{ controller } */
let batchPollTimer = 0;      /* 2 秒对账 /api/batch/:id */
let batchTicker = 0;         /* 1 秒刷新胶囊里的用时 */
let deadlineTimer = 0;       /* 硬截止：服务端 deadlineMs + 60 秒 */
let cancelWatchTimer = 0;    /* 停止后静默等服器结束 */
let batchFinalized = true;   /* 幂等收尾标记 */
let batchSummary = null;     /* 收尾要播报的统计 */
const BATCH_POLL_MS = 2000;
const DEADLINE_GRACE_MS = 60000;
const DEADLINE_FALLBACK_MS = 12 * 60 * 1000;

function fmtClock(ts) {
  const d = new Date(Number(ts) || Date.now());
  return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
}
function batchSecs(b) {
  return Math.max(0, Math.round((Date.now() - (b.startedAt || Date.now())) / 1000));
}

function stopBatchTimers() {
  if (batchTicker) { clearInterval(batchTicker); batchTicker = 0; }
  if (batchPollTimer) { clearInterval(batchPollTimer); batchPollTimer = 0; }
  if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = 0; }
}
function startBatchTimers(withPoll) {
  stopBatchTimers();
  batchTicker = setInterval(updateBatchStatus, 1000);
  if (withPoll) batchPollTimer = setInterval(pollBatch, BATCH_POLL_MS);
}
function armDeadline(deadlineMs) {
  if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = 0; }
  const wait = Number(deadlineMs) > 0 ? Number(deadlineMs) + DEADLINE_GRACE_MS : DEADLINE_FALLBACK_MS;
  deadlineTimer = setTimeout(function () {
    deadlineTimer = 0;
    if (!state.batch) return;
    const ctrl = activeStream && activeStream.controller;
    if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    finalizeBatch("timeout");
  }, wait);
}

/* 胶囊 + 状态栏进度（按钮文案归 updateGenButton 管） */
function updateBatchStatus() {
  const b = state.batch;
  if (!b) return;
  const secs = batchSecs(b);
  const lt = $("#loadingText");
  let pill;
  if (!b.owned) pill = "后台批次 · " + b.done + "/" + b.total + " · " + secs + " 秒";
  else if (b.total > 1) pill = "生成中 · 完成 " + b.done + "/" + b.total + " 张 · 进行中 " + b.active + " 张 · " + secs + " 秒";
  else pill = "生成中 · " + (b.size || "") + " · " + secs + " 秒";
  if (lt) lt.textContent = pill;
  /* 接管的批次不每秒刷状态栏，保留「本机还有一批在生成…开始于 hh:mm」 */
  if (b.owned && b.total > 1) {
    setStatus("生成中 · 完成 " + b.done + "/" + b.total + " 张 · 进行中 " + b.active + " 张 · 失败 " + b.fail + " · 用时 " + secs + " 秒");
  }
}

function updateFollowButton() {
  const btn = $("#followLatest");
  if (!btn) return;
  btn.hidden = state.followLatest || !state.batch;
}

/* 「回到最新」：把画布切回这一批最近出的图（没有就退回存档第一张） */
function showLatestImage() {
  state.followLatest = true;
  updateFollowButton();
  const b = state.batch;
  if (b && b.lastUrl) { setPreviewImage(b.lastUrl); return; }
  if (state.archives && state.archives.length) {
    const it = state.archives[0];
    setPreviewImage("/files/" + encodeURIComponent(it.dir) + "/" + encodeURIComponent(it.file));
    return;
  }
  toast("这一批还没有出图");
}

/* 服务端没发 batch-start（旧版服务/异常流）时也先建一个本地镜像，保证停止按钮有东西可停 */
function ensureRuntimeBatch(total, startedAt, jobs, mode) {
  if (state.batch) return state.batch;
  state.batch = {
    id: "",
    total: Math.max(1, Number(total) || 1),
    concurrency: 0,
    done: 0, ok: 0, fail: 0, active: 0,
    startedAt: startedAt || Date.now(),
    finished: false, cancelled: false, owned: true,
    size: jobs && jobs[0] ? jobs[0].size : "",
    mode: mode || "batch",
    lastUrl: ""
  };
  updateGenButton();
  updateFollowButton();
  return state.batch;
}

/* 用服务端快照校正本地：计数只取较大值，避免轮询把刚收到的事件回退掉 */
function applyServerBatch(b, s) {
  if (!b || !s) return;
  if (Number(s.total)) b.total = Math.max(b.total || 0, Number(s.total));
  b.done = Math.max(b.done || 0, Number(s.done) || 0);
  b.ok = Math.max(b.ok || 0, Number(s.ok) || 0);
  b.fail = Math.max(b.fail || 0, Number(s.fail) || 0);
  if (s.active != null) b.active = Math.max(0, Number(s.active) || 0);
  if (Number(s.concurrency)) b.concurrency = Number(s.concurrency);
  if (Number(s.startedAt)) b.startedAt = Number(s.startedAt);
  if (s.cancelled) b.cancelled = true;
  if (s.finishedAt) { b.finished = true; b.finishedAt = Number(s.finishedAt) || Date.now(); }
}

async function fetchBatchState(id) {
  if (!id) return { kind: "error" };
  let res;
  try {
    res = await fetch("/api/batch/" + encodeURIComponent(id), { cache: "no-store" });
  } catch (e) {
    return { kind: "error" }; /* 网络错误忽略，等下一次轮询 */
  }
  if (res.status === 404) return { kind: "missing" };
  let j = null;
  try { j = await res.json(); } catch (e) { return { kind: "error" }; }
  if (!j || !j.ok || !j.batch) return { kind: "error" };
  return { kind: "ok", batch: j.batch };
}

async function pollBatch() {
  const b = state.batch;
  if (!b || b.polling) return;
  b.polling = true;
  try {
    const r = await fetchBatchState(b.id);
    if (r.kind === "missing") { finalizeBatch("interrupted"); return; }
    if (r.kind !== "ok") return;
    applyServerBatch(b, r.batch);
    if (!b.owned) {
      setStatus("本机还有一批在生成 " + b.done + "/" + b.total + "，开始于 " + fmtClock(b.startedAt));
    }
    updateBatchStatus();
    if (b.finished) finalizeBatch(b.cancelled ? "stopped" : "done");
  } finally {
    b.polling = false;
  }
}

/* 幂等收尾：任何路径（正常结束/停止/超时/404/异常）都走这里，保证画布与按钮解锁 */
function finalizeBatch(reason) {
  if (batchFinalized) return;
  batchFinalized = true;
  const b = state.batch;
  const sum = batchSummary || (b ? {
    mode: b.mode, total: b.total, isBatch: (b.total || 0) > 1,
    ok: b.ok, fail: b.fail, startedAt: b.startedAt, failures: []
  } : null);
  batchSummary = null;
  stopBatchTimers();
  if (activeStream && activeStream.controller) {
    try { activeStream.controller.abort(); } catch (e) {}
  }
  activeStream = null;
  state.batch = null;
  state.activeGen = 0;
  setBusy(false);
  updateFollowButton();
  updateRetryButton();
  updateGenButton();
  loadArchive();

  const secs = sum ? Math.round((Date.now() - (sum.startedAt || Date.now())) / 1000) : 0;
  if (reason === "stopped") {
    setStatus("已停止" + (sum && sum.ok ? "：已经出的 " + sum.ok + " 张都在存档里" : ""));
    toast("已停止这一批" + (sum && sum.ok ? "（已出的图都已存档）" : ""));
    return;
  }
  if (reason === "timeout") {
    setStatus("本批超时，已停止等待；已经出的图都在存档里", true);
    toast("本批超时，已停止等待；已经出的图都在存档里", 6000);
    return;
  }
  if (reason === "interrupted") {
    setStatus("批次状态在服务端找不到了（可能服务重启过）；已经出的图都在存档里", true);
    toast("批次状态丢失（可能服务重启过），已经出的图都在存档里", 6000);
    return;
  }
  /* 刷新后接管的批次 */
  if (b && !b.owned) {
    setStatus("后台批次完成 · 成功 " + (b.ok || 0) + "/" + (b.total || 0) + " 张 · 用时 " + secs + " 秒");
    toast("后台批次已完成：成功 " + (b.ok || 0) + " / " + (b.total || 0) + " 张", 5000);
    return;
  }
  /* 本机发起的批次 */
  const label = sum && sum.mode === "retry" ? "重试" : "并发生成";
  const total = (sum && sum.total) || 0;
  const ok = (sum && sum.ok) || 0;
  const fail = (sum && sum.fail) || 0;
  const failures = (sum && sum.failures) || [];
  const noAccounts = failures.some(function (f) { return f.code === "no_accounts"; });
  const hint = noAccounts ? "（上游账号池暂无可用账号，等 1–5 分钟再点「重试失败」）" : "";
  const failedNote = fail
    ? "，失败 " + fail + " 张" + (failures[0] ? "（" + failures[0].job.model + "：" + failures[0].error + "）" : "") + hint
    : "";
  if (sum && sum.isBatch) {
    setStatus(label + "完成 " + ok + "/" + total + " 张" + failedNote + " · 用时 " + secs + " 秒", fail > 0 && ok === 0);
    if (state.followLatest) {
      toast(fail ? label + "完成 " + ok + " 张，失败 " + fail + " 张" + hint : label + "完成 " + ok + " 张 · 用时 " + secs + " 秒", fail ? 8000 : 4200);
    } else {
      /* 用户正在看旧图：不抢画面，只提示 */
      toast("本批已完成 " + ok + "/" + total + " 张，点下方存档查看新图" + hint, 5200);
    }
  } else if (fail) {
    setStatus(state.lastError + hint, true);
    toast(state.lastError + hint, 7000);
  }
  state.lastError = "";
  updateRetryButton();
}

/* 真停止：abort 本页的流 + 通知服务端取消没开跑的任务 + 立刻解锁，之后静默等服器收尾 */
function stopBatch() {
  const b = state.batch;
  if (!b && !state.busy) return;
  if (b) {
    b.cancelled = true;
    if (b.id) {
      try {
        fetch("/api/batch/" + encodeURIComponent(b.id) + "/cancel", { method: "POST" }).catch(function () {});
      } catch (e) {}
    }
  }
  const ctrl = activeStream && activeStream.controller;
  if (ctrl) { try { ctrl.abort(); } catch (e) {} }
  const id = b && b.id;
  finalizeBatch("stopped");
  if (id) {
    if (cancelWatchTimer) { clearInterval(cancelWatchTimer); cancelWatchTimer = 0; }
    let tries = 0;
    cancelWatchTimer = setInterval(async function () {
      tries++;
      const r = await fetchBatchState(id);
      if (r.kind !== "ok" || r.batch.finishedAt || tries >= 40) {
        clearInterval(cancelWatchTimer);
        cancelWatchTimer = 0;
        loadArchive(); /* 服务端把已经开画的收完尾后，再刷一次存档 */
      }
    }, 3000);
  }
}

/* 刷新页面后接管：/api/batch/active 里还有未完成批次就接着显示进度（不锁画布） */
async function takeoverActiveBatch() {
  let j = null;
  try { j = await api("/api/batch/active"); } catch (e) { return false; }
  const list = j && j.ok && Array.isArray(j.batches) ? j.batches : [];
  const s = list.filter(function (x) { return x && x.id && !x.finishedAt; }).pop();
  if (!s) return false;
  batchFinalized = false;
  batchSummary = null;
  state.followLatest = true;
  state.batch = {
    id: s.id,
    total: Number(s.total) || 0,
    concurrency: Number(s.concurrency) || 0,
    done: Number(s.done) || 0,
    ok: Number(s.ok) || 0,
    fail: Number(s.fail) || 0,
    active: Number(s.active) || 0,
    startedAt: Number(s.startedAt) || Date.now(),
    finished: false,
    cancelled: !!s.cancelled,
    owned: false,
    size: "",
    mode: "batch",
    lastUrl: ""
  };
  updateFollowButton();
  updateGenButton();
  startBatchTimers(true);
  updateBatchStatus();
  setStatus("本机还有一批在生成 " + state.batch.done + "/" + state.batch.total + "，开始于 " + fmtClock(state.batch.startedAt));
  return true;
}

/* 跑一批 job（mode = "batch" 新批次 / "retry" 重试失败张）
   整段包在 try/finally 里：成功、失败、被停止、异常，最后都走 finalizeBatch 解锁画布 */
async function runBatch(jobs, mode) {
  if (state.batch) { toast("已有一批在生成中，先点停止再试"); return; }
  const total = jobs.length;
  const isBatch = total > 1;
  const label = mode === "retry" ? "重试" : "并发生成";
  const startedAt = Date.now();
  const failures = [];
  const resultsByIdx = new Map();
  const doneIdx = new Set();
  let lastArchiveAt = 0;
  let streamError = "";
  let reason = "done";
  let okCount = 0;
  let failCount = 0;
  let activeCount = 0;

  state.activeGen = 0;
  state.lastError = "";
  batchFinalized = false;
  batchSummary = null;
  state.followLatest = true;
  ensureRuntimeBatch(total, startedAt, jobs, mode);
  const ctrl = new AbortController();
  activeStream = { controller: ctrl };
  startBatchTimers(false);
  /* 拿不到服务端的 deadlineMs 时也按 12 分钟兜底，别让「生成中」无限转 */
  armDeadline(0);
  updateFollowButton();
  setBusy(true);
  updateRetryButton();

  if (isBatch) {
    toast(mode === "retry" ? "开始重试 " + total + " 张失败的图（已按错误类型拉长重试间隔）" : "开始并发生成 " + total + " 张：每张都是新随机人物");
  } else {
    setStatus("已提交：「" + jobs[0].model + "」" + jobs[0].size + "，等待出图中…");
  }

  try {
    const sres = await streamBatch(jobs, function (ev) {
      if (!ev || !ev.type) return;
      const b = state.batch || ensureRuntimeBatch(total, startedAt, jobs, mode);
      if (ev.type === "batch-start") {
        if (ev.batchId) b.id = ev.batchId;
        b.total = Math.max(Number(ev.total) || 0, b.total || total, total);
        if (ev.concurrency) b.concurrency = Number(ev.concurrency) || b.concurrency;
        if (ev.deadlineMs) armDeadline(ev.deadlineMs);
        /* 有了 batchId 才开始 2 秒对账 */
        startBatchTimers(true);
        updateGenButton();
      } else if (ev.type === "job-start") {
        activeCount++;
        b.active = activeCount;
        state.activeGen = activeCount;
      } else if (ev.type === "job-done") {
        activeCount = Math.max(0, activeCount - 1);
        b.active = activeCount;
        state.activeGen = activeCount;
        if (!doneIdx.has(ev.idx)) {
          doneIdx.add(ev.idx);
          if (ev.ok) { okCount++; b.ok = Math.max(b.ok, okCount); }
          else { failCount++; b.fail = Math.max(b.fail, failCount); }
        }
        b.done = Math.max(b.done, okCount + failCount);
        if (ev.ok) {
          const url = fileUrlOf(ev.rel, ev.file);
          resultsByIdx.set(ev.idx, url);
          b.lastUrl = url;
          /* 只有“跟随最新”时才抢画面；用户点存档看旧图时不抢 */
          if (state.followLatest) setPreviewImage(url);
          if (!isBatch) setStatus("已存档 → " + ev.dir + " / " + ev.file);
          const now = Date.now();
          if (now - lastArchiveAt > 1200) { lastArchiveAt = now; loadArchive(); }
        } else {
          failures.push({ idx: ev.idx, job: jobs[ev.idx], error: ev.error, code: ev.code || "upstream_error" });
          state.lastError = "「" + jobs[0].model + "」" + (ev.error || "生成失败");
        }
      } else if (ev.type === "heartbeat") {
        b.done = Math.max(b.done, Number(ev.done) || 0);
        b.ok = Math.max(b.ok, Number(ev.ok) || 0);
        b.fail = Math.max(b.fail, Number(ev.fail) || 0);
        if (ev.active != null) {
          b.active = Math.max(0, Number(ev.active) || 0);
          activeCount = b.active;
          state.activeGen = activeCount;
        }
      } else if (ev.type === "batch-done") {
        b.finished = true;
        b.finishedAt = Number(ev.finishedAt) || Date.now();
        if (Number(ev.total)) b.total = Number(ev.total);
        b.ok = Math.max(b.ok, Number(ev.ok) || 0);
        b.fail = Math.max(b.fail, Number(ev.fail) || 0);
        if (Number(ev.cancelled) > 0 || b.cancelled) b.cancelled = true;
      } else if (ev.type === "batch-error") {
        streamError = ev.error || "批次异常";
        state.lastError = label + "失败：" + streamError;
      }
      updateBatchStatus();
    }, ctrl.signal);

    if (sres && sres.aborted) reason = "stopped";
    if (batchFinalized) return;           /* stopBatch 已经提前收尾了 */
    if (state.batch && state.batch.cancelled) reason = "stopped";

    if (reason !== "stopped") {
      /* 没收到结果的 job 也归入“失败”，可以重试 */
      jobs.forEach(function (job, idx) {
        if (doneIdx.has(idx)) return;
        if (failures.some(function (f) { return f.idx === idx; })) return;
        failures.push({ idx: idx, job: job, error: streamError || "没有收到结果", code: "stream_error" });
      });
      failCount = failures.length;
      okCount = Math.max(okCount, Math.min(total, total - failCount));
      failedJobs = failures.map(function (f) { return f.job; });
    }

    /* 新批次结束后把画布切回“第 N 张”（左侧参数对应的就是它）；重试批次保持最近完成的 */
    if (reason === "done" && mode === "batch" && isBatch && state.followLatest) {
      const lastUrl = resultsByIdx.get(total);
      if (lastUrl) setPreviewImage(lastUrl);
    }

    const b = state.batch;
    if (b) {
      b.ok = Math.max(b.ok, okCount);
      b.fail = Math.max(b.fail, failCount);
      b.done = Math.max(b.done, okCount + failCount);
    }
    batchSummary = { mode: mode, total: total, isBatch: isBatch, ok: okCount, fail: failCount, startedAt: startedAt, failures: failures };
  } catch (e) {
    if (e && (e.name === "AbortError" || e.code === 20)) reason = "stopped";
    else {
      streamError = String((e && e.message) || e);
      state.lastError = label + "请求失败：" + streamError;
    }
    batchSummary = batchSummary || { mode: mode, total: total, isBatch: isBatch, ok: okCount, fail: failures.length, startedAt: startedAt, failures: failures };
  } finally {
    /* 任何异常都不能把 busy 和胶囊卡住 */
    finalizeBatch(reason);
  }
}

async function generate() {
  /* 有批次时这个按钮就是「停止」 */
  if (state.batch) { stopBatch(); return; }
  /* 极端情况：批次还没收到 batch-start，也要能停 */
  if (state.busy) { stopBatch(); return; }
  if (!state.modelId) { toast("先选一个模型"); return; }
  if (currentTemplate().requiresEra && !eraOn()) { toast("服饰拆解需要先选择时代与身份卡"); revealParam("era"); return; }
  const firstSnap = buildPromptSnapshot();
  if (!firstSnap.text.trim()) { toast("提示词是空的"); return; }
  if (firstSnap.unknown.length) {
    toast("提示词里有 " + firstSnap.unknown.length + " 个未知变量（" + firstSnap.unknown.map(function (u) { return "{{" + u.key + "}}"; }).join(" ") + "），已拦截；先到「体检」里修正", 5200);
    openHealth();
    return;
  }

  const n = batchLimit();

  /* 先把这一批要用的“人物快照”全部定下来：多张时每张都是新随机人物。
     重掷走静默模式（不重绘、不逐张落盘），全部拍完再统一刷新一次。 */
  const jobs = [];
  for (let i = 0; i < n; i++) {
    if (n > 1) rerollAll(undefined, { silent: true });
    jobs.push(snapshotJob(i + 1, n));
  }
  if (n > 1) syncAll();

  failedJobs = [];
  updateRetryButton();
  await runBatch(jobs, "batch");
}

/* 用原人物参数、原提示词重试上一批失败的图（不重新随机人物） */
async function retryFailed() {
  if (state.batch || state.busy) { toast("正在生成中，等这批结束再试"); return; }
  if (!failedJobs.length) { toast("没有需要重试的图"); return; }
  const jobs = failedJobs.slice();
  failedJobs = [];
  updateRetryButton();
  await runBatch(jobs, "retry");
}

/* ---------- init ---------- */
function bindUI() {
  $("#generateBtn").addEventListener("click", generate);

  $("#rerollAll").addEventListener("click", function () {
    rerollAll();
    toast("已随机人物 · 种子 " + state.seed);
  });

  $("#unlockAll").addEventListener("click", function () {
    state.locks.clear();
    renderParams();
    saveState();
    toast("已全部解锁");
  });

  /* v5 · 参数工具栏 / 档案 / 词典 / 体检 */
  /* P0：搜索防抖 120ms（原来每敲一个字整栏重建一次） */
  let paramSearchTimer = 0;
  $("#paramSearch").addEventListener("input", function (e) {
    const q = e.target.value.trim();
    clearTimeout(paramSearchTimer);
    paramSearchTimer = setTimeout(function () {
      if (state.paramQuery === q) return;
      state.paramQuery = q;
      renderParams();
    }, 120);
  });
  $("#paramFilters").addEventListener("click", function (e) {
    const b = e.target.closest("[data-tier]");
    if (!b) return;
    state.tierFilter = b.dataset.tier;
    renderParams();
  });
  $("#presetSeg").addEventListener("click", function (e) {
    const b = e.target.closest("[data-preset]");
    if (!b) return;
    applyDetailPreset(b.dataset.preset);
  });
  const densitySeg = $("#densitySeg");
  if (densitySeg) densitySeg.addEventListener("click", function (e) {
    const b = e.target.closest("[data-density]");
    if (!b) return;
    state.viewDensity = b.dataset.density === "full" ? "full" : "summary";
    renderParams();
    saveState();
    toast(state.viewDensity === "full" ? "已切到全展开（旧观感）" : "已切到摘要行（一行一项，点开才展开）");
  });
  $("#dictBtn").addEventListener("click", openDict);
  $("#dictClose").addEventListener("click", function () { $("#dictModal").classList.remove("on"); });
  $("#dictModal").addEventListener("click", function (e) { if (e.target.id === "dictModal") e.target.classList.remove("on"); });
  $("#dictSearch").addEventListener("input", function (e) { dictQuery = e.target.value.trim(); renderDict(); });
  $("#dictTabs").addEventListener("click", function (e) {
    const b = e.target.closest("[data-scope]");
    if (!b) return;
    dictScope = b.dataset.scope;
    $("#dictTabs").querySelectorAll("[data-scope]").forEach(function (x) { x.classList.toggle("on", x.dataset.scope === dictScope); });
    renderDict();
  });
  $("#healthBtn").addEventListener("click", openHealth);
  $("#healthClose").addEventListener("click", function () { $("#healthModal").classList.remove("on"); });
  $("#healthModal").addEventListener("click", function (e) { if (e.target.id === "healthModal") e.target.classList.remove("on"); });
  $("#paramModal").addEventListener("click", function (e) { if (e.target.id === "paramModal") e.target.classList.remove("on"); });

  $("#charName").addEventListener("click", openProfileModal);
  $("#charMeta").addEventListener("click", openProfileModal);
  $("#profileCancel").addEventListener("click", function () { $("#profileModal").classList.remove("on"); });
  $("#profileModal").addEventListener("click", function (e) { if (e.target.id === "profileModal") e.target.classList.remove("on"); });
  $("#profileSave").addEventListener("click", saveProfileModal);
  $("#pfRollName").addEventListener("click", function () {
    const sex = currentSex();
    const N = DATA.names || {};
    const given = sex === "female" ? N.givenFemale : sex === "male" ? N.givenMale : N.givenNeutral;
    $("#pfName").value = pickFromPool(N.surnames) + pickFromPool(given);
  });
  $("#pfRollIdentity").addEventListener("click", function () { $("#pfIdentity").value = pickFromPool((DATA.names || {}).identities); });
  $("#pfRollPersonality").addEventListener("click", function () { $("#pfPersonality").value = pickFromPool((DATA.names || {}).personalities); });
  $("#pfRollTrait").addEventListener("click", function () { $("#pfTrait").value = pickFromPool((DATA.names || {}).traits); });
  $("#pfRollStyle").addEventListener("click", function () {
    const pool = ((DATA.names || {}).styleKeywords || []).slice();
    const picked = [];
    while (picked.length < 2 && pool.length) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    $("#pfStyle").value = picked.join("、");
  });
  $("#pfBioGen").addEventListener("click", function () { $("#pfBio").value = generateBioText(); });

  $("#applySeed").addEventListener("click", function () {
    const v = Number($("#seedInput").value);
    if (!v || isNaN(v)) { toast("请输入数字种子"); return; }
    rerollAll(v >>> 0);
    toast("已按种子 " + state.seed + " 重建");
  });
  $("#diceSeed").addEventListener("click", function () {
    rerollAll();
    toast("种子 " + state.seed);
  });

  $("#resetBlocks").addEventListener("click", function () {
    if (!window.confirm("重置会把内置段恢复成默认文字（当前 " + state.blocks.filter(function (b) { return b.kind !== "free"; }).length + " 段）。内容段对所有画幅都生效，自定义段落会被移除。继续？")) return;
    state.blocks = [];
    state.templateText = {};
    loadBlocks();
    renderBlocks();
    updatePromptPreview();
    saveState();
    toast("已重置为默认提示词");
  });

  $("#addBlock").addEventListener("click", function () {
    state.blocks.push({ id: "free_" + Date.now(), kind: "free", label: "自定义段落", text: "在这里写一段描述…", enabled: true });
    persistBlocks(); renderBlocks(); updatePromptPreview();
    toast("已加到列表末尾；自定义段落所有画幅共用，右上角 × 可以移除");
  });

  $("#copyPrompt").addEventListener("click", function () {
    const snap = buildPromptSnapshot();
    const note = snap.unknown.length ? " · 已移除 " + snap.unknown.length + " 个未知变量" : "";
    function done() { toast("提示词已复制 · " + snap.stats.chars + " 字" + note); }
    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = snap.text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
      if (ok) done();
      else toast("复制失败：浏览器不允许剪贴板访问，请手动选中提示词复制", 4200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(snap.text).then(done, fallback);
    } else {
      fallback();
    }
  });

  $("#retryFailed").addEventListener("click", retryFailed);

  /* 生成中点了存档看旧图 → 出现「↩ 回到最新」，点一下回这一批最新出的图 */
  $("#followLatest").addEventListener("click", showLatestImage);

  /* 切回页面 / 网络恢复时立刻和服务端对一次账（页面休眠久了心跳会停） */
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.batch) pollBatch();
  });
  window.addEventListener("online", function () {
    if (state.batch) pollBatch();
  });

  $("#archiveOpen").addEventListener("click", async function () {
    const j = await api("/api/archive/open", { method: "POST" });
    if (j && j.ok) toast("已打开存档目录：" + j.path);
    else toast("存档位置：本目录 / output / 人物 / 男｜女｜中性");
  });

  $("#togglePhrases").addEventListener("click", function () {
    state.showPhrases = !state.showPhrases;
    const panel = document.querySelector(".param-panel");
    if (panel) panel.classList.toggle("phrases-on", state.showPhrases);
    $("#togglePhrases").classList.toggle("on", state.showPhrases);
    renderParams();
    saveState();
    toast(state.showPhrases ? "已在摘要行下显示词句（点击词句可在右侧定位）" : "已隐藏词句（悬停参数仍可高亮提示词里的对应词）");
  });

  $("#varTableBtn").addEventListener("click", openVarTable);
  $("#varClose").addEventListener("click", function () { $("#varModal").classList.remove("on"); });
  $("#varModal").addEventListener("click", function (e) { if (e.target.id === "varModal") e.target.classList.remove("on"); });
  $("#varSearch").addEventListener("input", function (e) {
    varQuery = e.target.value.trim();
    renderVarTable();
  });
  $("#varTabs").addEventListener("click", function (e) {
    const b = e.target.closest("[data-scope]");
    if (!b) return;
    varScope = b.dataset.scope;
    renderVarTable();
  });

  $("#promptPreview").addEventListener("click", function (e) {
    const span = e.target.closest(".pvar");
    if (!span) return;
    locateSource(span.dataset.var);
  });

  $("#trashBtn").addEventListener("click", openTrash);
  $("#trashClose").addEventListener("click", function () { $("#trashModal").classList.remove("on"); });
  $("#trashModal").addEventListener("click", function (e) { if (e.target.id === "trashModal") e.target.classList.remove("on"); });
  $("#trashEmptyBtn").addEventListener("click", emptyTrash);
  $("#trashOpenDir").addEventListener("click", openTrashDir);

  $("#confirmCancel").addEventListener("click", function () { closeConfirm(false); });
  $("#confirmOk").addEventListener("click", function () { closeConfirm(true); });
  $("#confirmModal").addEventListener("click", function (e) {
    if (e.target.id === "confirmModal") closeConfirm(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if ($("#confirmModal").classList.contains("on")) closeConfirm(false);
      else if ($("#profileModal").classList.contains("on")) $("#profileModal").classList.remove("on");
      else if ($("#paramModal").classList.contains("on")) $("#paramModal").classList.remove("on");
      else if ($("#dictModal").classList.contains("on")) $("#dictModal").classList.remove("on");
      else if ($("#healthModal").classList.contains("on")) $("#healthModal").classList.remove("on");
      else if ($("#varModal").classList.contains("on")) $("#varModal").classList.remove("on");
      else if ($("#trashModal").classList.contains("on")) $("#trashModal").classList.remove("on");
      else if ($("#reverseModal").classList.contains("on")) closeReverseModal();
      else if ($("#modal").classList.contains("on")) closeModal();
      else if ($("#manageModal").classList.contains("on")) $("#manageModal").classList.remove("on");
    }
  });

  $("#providerSel").addEventListener("change", function (e) {
    if (e.target.value === "__add__") {
      e.target.value = state.providerId || "";
      openModal();
      return;
    }
    state.providerId = e.target.value;
    state.modelId = null;
    state.allModels = [];
    saveState();
    loadModels();
  });

  $("#modelSel").addEventListener("change", function (e) {
    state.modelId = e.target.value;
    saveState();
    setStatus("已选模型：" + state.modelId);
  });

  $("#refreshModels").addEventListener("click", function () {
    const b = $("#refreshModels");
    b.classList.add("spin");
    setTimeout(function () { b.classList.remove("spin"); }, 420);
    loadModels();
  });

  $("#batchSel").addEventListener("change", function (e) {
    state.batchCount = Number(e.target.value) || 1;
    saveState();
  });

  $("#manageBtn").addEventListener("click", openManage);
  $("#manageClose").addEventListener("click", function () { $("#manageModal").classList.remove("on"); });
  $("#manageAddProvider").addEventListener("click", function () {
    $("#manageModal").classList.remove("on");
    openModal("add", null, { fromManage: true });
  });
  $("#manageRefreshModels").addEventListener("click", async function () {
    await loadModels();
    renderManage();
  });
  $("#manageModal").addEventListener("click", function (e) {
    if (e.target.id === "manageModal") e.target.classList.remove("on");
  });

  $("#qualitySel").addEventListener("change", function (e) {
    state.quality = e.target.value;
    saveState();
  });

  $("#templateSel").addEventListener("change", function (e) {
    stashTemplateStructure();
    state.templateId = e.target.value;
    applyTemplateStructure();
    renderBlocks();
    renderParams();
    updatePromptPreview();
    saveState();
    setStatus("版面已切换：" + currentTemplate().label + "；人物内容段是同一份，开关状态保持不变");
  });

  $("#layoutManage").addEventListener("click", openLayoutModal);
  $("#layoutClose").addEventListener("click", closeLayoutModal);
  $("#layoutAdd").addEventListener("click", createLayout);
  $("#layoutReset").addEventListener("click", resetLayouts);
  $("#layoutModal").addEventListener("click", function (e) {
    if (e.target.id === "layoutModal") closeLayoutModal();
  });

  $("#modalCancel").addEventListener("click", closeModal);
  $("#modalSave").addEventListener("click", saveProvider);
  $("#modal").addEventListener("click", function (e) { if (e.target.id === "modal") closeModal(); });

  /* ---------- 参考图复刻（图 → 提示词 / 风格） ---------- */
  $("#reverseBtn").addEventListener("click", openReverseModal);
  $("#revClose").addEventListener("click", closeReverseModal);
  $("#reverseModal").addEventListener("click", function (e) { if (e.target.id === "reverseModal") closeReverseModal(); });
  $("#activeStyleChip").addEventListener("click", clearActiveStyle);

  $("#revProviderSel").addEventListener("change", function (e) {
    state.llmProviderId = e.target.value || null;
    state.llmModelId = null;
    state.llmModels = [];
    state.llmModelsFor = "";
    saveState();
    if (state.llmProviderId) loadReverseModels(); else renderReverseModelOptions();
  });
  $("#revModelSel").addEventListener("change", function (e) {
    state.llmModelId = e.target.value || null;
    saveState();
  });
  $("#revRefreshModels").addEventListener("click", function () { loadReverseModels(); });
  $("#revStrengthSel").addEventListener("change", function (e) {
    state.llmStrength = ["auto", "low", "medium", "high"].indexOf(e.target.value) >= 0 ? e.target.value : "auto";
    saveState();
  });
  $("#revAddProvider").addEventListener("click", function () {
    closeReverseModal();
    openModal("add", null, { kind: "llm", fromReverse: true });
  });
  const addLlmBtn = $("#manageAddLlm");
  if (addLlmBtn) addLlmBtn.addEventListener("click", function () {
    $("#manageModal").classList.remove("on");
    openModal("add", null, { kind: "llm", fromManage: true });
  });

  $("#revSysToggle").addEventListener("click", function () {
    const box = $("#revSysEditor");
    box.hidden = !box.hidden;
    if (!box.hidden) { reverseEditingNew = false; renderReversePromptSelect(); }
  });
  $("#revSysSel").addEventListener("change", function (e) { selectReversePrompt(e.target.value); });
  $("#revSysEditSel").addEventListener("change", function (e) { selectReversePrompt(e.target.value); });
  $("#revSysNew").addEventListener("click", function () {
    reverseEditingNew = true;
    $("#revSysName").value = "";
    $("#revSysText").value = "";
    $("#revSysText").focus();
  });
  $("#revSysSave").addEventListener("click", saveReversePromptFromEditor);
  $("#revSysDelete").addEventListener("click", deleteReversePrompt);
  $("#revSysReset").addEventListener("click", resetReversePrompts);

  /* 参考图：点击 / 拖拽 / 粘贴 / 链接 */
  $("#revDrop").addEventListener("click", function (e) {
    if (e.target && e.target.id === "revFile") return;
    $("#revFile").click();
  });
  $("#revFile").addEventListener("change", function (e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f) handleReverseFile(f);
  });
  ["dragenter", "dragover"].forEach(function (name) {
    $("#revDrop").addEventListener(name, function (e) {
      e.preventDefault();
      $("#revDrop").classList.add("over");
    });
  });
  ["dragleave", "drop"].forEach(function (name) {
    $("#revDrop").addEventListener(name, function (e) {
      e.preventDefault();
      $("#revDrop").classList.remove("over");
    });
  });
  $("#revDrop").addEventListener("drop", function (e) {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleReverseFile(f);
  });
  document.addEventListener("paste", function (e) {
    const modal = $("#reverseModal");
    if (!modal || !modal.classList.contains("on")) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf("image/") === 0) {
        const f = items[i].getAsFile();
        if (f) { e.preventDefault(); handleReverseFile(f); break; }
      }
    }
  });
  $("#revUrlLoad").addEventListener("click", loadReverseFromUrl);
  $("#revUrl").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); loadReverseFromUrl(); }
  });
  $("#revRun").addEventListener("click", runReverse);
  $("#revCopy").addEventListener("click", function () {
    const text = $("#revResult").value.trim();
    if (!text) { toast("还没有可复制的提示词"); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast("提示词已复制 · " + text.length + " 字"); },
        function () { toast("复制失败：浏览器不允许剪贴板访问，请手动选中复制", 4200); }
      );
    } else {
      toast("复制失败：浏览器不支持剪贴板，请手动选中复制", 4200);
    }
  });
  $("#revSaveStyle").addEventListener("click", saveReverseAsStyle);
  $("#revUseFull").addEventListener("click", function () { useReverseResult("full"); });
  $("#revUseSuffix").addEventListener("click", function () { useReverseResult("suffix"); });

  initZoom();
}

function fillStaticSelects() {
  const bSel = $("#batchSel");
  BATCH_LIST.forEach(function (n) {
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = n + " 张";
    bSel.appendChild(o);
  });
  bSel.value = String(state.batchCount || 1);
  bSel.title = "一次生成几张；张数大于 1 时每一张都会重新随机一个新人物，最多 10 张同时并发出图";
  renderSizeControls();

  const qSel = $("#qualitySel");
  QUALITIES.forEach(function (q) {
    const o = document.createElement("option");
    o.value = q[0];
    o.textContent = q[1];
    qSel.appendChild(o);
  });
  qSel.value = state.quality;

  normalizeTemplate();
  renderTemplateOptions();
  loadBlocks();
  renderBlocks();
}

let editingProviderId = null;
let editingProviderKind = "image"; /* image = 生图服务商；llm = 参考图反推用的 LLM */
let modalReturnToManage = false; /* 从管理面板进来的弹窗，关掉后回管理面板 */
let modalReturnToReverse = false; /* 从「以图复刻」进来的弹窗，关掉后回复刻面板 */

function openModal(mode, provider, opts) {
  opts = opts || {};
  const editing = mode === "edit" && provider ? provider : null;
  editingProviderId = editing ? editing.id : null;
  editingProviderKind = opts.kind || (editing && editing.kind) || "image";
  const isLlm = editingProviderKind === "llm";
  modalReturnToManage = !!opts.fromManage;
  modalReturnToReverse = !!opts.fromReverse;
  const title = $("#modalTitle");
  if (title) title.textContent = editing
    ? (isLlm ? "编辑反推服务商" : "编辑服务商")
    : (isLlm ? "接入反推模型（LLM）" : "接入第三方生图接口");
  const note = $("#modalNote");
  if (note) {
    note.innerHTML = isLlm
      ? "接口需兼容 OpenAI 的 <code>/v1/models</code> 与 <code>/v1/chat/completions</code>，模型要支持图片输入（vision）。地址只填域名也行（会依次试 <code>/v1/models</code>、<code>/models</code>）。<strong>密钥仍只写进 <code>.env</code></strong>，保存后立即生效。"
      : "接口需兼容 OpenAI 的 <code>/v1/models</code> 与 <code>/v1/images/generations</code>；地址只填域名也行（会依次试 <code>/v1/models</code>、<code>/models</code>）。<strong>密钥会保存进项目根目录的 <code>.env</code></strong>（<code>config.json</code> 不保存），保存后立即生效，也可以直接手改 <code>.env</code>。";
  }
  const strengthRow = $("#pvStrengthRow");
  if (strengthRow) strengthRow.hidden = !isLlm;
  const strengthInput = $("#pvStrength");
  if (strengthInput) strengthInput.value = isLlm && editing ? (editing.strengthParam == null ? "" : editing.strengthParam) : "";
  const saveBtn = $("#modalSave");
  if (saveBtn) saveBtn.textContent = editing ? "保存修改" : "保存并拉取模型";
  $("#pvName").value = editing ? editing.name : "";
  $("#pvBase").value = editing ? editing.baseUrl : "";
  /* 密钥只进 .env：弹窗里可以粘贴，保存时由服务端写回 .env（config.json 不保存） */
  const pvId = $("#pvId");
  if (pvId) {
    pvId.value = editing ? editing.id : "";
    pvId.disabled = !!editing;
    pvId.placeholder = editing ? "标识不可修改" : "小写字母/数字，如 cpa / vision";
  }
  const keyInput = $("#pvKey");
  keyInput.value = "";
  keyInput.disabled = false;
  keyInput.placeholder = editing
    ? (editing.hasKey ? "已保存 " + editing.keyMask + "（留空 = 不修改）" : "粘贴密钥，保存时写入 .env")
    : "粘贴密钥（可选；保存时写入 .env）";
  keyInput.title = "密钥会写入项目根目录的 .env，config.json 不保存；保存后立即生效，重启也不会丢。留空表示不改动已有密钥。";
  $("#modal").classList.add("on");
}
function closeModal() {
  editingProviderId = null;
  $("#modal").classList.remove("on");
  if (modalReturnToManage) {
    modalReturnToManage = false;
    renderManage();
    $("#manageModal").classList.add("on");
  }
  if (modalReturnToReverse) {
    modalReturnToReverse = false;
    openReverseModal();
  }
}

function reopenManageIfNeeded(back) {
  if (!back) return;
  renderManage();
  $("#manageModal").classList.add("on");
}

function reopenReverseIfNeeded(back) {
  if (!back) return;
  openReverseModal();
}

/* 接口地址允许粘贴成 …/v1 或 …/v1/models，程序自己会拼 /v1/models 与 /v1/images/generations */
function normalizeBaseUrl(raw) {
  let s = String(raw || "").trim().replace(/\/+$/, "");
  s = s.replace(/\/v1\/models$/i, "").replace(/\/models$/i, "").replace(/\/v1$/i, "");
  return s.replace(/\/+$/, "");
}

async function saveProvider() {
  const kind = editingProviderKind;
  const isLlm = kind === "llm";
  const pool = isLlm ? state.llmProviders : state.providers;
  const editing = editingProviderId
    ? pool.find(function (x) { return x.id === editingProviderId; })
    : null;
  const name = $("#pvName").value.trim() || (editing ? editing.name : (isLlm ? "反推服务商" : "新服务商"));
  const baseUrl = normalizeBaseUrl($("#pvBase").value);
  if (!baseUrl) { toast("接口地址要填"); return; }
  if (!/^https?:\/\//i.test(baseUrl)) { toast("接口地址要以 http:// 或 https:// 开头"); return; }
  /* 密钥只进 .env：这里填的会由服务端写回 .env，config.json 不保存 */
  const key = $("#pvKey").value.trim();
  const payload = { name: name, baseUrl: baseUrl, kind: kind };
  if (editing) {
    payload.id = editing.id;
  } else {
    /* 标识会拼成环境变量名（ZXT_KEY_<标识>），只允许小写字母/数字/_/- */
    const rawId = String(($("#pvId") && $("#pvId").value) || "").trim().toLowerCase();
    if (rawId && !/^[a-z0-9_-]{1,32}$/.test(rawId)) {
      toast("标识只能用 1–32 位小写字母、数字、下划线或短横线");
      return;
    }
    if (rawId) payload.id = rawId;
  }
  if (isLlm) payload.strengthParam = String(($("#pvStrength") && $("#pvStrength").value) || "").trim();
  const j = await api("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!j || !j.ok) { toast("保存失败：" + ((j && j.error) || "")); return; }
  const wasCurrent = !!(editing && (isLlm ? state.llmProviderId === editing.id : state.providerId === editing.id));
  const baseChanged = editing ? normalizeBaseUrl(editing.baseUrl) !== baseUrl : false;
  const backManage = modalReturnToManage;
  const backReverse = modalReturnToReverse;
  modalReturnToManage = false; /* 这里自己决定何时回面板，避免用旧列表渲染一次 */
  modalReturnToReverse = false;
  closeModal();
  state.providers = j.providers || state.providers;
  state.llmProviders = j.llmProviders || state.llmProviders;
  await loadProviders();
  /* 新增时服务端可能自动生成标识：以服务端返回的 id 为准 */
  const targetId = editing ? editing.id : (j.id || "");
  let keySaved = false;
  if (targetId && key) {
    const kr = await api("/api/providers/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: targetId, apiKey: key })
    });
    if (kr && kr.ok) {
      keySaved = true;
      state.providers = kr.providers || state.providers;
      state.llmProviders = kr.llmProviders || state.llmProviders;
      await loadProviders();
    } else {
      toast("服务商已保存，但密钥写进 .env 失败：" + ((kr && kr.error) || "未知错误"), 6000);
    }
  }
  if (isLlm) {
    /* LLM 分支：切到刚保存的反推服务商，重新拉模型，更新「以图复刻」面板 */
    if (!editing && targetId) state.llmProviderId = targetId;
    state.llmModels = [];
    state.llmModelsFor = "";
    if (state.llmProviderId) await loadReverseModels();
    saveState();
    reopenManageIfNeeded(backManage);
    reopenReverseIfNeeded(backReverse);
    const target = state.llmProviders.find(function (p) { return p.id === state.llmProviderId; });
    if (editing) {
      toast("已更新反推服务商「" + name + "」" + (keySaved
        ? "，密钥已写入 .env"
        : (wasCurrent && (baseChanged || keySaved) ? "，已重新拉取模型" : "")));
    } else {
      toast(target && target.hasKey
        ? "已接入反推服务商「" + name + "」，模型 " + state.llmModels.length + " 个"
        : "已新增「" + name + "」。在「编辑」里粘贴密钥，或写 .env 的 " + ((target && target.envKey) || "ZXT_KEY_…"), 6000);
    }
    return;
  }
  if (editing) {
    /* 编辑：不切换当前服务商；改了地址或密钥就重新拉一遍模型 */
    const changed = wasCurrent && (baseChanged || keySaved);
    if (changed) {
      state.modelId = null;
      await loadModels();
      saveState();
    }
    reopenManageIfNeeded(backManage);
    reopenReverseIfNeeded(backReverse);
    toast("已更新服务商「" + name + "」" + (keySaved
      ? "，密钥已写入 .env"
      : (changed ? "，已重新拉取模型" : "；要换密钥就粘贴到「密钥」框里再保存")));
    return;
  }
  if (targetId) {
    state.providerId = targetId;
    $("#providerSel").value = targetId;
    state.modelId = null;
    await loadModels(); /* 没配密钥时会如实显示「拉取失败 + 缺哪个变量」，省得猜 */
    saveState(); /* 记住刚接入的服务商，刷新后还停在这个服务商上 */
    reopenManageIfNeeded(backManage);
    reopenReverseIfNeeded(backReverse);
    const target = state.providers.find(function (p) { return p.id === targetId; });
    toast(target && target.hasKey
      ? "已接入 " + name + "，模型 " + state.models.length + " 个"
      : "已新增「" + name + "」。在「编辑」里粘贴密钥，或写 .env 的 " + ((target && target.envKey) || "ZXT_KEY_…") + " 后重启");
    return;
  }
  reopenManageIfNeeded(backManage);
  reopenReverseIfNeeded(backReverse);
  toast("已接入 " + name + "，模型 " + state.models.length + " 个");
}

/* ---------- 整页等比缩放 + 左右栏折叠 ---------- */
const UI_BASE_W = 1440;
const UI_BASE_H = 900;
const UI = { scale: 1, hideLeft: false, hideRight: false };
const PANEL_PREF_KEY = "zaoxiangtai.panels.v1"; /* 同上：历史键名，勿改 */

function clampNum(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/* 窗口越大整页越大、越小整页越小：顶栏、左右栏、画布一起变，不只是中间的图 */
function applyUiScale() {
  const w = window.innerWidth || UI_BASE_W;
  const h = window.innerHeight || UI_BASE_H;
  const s = clampNum(Math.min(w / UI_BASE_W, h / UI_BASE_H), 0.72, 1.6);
  UI.scale = Math.round(s * 1000) / 1000;
  document.documentElement.style.setProperty("--ui-s", String(UI.scale));
}
function uiScale() { return UI.scale > 0 ? UI.scale : 1; }

function loadPanelPref() {
  try {
    const raw = localStorage.getItem(PANEL_PREF_KEY);
    const j = raw ? JSON.parse(raw) : null;
    if (j && typeof j === "object") {
      UI.hideLeft = !!j.hideLeft;
      UI.hideRight = !!j.hideRight;
    }
  } catch (e) { /* 读不到就用默认 */ }
}
function savePanelPref() {
  try {
    localStorage.setItem(PANEL_PREF_KEY, JSON.stringify({ hideLeft: UI.hideLeft, hideRight: UI.hideRight }));
  } catch (e) { /* 存不了不影响使用 */ }
}
function applyPanelPref() {
  const app = document.querySelector(".app");
  if (!app) return;
  app.classList.toggle("hide-left", !!UI.hideLeft);
  app.classList.toggle("hide-right", !!UI.hideRight);
  const l = $("#railLeft"), r = $("#railRight");
  if (l) l.title = "展开左栏 · 人物参数（快捷键 [）";
  if (r) r.title = "展开右栏 · 提示词编排（快捷键 ]）";
}
/* 收起/展开后画布宽度变了，重新量一次，缩放与平移不会错位 */
function afterPanelChange() {
  requestAnimationFrame(function () {
    if (!previewReady()) return;
    measurePreview();
    clampZoomPan();
    applyZoom();
  });
}
function setPanelHidden(side, hidden) {
  if (side === "left") UI.hideLeft = !!hidden; else UI.hideRight = !!hidden;
  applyPanelPref();
  savePanelPref();
  afterPanelChange();
}
function togglePanel(side) {
  setPanelHidden(side, side === "left" ? !UI.hideLeft : !UI.hideRight);
}
/* 跳转到某个面板时（点变量、点词句），如果它正收着就先展开 */
function ensurePanelVisible(side) {
  if (side === "left" && UI.hideLeft) setPanelHidden("left", false);
  if (side === "right" && UI.hideRight) setPanelHidden("right", false);
}

function initUiChrome() {
  loadPanelPref();
  applyPanelPref();
  applyUiScale();
  window.addEventListener("resize", function () { applyUiScale(); });
  const hideL = $("#hideLeft"), hideR = $("#hideRight");
  const railL = $("#railLeft"), railR = $("#railRight");
  if (hideL) hideL.addEventListener("click", function () { setPanelHidden("left", true); });
  if (hideR) hideR.addEventListener("click", function () { setPanelHidden("right", true); });
  if (railL) railL.addEventListener("click", function () { setPanelHidden("left", false); });
  if (railR) railR.addEventListener("click", function () { setPanelHidden("right", false); });
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (e.key === "[") { togglePanel("left"); e.preventDefault(); }
    else if (e.key === "]") { togglePanel("right"); e.preventDefault(); }
  });
}
initUiChrome();

async function boot() {
  await loadData();
  const restored = restoreState();
  if (!restored || state.params.age == null) {
    state.params = defaultParams();
    rerollAll();
  } else {
    loadBlocks();
    /* 旧存档兜底：非法值回默认、上下文/槽位归一；不强制重算已保存的合法取值 */
    normalizeContext("");
    clampToSex();
    sanitizeParams();
    if (eraOn() && !lookFilled()) maybeDressEra();
    /* 老存档里可能把卡片名（含「·」）存成了身份：只修这种明显脏数据，不动用户手写的身份 */
    if (state.meta && String(state.meta.identity || "").indexOf("·") >= 0) state.meta.identity = identityPhrase();
    state.paramRevision = (state.paramRevision || 0) + 1;
  }
  fillStaticSelects();
  bindUI();
  renderParams();
  syncStage();
  updatePromptPreview();

  await loadProviders();
  await loadModels();
  const items = await loadArchive();

  // resume the most recent saved character when there is no local state
  if (!restored && items && items.length) {
    try {
      const last = items[0];
      const rec = await fetch("/files/" + encodeURIComponent(last.dir) + "/" + encodeURIComponent(last.id) + ".json").then(function (r) { return r.json(); });
      if (rec && rec.character && rec.character.params) {
        state.params = Object.assign({}, state.params, rec.character.params);
        state.lookId = rec.character.lookId || (rec.promptMeta && rec.promptMeta.evidence && rec.promptMeta.evidence.lookId) || "";
        state.seed = rec.character.seed || state.seed;
        state.meta = Object.assign(defaultMeta(), rec.character.meta || {});
        if (!Array.isArray(state.meta.styleKeywords)) state.meta.styleKeywords = [];
        state.highlights = Array.isArray(rec.character.highlights) ? rec.character.highlights.slice(0, 3) : [];
        if (rec.character.template && DATA.layouts.some(function (t) { return t.id === rec.character.template; })) {
          stashTemplateStructure();
          state.templateId = rec.character.template;
          $("#templateSel").value = state.templateId;
          applyTemplateStructure();
          renderBlocks();
        }
        renderParams();
        syncStage();
      }
    } catch (e) {}
  }

  if (items && items.length) {
    const last = items[0];
    setPreviewImage("/files/" + encodeURIComponent(last.dir) + "/" + encodeURIComponent(last.file));
  }
  /* 刷新页面后接管还在跑的批次：只显示进度，不锁画布 */
  await takeoverActiveBatch();
  updateGenButton();
  if (!state.providers.length) setStatus("还没有接入服务商，点右上角「服务商」里的「＋ 接入新的接口…」");
}

boot().catch(function (e) {
  setStatus("启动失败：" + String(e.message || e), true);
  console.error(e);
});
