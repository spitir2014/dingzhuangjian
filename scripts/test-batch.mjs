/* 批次流程端到端测试：本地假上游（scripts/mock-upstream.mjs）+ 真实 server.mjs 临时实例。

   四组用例：
     a) ok     —— 2 个任务并发出图、存档，批次记录有 finishedAt
     b) stall  —— 上游永不响应，单次超时后按 timeout 失败，整批 8 秒内结束
     c) cancel —— 4 个任务（并发上限压到 1），收到第一个 job-start 后取消：不再派发新任务，batch-done.cancelled > 0
     d) 503    —— 第一次返回 503，自动重试后成功（attempts > 1）

   边界：全部跑在临时目录 tmp/test-batch-<时间戳>/ 里，用 PORT / ZXT_CONFIG / ZXT_OUT 拉起独立实例，
   **不读写项目真实的 config.json 与 output/**；假上游只听 127.0.0.1，不调用真实上游、不花钱。

   用法：node scripts/test-batch.mjs   （或 npm run test:batch）
*/

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-upstream.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_FILE = path.join(ROOT, "server.mjs");
const TMP_ROOT = path.join(ROOT, "tmp", "test-batch-" + timeStamp());
const BASE_PORT = 8802;
const results = [];
const serverLogs = [];

function timeStamp() {
  const d = new Date();
  const pad = function (n) { return String(n).padStart(2, "0"); };
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function byType(events, type) {
  return events.filter(function (e) { return e && e.type === type; });
}

/* server.mjs 没有 ZXT_CONFIG / ZXT_OUT 时会读写真实的 config.json 与 output/，这里先拦住 */
async function preflight() {
  let src = "";
  try {
    src = await fs.readFile(SERVER_FILE, "utf8");
  } catch (e) {
    throw new Error("读不到 server.mjs：" + String((e && e.message) || e));
  }
  if (src.indexOf("ZXT_CONFIG") < 0 || src.indexOf("ZXT_OUT") < 0) {
    throw new Error(
      "server.mjs 还没有支持 ZXT_CONFIG / ZXT_OUT 环境变量，测试没法起隔离实例；\n" +
      "继续跑会读写真实的 config.json 与 output/，所以这里直接中止。请等服务端改动完成后再跑 npm run test:batch。"
    );
  }
}

async function prepareCase(name) {
  const dir = path.join(TMP_ROOT, name);
  const outDir = path.join(dir, "out");
  await fs.mkdir(outDir, { recursive: true });
  return { dir: dir, outDir: outDir, configPath: path.join(dir, "config.json") };
}

async function writeConfig(file, mockPort, settings) {
  const origin = "http://127.0.0.1:" + mockPort;
  const config = {
    providers: [
      {
        id: "mock",
        name: "本地假上游",
        baseUrl: origin,
        apiKey: "sk-test",
        authHeader: "Authorization",
        authPrefix: "Bearer",
        enabled: true,
        modelBase: origin + "/v1"
      }
    ],
    settings: Object.assign({ downloadDir: "output" }, settings || {})
  };
  await fs.writeFile(file, JSON.stringify(config, null, 2), "utf8");
}

async function startServer(options) {
  const child = spawn(process.execPath, [SERVER_FILE], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, {
      PORT: String(options.port),
      ZXT_CONFIG: options.configPath,
      ZXT_OUT: options.outDir
    })
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", function (c) { stdout += c; });
  child.stderr.on("data", function (c) { stderr += c; });
  let exited = false;
  child.once("exit", function () { exited = true; });
  const entry = {
    child: child,
    logs: function () { return (stdout + stderr).trim(); }
  };
  serverLogs.push(entry);

  const base = "http://127.0.0.1:" + options.port;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        "server.mjs 启动失败（进程已退出，端口 " + options.port + "）：\n" + (stdout + stderr).trim().slice(-2000)
      );
    }
    try {
      const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) });
      if (r.ok) return { child: child, base: base, logs: entry.logs };
    } catch (e) {}
    await sleep(200);
  }
  await stopServer(child);
  throw new Error("等 /api/health 10 秒仍未就绪：\n" + (stdout + stderr).trim().slice(-2000));
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(function (resolve) { child.once("exit", resolve); });
  try {
    child.kill();
  } catch (e) {}
  const timer = setTimeout(function () {
    try { child.kill("SIGKILL"); } catch (e) {}
  }, 4000);
  await Promise.race([exited, sleep(8000)]);
  clearTimeout(timer);
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    body = null;
  }
  return { status: res.status, body: body };
}

