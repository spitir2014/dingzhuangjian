/* 参考图复刻（图 → 提示词 / 风格）契约测试
   覆盖：
   1) LLM 服务商作为第二类服务商：/api/config 单独返回、拉模型、密钥仍只进 .env
   2) POST /api/reverse：把图 + 系统提示词发给 /v1/chat/completions，返回提示词文本
   3) 强度参数：传 reasoning_effort；上游不认时自动去掉再试一次并标记 strengthIgnored
   4) POST /api/fetch-image：图片链接 → data URL；拦截本机/内网地址与非图片
   5) 系统提示词：默认、新增、修改、删除、恢复默认
   6) 风格预设：保存 / 列表 / 删除 / 校验
   7) 回归：生图服务商与 /api/generate 完全不受影响；config.json 仍然不落 apiKey

   运行：node scripts/test-reverse.mjs
*/
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { startMock, MIN_PNG_B64 } from "./mock-upstream.mjs";

const ROOT = process.cwd();
const DIR = path.join(ROOT, "tmp", "test-reverse");
const CFG = path.join(DIR, "config.json");
const ENV = path.join(DIR, ".env.test");
const OUT = path.join(DIR, "out");
const DATA = path.join(DIR, "data");
const PORT = 8813;
const BASE = "http://127.0.0.1:" + PORT;
const PNG_DATA_URL = "data:image/png;base64," + MIN_PNG_B64;
const results = [];
const ok = (cond, msg) => {
  results.push([!!cond, msg]);
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(p, init) {
  const r = await fetch(BASE + p, init);
  let body = null;
  try { body = await r.json(); } catch (e) { body = null; }
  return { status: r.status, body: body };
}
const postJson = (p, obj, extraHeaders) => getJson(p, {
  method: "POST",
  headers: Object.assign({ "Content-Type": "application/json" }, extraHeaders || {}),
  body: JSON.stringify(obj)
});

async function startServer(allowLocalFetch) {
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    ZXT_CONFIG: CFG,
    ZXT_OUT: OUT,
    ZXT_DATA: DATA,
    ZXT_ENV: ENV
  });
  if (allowLocalFetch) env.ZXT_ALLOW_LOCAL_IMAGE_FETCH = "1";
  else delete env.ZXT_ALLOW_LOCAL_IMAGE_FETCH;
  delete env.ZXT_KEY_IMG;
  delete env.ZXT_KEY_VISION;
  delete env.ZXT_KEY_VISION2;
  const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: env
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/api/health", { signal: AbortSignal.timeout(800) });
      if (r.ok) return { child, logs: () => logs };
    } catch (e) {}
    await sleep(200);
  }
  child.kill();
  throw new Error("服务没起来：\n" + logs);
}
async function stopServer(s) {
  if (!s || !s.child) return;
  s.child.kill();
  await sleep(400);
}
async function writeConfig(mockBase, opts) {
  const cfg = {
    providers: [{
      id: "img",
      name: "假生图服务商",
      baseUrl: mockBase,
      authHeader: "Authorization",
      authPrefix: "Bearer ",
      enabled: true
    }],
    llmProviders: [{
      id: "vision",
      name: "假反推服务商",
      baseUrl: mockBase,
      authHeader: "Authorization",
      authPrefix: "Bearer ",
      enabled: true,
      strengthParam: (opts && opts.strengthParam) || "reasoning_effort"
    }],
    settings: { downloadDir: "output" }
  };
  await fs.writeFile(CFG, JSON.stringify(cfg, null, 2), "utf8");
}

