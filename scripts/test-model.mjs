/* 造像台模型层三方一致性测试（不需要浏览器）
 *
 * 底座：scripts/lib/app-harness.mjs —— 整份加载 web/app.js（vm + DOM 桩），
 * 数据用 data/*.json 真值注入，不维护函数清单。
 *
 * 目标：把「左栏参数 / 提示词快照 / 最终发送文本 / 身份卡派生」按新契约钉死，
 * 当前实现在迁移中可以红灯，但失败信息必须指向具体缺失函数或行为不符。
 *
 * 运行：node scripts/test-model.mjs
 */
import { createHarness } from "./lib/app-harness.mjs";

const J = JSON.stringify;

/* ------------------------------------------------------------------ *
 * 输出与断言
 * ------------------------------------------------------------------ */
let pass = 0;
let fail = 0;
const findings = [];
let secTitle = "";
let secPass = 0;
let secFail = 0;

function section(title) {
  if (secTitle) {
    console.log("  -- 本节 " + secPass + " PASS / " + secFail + " FAIL");
  }
  secTitle = title;
  secPass = 0;
  secFail = 0;
  console.log("\n=== " + title + " ===");
}
function passLine(msg) {
  pass++;
  secPass++;
  console.log("  PASS " + msg);
}
function failLine(msg) {
  fail++;
  secFail++;
  console.log("  FAIL " + msg);
}
function finding(msg) {
  findings.push(msg);
  console.log("  FINDING " + msg);
}
function check(cond, msg) {
  if (cond) passLine(msg);
  else failLine(msg);
  return !!cond;
}
function requireApi(name, where) {
  if (h.has(name)) return true;
  failLine(where + "：缺少 " + name + "()（新契约要求）");
  return false;
}
function runJson(expr) {
  return JSON.parse(h.run("JSON.stringify(" + expr + ")"));
}
function cmp(a, b) {
  a = String(a);
  b = String(b);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return "首个差异 @" + i + "：预览=" + J(a.slice(Math.max(0, i - 14), i + 30)) +
    " 发送=" + J(b.slice(Math.max(0, i - 14), i + 30));
}
function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const h = await createHarness();
const state = h.state;

/* ------------------------------------------------------------------ *
 * 数据/结构缓存（全部从 vm 里的真 DATA 取，避免硬编码与 data/*.json 漂移）
 * ------------------------------------------------------------------ */
const layouts = runJson("DATA.layouts.map(function (t) { return { id: t.id, label: t.label, orient: t.orient || 'any' }; })");
const layoutIds = layouts.map(function (t) { return t.id; });
const slotIds = runJson("((DATA.eras && DATA.eras.slots) || []).map(function (s) { return s.id; })");
const looks = runJson("((DATA.eras && DATA.eras.looks) || []).map(function (l) { return { id: l.id, label: l.label, era: l.era, sex: l.sex || null, role: l.role || 'none', community: l.community || 'none', rank: l.rank == null ? 'none' : String(l.rank), occasion: l.occasion || 'daily', slots: l.slots || {} }; })");
const lookIds = looks.map(function (l) { return l.id; });
const eras = runJson("((DATA.eras && DATA.eras.eras) || []).map(function (e) { return { id: e.id, label: e.label, promptLead: e.promptLead || e.label }; })");
const paramGroups = runJson("DATA.params.groups.map(function (g) { return { id: g.id, label: g.label, ctx: g.ctx || null, params: g.params.map(function (p) { return { id: p.id, label: p.label, type: p.type, virtual: !!p.virtual, default: p.default, optionValues: (p.options || []).map(function (o) { return o.value; }) }; }) }; })");
const allParams = [];
paramGroups.forEach(function (g) { g.params.forEach(function (p) { p.group = g.id; allParams.push(p); }); });
const paramById = {};
allParams.forEach(function (p) { paramById[p.id] = p; });

/* 素体态：选时代前一键填满 9 个服饰槽位（用到的是真实参数选项，不是假数据） */
const FILL_SLOT_CODE = [
  "(function () {",
  "  var filled = 0;",
  "  ((DATA.eras && DATA.eras.slots) || []).forEach(function (slot) {",
  "    var p = paramIndex[slot.id];",
  "    var opts = (p && p.options) || [];",
  "    var opt = opts.find(function (o) { return o.value !== 'none' && weightOf(o, currentSex()) > 0; }) ||",
  "              opts.find(function (o) { return o.value !== 'none'; });",
  "    if (opt) { state.params[slot.id] = opt.value; filled++; }",
  "  });",
  "  commitParams({ reason: 'test', silent: true });",
  "  return filled;",
  "})()"
].join("\n");

function filledSlotCount() {
  let n = 0;
  slotIds.forEach(function (id) { if (state.params[id] !== "none") n++; });
  return n;
}

/* 准备 T1 的三种状态：素体 / 清·盛清+空槽位 / 清·盛清+满槽位 */
function prepareCase(tid, mode) {
  h.reset({ templateId: tid });
  if (mode === "bare") return;
  h.run("setParamValue('era', 'qing_early')");
  if (mode === "era_empty") {
    h.run("clearCostumeSlots(); state.lookId = ''; commitParams({ reason: 'test', silent: true });");
  } else if (mode === "era_full") {
    h.run(FILL_SLOT_CODE);
  }
}

