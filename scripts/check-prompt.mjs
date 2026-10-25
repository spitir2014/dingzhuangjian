import fs from "node:fs/promises";

/* 逐个画幅拼一遍提示词：检查变量是否全部落地、镜头/构图描述是否齐全、
   九宫格是否真的给出九格表情、被版面停用的段落是否真的没进提示词。 */

const params = JSON.parse(await fs.readFile("data/params.json", "utf8"));
const templates = JSON.parse(await fs.readFile("data/templates.json", "utf8"));
const names = JSON.parse(await fs.readFile("data/names.json", "utf8"));
const presets = JSON.parse(await fs.readFile("data/presets.json", "utf8"));
const appSrc = await fs.readFile("web/app.js", "utf8");

let layouts = templates.templates;
try {
  const j = JSON.parse(await fs.readFile("data/layouts.json", "utf8"));
  if (Array.isArray(j.layouts) && j.layouts.length) layouts = j.layouts;
} catch (e) { /* 退回 templates.json 的默认画幅 */ }

const ratioMatch = appSrc.match(/const RATIOS = (\[[\s\S]*?\n\]);/);
const RATIOS = ratioMatch ? new Function("return " + ratioMatch[1])() : [];
const ratioById = new Map(RATIOS.map((r) => [r.id, r]));

const paramMap = new Map();
for (const g of params.groups) for (const p of g.params) paramMap.set(p.id, p);
const stateParams = {};
for (const [id, p] of paramMap) stateParams[id] = p.default;

const bandFor = (p, value) => {
  if (!p.bands) return String(value);
  for (const b of p.bands) if (value <= b.max) return b.phrase;
  return p.bands[p.bands.length - 1].phrase;
};
const optionOf = (p, value) => p.options.find((o) => o.value === value) || p.options[0];

function buildVars(layout, aspectText) {
  const vars = {};
  for (const [id, p] of paramMap) {
    if (p.type === "choice" || p.type === "sex") {
      const o = optionOf(p, stateParams[id]);
      vars[id] = o.label;
      vars[id + "Phrase"] = o.phrase;
    } else {
      vars[id] = String(stateParams[id]);
      vars[id + "Phrase"] = bandFor(p, stateParams[id]);
    }
  }
  for (const [id, p] of paramMap) {
    if (p.type === "choice") vars[id] = optionOf(p, stateParams[id]).phrase;
  }
  vars.ethnicity = optionOf(paramMap.get("ethnicity"), stateParams.ethnicity).phrase;
  vars.presentation = bandFor(paramMap.get("presentation"), stateParams.presentation);
  vars.masculinity = vars.presentation;
  vars.sexPhrase = optionOf(paramMap.get("sex"), "male").phrase;
  vars.sexLabel = optionOf(paramMap.get("sex"), "male").label;
  vars.aspectText = aspectText;
  vars.aspectRatio = aspectText.split(" ")[0];
  vars.sizePx = "2048x2048";
  vars.underTop = "上身赤裸";
  vars.outfitExtra = "，下身只穿一条肉色无缝紧身短裤，没有其他衣物、没有鞋、没有配饰，身体轮廓清楚可见";
  /* 素体态：服饰句为空串，段落逐字等于改造前的「服装：{{underTop}}{{outfitExtra}}。」 */
  vars.costume = "";
  vars.ageLook = bandFor(paramMap.get("age"), stateParams.age);
  vars.asymmetry = bandFor(paramMap.get("asymmetry"), stateParams.asymmetry);
  vars.name = names.surnames[0] + names.givenMale[0];
  vars.identity = names.identities[0];
  vars.trait = names.traits[0];
  vars.personality = names.personalities[0];
  vars.styleKeywords = names.styleKeywords.slice(0, 2).join("、");
  vars.bio = "";
  vars.profileText = "人物档案：" + vars.identity + "，性格" + vars.personality + "，" + vars.trait + "。风格关键词：" + vars.styleKeywords + "。";
  vars.signatureSentence = "";
  for (const [k, v] of Object.entries(layout.vars || {})) {
    if (typeof v === "string") vars[k] = v;
  }
  return vars;
}

function presetFor(layoutId) {
  const p = (presets.presets || []).find((x) => x.layoutId === layoutId);
  return p || { ratio: "16:9", res: "2K" };
}
function aspectTextFor(layoutId) {
  const p = presetFor(layoutId);
  const r = ratioById.get(p.ratio) || RATIOS[0];
  const s = (r && r.sizes && (r.sizes[p.res] || r.sizes["2K"])) || [2048, 2048];
  const dir = s[0] > s[1] ? " 横版" : s[0] < s[1] ? " 竖版" : " 方形";
  return p.ratio + dir;
}

