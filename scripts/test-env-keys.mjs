/* 密钥契约测试（方案 A）：密钥只存 .env，config.json 永不落盘。
   覆盖：
   1) 没有 .env / 缺密钥：服务照常启动，/api/config 报 hasKey=false 并给出变量名
   2) 缺密钥拉模型：400，错误里带该服务商应填的变量名
   3) 往 /api/providers 提交密钥：400，明确指向 .env（不能假装改成功）
   4) 有 .env：hasKey=true，掩码取前 4 后 4
   5) 任何一次保存之后，config.json 里都不允许出现 apiKey 字段
   6) 网页弹窗填密钥（POST /api/providers/key）：写进 .env、立即生效、
      重复保存替换同一行、拒绝跨站来源
*/
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const DIR = path.join(ROOT, "tmp", "test-env-keys");
const CFG = path.join(DIR, "config.json");
const OUT = path.join(DIR, "out");
const ENV_OK = path.join(DIR, ".env.test");
const ENV_MISSING = path.join(DIR, ".env.absent");
const PORT = 8809;
const BASE = "http://127.0.0.1:" + PORT;
const results = [];
const ok = (c, m) => { results.push([!!c, m]); if (!c) console.log("FAIL " + m); else console.log("  PASS " + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await fs.rm(DIR, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(CFG, JSON.stringify({
  providers: [{
    id: "mock", name: "契约测试服务商", baseUrl: "http://127.0.0.1:9",
    authHeader: "Authorization", authPrefix: "Bearer ", enabled: true
  }],
  settings: { downloadDir: "output" }
}, null, 2), "utf8");
await fs.writeFile(ENV_OK, "ZXT_KEY_MOCK=sk-test-1234\n", "utf8");

async function start(envFile) {
  const env = Object.assign({}, process.env, { PORT: String(PORT), ZXT_CONFIG: CFG, ZXT_OUT: OUT, ZXT_ENV: envFile });
  delete env.ZXT_KEY_MOCK; /* 父进程环境不许漏进来，否则测不出 .env 的作用 */
  const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: env
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/api/health", { signal: AbortSignal.timeout(800) }); if (r.ok) return { child, logs: () => logs }; } catch (e) {}
    await sleep(200);
  }
  child.kill();
  throw new Error("服务没起来：\n" + logs);
}
async function stop(child) { child.kill(); await sleep(400); }
async function getJson(p, init) { const r = await fetch(BASE + p, init); return { status: r.status, body: await r.json() }; }
const postJson = (p, body) => getJson(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/* ---------- 第一段：没有 .env ---------- */
let s = await start(ENV_MISSING);
let r = await getJson("/api/config");
const p0 = r.body.providers[0];
ok(p0.hasKey === false, "缺密钥：hasKey=false");
ok(p0.envKey === "ZXT_KEY_MOCK", "缺密钥：给出应填变量名 ZXT_KEY_MOCK");
ok(p0.keyMask === "", "缺密钥：掩码为空");
ok(s.logs().indexOf("[密钥缺失]") >= 0, "缺密钥：启动时控制台有 [密钥缺失] 提示");

r = await getJson("/api/models?provider=mock");
ok(r.status === 400 && /ZXT_KEY_MOCK/.test(r.body.error || ""), "缺密钥拉模型：400 且错误里带变量名");

r = await postJson("/api/providers", { id: "mock", name: "偷偷改密钥", baseUrl: "http://127.0.0.1:9", apiKey: "sk-should-be-rejected" });
ok(r.status === 400 && /\.env/.test(r.body.error || ""), "网页提交密钥：400 且指向 .env");

/* 触发一次真实写盘（隐藏模型），确认密钥不会跟着落盘 */
r = await postJson("/api/models/hide", { providerId: "mock", modelId: "some-model", hidden: true });
ok(r.status === 200, "写盘接口可用（models/hide 200）");
await sleep(200);
let disk = await fs.readFile(CFG, "utf8");
ok(disk.indexOf("hiddenModels") >= 0, "确认真的写了 config.json（hiddenModels 已更新）");
ok(!/\"apiKey\"/.test(disk), "写盘后 config.json 里没有 apiKey 字段");

/* ---------- 网页弹窗里填密钥：写回 .env，立即生效 ---------- */
r = await postJson("/api/providers/key", { providerId: "nope", apiKey: "sk-x" });
ok(r.status === 404, "未知服务商写密钥：404");

r = await postJson("/api/providers/key", { providerId: "mock", apiKey: "   " });
ok(r.status === 400, "空密钥：400");

r = await postJson("/api/providers/key", { providerId: "mock", apiKey: "sk-a\r\nZXT_KEY_BAD=1" });
ok(r.status === 400, "含换行的密钥：400");

r = await getJson("/api/providers/key", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Origin": "http://evil.example" },
  body: JSON.stringify({ providerId: "mock", apiKey: "sk-evil" })
});
ok(r.status === 403, "跨站来源写密钥：403");

r = await postJson("/api/providers/key", { providerId: "mock", apiKey: "sk-ui-567890" });
ok(r.status === 200 && r.body.providers[0].hasKey === true, "网页填密钥：200 且 hasKey=true");
ok(r.body.providers[0].keyMask === "sk-u••••••••7890", "网页填密钥：掩码正确");
let envDisk = await fs.readFile(ENV_MISSING, "utf8");
ok(/^ZXT_KEY_MOCK=sk-ui-567890$/m.test(envDisk), "网页填密钥：已写入 .env");
ok(envDisk.indexOf("ZXT_KEY_BAD") < 0, "非法密钥没有写进 .env");

/* 再存一次：同名变量只能有一行（替换而不是追加） */
r = await postJson("/api/providers/key", { providerId: "mock", apiKey: "sk-ui-999900" });
envDisk = await fs.readFile(ENV_MISSING, "utf8");
ok((envDisk.match(/^ZXT_KEY_MOCK=/gm) || []).length === 1 && /^ZXT_KEY_MOCK=sk-ui-999900$/m.test(envDisk), "重复保存：替换同一行，不重复追加");

disk = await fs.readFile(CFG, "utf8");
ok(!/\"apiKey\"/.test(disk), "网页填密钥后 config.json 里仍然没有 apiKey 字段");
await stop(s.child);

/* ---------- 第二段：有 .env ---------- */
s = await start(ENV_OK);
r = await getJson("/api/config");
const p1 = r.body.providers[0];
ok(p1.hasKey === true, "有 .env：hasKey=true");
ok(p1.keyMask === "sk-t••••••••1234", "有 .env：掩码取前 4 后 4（" + p1.keyMask + "）");
ok(s.logs().indexOf("[密钥缺失]") < 0, "有 .env：启动时不再提示缺密钥");
await stop(s.child);

const passed = results.filter((x) => x[0]).length;
console.log("\n密钥契约：" + passed + "/" + results.length + " 通过");
if (passed !== results.length) { console.log("有失败用例，退出码 1"); process.exit(1); }