function previewHtmlExact() {
  if (h.has("compilePromptHTML")) return h.run("compilePromptHTML({ mode: 'exact' })");
  return h.run(
    "(function () {" +
    "  var snap = buildPromptSnapshot();" +
    "  var parts = snap.segments.map(function (seg) { return renderTemplateHTML(seg.raw, snap.vars, { mode: 'exact' }); });" +
    "  var tail = eraNegative();" +
    "  if (tail) parts.push(escapeHtml(tail));" +
    "  return parts.join('\\n\\n');" +
    "})()"
  );
}
function previewHtmlRich() {
  if (h.has("compilePromptHTML")) return h.run("compilePromptHTML()");
  return h.run(
    "(function () {" +
    "  var snap = buildPromptSnapshot();" +
    "  return snap.segments.map(function (seg) { return renderTemplateHTML(seg.raw, snap.vars); }).join('\\n\\n');" +
    "})()"
  );
}

/* ------------------------------------------------------------------ *
 * 【0】契约 API / 状态字段
 * ------------------------------------------------------------------ */
function testApi() {
  const apis = [
    "buildPromptSnapshot", "compilePrompt", "renderTemplateHTML", "buildVars",
    "currentLook", "identityPhrase", "applyDerived", "commitParams",
    "clearCostumeSlots", "effectiveUsage", "usedVarKeys", "collectHealthIssues",
    "rollOne", "rerollAll", "setParamValue", "applyLookPreset", "generate"
  ];
  const missing = apis.filter(function (name) { return !h.has(name); });
  check(missing.length === 0, "新契约 API 齐全" + (missing.length ? "（缺 " + missing.join("、") + "）" : ""));

  h.reset();
  check(state.lookCustomized !== null && typeof state.lookCustomized === "object", "state.lookCustomized 是对象");
  check(typeof state.rollTick === "number", "state.rollTick 是数字");
  check(typeof state.paramRevision === "number", "state.paramRevision 是数字");
  const rev0 = state.paramRevision;
  h.run("commitParams({ reason: 'test', changed: '', silent: true })");
  check(state.paramRevision === rev0 + 1, "commitParams() 每次提交推进 paramRevision（" + rev0 + "→" + state.paramRevision + "）");
  h.run("rollOne('age')");
  check(state.rollTick > 0, "rollOne 推进 state.rollTick（连续掷换值的计数器）");

  const snap = h.run("buildPromptSnapshot()");
  const fields = ["text", "vars", "segments", "stats", "unknown", "empty", "overrides"];
  const lost = fields.filter(function (k) { return !(k in snap); });
  check(lost.length === 0, "buildPromptSnapshot() 返回契约字段" + (lost.length ? "（缺 " + lost.join("、") + "）" : ""));
  if (snap.stats) {
    const statKeys = ["chars", "vars", "empty", "unknown"];
    const lostStats = statKeys.filter(function (k) { return typeof snap.stats[k] !== "number"; });
    check(lostStats.length === 0, "stats 是 {chars,vars,empty,unknown} 数字字段" + (lostStats.length ? "（缺 " + lostStats.join("、") + "）" : ""));
  }
  if (Array.isArray(snap.segments)) {
    const badSeg = snap.segments.filter(function (seg) { return typeof seg.raw !== "string" || typeof seg.text !== "string"; });
    check(badSeg.length === 0, "segments 每段都有 raw（模板原文）与 text（最终文字），预览可复用");
  }
  check(h.run("compilePrompt()") === snap.text, "compilePrompt() === buildPromptSnapshot().text");
}

/* ------------------------------------------------------------------ *
 * 【T1】预览=发送：6 画幅 × 3 状态，renderTemplateHTML 去标签后逐字相等
 * ------------------------------------------------------------------ */
