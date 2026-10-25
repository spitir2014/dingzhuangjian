/* 定妆间无浏览器测试底座
 *
 * 用法：
 *   import { createHarness } from "./lib/app-harness.mjs";
 *   const h = await createHarness();
 *   h.reset();
 *   h.run("compilePrompt()");
 *
 * 设计要点：
 * - 整份加载 web/app.js（不维护函数清单）：只从末尾剥掉 boot().catch(...) 启动调用；
 * - 用万能 Proxy 打桩 DOM / window / localStorage / fetch / 计时器，纯前端代码可以直接跑；
 * - 数据不走 fetch，由本模块读 data/*.json 后在 vm 里注入 DATA；
 * - 每个 createHarness() 有独立 vm context，互不串状态；同一 context 内用 reset() 回到基线。
 *
 * 约定：本模块只做“能加载、能调”，不对业务行为做断言（断言都在 scripts/test-model.mjs）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录（scripts/lib/ 往上两级） */
export const ROOT = path.resolve(HERE, "..", "..");

/** reset() 用的固定人物，保证测试不受姓名/身份随机影响 */
export const FIXED_META = Object.freeze({
  name: "陆行舟",
  identity: "游侠",
  personality: "沉静",
  trait: "寡言",
  bio: "",
  styleKeywords: []
});

/** reset() 的固定种子 */
export const FIXED_SEED = 123456;

const J = (v) => JSON.stringify(v);

/* ------------------------------------------------------------------ *
 * DOM / 浏览器 API 打桩
 * ------------------------------------------------------------------ */

/**
 * 万能节点桩：任意属性都返回同一个可调用 Proxy。
 * 特判（与应用里会被真值判断/字符串拼接的属性有关）：
 * - hidden=false、activeElement=null（document.hidden / document.activeElement）
 * - length=0（querySelectorAll 结果的长度循环不进入）
 * - textContent/value/innerHTML 等读作 ""，支持 += 拼接
 * - Symbol.toPrimitive 返回 ""，String(node) / node + "x" 不会抛
 * - toJSON=undefined，避免 JSON.stringify(state) 时把桩序列化成循环
 */
function makeNodeStub() {
  const target = function () {};
  const handler = {
    get(t, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "then") return undefined;
      if (prop === "toJSON") return undefined;
      if (prop === "hidden") return false;
      if (prop === "activeElement") return null;
      if (prop === "length") return 0;
      if (prop === "nodeType") return 1;
      if (prop === "dataset" || prop === "style" || prop === "classList") return stub;
      if (prop === "value" || prop === "textContent" || prop === "innerHTML" ||
          prop === "id" || prop === "className" || prop === "title") return "";
      if (prop in t) return t[prop];
      return stub;
    },
    set() { return true; },
    apply() { return stub; },
    construct() { return stub; },
    has() { return true; }
  };
  let stub;
  stub = new Proxy(target, handler);
  return stub;
}

/** localStorage 桩：真存真取（saveState/restoreState 能跑，但不跨 harness） */
function makeLocalStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    key(i) { return Array.from(map.keys())[i] || null; },
    get length() { return map.size; }
  };
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 加载 web/app.js 并返回测试句柄。
 *
 * @param {object} [opts]
 * @param {string} [opts.appPath] 默认 <root>/web/app.js
 * @returns {Promise<{
 *   run: (expr: string) => any,
 *   state: object,
 *   DATA: object,
 *   reset: (opts?: object) => void,
 *   has: (name: string) => boolean,
 *   callJson: (name: string, ...args: any[]) => any,
 *   appPath: string,
 *   appSrc: string,
 *   bootStrip: "catch" | "call",
 *   ctx: object
 * }>}
 */