await fs.rm(DIR, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(DATA, { recursive: true });
await fs.writeFile(ENV, "ZXT_KEY_IMG=sk-img-123456\nZXT_KEY_VISION=sk-vision-123456\n", "utf8");

let mock = await startMock({ port: 0, mode: "ok" });
const mockBase = "http://127.0.0.1:" + mock.port;
await writeConfig(mockBase);
let server = await startServer();

/* ---------- 1. 两类服务商分开返回 ---------- */
console.log("\n=== 1. 服务商与模型 ===");
let r = await getJson("/api/config");
ok(r.status === 200 && r.body.ok, "/api/config 200");
ok(Array.isArray(r.body.providers) && r.body.providers.length === 1, "生图服务商 1 个");
ok(Array.isArray(r.body.llmProviders) && r.body.llmProviders.length === 1, "反推（LLM）服务商 1 个");
const llm = (r.body.llmProviders || [])[0] || {};
ok(llm.kind === "llm", "LLM 服务商标记 kind=llm");
ok(llm.hasKey === true && llm.envKey === "ZXT_KEY_VISION", "LLM 服务商读到了 .env 密钥（ZXT_KEY_VISION）");
ok(llm.keyMask === "sk-v••••••••3456", "LLM 密钥掩码正确（" + llm.keyMask + "）");

r = await getJson("/api/models?provider=vision");
ok(r.status === 200 && r.body.ok && r.body.models.some((m) => m.id === "mock-image"), "LLM 服务商可以拉模型列表");
r = await getJson("/api/providers");
ok(r.body.providers.length === 1 && r.body.llmProviders.length === 1, "/api/providers 同时返回两类");

/* ---------- 2. 反推 ---------- */
console.log("\n=== 2. /api/reverse ===");
const reverseBody = {
  providerId: "vision",
  model: "mock-vision",
  systemPrompt: "SYS: 你是复刻助手",
  systemPromptId: "default",
  imageDataUrl: PNG_DATA_URL,
  instruction: "INST: 保留光线",
  strength: "high"
};
r = await postJson("/api/reverse", reverseBody);
ok(r.status === 200 && r.body.ok === true, "反推成功 200/ok");
ok(/mock 反推提示词/.test(r.body.text || ""), "返回了提示词文本");
ok(/含图/.test(r.body.text || ""), "请求里带上了参考图（image_url data URL）");
ok(/强度 high/.test(r.body.text || ""), "强度参数发成了 reasoning_effort=high");
ok(r.body.meta && r.body.meta.model === "mock-vision", "meta 回传模型名");
ok(r.body.meta && r.body.meta.usage && r.body.meta.usage.total_tokens === 36, "meta 回传 usage");

r = await postJson("/api/reverse", Object.assign({}, reverseBody, { strength: "auto" }));
ok(r.body.ok === true && /强度 none/.test(r.body.text || ""), "强度 auto 时不发强度参数");

r = await postJson("/api/reverse", Object.assign({}, reverseBody, { providerId: "img" }));
ok(r.status === 400 && /未找到反推服务商/.test(r.body.error || ""), "拿生图服务商反推：400 且提示清楚");
r = await postJson("/api/reverse", Object.assign({}, reverseBody, { systemPrompt: "" }));
ok(r.status === 400 && /系统提示词/.test(r.body.error || ""), "系统提示词为空：400");
r = await postJson("/api/reverse", Object.assign({}, reverseBody, { imageDataUrl: "not-an-image" }));
ok(r.status === 400 && /参考图不合法/.test(r.body.error || ""), "参考图不是 data URL：400");
r = await postJson("/api/reverse", Object.assign({}, reverseBody, { model: "" }));
ok(r.status === 400 && /未选择反推模型/.test(r.body.error || ""), "没选模型：400");

/* ---------- 3. 抓图（默认禁止本机/内网） ---------- */
console.log("\n=== 3. /api/fetch-image 安全闸 ===");
r = await postJson("/api/fetch-image", { url: mockBase + "/v1/mock-image.png" });
ok(r.status === 400 && /本机或内网/.test(r.body.error || ""), "本机地址被拦截（SSRF 默认关闭）");
r = await postJson("/api/fetch-image", { url: "http://192.168.1.2/x.png" });
ok(r.status === 400 && /本机或内网/.test(r.body.error || ""), "内网地址被拦截");
r = await postJson("/api/fetch-image", { url: "file:///etc/passwd" });
ok(r.status === 400, "非 http(s) 链接被拦截");

/* ---------- 4. 系统提示词 ---------- */
console.log("\n=== 4. /api/reverse-prompts ===");
r = await getJson("/api/reverse-prompts");
ok(r.status === 200 && r.body.ok && r.body.prompts.length === 1 && r.body.defaultId === "default", "默认只有内置一条");
const defaultText = (r.body.prompts || [])[0] ? r.body.prompts[0].text : "";
ok(/视觉反推助手/.test(defaultText), "内置提示词文字在");
r = await postJson("/api/reverse-prompts", { name: "我的复刻", text: "SYS-2 我的系统提示词" });
ok(r.body.ok === true && r.body.prompts.length === 2, "新增一条：变成 2 条");
const customId = (r.body.prompt || {}).id;
ok(!!customId, "新增返回了 id");
r = await postJson("/api/reverse-prompts", { id: customId, name: "改个名", text: "SYS-2b 改过的文字" });
const updated = (r.body.prompts || []).find((p) => p.id === customId) || {};
ok(updated.name === "改个名" && updated.text === "SYS-2b 改过的文字", "按 id 修改生效");
r = await postJson("/api/reverse-prompts", { name: "", text: "" });
ok(r.status === 400 && /不能为空/.test(r.body.error || ""), "空文字：400");
r = await getJson("/api/reverse-prompts?id=" + encodeURIComponent(customId), { method: "DELETE" });
ok(r.body.ok === true && r.body.prompts.length === 1, "删除自定义那条");
r = await postJson("/api/reverse-prompts/reset", {});
ok(r.body.ok === true && /视觉反推助手/.test(r.body.prompts[0].text), "恢复默认把内置文字写回去");

/* ---------- 5. 风格预设 ---------- */
console.log("\n=== 5. /api/styles ===");
const styleBody = {
  name: "清冷棚拍柔光",
  prompt: "画面：复刻提示词正文。\n\n风格与质感：柔光，低饱和，哑光质感。",
  styleSuffix: "柔光，低饱和，哑光质感。",
  tags: ["柔光", "低饱和"],
  thumb: PNG_DATA_URL,
  source: { kind: "url", url: mockBase + "/v1/mock-image.png" },
  llm: { providerId: "vision", providerName: "假反推服务商", model: "mock-vision", strength: "high", systemPromptId: "default" }
};
r = await postJson("/api/styles", styleBody);
ok(r.body.ok === true && !!r.body.style.id, "保存风格预设成功并返回 id");
const styleId = (r.body.style || {}).id;
ok((r.body.style || {}).tags.length === 2 && /柔光/.test((r.body.style || {}).styleSuffix || ""), "标签与风格段都存住了");
r = await getJson("/api/styles");
ok(r.body.ok && r.body.styles.length === 1, "列表里有 1 条");
r = await postJson("/api/styles", Object.assign({}, styleBody, { prompt: "" }));
ok(r.status === 400 && /不能为空/.test(r.body.error || ""), "空提示词：400");
r = await postJson("/api/styles", Object.assign({}, styleBody, { prompt: "x".repeat(30001) }));
ok(r.status === 400 && /太长/.test(r.body.error || ""), "超长提示词：400");
r = await getJson("/api/styles?id=" + encodeURIComponent(styleId), { method: "DELETE" });
ok(r.body.ok === true && r.body.styles.length === 0, "删除风格预设");

/* ---------- 6. 新增 / 删除 LLM 服务商 ---------- */
console.log("\n=== 6. LLM 服务商增删与密钥 ===");
r = await postJson("/api/providers", { kind: "llm", id: "vision2", name: "第二个反推", baseUrl: mockBase });
ok(r.body.ok === true && r.body.kind === "llm" && r.body.id === "vision2", "新增 LLM 服务商");
ok(r.body.llmProviders.length === 2 && r.body.providers.length === 1, "只进了 llmProviders，不污染生图列表");
r = await postJson("/api/providers/key", { providerId: "vision2", apiKey: "sk-v2-123456" });
ok(r.body.ok === true && (r.body.llmProviders || []).some((p) => p.id === "vision2" && p.hasKey), "给 LLM 服务商写密钥成功");
r = await getJson("/api/models?provider=vision2");
ok(r.body.ok === true && r.body.models.length > 0, "新 LLM 服务商可拉模型");
r = await postJson("/api/providers", { kind: "llm", id: "img", name: "撞标识", baseUrl: mockBase });
ok(r.status === 400 && /已被另一类服务商占用/.test(r.body.error || ""), "LLM 不能复用生图服务商的标识");
r = await getJson("/api/providers?kind=llm&id=vision2", { method: "DELETE" });
ok(r.body.ok === true && r.body.llmProviders.length === 1, "删除 LLM 服务商");

/* ---------- 7. 回归：生图没被影响 + 密钥不落盘 ---------- */
console.log("\n=== 7. 生图回归与密钥隔离 ===");
r = await postJson("/api/generate", { providerId: "img", model: "mock-image", prompt: "回归测试提示词", size: "1024x1024" });
ok(r.body.ok === true && /^data:image\/png;base64,/.test(r.body.dataUrl || ""), "生图接口仍然正常");
r = await postJson("/api/generate", { providerId: "vision", model: "mock-vision", prompt: "拿反推服务商生图" });
ok(r.status === 400 && /未找到该服务商/.test(r.body.error || ""), "LLM 服务商不能拿去生图");
await sleep(250);
const disk = await fs.readFile(CFG, "utf8");
ok(!/"apiKey"/.test(disk), "config.json 里没有 apiKey");
ok(/"llmProviders"/.test(disk), "config.json 里有 llmProviders");
ok(/"providers"/.test(disk), "config.json 里生图 providers 还在");
const envDisk = await fs.readFile(ENV, "utf8");
ok(/^ZXT_KEY_VISION2=sk-v2-123456$/m.test(envDisk), "网页写的密钥进了 .env（ZXT_KEY_VISION2）");
ok(!/"sk-v2-123456"/.test(disk), "密钥没有写进 config.json");

/* ---------- 8. 上游不认强度参数时的兜底 ---------- */
console.log("\n=== 8. 强度参数兜底 ===");
await stopServer(server);
await mock.close();
mock = await startMock({ port: 0, mode: "ok", rejectStrength: true });
const mockBase2 = "http://127.0.0.1:" + mock.port;
await writeConfig(mockBase2);
server = await startServer(true); /* 测试钩子：放开本机抓图，才能用假上游验证真实抓取路径 */
r = await postJson("/api/reverse", Object.assign({}, reverseBody, { strength: "medium" }));
ok(r.body.ok === true && r.body.meta && r.body.meta.strengthIgnored === true, "上游 400 后去掉强度参数重试，并标记 strengthIgnored");
ok(/强度 none/.test(r.body.text || ""), "重试请求里确实没有强度参数");

/* ---------- 9. 抓图成功路径（测试钩子放开本机地址） ---------- */
console.log("\n=== 9. /api/fetch-image 成功路径 ===");
r = await postJson("/api/fetch-image", { url: mockBase2 + "/v1/mock-image.png" });
ok(r.status === 200 && r.body.ok === true, "图片链接抓取成功");
ok(/^data:image\/png;base64,/.test(r.body.dataUrl || ""), "返回 png data URL");
ok(r.body.bytes > 0 && r.body.width === 1 && r.body.height === 1, "回传字节数与尺寸（1×1）");
r = await postJson("/api/fetch-image", { url: mockBase2 + "/v1/redirect-image" });
ok(r.status === 200 && /^data:image\/png;base64,/.test(r.body.dataUrl || ""), "302 跳转后仍能抓到图片");
r = await postJson("/api/fetch-image", { url: mockBase2 + "/health" });
ok(r.status === 400 && /不是 png/.test(r.body.error || ""), "非图片内容被拦截");
r = await postJson("/api/fetch-image", { url: "http://127.0.0.1:" + PORT + "/api/config" });
ok(r.status === 400 && /不是 png/.test(r.body.error || ""), "抓到 JSON 也按非图片处理");

await stopServer(server);
await mock.close();
console.log("");
const failed = results.filter((x) => !x[0]);
console.log("参考图复刻契约测试：" + (results.length - failed.length) + " PASS / " + failed.length + " FAIL");
if (failed.length) {
  for (const f of failed) console.log("  FAIL " + f[1]);
  process.exit(1);
}
process.exit(0);