function testT1() {
  if (!requireApi("buildPromptSnapshot", "T1") || !requireApi("renderTemplateHTML", "T1")) return;
  check(layoutIds.length === 6, "画幅数为 6（实际 " + layoutIds.length + "）");

  const modes = [["bare", "素体"], ["era_empty", "清·盛清+槽位空"], ["era_full", "清·盛清+满槽位"]];
  for (const lay of layouts) {
    for (const pair of modes) {
      const mode = pair[0];
      const modeLabel = pair[1];
      prepareCase(lay.id, mode);
      if (mode === "era_full" && !check(filledSlotCount() === slotIds.length, lay.id + "/" + modeLabel + "：9 个服饰槽位都填满（实际 " + filledSlotCount() + "）")) {
        /* 填不满也继续比较预览与发送文本，只是把数据问题单独标红 */
      }
      const snap = h.run("buildPromptSnapshot()");
      const previewText = stripTags(previewHtmlExact());
      const eq = previewText === snap.text;
      check(eq, lay.id + "/" + modeLabel + "：预览去标签 === 发送文本（" + snap.text.length + " 字）");
      if (!eq) console.log("       " + cmp(previewText, snap.text));
      check(snap.text.indexOf("（空）") < 0, lay.id + "/" + modeLabel + "：发送文本不含「（空）」");
    }
  }

  /* rich 模式（段卡片解析预览）保留「（空）」；exact 模式空值输出零宽 span */
  h.reset();
  const emptyKeys = runJson("buildPromptSnapshot().empty");
  if (emptyKeys.length) {
    const key = emptyKeys[0];
    const rich = previewHtmlRich();
    const exact = previewHtmlExact();
    check(rich.indexOf("（空）") >= 0, "rich 预览保留「（空）」用于段卡片解析预览");
    const spanRe = new RegExp('<span class="[^"]*\\bpvar\\b[^"]*"[^>]*data-var="' + key + '"[^>]*></span>');
    check(spanRe.test(exact), "exact 预览为空变量 " + key + " 输出零宽 pvar span（无可见文字）");
    check(stripTags(exact).indexOf("（空）") < 0, "exact 预览去标签后不含「（空）」");
  } else {
    finding("素体态 buildPromptSnapshot().empty 为空，rich/exact 模式差异只做了等值检查");
  }
}

/* ------------------------------------------------------------------ *
 * 【T2】未知变量：不发送、进 stats.unknown；generate 层有拦截
 * ------------------------------------------------------------------ */
function testT2() {
  if (!requireApi("buildPromptSnapshot", "T2")) return;
  h.reset();
  h.run("state.blocks.push({ id: 'free_x', kind: 'free', label: '自定义', text: '补充：{{notAVar}} 与 {{age}}。', enabled: true })");
  const snap = h.run("buildPromptSnapshot()");
  const age = state.params.age;

  check(/\{\{\w+\}\}/.test(snap.text) === false, "发送文本里没有残留 {{变量}}（未知变量已剥掉）");
  check(snap.text.indexOf("{{notAVar}}") < 0, "发送文本不含 {{notAVar}}");
  check(snap.stats && snap.stats.unknown === 1, "stats.unknown === 1（实际 " + (snap.stats && snap.stats.unknown) + "）");
  const u0 = Array.isArray(snap.unknown) ? snap.unknown[0] : null;
  const uKey = typeof u0 === "string" ? u0 : (u0 && u0.key);
  check(uKey === "notAVar", "unknown 记录到 notAVar（实际 " + J(uKey) + "）");
  /* 契约：unknown:[{key,blocks}]；UI 提示与 generate 拦截都要靠同一形状（当前 updatePromptPreview 用 u.key，generate 用字符串） */
  check(
    !!u0 && typeof u0 === "object" && typeof u0.key === "string" && Array.isArray(u0.blocks),
    "unknown 条目形状为 {key,blocks}（实际 " + J(u0) + "）"
  );
  if (u0 && typeof u0 === "object" && Array.isArray(u0.blocks)) {
    check(u0.blocks.indexOf("自定义") >= 0, "unknown.blocks 记录来源段（自定义）");
  }
  check(snap.text.indexOf("补充：") >= 0 && snap.text.indexOf("与 " + age + "。") >= 0, "同段的已知变量 {{age}} 正常替换（" + age + "）");

  /* renderTemplateHTML 的 exact / rich 口径直接单测（最终提示词 vs 段卡片解析预览） */
  const exactUnknown = h.callJson("renderTemplateHTML", "前{{notAVar}}后", {}, { mode: "exact" });
  check(stripTags(exactUnknown) === "前后" && String(exactUnknown).indexOf("notAVar") < 0, "exact 模式未知变量直接消失（前{{notAVar}}后 → 前后）");
  const richUnknown = h.callJson("renderTemplateHTML", "前{{notAVar}}后", {});
  check(String(richUnknown).indexOf("unknown") >= 0 && String(richUnknown).indexOf("{{notAVar}}") >= 0, "rich 模式未知变量保留标红 span（段卡片解析预览）");
  const exactEmpty = h.callJson("renderTemplateHTML", "A{{costume}}B", { costume: "" }, { mode: "exact" });
  check(stripTags(exactEmpty) === "AB" && /\bpvar\b/.test(exactEmpty) && /data-var="costume"/.test(exactEmpty), "exact 模式空值输出零宽 pvar span 且无可见文字");

  const genSrc = h.run("typeof generate === 'function' ? String(generate) : ''");
  const guarded = /unknown\.length/.test(genSrc) && /buildPromptSnapshot/.test(genSrc);
  if (guarded) {
    passLine("generate 层先取 buildPromptSnapshot 并在 unknown.length > 0 时拦截");
  } else {
    finding("generate 层未知变量拦截未直接可见（generate 依赖 DOM；按说明以 stats.unknown > 0 且发送文本已剥掉为准）");
  }
}

/* ------------------------------------------------------------------ *
 * 【T3】掷：每个可掷参数连续 rollOne 10 次，至少 9 次换值
 * ------------------------------------------------------------------ */