const NEW_PARAM_IDS = ["faceProportion","noseShape","lipShape","lipTexture","browGap","noseTip","earShape","faceLines","teeth","makeup","bodyShape","handDetail","complexion","moles","hairLength","bangs","parting","flyaways"];
const errors = [];
const fail = (msg) => errors.push(msg);

const rows = [];
for (const layout of layouts) {
  const suppressed = new Set(Array.isArray(layout.suppress) ? layout.suppress : []);
  const vars = buildVars(layout, aspectTextFor(layout.id));
  const parts = [];
  for (const id of templates.order) {
    if (suppressed.has(id)) continue;
    const block = (layout.structure || {})[id] || templates.content[id];
    if (!block) continue;
    const text = String(block.text).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    if (text.trim()) parts.push(text.trim());
  }
  const prompt = parts.join("\n\n");

  if (/\{\{\w+\}\}/.test(prompt)) fail(layout.id + "：有变量没替换（" + prompt.match(/\{\{\w+\}\}/g).join(" ") + "）");
  if (!/机位/.test(prompt)) fail(layout.id + "：版面里没有写机位/相机高度");
  if (!/平视/.test(prompt) && !/光轴[^。]{0,6}水平/.test(prompt)) fail(layout.id + "：版面里没有写平视/水平光轴");
  if (/左右对称/.test(prompt)) fail(layout.id + "：仍出现「左右对称」（会和四分之三侧脸/表情不对称打架）");
  if (prompt.indexOf("人物档案：") < 0) fail(layout.id + "：没有人物档案段");
  for (const id of NEW_PARAM_IDS) {
    const p = paramMap.get(id);
    const phrase = p.options.find((o) => o.value === p.default).phrase;
    if (prompt.indexOf(phrase) < 0) fail(layout.id + "：缺 " + id + " 的默认词句");
  }
  const budget = layout.orient === "landscape" ? 2100 : 1800;
  if (prompt.length > budget) fail(layout.id + "：提示词 " + prompt.length + " 字，超过 " + budget + " 预算");
  const orient = layout.orient;
  if (orient && orient !== "any") {
    const pr = presetFor(layout.id);
    const ratio = ratioById.get(pr.ratio);
    if (ratio) {
      const s = ratio.sizes[pr.res] || ratio.sizes["2K"];
      const o = s[0] > s[1] ? "landscape" : s[0] < s[1] ? "portrait" : "square";
      if (o !== orient) fail(layout.id + "：orient=" + orient + "，但预设 " + pr.ratio + " 是 " + o);
    }
  }

  if (layout.id === "expression_grid") {
    if (prompt.indexOf("九格表情按顺序") < 0) fail("expression_grid：没有九格表情清单");
    const cells = (prompt.match(/(^|\n)[1-9] /g) || []).length;
    if (cells !== 9) fail("expression_grid：九格清单只数到 " + cells + " 条");
    if (prompt.indexOf("画面高度的 8%") >= 0) fail("expression_grid：左上角文字段没被停用，会压在第 1 格脸上");
    if (prompt.indexOf("下身只穿") >= 0) fail("expression_grid：着装段还在讲下身");
    if (prompt.indexOf("眼睛看向镜头") < 0) fail("expression_grid：没有强调九格眼睛看镜头");
  } else if (!suppressed.has("info")) {
    if (prompt.indexOf("画面高度的 8%") < 0) fail(layout.id + "：左上角文字段不见了");
    if (prompt.indexOf("80%") < 0) fail(layout.id + "：左上角文字没有宽度上限（竖版会出画）");
    if (prompt.indexOf(vars.name) < 0) fail(layout.id + "：左上角文字里没有人物名");
  }
  if (layout.id === "costume_breakdown") {
    if (!/五个独立的无文字细节窗/.test(prompt)) fail("costume_breakdown：缺少五个服饰拆解窗口");
    if (!/无文字纯色小方块/.test(prompt)) fail("costume_breakdown：缺少无文字色卡约束");
  }
  rows.push({ id: layout.id, label: layout.label, chars: prompt.length, suppressed: [...suppressed].join(",") || "-", prompt });
}

console.log("逐画幅提示词检查：");
for (const r of rows) console.log("  " + r.id.padEnd(18) + r.chars.toString().padStart(5) + " 字   停用段: " + r.suppressed + "   " + r.label);
if (errors.length) {
  console.error("\n发现 " + errors.length + " 个问题:");
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}
console.log("\n全部画幅通过：变量无残留、机位/平视齐全、九格表情九条、停用段未进提示词、长度都在预算内。");