/* 读 NDJSON 响应流：逐行解析，收到一行就回一个事件（取消用例靠 onEvent 半路插取消） */
async function postBatch(base, body, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || 30000;
  const events = [];
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);

  async function emit(line) {
    const text = line.trim();
    if (!text) return;
    let evt;
    try {
      evt = JSON.parse(text);
    } catch (e) {
      throw new Error("NDJSON 行不是合法 JSON：" + text.slice(0, 200));
    }
    events.push(evt);
    if (opts.onEvent) await opts.onEvent(evt, events);
  }

  try {
    const res = await fetch(base + "/api/generate-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error("POST /api/generate-batch 返回 " + res.status + "：" + text.slice(0, 300));
    }
    if (!res.body) throw new Error("POST /api/generate-batch 没有响应体，服务端可能没按 NDJSON 返回");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let closed = false;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        closed = true;
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        await emit(line);
      }
    }
    buffer += decoder.decode();
    await emit(buffer);
    return { events: events, closed: closed };
  } catch (e) {
    if (e && (e.name === "AbortError" || e.name === "TimeoutError")) {
      throw new Error("批次响应流 " + timeoutMs + "ms 内没有结束（可能卡住或没等到 batch-done）");
    }
    throw e;
  } finally {
    clearTimeout(timer);
    try { controller.abort(); } catch (e) {}
  }
}

function makeJob(name, gender) {
  return {
    model: "mock-image",
    prompt: "批次测试提示词：" + name,
    gender: gender,
    filenameHint: name + "_170cm_正背设定卡",
    character: { seed: 1234, meta: { name: name } }
  };
}

async function walkFiles(dir, out) {
  out = out || [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) await walkFiles(abs, out);
    else out.push(abs);
  }
  return out;
}

/* ---------- 用例 a：ok ---------- */
async function caseOk() {
  const dirs = await prepareCase("a-ok");
  const mock = await startMock({ port: 0, mode: "ok" });
  let server = null;
  try {
    await writeConfig(dirs.configPath, mock.port, { jobTimeoutMs: 10000, jobDeadlineMs: 20000 });
    server = await startServer({ port: BASE_PORT, configPath: dirs.configPath, outDir: dirs.outDir });

    const jobs = [makeJob("测试甲", "男"), makeJob("测试乙", "女")];
    const run = await postBatch(server.base, { providerId: "mock", jobs: jobs }, { timeoutMs: 15000 });
    const events = run.events;

    assert.ok(run.closed, "批次结束时响应流应当读完后关闭");
    const start = byType(events, "batch-start")[0];
    assert.ok(start, "没收到 batch-start 事件");
    assert.ok(start.batchId, "batch-start 应带 batchId");
    assert.equal(start.total, jobs.length, "batch-start.total 应为 " + jobs.length + "，实际 " + start.total);

    const dones = byType(events, "job-done");
    assert.equal(dones.length, jobs.length, "应有 " + jobs.length + " 条 job-done，实际 " + dones.length);
    for (const job of dones) {
      assert.equal(
        job.ok,
        true,
        "第 " + (job.idx + 1) + " 张应成功，实际 ok=" + job.ok + " code=" + job.code + " error=" + job.error
      );
    }
    const batchDone = byType(events, "batch-done")[0];
    assert.ok(batchDone, "没收到 batch-done 事件");
    assert.equal(batchDone.ok, jobs.length, "batch-done.ok 应为 " + jobs.length + "，实际 " + batchDone.ok);
    assert.equal(batchDone.fail, 0, "batch-done.fail 应为 0，实际 " + batchDone.fail);

    const info = await getJson(server.base + "/api/batch/" + start.batchId);
    assert.equal(info.status, 200, "GET /api/batch/:id 应返回 200，实际 " + info.status);
    assert.ok(info.body && info.body.batch, "GET /api/batch/:id 应返回 batch 对象，实际 " + JSON.stringify(info.body));
    assert.ok(info.body.batch.finishedAt, "批次结束后 GET /api/batch/:id 的 finishedAt 应非空");

    const files = await walkFiles(dirs.outDir);
    const images = files.filter(function (f) { return /\.(png|jpg|jpeg|webp)$/i.test(f); });
    assert.equal(
      images.length,
      jobs.length,
      "临时 out 下应有 " + jobs.length + " 张图片，实际 " + images.length +
        "（" + files.map(function (f) { return path.relative(dirs.outDir, f); }).join("、") + "）"
    );
    const indexFile = path.join(dirs.outDir, "index.json");
    assert.ok(files.indexOf(indexFile) >= 0, "临时 out 下应有 index.json");
    const index = JSON.parse(await fs.readFile(indexFile, "utf8"));
    assert.ok(
      Array.isArray(index) && index.length === jobs.length,
      "index.json 应有 " + jobs.length + " 条记录，实际 " + (Array.isArray(index) ? index.length : "不是数组")
    );
    const png = await fs.readFile(images[0]);
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", "存档图片应是 PNG（文件签名不符）");
  } finally {
    if (server) await stopServer(server.child);
    await mock.close();
  }
}