function testT3() {
  if (!requireApi("rollOne", "T3")) return;
  const failures = [];
  const skipped = [];
  let tested = 0;
  /* 服饰槽位只有在时代开启时才可掷（素体态按设计恒为 none），所以按参数组准备合法上下文 */
  const eraEnv = function () {
    h.run("setParamValue('era', 'qing_early'); clearCostumeSlots(); state.lookId = ''; commitParams({ reason: 'test', silent: true });");
  };

  for (const p of allParams) {
    if (p.virtual || p.id === "sex" || (p.type !== "choice" && p.type !== "number")) continue;
    h.reset();
    if (p.group === "costume") eraEnv();
    if (p.type === "choice") {
      const n = h.run("allowedOptions(paramIndex[" + J(p.id) + "], currentSex()).length");
      if (n <= 1) {
        skipped.push(p.id + "（当前上下文只有 " + n + " 个可用选项）");
        continue;
      }
    }
    tested++;
    let prev = state.params[p.id];
    let changes = 0;
    const seq = [];
    for (let i = 0; i < 10; i++) {
      h.run("rollOne(" + J(p.id) + ")");
      const v = state.params[p.id];
      if (v !== prev) changes++;
      prev = v;
      seq.push(v);
    }
    if (changes < 9) failures.push({ id: p.id, changes: changes, seq: seq });
  }

  check(tested > 0, "找到可掷参数（" + tested + " 个）");
  if (skipped.length) console.log("  SKIP " + skipped.join("；"));
  check(
    failures.length === 0,
    "全部 " + tested + " 个可掷参数连续掷 10 次，均至少 9 次换值" +
    (failures.length ? "（" + failures.length + " 个不达标：" + failures.map(function (f) { return f.id + " " + f.changes + "/10"; }).join("、") + "）" : "")
  );
  failures.slice(0, 12).forEach(function (f) {
    console.log("       " + f.id + " changes=" + f.changes + "/10 序列=" + J(f.seq));
  });
  if (failures.length > 12) console.log("       …其余 " + (failures.length - 12) + " 个略");
}

/* ------------------------------------------------------------------ *
 * 【T4】锁矩阵：逐参数 lock + 50 种子 rerollAll，值不变（白名单要写原因）
 * ------------------------------------------------------------------ */
function testT4() {
  if (!requireApi("rerollAll", "T4")) return;
  /* 白名单：这些参数的“改值”由上下文/身份卡硬约束决定，锁不是唯一来源 */
  const WHY = {
    sex: "rerollAll 会按权重重选性别；本用例把 sex 当稳定器一起锁住，避免它把其它参数的门控/范围带跑",
    era: "虚拟上下文参数：rerollAll 明确跳过时代，锁对它是冗余（不在本用例考核）",
    community: "虚拟上下文参数：由身份决定，rerollAll 不随机",
    role: "虚拟上下文参数：由身份决定，rerollAll 不随机",
    rank: "虚拟上下文参数：由身份卡决定，rerollAll 不随机",
    occasion: "虚拟上下文参数：由身份卡决定，rerollAll 不随机",
    headwear: "服饰槽位：由时代/身份卡硬约束决定（硬约束优先于锁），且 rerollAll 跳过 costume 组",
    outer: "服饰槽位：由时代/身份卡硬约束决定（硬约束优先于锁），且 rerollAll 跳过 costume 组",
    inner: "服饰槽位：由时代/身份卡硬约束决定（硬约束优先于锁），且 rerollAll 跳过 costume 组",
    lower: "服饰槽位：由时代/身份卡硬约束决定（硬约束优先于锁），且 rerollAll 跳过 costume 组",
    shoes: "服饰槽位：由时代/身份卡硬约束决定（硬约束优先于锁），且 rerollAll 跳过 costume 组",
    accessory: "服饰槽位：由时代/身份卡硬约束决定（硬约束优先于锁），且 rerollAll 跳过 costume 组",
    pattern: "服饰槽位：由时代/身份卡硬约束决定（硬约束优先于锁），且 rerollAll 跳过 costume 组",
    material: "服饰槽位：由时代/身份卡硬约束决定（硬约束优先于锁），且 rerollAll 跳过 costume 组",
    color: "服饰槽位：由时代/身份卡硬约束决定（硬约束优先于锁），且 rerollAll 跳过 costume 组"
  };
  const whitelisted = [];
  const violations = [];
  let tested = 0;
  for (const p of allParams) {
    /* 白名单/虚拟参数要把原因打到输出里，不许静默跳过 */
    if (p.virtual) { whitelisted.push([p.id, WHY[p.id] || "虚拟上下文参数：rerollAll 不随机"]); continue; }
    if (p.id === "sex") { whitelisted.push([p.id, WHY.sex]); continue; }
    if (Object.prototype.hasOwnProperty.call(WHY, p.id)) { whitelisted.push([p.id, WHY[p.id]]); continue; }
    tested++;
    h.reset();
    h.run("state.locks = new Set([" + J(p.id) + ", 'sex']);");
    const before = state.params[p.id];
    let bad = null;
    for (let seed = 1; seed <= 50; seed++) {
      h.run("rerollAll(" + seed + ")");
      if (state.params[p.id] !== before) { bad = { seed: seed, after: state.params[p.id] }; break; }
    }
    if (bad) violations.push({ id: p.id, seed: bad.seed, before: before, after: bad.after });
  }
  check(tested > 0, "锁矩阵覆盖参数（" + tested + " 个）");
  whitelisted.forEach(function (item) {
    console.log("  SKIP 白名单 " + item[0] + "：" + item[1]);
  });
  check(
    violations.length === 0,
    "锁定后 50 个种子 rerollAll 值不变" +
    (violations.length ? "（" + violations.length + " 个被改：" + violations.slice(0, 10).map(function (v) { return v.id + "@seed" + v.seed + " " + J(v.before) + "→" + J(v.after); }).join("；") + "）" : "")
  );
  violations.slice(10).forEach(function (v) {
    console.log("       " + v.id + " seed=" + v.seed + " " + J(v.before) + " → " + J(v.after));
  });
}

