/* 本地假上游：只实现 OpenAI 兼容的接口，用来离线跑批次流程与参考图反推。
   - GET  /v1/models             → { data: [{ id: "mock-image", object: "model" }] }
   - POST /v1/images/generations → 按 MOCK_MODE 返回：ok / slow / stall / 503
   - POST /v1/chat/completions   → 固定返回一段「反推提示词」，用于参考图复刻测试
   - GET  /v1/mock-image.png     → 返回一张 1×1 PNG，用于「图片链接 → data URL」测试

   零依赖、只监听 127.0.0.1、不联网、不花钱。

   直接运行：
     node scripts/mock-upstream.mjs [--port 8801] [--mode ok|slow|stall|503] [--delay 1500] [--times 1]
   环境变量：MOCK_PORT（默认 8801）、MOCK_MODE（默认 ok）、MOCK_DELAY_MS（默认 1500）、MOCK_503_TIMES（默认 1）

   也可以在测试脚本里 import：
     const mock = await startMock({ mode: "slow", delayMs: 1500 }); // → { server, port, close }
     ...
     await mock.close();
*/

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* 1×1 RGBA 最小合法 PNG（IHDR / IDAT / IEND 的 CRC 都正确），生图接口返回这张 */
export const MIN_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQrrn2HwAE0AJ9U2q3xQAAAABJRU5ErkJggg==";

const MODES = ["ok", "slow", "stall", "503"];
const DEFAULT_PORT = 8801;
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_503_TIMES = 1;

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizeMode(raw) {
  const mode = String(raw == null || raw === "" ? "ok" : raw).trim().toLowerCase();
  if (MODES.indexOf(mode) < 0) {
    throw new Error("未知的 MOCK_MODE：" + raw + "（可选 " + MODES.join(" / ") + "）");
  }
  return mode;
}

function sendJson(res, status, obj) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i]);
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : null;
    const take = function () {
      if (inline != null) return inline;
      if (i + 1 < argv.length && !String(argv[i + 1]).startsWith("--")) return argv[++i];
      return "";
    };
    if (key === "--help" || key === "-h") out.help = true;
    else if (key === "--port") out.port = take();
    else if (key === "--mode") out.mode = take();
    else if (key === "--delay" || key === "--delay-ms") out.delayMs = take();
    else if (key === "--times" || key === "--times-503") out.times503 = take();
  }
  return out;
}