/* ---------- 用例 b：stall 超时 ---------- */
async function caseStall() {
  const dirs = await prepareCase("b-stall");
  const mock = await startMock({ port: 0, mode: "stall" });
  let server = null;
  try {
    await writeConfig(dirs.configPath, mock.port, { jobTimeoutMs: 1500, jobDeadlineMs: 2000 });
    server = await startServer({ port: BASE_PORT + 1, configPath: dirs.configPath, outDir: dirs.outDir });

    const startedAt = Date.now();
    const run = await postBatch(
      server.base,
      { providerId: "mock", jobs: [makeJob("超时甲", "男")] },
      { timeoutMs: 12000 }
    );
    const elapsed = Date.now() - startedAt;
    const events = run.events;

    assert.ok(run.closed, "超时批次结束时响应流也应当读完后关闭");
    assert.ok(elapsed < 8000, "整批应在 8 秒内结束，实际 " + elapsed + "ms");
    const dones = byType(events, "job-done");
    assert.equal(dones.length, 1, "应有 1 条 job-done，实际 " + dones.length);
    assert.equal(dones[0].ok, false, "上游不响应时这张应失败，实际 ok=" + dones[0].ok);
    assert.equal(
      dones[0].code,
      "timeout",
      "job-done.code 应为 timeout（单张超时），实际 code=" + dones[0].code + " error=" + dones[0].error
    );
    const batchDone = byType(events, "batch-done")[0];
    assert.ok(batchDone, "超时后仍应收到 batch-done（响应流要正常结束）");
    assert.equal(batchDone.ok, 0, "batch-done.ok 应为 0，实际 " + batchDone.ok);
    assert.equal(batchDone.fail, 1, "batch-done.fail 应为 1，实际 " + batchDone.fail);
  } finally {
    if (server) await stopServer(server.child);
    await mock.close();
  }
}

/* ---------- 用例 c：cancel ---------- */
async function caseCancel() {
  const dirs = await prepareCase("c-cancel");
  const mock = await startMock({ port: 0, mode: "slow", delayMs: 1500 });
  let server = null;
  try {
    /* 4 个任务、模型并发上限压到 1：取消时必然还有没开始的排队任务；
       并发 > 1 时首批 job-start 会在取消请求到达前一起写出，断言"取消后没有新 job-start"会有竞态 */
    await writeConfig(dirs.configPath, mock.port, {
      jobTimeoutMs: 15000,
      jobDeadlineMs: 30000,
      modelConcurrency: { "mock-image": 1 }
    });
    server = await startServer({ port: BASE_PORT + 2, configPath: dirs.configPath, outDir: dirs.outDir });

    const jobs = [
      makeJob("取消甲", "男"),
      makeJob("取消乙", "女"),
      makeJob("取消丙", "中性"),
      makeJob("取消丁", "男")
    ];
    let batchId = null;
    let cancelAt = -1;
    let cancelStatus = 0;
    const startedAt = Date.now();

    const run = await postBatch(server.base, { providerId: "mock", jobs: jobs }, {
      timeoutMs: 20000,
      onEvent: async function (evt, all) {
        if (evt.type === "batch-start") batchId = evt.batchId;
        if (evt.type === "job-start" && cancelAt < 0) {
          cancelAt = all.length - 1;
          const r = await fetch(server.base + "/api/batch/" + batchId + "/cancel", {
            method: "POST",
            signal: AbortSignal.timeout(5000)
          });
          cancelStatus = r.status;
          const j = await r.json();
          assert.equal(r.status, 200, "POST /api/batch/:id/cancel 应返回 200，实际 " + r.status);
          assert.equal(j.ok, true, "取消接口 ok 应为 true，实际 " + JSON.stringify(j));
          assert.equal(j.cancelled, true, "取消接口 cancelled 应为 true，实际 " + JSON.stringify(j));
        }
      }
    });
    const elapsed = Date.now() - startedAt;
    const events = run.events;

    assert.ok(run.closed, "取消后响应流也应读完后关闭");
    assert.ok(cancelAt >= 0 && batchId, "没等到第一个 job-start，取消没有发出去");
    assert.equal(cancelStatus, 200, "取消请求应返回 200，实际 " + cancelStatus);

    const starts = byType(events, "job-start");
    assert.equal(starts.length, 1, "并发上限为 1 时只应有 1 个 job-start，实际 " + starts.length);
    const laterStarts = events.slice(cancelAt + 1).filter(function (e) { return e.type === "job-start"; });
    assert.equal(
      laterStarts.length,
      0,
      "取消后不应再派发新的 job-start，实际又派发了 " + laterStarts.map(function (e) { return e.idx; }).join("、")
    );

    const batchDone = byType(events, "batch-done")[0];
    assert.ok(batchDone, "取消后仍应收到 batch-done");
    assert.ok(
      Number(batchDone.cancelled) > 0,
      "batch-done.cancelled 应大于 0（有排队任务被取消），实际 " + batchDone.cancelled
    );
    assert.ok(elapsed < 15000, "取消后整批应在 15 秒内结束，实际 " + elapsed + "ms");

    const info = await getJson(server.base + "/api/batch/" + batchId);
    assert.equal(info.status, 200, "取消后 GET /api/batch/:id 应返回 200，实际 " + info.status);
    assert.ok(
      info.body && info.body.batch && info.body.batch.finishedAt,
      "取消后 GET /api/batch/:id 的 finishedAt 应非空"
    );
  } finally {
    if (server) await stopServer(server.child);
    await mock.close();
  }
}