/* ------------------------------------------------------------------ *
 * 【T5】身份卡派生约束：36 卡 × 50 种子
 * ------------------------------------------------------------------ */
function testT5() {
  if (!requireApi("applyLookPreset", "T5") || !requireApi("rerollAll", "T5")) return;
  check(lookIds.length === 36, "身份卡数为 36（实际 " + lookIds.length + "）");
  const violations = [];
  let cases = 0;
  for (const lookId of lookIds) {
    h.reset();
    h.run("applyLookPreset(" + J(lookId) + ")");
    for (let seed = 1; seed <= 50; seed++) {
      h.run("rerollAll(" + seed + ")");
      const P = state.params;
      const issues = [];
      if (P.hairStyle === "shaved" && P.hairLength !== "buzz") issues.push("hairStyle=shaved 但 hairLength=" + P.hairLength);
      if ((P.hairStyle === "buzz" || P.hairStyle === "slick" || P.hairStyle === "shaved") && P.bangs !== "none") issues.push("hairStyle=" + P.hairStyle + " 但 bangs=" + P.bangs);
      if (["queue", "qipan", "hanji_hair", "updo", "bun"].indexOf(P.hairStyle) >= 0 && P.parting !== "none") issues.push("hairStyle=" + P.hairStyle + " 但 parting=" + P.parting);
      cases++;
      if (issues.length) violations.push({ lookId: lookId, seed: seed, issues: issues, values: { hairStyle: P.hairStyle, hairLength: P.hairLength, bangs: P.bangs, parting: P.parting } });
    }
  }
  check(cases === lookIds.length * 50, "覆盖 " + lookIds.length + " 卡 × 50 种子（" + cases + " 次）");
  check(
    violations.length === 0,
    "身份卡派生约束成立：shaved⇒hairLength=buzz；buzz/slick/shaved⇒bangs=none；发髻/辫发⇒parting=none" +
    (violations.length ? "（" + violations.length + " 次违反）" : "")
  );
  violations.slice(0, 15).forEach(function (v) {
    console.log("       " + v.lookId + " seed=" + v.seed + " " + v.issues.join("；") + " 取值=" + J(v.values));
  });
  if (violations.length > 15) console.log("       …其余 " + (violations.length - 15) + " 次略");
}

/* ------------------------------------------------------------------ *
 * 【T6】身份词：名词短语，不含「·」、≤ 8 字、不等于卡片名
 * ------------------------------------------------------------------ */
function testT6() {
  if (!requireApi("identityPhrase", "T6") || !requireApi("applyLookPreset", "T6")) return;
  h.reset();
  const failures = [];
  for (const look of looks) {
    h.reset();
    h.run("applyLookPreset(" + J(look.id) + "); rerollAll(999);");
    const identity = state.meta.identity || "";
    const len = Array.from(identity).length;
    const varsIdentity = h.run("buildVars().identity");
    const phrase = h.run("identityPhrase()");
    const issues = [];
    if (!identity) issues.push("为空");
    if (identity.indexOf("·") >= 0) issues.push("含「·」");
    if (len > 8) issues.push("长度 " + len + " > 8");
    if (identity === look.label) issues.push("等于卡片名");
    if (varsIdentity !== identity) issues.push("buildVars().identity=" + J(varsIdentity) + " 与 meta 不一致");
    if (phrase !== identity) issues.push("identityPhrase()=" + J(phrase) + " 与 meta 不一致");
    if (issues.length) failures.push({ id: look.id, label: look.label, identity: identity, issues: issues });
  }
  check(failures.length === 0, "全部 " + looks.length + " 张身份卡换人后 meta.identity 合格（名词短语、无「·」、≤8 字、buildVars 一致）");
  failures.forEach(function (f) {
    console.log("       " + f.id + " [" + f.label + "] identity=" + J(f.identity) + "：" + f.issues.join("；"));
  });
}

/* ------------------------------------------------------------------ *
 * 【T7】素体清理：选清装→卡槽清空 / 自定义 {{headwear}} 编译为空
 * ------------------------------------------------------------------ */