/* 起一个假上游；port 传 0 时由系统分配，返回值里的 port 是实际端口 */
export async function startMock(options = {}) {
  const opts = options || {};
  const mode = normalizeMode(opts.mode != null ? opts.mode : process.env.MOCK_MODE);
  const port = toNumber(opts.port != null ? opts.port : process.env.MOCK_PORT, DEFAULT_PORT);
  const delayMs = toNumber(opts.delayMs != null ? opts.delayMs : process.env.MOCK_DELAY_MS, DEFAULT_DELAY_MS);
  const times503 = toNumber(opts.times503 != null ? opts.times503 : process.env.MOCK_503_TIMES, DEFAULT_503_TIMES);

  let hits503 = 0;
  /* 可选：第一次收到 strength 参数就返回 400，用来验证「去掉强度参数重试」的兜底 */
  const rejectStrength = opts.rejectStrength === true;
  let strengthRejected = false;
  const sockets = new Set();
  const timers = new Set();

  function chatJson(body) {
    const messages = (body && body.messages) || [];
    const text = JSON.stringify(messages);
    const hasImage = text.indexOf("data:image") >= 0;
    const strength = body.reasoning_effort || body.strength || "none";
    const content = "画面：mock 反推提示词，固定机位与柔和光线，材质清晰。\n\n风格与质感：mock 风格段（" +
      (hasImage ? "含图" : "无图") + "，强度 " + strength + "）";
    return {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: (body && body.model) || "mock-vision",
      choices: [{ index: 0, message: { role: "assistant", content: content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 }
    };
  }

  function handleChat(req, res) {
    let raw = "";
    let aborted = false;
    req.on("data", function (c) { raw += c; });
    req.on("aborted", function () { aborted = true; });
    req.on("close", function () { aborted = true; });
    req.on("error", function () { aborted = true; });
    req.on("end", function () {
      if (aborted || res.writableEnded || res.destroyed) return;
      if (!req.socket || req.socket.destroyed) return;
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch (e) { body = {}; }
      if (rejectStrength && body.reasoning_effort && !strengthRejected) {
        strengthRejected = true;
        return sendJson(res, 400, { error: { message: "mock upstream：不支持 reasoning_effort" } });
      }
      sendJson(res, 200, chatJson(body));
    });
  }

  function imageJson(model) {
    return {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: MIN_PNG_B64 }],
      model: model || "mock-image",
      size: "1024x1024",
      usage: { credit: 0.1 }
    };
  }

  function handleGenerate(req, res) {
    let raw = "";
    let aborted = false;
    req.on("data", function (c) { raw += c; });
    req.on("aborted", function () { aborted = true; });
    req.on("close", function () { aborted = true; });
    req.on("error", function () { aborted = true; });
    req.on("end", function () {
      if (aborted || res.writableEnded || res.destroyed) return;
      if (!req.socket || req.socket.destroyed) return;
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch (e) { body = {}; }
      if (mode === "stall") {
        /* 不写响应头、不 end：客户端会一直等，用来验证超时 / 取消；
           客户端 abort 后 req 会触发 aborted / close，这里静默忽略 */
        return;
      }
      if (mode === "503" && hits503 < times503) {
        hits503++;
        return sendJson(res, 503, { error: { message: "mock upstream 503（第 " + hits503 + " 次）" } });
      }
      if (mode === "slow") {
        const timer = setTimeout(function () {
          timers.delete(timer);
          sendJson(res, 200, imageJson(body && body.model));
        }, delayMs);
        if (typeof timer.unref === "function") timer.unref();
        timers.add(timer);
        return;
      }
      sendJson(res, 200, imageJson(body && body.model));
    });
  }

  const server = http.createServer(function (req, res) {
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch (e) {
      return sendJson(res, 400, { error: { message: "请求地址不合法" } });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return sendJson(res, 200, { data: [{ id: "mock-image", object: "model" }] });
    }
    if (req.method === "POST" && url.pathname === "/v1/images/generations") {
      return handleGenerate(req, res);
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return handleChat(req, res);
    }
    if (req.method === "GET" && url.pathname === "/v1/redirect-image") {
      res.writeHead(302, { Location: "/v1/mock-image.png" });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/v1/mock-image.png") {
      const buf = Buffer.from(MIN_PNG_B64, "base64");
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": buf.length,
        "Cache-Control": "no-store"
      });
      return res.end(buf);
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return sendJson(res, 200, { ok: true, mode: mode, delayMs: delayMs, times503: times503, hits503: hits503 });
    }
    return sendJson(res, 404, { error: { message: "假上游没有这个路由：" + req.method + " " + url.pathname } });
  });

  server.on("connection", function (socket) {
    sockets.add(socket);
    socket.on("close", function () { sockets.delete(socket); });
    socket.on("error", function () {});
  });

  await new Promise(function (resolve, reject) {
    const onError = function (e) {
      server.removeListener("listening", onListening);
      reject(e);
    };
    const onListening = function () {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

  const actualPort = server.address().port;

  function close() {
    return new Promise(function (resolve) {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) {
        try { socket.destroy(); } catch (e) {}
      }
      sockets.clear();
      try {
        server.close(function () { resolve(); });
      } catch (e) {
        resolve();
      }
    });
  }

  return { server: server, port: actualPort, mode: mode, close: close };
}

/* ---------- 直接运行：node scripts/mock-upstream.mjs [--port ...] ---------- */
const RUN_AS_SCRIPT = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_AS_SCRIPT) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("用法：node scripts/mock-upstream.mjs [--port 8801] [--mode ok|slow|stall|503] [--delay 1500] [--times 1]");
    console.log("环境变量：MOCK_PORT / MOCK_MODE / MOCK_DELAY_MS / MOCK_503_TIMES");
    process.exit(0);
  }
  let mock;
  try {
    mock = await startMock({
      port: args.port != null ? args.port : process.env.MOCK_PORT,
      mode: args.mode != null ? args.mode : process.env.MOCK_MODE,
      delayMs: args.delayMs != null ? args.delayMs : process.env.MOCK_DELAY_MS,
      times503: args.times503 != null ? args.times503 : process.env.MOCK_503_TIMES
    });
  } catch (e) {
    console.error("假上游启动失败：" + String((e && e.message) || e));
    process.exit(1);
  }
  console.log("假上游已启动：http://127.0.0.1:" + mock.port + "（模式 " + mock.mode + "）");
  console.log("  GET  /v1/models");
  console.log("  POST /v1/images/generations");
  if (mock.mode === "slow") console.log("  每次生图延迟 " + toNumber(args.delayMs != null ? args.delayMs : process.env.MOCK_DELAY_MS, DEFAULT_DELAY_MS) + "ms 后返回");
  if (mock.mode === "stall") console.log("  永不响应（用来测超时 / 取消，记得 Ctrl+C 退出）");
  if (mock.mode === "503") console.log("  前 " + toNumber(args.times503 != null ? args.times503 : process.env.MOCK_503_TIMES, DEFAULT_503_TIMES) + " 次返回 503，之后成功");
  console.log("按 Ctrl+C 退出。");

  let closing = false;
  const shutdown = function (signal) {
    if (closing) return;
    closing = true;
    console.log("\n收到 " + signal + "，假上游退出。");
    mock.close().then(function () { process.exit(0); }, function () { process.exit(0); });
  };
  process.on("SIGINT", function () { shutdown("SIGINT"); });
  process.on("SIGTERM", function () { shutdown("SIGTERM"); });
}