export async function createHarness(opts = {}) {
  const appPath = opts.appPath || path.join(ROOT, "web", "app.js");
  const src = await fs.readFile(appPath, "utf8");

  /* 只去掉末尾启动调用：boot().catch(function(){...}); 不能把 boot 函数本体一起删 */
  let appSrc = src;
  let bootStrip = null;
  const catchMatch = /boot\(\)\.catch\([\s\S]*$/.exec(src);
  if (catchMatch) {
    appSrc = src.slice(0, catchMatch.index);
    bootStrip = "catch";
  } else {
    const callMatch = /^\s*boot\(\)\s*;?\s*$/m.exec(src);
    if (callMatch) {
      appSrc = src.slice(0, callMatch.index);
      bootStrip = "call";
    } else {
      throw new Error(
        "app.js 末尾没有找到 boot().catch(...)（或 boot();）启动调用，" +
        "无法安全加载；请检查 web/app.js 是否被改坏，或更新 app-harness 的剥除规则"
      );
    }
  }

  const node = makeNodeStub();
  const localStorage = makeLocalStorage();

  const documentStub = node;
  const windowStub = new Proxy(
    {
      innerWidth: 1920,
      innerHeight: 1080,
      devicePixelRatio: 1,
      document: documentStub,
      localStorage,
      location: { protocol: "http:", host: "localhost", href: "http://localhost/" },
      addEventListener() {},
      removeEventListener() {},
      matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
      getComputedStyle() { return node; },
      requestAnimationFrame: (cb) => {
        try { cb(0); } catch (e) { /* 桩只保证同步安全 */ }
        return 1;
      },
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: () => 2,
      clearInterval() {}
    },
    {
      get(t, prop) {
        if (prop === Symbol.toPrimitive) return () => "";
        if (prop in t) return t[prop];
        return node;
      },
      set(t, prop, value) { t[prop] = value; return true; }
    }
  );
  windowStub.window = windowStub;
  windowStub.self = windowStub;

  const sandbox = {
    console,
    document: documentStub,
    window: windowStub,
    self: windowStub,
    navigator: { userAgent: "node-harness", language: "zh-CN", clipboard: { writeText: async () => {} } },
    location: windowStub.location,
    localStorage,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => "" }),
    requestAnimationFrame: (cb) => {
      try { cb(0); } catch (e) { /* 同步执行，异步回调异常不影响加载 */ }
      return 1;
    },
    cancelAnimationFrame() {},
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 2,
    clearInterval() {},
    getComputedStyle: () => node,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    alert() {},
    confirm: () => false,
    prompt: () => null
  };

  const ctx = vm.createContext(sandbox);
  try {
    vm.runInContext(appSrc, ctx, { filename: "web/app.js" });
  } catch (e) {
    const msg = e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n") : String(e);
    throw new Error("把 web/app.js 加载进 vm 失败（多半是顶层 DOM/浏览器 API 没有打桩）：\n" + msg);
  }

  const run = (expr) => vm.runInContext(String(expr), ctx);

  /* 加载后的结构自检：后面所有用例都依赖这些顶层函数 */
  if (run("typeof compilePrompt") !== "function") {
    throw new Error("app.js 结构变了：compilePrompt 不是函数（函数名/末尾启动调用需要更新）");
  }
  if (run("typeof buildVars") !== "function") {
    throw new Error("app.js 结构变了：buildVars 不是函数（函数名/末尾启动调用需要更新）");
  }

  /* 读数据并在 vm 里注入 DATA（不触发 loadData/fetch） */
  const [params, templates, layoutsJson, eras, names, presetsJson] = await Promise.all([
    readJson("data/params.json"),
    readJson("data/templates.json"),
    readJson("data/layouts.json"),
    readJson("data/eras.json"),
    readJson("data/names.json"),
    readJson("data/presets.json")
  ]);
  const layouts = Array.isArray(layoutsJson.layouts) && layoutsJson.layouts.length
    ? layoutsJson.layouts
    : (templates.templates || []);
  const presets = Array.isArray(presetsJson.presets) ? presetsJson.presets : [];

  run(
    "DATA.params = " + J(params) + ";\n" +
    "DATA.order = " + J(templates.order || []) + ";\n" +
    "DATA.content = " + J(templates.content || {}) + ";\n" +
    "DATA.layouts = " + J(layouts) + ";\n" +
    "DATA.eras = " + J(eras) + ";\n" +
    "DATA.names = " + J(names) + ";\n" +
    "DATA.presets = " + J(presets) + ";\n" +
    "DATA.params.groups.forEach(function (g) { g.params.forEach(function (p) { paramIndex[p.id] = p; }); });\n" +
    "buildParamGroupIndex();\n"
  );

  const stateRef = run("state");
  const dataRef = run("DATA");

  /**
   * 回到基线状态。只做状态初始化，不调 UI 渲染（syncAll 由各业务函数自己决定）。
   * 与 app.js 启动后“没有旧存档”的路径一致：defaultParams → defaultBlocks → loadBlocks。
   */
  function reset(o = {}) {
    const meta = Object.assign({}, FIXED_META, o.meta || {});
    const seed = o.seed == null ? FIXED_SEED : Number(o.seed) >>> 0;
    const templateId = o.templateId || "sheet_2view";
    const ratio = o.ratio || "16:9";
    run(
      "state.templateId = " + J(templateId) + ";\n" +
      "state.ratio = " + J(ratio) + ";\n" +
      "state.res = " + J(o.res || "2K") + ";\n" +
      "state.params = defaultParams();\n" +
      "state.locks = new Set();\n" +
      "state.seed = " + seed + ";\n" +
      "state.highlights = [];\n" +
      "state.meta = " + J(meta) + ";\n" +
      "state.lookId = \"\";\n" +
      "state.lookCustomized = {};\n" +
      "state.derivedConflicts = [];\n" +
      "state.manualOverrides = {};\n" +
      "state.rollTick = 0;\n" +
      "state.paramRevision = 0;\n" +
      "state.detailPreset = \"detailed\";\n" +
      "state.templateText = {};\n" +
      "state.blocks = defaultBlocks();\n" +
      "loadBlocks();\n"
    );
  }

  function has(name) {
    return run("typeof " + name) === "function";
  }

  function callJson(name, ...args) {
    const list = args.map((a) => (a === undefined ? "undefined" : J(a))).join(", ");
    return run(name + "(" + list + ")");
  }

  return {
    run,
    state: stateRef,
    DATA: dataRef,
    reset,
    has,
    callJson,
    appPath,
    appSrc,
    bootStrip,
    ctx
  };
}

async function readJson(rel) {
  return JSON.parse(await fs.readFile(path.join(ROOT, rel), "utf8"));
}