function testT7() {
  if (!requireApi("currentLook", "T7") || !requireApi("clearCostumeSlots", "T7")) return;
  h.reset();
  h.run("setParamValue('era', 'qing_early')");
  check(!!state.lookId, "选「清·盛清」后自动套用身份卡（lookId=" + J(state.lookId) + "）");
  check(filledSlotCount() > 0, "自动套卡后服饰槽位已被填（" + filledSlotCount() + "/" + slotIds.length + "）");

  h.run("state.blocks.push({ id: 'free_headwear', kind: 'free', label: '自定义', text: '头部：{{headwear}}。', enabled: true })");
  h.run("setParamValue('era', 'none')");

  check(slotIds.every(function (id) { return state.params[id] === "none"; }), "切回素体：9 个服饰槽位全部 none");
  check(h.run("currentLook()") == null, "切回素体：currentLook() 为 null");
  check(state.lookId === "", "切回素体：state.lookId 已清空");
  const snap = h.run("buildPromptSnapshot()");
  check(snap.text.indexOf("{{headwear}}") < 0, "自定义段 {{headwear}} 不再以原文出现");
  check(snap.text.indexOf("头部：。") >= 0, "自定义段 {{headwear}} 编译为空串（得到「头部：。」）");
  check(Array.isArray(snap.empty) && snap.empty.indexOf("headwear") >= 0, "headwear 计入 snapshot.empty（契约 empty:[key]）");
}

/* ------------------------------------------------------------------ *
 * 【T8】服饰句：时代开 + 槽位全 none → 不出现「服装：。」，仍有时代身份词
 * ------------------------------------------------------------------ */
function testT8() {
  if (!requireApi("buildPromptSnapshot", "T8")) return;
  h.reset();
  h.run("setParamValue('era', 'qing_early')");
  h.run("clearCostumeSlots(); state.lookId = ''; commitParams({ reason: 'test', silent: true });");
  check(filledSlotCount() === 0, "前置：9 个服饰槽位已清空");
  const snap = h.run("buildPromptSnapshot()");
  const era = eras.find(function (e) { return e.id === "qing_early"; }) || { label: "清·盛清", promptLead: "清代盛期" };
  check(snap.text.indexOf("服装：。") < 0, "提示词不含空服饰句「服装：。」");
  check(snap.text.indexOf(era.promptLead) >= 0 || snap.text.indexOf(era.label) >= 0, "提示词仍含时代词（" + era.promptLead + " / " + era.label + "）");
  if (h.has("costumeText")) {
    const costume = h.run("costumeText()");
    check(costume.length > 0 && snap.text.indexOf(costume) >= 0, "服饰句非空且进了提示词（" + J(costume) + "）");
    check(/正一品|文官|贵妇|皇帝|皇后|宗室|士人|农妇|商贾|匠妇|旗人|侍卫|僧|道士|兵|衙役/.test(costume), "服饰句含身份词（不是只有时代前缀）");
  }
}

/* ------------------------------------------------------------------ *
 * 【T9】卡片有效性：上下文变了→currentLook() null、槽位清空；未变→有效
 * ------------------------------------------------------------------ */
function testT9() {
  if (!requireApi("currentLook", "T9")) return;
  const card = looks.find(function (l) { return l.id === "qe_official_civil_1"; }) || looks[0];
  if (!card) { failLine("T9：DATA.eras.looks 为空，无法测卡片有效性"); return; }

  h.reset();
  h.run("applyLookPreset(" + J(card.id) + ")");
  const look = h.run("currentLook()");
  check(look && look.id === card.id, "未改上下文时 currentLook() 返回有效卡（" + card.id + "）");
  check(filledSlotCount() > 0, "有效卡时服饰槽位非空（" + filledSlotCount() + "/" + slotIds.length + "）");

  /* community：优先挑一个同代/同角色下没有任何卡能匹配的值 */
  const communityValues = (paramById.community && paramById.community.optionValues) || [];
  let targetCommunity = null;
  for (const value of communityValues) {
    if (value === card.community || value === "none") continue;
    const matches = looks.some(function (l) {
      return l.era === card.era && l.role === card.role && l.community === value &&
        (!l.sex || l.sex === state.params.sex);
    });
    if (!matches) { targetCommunity = value; break; }
  }
  if (!targetCommunity && communityValues.indexOf("none") >= 0) targetCommunity = "none";
  if (!targetCommunity) {
    finding("T9：找不到会让卡片失效的 community 取值，community 分支只做说明");
  } else {
    h.reset();
    h.run("applyLookPreset(" + J(card.id) + ")");
    h.run("setParamValue('community', " + J(targetCommunity) + ")");
    check(h.run("currentLook()") == null, "改 community=" + targetCommunity + " 后 currentLook() 为 null");
    check(state.lookId === "", "改 community 后 lookId 已清空");
    check(slotIds.every(function (id) { return state.params[id] === "none"; }), "改 community 后 9 个槽位清空");
  }

  /* role：用 none（没有任何卡使用 none 角色） */
  h.reset();
  h.run("applyLookPreset(" + J(card.id) + ")");
  h.run("setParamValue('role', 'none')");
  check(h.run("currentLook()") == null, "改 role=none 后 currentLook() 为 null");
  check(state.lookId === "", "改 role 后 lookId 已清空");
  check(slotIds.every(function (id) { return state.params[id] === "none"; }), "改 role 后 9 个槽位清空");

  /* sex：换性别后当前卡立即失效 */
  h.reset();
  h.run("applyLookPreset(" + J(card.id) + ")");
  const oldSex = state.params.sex;
  h.run("setSex(" + J(oldSex === "male" ? "female" : "male") + ")");
  check(h.run("currentLook()") == null, "换性别后 currentLook() 为 null");
  check(state.lookId === "", "换性别后 lookId 已清空");
  check(slotIds.every(function (id) { return state.params[id] === "none"; }), "换性别后 9 个槽位清空");
}

