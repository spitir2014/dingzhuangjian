import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { startMock } from "./mock-upstream.mjs";

const ROOT = process.cwd();
const DIR = path.join(ROOT, "tmp", "e2e-costume");
const OUT = path.join(DIR, "out");
const CFG = path.join(DIR, "config.json");
const PORT = 8804;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (c, m) => { results.push([!!c, m]); if (!c) console.log("FAIL " + m); };

await fs.rm(DIR, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
const mock = await startMock({ mode: "ok" });
await fs.writeFile(CFG, JSON.stringify({
  providers: [{ id: "mock", name: "本地假上游", baseUrl: "http://127.0.0.1:" + mock.port, apiKey: "sk-test",
    authHeader: "Authorization", authPrefix: "Bearer", enabled: true, modelBase: "http://127.0.0.1:" + mock.port + "/v1" }],
  settings: { downloadDir: "output" }
}, null, 2), "utf8");

const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  env: Object.assign({}, process.env, { PORT: String(PORT), ZXT_CONFIG: CFG, ZXT_OUT: OUT })
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });
const base = "http://127.0.0.1:" + PORT;
let ready = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(800) }); if (r.ok) { ready = true; break; } } catch (e) {}
  await sleep(200);
}
ok(ready, "server 起来了（" + (ready ? "ok" : logs.slice(-300)) + "）");

const costume = "清代盛期正一品文官，头戴暖帽，帽顶嵌红宝石顶珠，身穿石青色补褂，平袖，左右开衩，内穿白布中衣，足蹬黑缎皂靴，颈挂朝珠，前胸对襟两侧各半方补、后背整方，绣一只仙鹤，面料妆花缎，主色石青。";
const promptCostume = "人物：26岁的东亚男性，身高约 178 厘米。\n\n服装：\n" + costume + "\n\n不要出现：晚清大拉翅、花盆底、氅衣；不要明代交领、乌纱帽；不要和服、韩服。";
const promptBase = "人物：26岁的东亚男性，身高约 178 厘米。\n\n服装：上身赤裸，下身只穿一条肉色无缝紧身短裤，没有其他衣物、没有鞋、没有配饰，身体轮廓清楚可见。";
const jobs = [
  { idx: 0, total: 2, providerId: "mock", model: "mock-image", prompt: promptCostume, size: "1024x1024", retries: 1,
    gender: "男", filenameHint: "E2E_清装_文官_178cm_正背设定卡",
    promptMeta: { layout: "sheet_2view", layoutLabel: "正背设定卡", ratio: "16:9", res: "2K", size: "1024x1024",
      detailPreset: "detailed", blocksEnabled: ["subject", "outfit"], length: promptCostume.length, era: "qing_early", role: "official_civil", rank: "1", costumeChars: costume.length,
      evidence: { lookId: "qe_civil_1", level: "A/B", refs: ["S1", "S5"], note: "官修典制与馆藏实物" } },
    character: { seed: 12345, params: { sex: "male", age: 26, height: 178, era: "qing_early", community: "manchu", role: "official_civil", rank: "1", occasion: "daily",
      headwear: "nuanmao", outer: "bufu", inner: "zhongyi", lower: "paoju", shoes: "zaoxue", accessory: "chaozhu", pattern: "buzi_civil", material: "zhuanghuaduan", color: "shiqing" },
      meta: { name: "沈砚之", identity: "文官" }, highlights: [], template: "sheet_2view", size: "1024x1024" } },
  { idx: 1, total: 2, providerId: "mock", model: "mock-image", prompt: promptBase, size: "1024x1024", retries: 1,
    gender: "女", filenameHint: "E2E_素体_女_170cm_半身肖像",
    promptMeta: { layout: "portrait", layoutLabel: "半身肖像", ratio: "2:3", res: "2K", size: "1024x1024",
      detailPreset: "detailed", blocksEnabled: ["subject", "outfit"], length: promptBase.length, era: "none", role: "none", rank: "none", costumeChars: 0 },
    character: { seed: 777, params: { sex: "female", age: 26, height: 170, era: "none" }, meta: { name: "温南枝", identity: "绣娘" }, highlights: [], template: "portrait", size: "1024x1024" } }
];

const res = await fetch(base + "/api/generate-batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: "mock", jobs }), signal: AbortSignal.timeout(60000) });
ok(res.ok, "POST /api/generate-batch 200");
const text = await res.text();
const events = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
const dones = events.filter((e) => e.type === "job-done");
ok(dones.length === 2, "两张都出图（" + dones.length + "/2）");
ok(dones.every((d) => d.ok), "两张都成功");

const files = [];
async function walk(dir) {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(p); else files.push(p);
  }
}
await walk(OUT);
const jsons = files.filter((f) => f.endsWith(".json") && !f.endsWith("index.json"));
ok(jsons.length === 2, "落盘两份 JSON（" + jsons.length + "）");
const recs = [];
for (const f of jsons) recs.push(JSON.parse(await fs.readFile(f, "utf8")));
const costumeRec = recs.find((r) => r.promptMeta && r.promptMeta.era === "qing_early");
const baseRec = recs.find((r) => r.promptMeta && r.promptMeta.era === "none");
ok(!!costumeRec && !!baseRec, "能按 promptMeta.era 区分清装/素体存档");
ok(costumeRec.schemaVersion === 4, "清装存档 schemaVersion=4（实际 " + (costumeRec && costumeRec.schemaVersion) + "）");
ok(costumeRec.promptMeta.role === "official_civil" && costumeRec.promptMeta.rank === "1", "promptMeta 记了 role/rank");
ok(costumeRec.promptMeta.costumeChars === costume.length, "promptMeta 记了服饰句字数");
ok(costumeRec.promptMeta.evidence?.lookId === "qe_civil_1" && costumeRec.promptMeta.evidence?.refs?.includes("S1"), "promptMeta 保存身份卡证据元数据");
ok(costumeRec.actualSize && costumeRec.actualSize !== costumeRec.requestedSize && costumeRec.sizeMatchesRequest === false, "按图片编码记录实际像素，假上游微图不能误报请求的2K尺寸");
ok(costumeRec.character.params.era === "qing_early" && costumeRec.character.params.outer === "bufu", "character.params 保留时代与槽位");
ok(costumeRec.prompt.indexOf("石青色补褂") >= 0, "存档 prompt 里含服饰句");
ok(baseRec.promptMeta.costumeChars === 0 && baseRec.character.params.era === "none", "素体存档 era=none / 0 字服饰");
const idx = JSON.parse(await fs.readFile(path.join(OUT, "index.json"), "utf8"));
ok(Array.isArray(idx) && idx.length === 2, "index.json 追加两条");

console.log("");
const failed = results.filter((r) => !r[0]);
console.log("E2E " + (results.length - failed.length) + "/" + results.length + " 通过");
if (failed.length) { for (const f of failed) console.log(" - " + f[1]); process.exitCode = 1; }
child.kill("SIGKILL");
await mock.close();
await sleep(300);
process.exit(process.exitCode || 0);