/* ---------- 用例 d：503 重试 ---------- */
async function caseRetry503() {
  const dirs = await prepareCase("d-503");
  const mock = await startMock({ port: 0, mode: "503", times503: 1 });
  let server = null;
  try {
    await writeConfig(dirs.configPath, mock.port, { jobTimeoutMs: 20000, jobDeadlineMs: 30000 });
    server = await startServer({ port: BASE_PORT + 3, configPath: dirs.configPath, outDir: dirs.outDir });

    const run = await postBatch(
      server.base,
      { providerId: "mock", jobs: [makeJob("重试甲", "男")] },
      { timeoutMs: 20000 }
    );
    const events = run.events;

    assert.ok(run.closed, "重试成功后响应流应读完后关闭");
    const dones = byType(events, "job-done");
    assert.equal(dones.length, 1, "应有 1 条 job-done，实际 " + dones.length);
    assert.equal(
      dones[0].ok,
      true,
      "第一次 503 后应自动重试成功，实际 ok=" + dones[0].ok + " code=" + dones[0].code + " error=" + dones[0].error
    );
    assert.ok(
      Number(dones[0].attempts) > 1,
      "job-done.attempts 应大于 1（说明确实重试过），实际 " + dones[0].attempts
    );
    const batchDone = byType(events, "batch-done")[0];
    assert.ok(batchDone, "应收到 batch-done");
    assert.equal(batchDone.ok, 1, "batch-done.ok 应为 1，实际 " + batchDone.ok);
  } finally {
    if (server) await stopServer(server.child);
    await mock.close();
  }
}

/* ---------- 运行与汇总 ---------- */
async function runCase(name, fn) {
  const serverCountBefore = serverLogs.length;
  const startedAt = Date.now();
  console.log("… " + name);
  try {
    await fn();
    const ms = Date.now() - startedAt;
    results.push({ name: name, ok: true, ms: ms });
    console.log("PASS  " + name + "（" + ms + "ms）");
  } catch (e) {
    const ms = Date.now() - startedAt;
    results.push({ name: name, ok: false, ms: ms, error: e });
    console.log("FAIL  " + name + "（" + ms + "ms）");
    console.log("      " + String((e && e.message) || e).replace(/\n/g, "\n      "));
    for (let i = serverCountBefore; i < serverLogs.length; i++) {
      const logs = serverLogs[i].logs();
      if (logs) console.log("      ── server 日志（末尾 1200 字）──\n      " + logs.slice(-1200).replace(/\n/g, "\n      "));
    }
  }
}

async function main() {
  await preflight();
  console.log("批次测试临时目录：" + TMP_ROOT);
  console.log("（假上游只监听 127.0.0.1，服务端实例用临时 config / out，不碰真实存档）");
  console.log("");

  await runCase("a) ok：2 个任务并发出图并存档", caseOk);
  await runCase("b) stall：上游不响应，整批 8 秒内按 timeout 结束", caseStall);
  await runCase("c) cancel：4 个任务、并发 1，首个 job-start 后取消", caseCancel);
  await runCase("d) 503：首次失败后自动重试成功", caseRetry503);

  const failed = results.filter(function (r) { return !r.ok; });
  console.log("");
  console.log("========================================");
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + "（" + r.ms + "ms）");
  console.log("共 " + results.length + " 组：通过 " + (results.length - failed.length) + "，失败 " + failed.length);
  console.log("临时目录：" + TMP_ROOT);
  if (failed.length) {
    console.log("失败原因见上面每一组 FAIL 后面的说明。");
    process.exitCode = 1;
  } else {
    console.log("全部通过。");
  }
}

try {
  await main();
} catch (e) {
  console.error("测试无法运行：" + String((e && e.message) || e));
  process.exitCode = 1;
}