/* ------------------------------------------------------------------ *
 * 【T10】口径：effectiveUsage 与左栏「未用」一致；体检未接入为空
 * ------------------------------------------------------------------ */
function testT10() {
  const haveEff = h.has("effectiveUsage");
  if (!haveEff) failLine("T10：缺少 effectiveUsage()（新契约要求返回 Map/Set：被实际输出引用的变量）");
  h.reset();
  h.run("state.blocks.push({ id: 'free_usage', kind: 'free', label: '口径', text: '补充：{{notAVar}} {{costume}} {{age}} {{hairStyle}}。', enabled: true })");

  let effSet;
  if (haveEff) {
    const kind = h.run("(function () { var u = effectiveUsage(); return u instanceof Map ? 'Map' : u instanceof Set ? 'Set' : (Array.isArray(u) ? 'Array' : typeof u); })()");
    check(kind === "Map" || kind === "Set", "effectiveUsage() 返回 Map/Set（实际 " + kind + "）");
    effSet = new Set(runJson("(function () { var u = effectiveUsage(); if (!u) return []; if (u instanceof Map) return Array.from(u.keys()); if (u instanceof Set) return Array.from(u); if (Array.isArray(u)) return u; return Object.keys(u); })()"));
  } else {
    finding("effectiveUsage 未实现，T10 暂用 buildPromptSnapshot().used 做等价语义检查（契约仍要求独立函数）");
    effSet = new Set(runJson("Array.from(buildPromptSnapshot().used)"));
  }
  const vars = runJson("buildVars()");
  check(!effSet.has("notAVar"), "口径集合不含未知变量 notAVar");
  check(!effSet.has("costume"), "口径集合不含空值变量 costume（素体态为空串）");
  check(effSet.has("age") && effSet.has("hairStyle"), "口径集合含实际输出的 age / hairStyle");
  const badVals = Array.from(effSet).filter(function (k) { return vars[k] == null || String(vars[k]) === ""; });
  check(badVals.length === 0, "口径集合里的每个键都有非空变量值" + (badVals.length ? "（空/缺失：" + badVals.join("、") + "）" : ""));

  const usedSet = new Set(runJson("Array.from(usedVarKeys())"));
  const missingFromUsed = Array.from(effSet).filter(function (k) { return !usedSet.has(k); });
  const missingFromEff = Array.from(usedSet).filter(function (k) { return !effSet.has(k); });
  check(
    missingFromUsed.length === 0 && missingFromEff.length === 0,
    "usedVarKeys 与 " + (haveEff ? "effectiveUsage" : "snapshot.used") + " 口径一致" +
    (missingFromUsed.length || missingFromEff.length ? "（used 缺：" + missingFromUsed.join("、") + "；口径集合缺：" + missingFromEff.join("、") + "）" : "")
  );
  if (haveEff) {
    const snapUsed = new Set(runJson("Array.from(buildPromptSnapshot().used)"));
    const effOnly = Array.from(effSet).filter(function (k) { return !snapUsed.has(k); });
    const snapOnly = Array.from(snapUsed).filter(function (k) { return !effSet.has(k); });
    check(effOnly.length === 0 && snapOnly.length === 0, "effectiveUsage 与 buildPromptSnapshot().used 同源（差集为空）" +
      (effOnly.length || snapOnly.length ? "（effectiveUsage 多：" + effOnly.join("、") + "；快照多：" + snapOnly.join("、") + "）" : ""));
  }

  const upSrc = h.run("typeof updateParamUsage === 'function' ? String(updateParamUsage) : ''");
  if (/effectiveUsage|snap\.used|buildPromptSnapshot/.test(upSrc)) {
    passLine("左栏「未用」与快照同源（updateParamUsage 使用 snapshot.used/effectiveUsage）");
  } else {
    finding("updateParamUsage 未使用 effectiveUsage/snapshot.used；左栏「未用」与口径的渲染一致性无法在 DOM 桩下断言");
  }

  /* 体检测试的是纯逻辑，不依赖 DOM */
  h.reset();
  const issues = runJson("collectHealthIssues()");
  check(Array.isArray(issues.notIntegrated) && issues.notIntegrated.length === 0,
    "体检「未接入」为空" + (issues.notIntegrated && issues.notIntegrated.length ? "（" + issues.notIntegrated.join("、") + "）" : ""));
  check(Array.isArray(issues.unknown) && issues.unknown.length === 0, "体检「未知变量」为空");
  const snap = h.run("buildPromptSnapshot()");
  if (issues.len != null && snap.stats) {
    check(issues.len === snap.stats.chars, "体检长度取自快照 stats.chars（" + issues.len + "）");
  }
}

/* ------------------------------------------------------------------ *
 * 【T11】种子：同一初始状态 rerollAll(123) 两次，params/meta/prompt 完全一致
 * ------------------------------------------------------------------ */
function testT11() {
  if (!requireApi("rerollAll", "T11")) return;
  function capture() {
    return {
      params: h.run("JSON.stringify(state.params)"),
      meta: h.run("JSON.stringify(state.meta)"),
      prompt: h.run("compilePrompt()"),
      seed: state.seed,
      lookId: state.lookId,
      identity: state.meta.identity
    };
  }
  h.reset();
  h.run("rerollAll(123)");
  const a = capture();
  h.reset();
  h.run("rerollAll(123)");
  const b = capture();
  check(a.seed === 123 && b.seed === 123, "rerollAll(123) 固定种子（" + a.seed + "/" + b.seed + "）");
  check(a.params === b.params, "两次同种子 rerollAll：params 完全一致");
  check(a.meta === b.meta, "两次同种子 rerollAll：meta 完全一致");
  check(a.prompt === b.prompt, "两次同种子 rerollAll：提示词逐字一致（" + a.prompt.length + " 字）");
  check(a.lookId === b.lookId && a.identity === b.identity, "两次同种子 rerollAll：lookId / identity 一致");
  if (a.params !== b.params) {
    const pa = JSON.parse(a.params);
    const pb = JSON.parse(b.params);
    const diffKeys = Object.keys(pa).filter(function (k) { return pa[k] !== pb[k]; });
    console.log("       不一致参数：" + diffKeys.slice(0, 12).map(function (k) { return k + " " + J(pa[k]) + "→" + J(pb[k]); }).join("；"));
  }
}

/* ------------------------------------------------------------------ *
 * 【T12】回归：6 画幅无残留变量、长度预算内、含人物档案
 * ------------------------------------------------------------------ */
function testT12() {
  if (!requireApi("compilePrompt", "T12")) return;
  for (const lay of layouts) {
    h.reset({ templateId: lay.id });
    const snap = h.run("buildPromptSnapshot()");
    const prompt = h.run("compilePrompt()");
    const budget = lay.orient === "landscape" ? 2100 : 1800;
    check(/\{\{\w+\}\}/.test(prompt) === false, lay.id + "：提示词无 {{变量}} 残留");
    check(prompt.length <= budget, lay.id + "：" + prompt.length + " 字 ≤ 预算 " + budget + "（" + (lay.orient === "landscape" ? "横" : "竖/任意") + "）");
    check(prompt.indexOf("人物档案：") >= 0, lay.id + "：含「人物档案：」");
    check(prompt === snap.text, lay.id + "：compilePrompt() 与 snapshot.text 同源");
  }
}

/* ------------------------------------------------------------------ *
 * 运行
 * ------------------------------------------------------------------ */
const TESTS = [
  ["【0】契约 API 与状态字段", testApi],
  ["【T1】预览=发送（6 画幅 × 3 状态）", testT1],
  ["【T2】未知变量：不发送 / 有拦截", testT2],
  ["【T3】掷：连续 10 次至少 9 次换值", testT3],
  ["【T4】锁矩阵：50 种子值不变（白名单有原因）", testT4],
  ["【T5】身份卡派生约束（36 卡 × 50 种子）", testT5],
  ["【T6】身份词：名词短语 / 无「·」/ ≤8 字", testT6],
  ["【T7】素体清理：槽位清空 / {{headwear}} 空", testT7],
  ["【T8】服饰句：无「服装：。」/ 有时代身份词", testT8],
  ["【T9】卡片有效性：失效即清槽 / 未失效可用", testT9],
  ["【T10】口径：effectiveUsage / 体检未接入", testT10],
  ["【T11】种子：同种子两次完全一致", testT11],
  ["【T12】回归：6 画幅预算 / 无残留 / 人物档案", testT12]
];

for (const item of TESTS) {
  section(item[0]);
  try {
    item[1]();
  } catch (e) {
    failLine("执行异常：" + (e && e.message ? e.message : String(e)));
    if (e && e.stack) console.log("       " + String(e.stack).split("\n").slice(1, 3).join("\n       "));
  }
}
if (secTitle) console.log("  -- 本节 " + secPass + " PASS / " + secFail + " FAIL");

console.log("\n" + "=".repeat(56));
console.log("汇总：PASS " + pass + " / FAIL " + fail + " / FINDING " + findings.length);
if (findings.length) {
  console.log("FINDING 清单：");
  findings.forEach(function (f, i) { console.log("  " + (i + 1) + ". " + f); });
}
if (fail > 0) {
  console.log("结果：有 " + fail + " 项失败（红灯即待修契约/实现）。");
  process.exitCode = 1;
} else {
  console.log("结果：全部通过。");
}
