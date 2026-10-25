/* 画幅逻辑回归测试：不装浏览器，直接复用 web/app.js 里的真实函数体在 vm 里跑
   （DATA/state 用 data/*.json 真实数据喂）。覆盖：
   1) 五个画幅干净启动：结构段是新文案、机位/平视齐全、无变量残留
   2) 老存档迁移：旧 blocks + 旧 templateText 缓存里的旧文案会被换成新默认，开关状态保留
   3) 切换画幅：内容段共用文案与版面 vars 正确来回切换
   4) 用户手改过的结构段不会被迁移吃掉
   5) 版面停用段（九宫格的左上角文字）不参与拼装
*/
import fs from "node:fs/promises";
import vm from "node:vm";

const src = await fs.readFile("web/app.js", "utf8");

/* 按名字抽取函数/常量：字符串与注释里的花括号要跳过 */
function sliceBalanced(s, start) {
  let depth = 0, i = start, q = null, esc = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "\u0060") { q = c; continue; }
    if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "/" && s[i + 1] === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  throw new Error("unbalanced brace at " + start);
}
function extractFn(name) {
  const m = new RegExp("function\\s+" + name + "\\s*\\(").exec(src);
  if (!m) throw new Error("function not found: " + name);
  const brace = src.indexOf("{", m.index);
  return src.slice(m.index, brace) + sliceBalanced(src, brace);
}
function extractConst(name) {
  const m = new RegExp("const\\s+" + name + "\\s*=\\s*\\{").exec(src);
  if (!m) throw new Error("const not found: " + name);
  const brace = src.indexOf("{", m.index);
  return "const " + name + " = " + sliceBalanced(src, brace) + ";";
}
const NAMES = ["bandFor","isContentBlock","currentTemplate","templateSuppressedIds","isBlockSuppressed",
  "ratioOrient","templateOrient","ratioAllowed","ensureRatioForTemplate",
  "defaultBlocks","ensureBlockSkeleton","applyTemplateStructure","applyDetailPresetFlags",
  "migrateLegacyContent","migrateLegacyStructure","loadBlocks","compileBlockText","compilePrompt",
  "buildPromptSnapshot","expandCovers","clearCostumeSlots","identityPhrase","currentLook","genMeta","mulberry32","pick","randInt",
  "buildVars","currentSex","sexMeta","currentRatio","sizeString","aspectText",
  "costumeText","applyLookData","budgetFor","eraOn","eraDef","optionLabel","costumeRolePhrase","currentRankInfo","eraNegative"];
const CONSTS = ["DETAIL_PRESETS","LEGACY_CONTENT","LEGACY_STRUCT"];
const code = CONSTS.map(extractConst).join("\n") + "\n" + NAMES.map(extractFn).join("\n");

const params = JSON.parse(await fs.readFile("data/params.json", "utf8"));
const templates = JSON.parse(await fs.readFile("data/templates.json", "utf8"));
const layouts = JSON.parse(await fs.readFile("data/layouts.json", "utf8")).layouts;
const names = JSON.parse(await fs.readFile("data/names.json", "utf8"));
const erasData = JSON.parse(await fs.readFile("data/eras.json", "utf8"));

const RATIOS = new Function("return " + /const RATIOS = (\[[\s\S]*?\n\]);/.exec(src)[1])();
const RES_LIST = new Function("return " + /const RES_LIST = (\[[^\]]*\]);/.exec(src)[1])();

const paramIndex = {};
for (const g of params.groups) for (const p of g.params) paramIndex[p.id] = p;
const DATA = { params, order: templates.order, content: templates.content, layouts, eras: erasData, names };
const state = {
  blocks: [], templateText: {}, templateId: "sheet_2view", params: {}, meta: {}, highlights: [],
  ratio: "16:9", res: "2K", detailPreset: "detailed", locks: new Set(), seed: 0,
  lookId: "", lookCustomized: {}, derivedConflicts: [], rollTick: 0, paramRevision: 0
};
for (const g of params.groups) for (const p of g.params) state.params[p.id] = p.default;
state.meta = { name: names.surnames[0] + names.givenMale[0], identity: names.identities[0], personality: names.personalities[0], trait: names.traits[0], bio: "", styleKeywords: ["清冷"] };

const sandbox = {
  DATA, state, paramIndex, paramGroupIndex: {}, RATIOS, RES_LIST, console,
  Set, Object, Array, String, Number, Math, JSON, RegExp,
  /* app.js 里的副作用函数在无头测试里打桩 */
  saveState: function () {}, renderSizeControls: function () {}, toast: function () {}, $: function () { return null; }
};
const ctx = vm.createContext(sandbox);
vm.runInContext(code, ctx);
const run = (expr) => vm.runInContext(expr, ctx);

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); else console.log("  PASS " + msg); };

/* 1) 五个画幅干净启动 */
console.log("[1] 干净启动");
for (const t of layouts) {
  run("state.blocks = []; state.templateText = {}; state.templateId = '" + t.id + "';");
  run("loadBlocks()");
  const p = run("compilePrompt()");
  ok(/\{\{\w+\}\}/.test(p) === false, t.label + "：无变量残留");
  ok(p.indexOf("机位") >= 0 && (/平视/.test(p) || /光轴[^。]{0,6}水平/.test(p)), t.label + "：写了机位与平视/水平光轴");
  ok(p.indexOf("左右对称") < 0, t.label + "：不再要求左右对称");
  const budget = t.orient === "landscape" ? 2100 : 1800;
  ok(p.length <= budget, t.label + "：" + p.length + " 字，在 " + budget + " 预算内");
}

/* 2) 老存档迁移（旧文案取自修复前的 templates 快照；同时核对 app.js 里的 LEGACY_* 注册表与快照一致） */
console.log("[2] 老存档迁移");
/* 夹具随仓库提交，放在 scripts/fixtures/：以前放在 tmp/，清理临时目录后测试就会失去校验能力 */
let legacyT = null;
try { legacyT = JSON.parse(await fs.readFile("scripts/fixtures/legacy-templates.json", "utf8")); } catch (e) {}
const L = run("LEGACY_STRUCT");
const LC = run("LEGACY_CONTENT");
if (legacyT) {
  let same = true;
  for (const t of legacyT.templates) {
    if (L.layout[t.id] !== t.structure.layout.text) same = false;
    for (const k of ["format", "style", "negative"]) if (L[k] !== t.structure[k].text) same = false;
  }
  const lcOutfit = Array.isArray(LC.outfit) ? LC.outfit : [LC.outfit];
  if (lcOutfit.indexOf(legacyT.content.outfit.text) < 0 || LC.info !== legacyT.content.info.text || LC.realism !== legacyT.content.realism.text) same = false;
  ok(same, "app.js 的 LEGACY_STRUCT / LEGACY_CONTENT 与快照里的旧文案逐字一致（迁移注册表没写错）");
} else {
  console.log("  FAIL 缺少夹具 scripts/fixtures/legacy-templates.json，迁移注册表校验被跳过");
  ok(false, "老存档迁移夹具存在（scripts/fixtures/legacy-templates.json）");
}
/* 兜底：没有夹具时用当前注册表合成（此时上面的校验会判 FAIL，不会再静默通过） */
const fallbackOutfit = Array.isArray(LC.outfit) ? LC.outfit[LC.outfit.length - 1] : LC.outfit;
const legacy = legacyT || { templates: layouts.map((t) => ({ id: t.id, structure: { format: { text: L.format }, style: { text: L.style }, negative: { text: L.negative }, layout: { text: L.layout[t.id] } } })), content: { outfit: { text: fallbackOutfit }, info: { text: LC.info }, realism: { text: LC.realism } } };

run("state.blocks = []; state.templateText = {}; state.templateId = 'expression_grid';");
state.templateText = {};
for (const t of legacy.templates) {
  state.templateText[t.id] = {};
  for (const k of ["format", "layout", "style", "negative"]) state.templateText[t.id][k] = { text: t.structure[k].text, enabled: true };
}
const gridOld = legacy.templates.find((x) => x.id === "expression_grid");
state.blocks = templates.order.map((id) => {
  if (templates.content[id]) return { id, kind: "content", label: templates.content[id].label, text: templates.content[id].text, enabled: true };
  const old = gridOld.structure[id];
  return { id, kind: "structure", label: id, text: old.text, enabled: true };
});
state.blocks.find((b) => b.id === "outfit").text = legacy.content.outfit.text;
state.blocks.find((b) => b.id === "info").text = legacy.content.info.text;
state.blocks.find((b) => b.id === "realism").text = legacy.content.realism.text;
run("loadBlocks()");
let p = run("compilePrompt()");
ok(p.indexOf("九格表情按顺序") >= 0, "旧缓存不再盖住新版面：九宫格拿到九格清单");
ok(p.indexOf("机位：九格共用一个平视人像机位") >= 0, "旧缓存：九宫格拿到新机位");
ok(p.indexOf("画面宽度的 22%") < 0, "九宫格：左上角文字段被版面停用");
ok(p.indexOf("下身只穿") < 0, "九宫格：着装段被 vars 改成只到肩部");
ok(p.indexOf("按「版面」段的九格清单逐格执行") >= 0, "九宫格：表情段被 vars 改写");
ok(p.length <= 1800, "九宫格：" + p.length + " 字，在预算内");
ok(p.indexOf("近景可见毛孔") >= 0, "老存档的「真实质感」段也迁到了新文案");

/* 3) 切换画幅来回 */
console.log("[3] 切换画幅");
state.templateId = "sheet_2view";
run("applyTemplateStructure()");
p = run("compilePrompt()");
ok(p.indexOf("机位：大头像用平视机位") >= 0, "切到正背卡：用它自己的新版面");
ok(p.indexOf("画面高度的 8%") >= 0, "切到正背卡：文字段恢复");
ok(p.indexOf("下身只穿") >= 0, "切到正背卡：着装段回到共用原文");
ok(run("buildVars()").gaze.indexOf("背面全身像只画后脑") >= 0, "正背卡：视线 vars 生效（背面不回头）");
ok(run("isBlockSuppressed('info')") === false, "正背卡：info 不再被停用");

/* 4) 手改过的结构段不被迁移吃掉 */
console.log("[4] 手改保护");
state.templateText.sheet_2view = state.templateText.sheet_2view || {};
state.templateText.sheet_2view.layout = { text: "版式：我自己改的版式，必须有这一句", enabled: true };
run("loadBlocks()");
ok(run("compilePrompt()").indexOf("我自己改的版式") >= 0, "手改过的版面段保留");

/* 5) 迁移保留开关状态 */
console.log("[5] 开关状态");
state.templateText = { expression_grid: { info: { text: legacy.content.info.text, enabled: false } } };
state.templateId = "expression_grid";
run("loadBlocks()");
ok(run("isBlockSuppressed('info')") === true && run("compilePrompt()").indexOf("画面高度的 8%") < 0, "九宫格 info 仍不参与拼装（停用 + 旧开关关闭）");

/* 6) 画幅方向与比例联动 */
console.log("[6] 画幅方向");
state.templateId = "sheet_2view";
run("state.ratio = '16:9'; applyTemplateStructure();");
ok(run("ratioAllowed('16:9')") === true && run("ratioAllowed('3:4')") === false, "正背卡：只放行横版比例");
ok(run("state.ratio") === "16:9", "正背卡：16:9 保持不变");
state.templateId = "sheet_2view";
run("state.ratio = '3:4'; applyTemplateStructure();");
ok(run("state.ratio") === "16:9", "从竖版比例切到正背卡时自动改回横版 16:9（当前 " + run("state.ratio") + "）");
ok(run("ratioAllowed(state.ratio)") === true, "自动切换后的比例与画幅方向兼容");

/* 7) 结构段开关跟着画幅走：正背卡关掉负面，切到立绘不能把「关」带过去 */
console.log("[7] 结构段开关");
state.templateId = "sheet_2view";
run("loadBlocks()");
state.templateText.sheet_2view = state.templateText.sheet_2view || {};
state.templateText.sheet_2view.negative = { text: "（正背卡自定义负面）", enabled: false };
run("applyTemplateStructure()");
ok(state.blocks.find((b) => b.id === "negative").enabled === false, "正背卡：负面段按本画幅缓存保持关闭");
state.templateId = "fullbody";
run("applyTemplateStructure()");
const negBlock = state.blocks.find((b) => b.id === "negative");
ok(negBlock.enabled === true && negBlock.text.indexOf("不要裁切头顶或脚部") >= 0, "切到立绘：负面段回到本画幅默认（开启 + 自己的文案）");

/* 8) 被 vars 覆盖的参数不能经「记忆点」写回单一取值 */
console.log("[8] 记忆点 vs vars");
state.templateId = "expression_grid";
state.highlights = ["expression"];
run("loadBlocks()");
const gv = run("buildVars()");
ok(gv.signatureSentence === "", "九宫格：把「表情」设为记忆点也不会把单一表情写回提示词");
state.templateId = "expression_grid";
run("state.ratio = '3:4'; applyTemplateStructure();");
ok(run("state.ratio") === "1:1", "切到九宫格时自动改成 1:1（" + run("state.ratio") + "）");


/* 9) 清装：身份卡 → 服饰句 → 预算 / 画幅裁剪 / 泄漏 */
console.log("[9] 清装身份卡");
const ANCHORS = {
  qe_official_civil_1: ["补褂", "仙鹤", "红宝石", "朝珠", "皂靴", "石青"],
  qe_manchu_lady: ["钿子", "一耳三钳", "平底绣鞋", "藕荷", "坎肩"],
  qe_han_lady: ["低髻", "抹额", "马面裙", "云肩", "月白"],
  qe_han_commoner: ["短袄", "大裆裤", "粗棉布", "本白", "素面无纹"],
  qe_merchant: ["瓜皮帽", "长袍", "荷包", "酱色", "暗花绸"],
  qe_farmer_w: ["毡帽", "短袄", "大裆裤", "粗棉布", "靛蓝"],
  qe_yamen_runner: ["红黑帽", "号衣", "快靴", "葛布", "靛蓝"],
  qe_monk: ["僧帽", "袈裟", "云履", "念珠", "缁黑"],
  qe_official_civil_1_formal: ["吉服袍", "马蹄袖", "蟒纹", "朝珠", "皂靴"],
  qe_official_civil_1_ceremonial: ["朝冠", "披领", "朝裳", "马蹄袖", "朝珠"]
};
for (const look of erasData.looks) {
  run("state.templateId = 'sheet_2view';");
  run("applyLookData(" + JSON.stringify(look) + ");");
  const costume = run("costumeText()");
  ok(costume.length >= 20, look.id + "：服饰句非空（" + costume.length + " 字）");
  const missing = (ANCHORS[look.id] || []).filter((a) => costume.indexOf(a) < 0);
  ok(missing.length === 0, look.id + "：形制锚点齐全" + (missing.length ? "（缺 " + missing.join("、") + "）" : ""));
  run("loadBlocks()");
  const prompt = run("compilePrompt()");
  ok(prompt.indexOf(costume) >= 0, look.id + "：服饰句进了提示词");
  const budget = run("budgetFor(templateOrient())");
  ok(prompt.length <= budget, look.id + "：提示词 " + prompt.length + " ≤ " + budget);
  ok(prompt.includes(erasData.eras.find((era) => era.id === look.era).negative), look.id + "：本时代负向词进了提示词");
}
/* P2：品级、时代隔离与受控的高风险身份卡。 */
console.log("[10] P2 品级与时代隔离");
for (const kind of ["civil", "military"]) {
  for (let rank = 1; rank <= 9; rank++) {
    const look = erasData.looks.find((item) => item.id === "qe_" + kind + "_" + rank);
    const rule = erasData.ranks[kind][String(rank)];
    ok(!!look, kind + " 正" + rank + "品身份卡存在");
    if (!look) continue;
    run("state.templateId = 'sheet_2view'; applyLookData(" + JSON.stringify(look) + " ); loadBlocks();");
    const costume = run("costumeText()");
    ok(costume.indexOf(rule.badge) >= 0, look.id + "：补子为 " + rule.badge);
    ok(costume.indexOf(rule.jewel) >= 0, look.id + "：顶珠为 " + rule.jewel);
    ok((costume.indexOf("朝珠") >= 0) === rule.pearls, look.id + "：朝珠资格正确");
  }
}
const earlyBanned = new Set(["dalachi", "huapendi", "late_qing_changyi", "xinjun_uniform", "cao_yi"]);
const earlyLeaks = erasData.looks.filter((look) => look.era === "qing_early").filter((look) => Object.values(look.slots || {}).some((value) => earlyBanned.has(value)));
ok(earlyLeaks.length === 0, "盛清身份卡没有晚清专属形制");
const specialAnchors = {
  qe_emperor_ceremony: ["皇帝", "明黄色朝服", "五爪金龙", "东珠朝珠"],
  qe_empress_ceremony: ["皇后", "石青色朝褂", "明黄色朝袍", "朝裙", "三盘朝珠", "两盘珊瑚"],
  qe_qinwang_daily: ["宗室亲王", "亲王补服", "团龙"],
  ql_noble_lady: ["清代晚期", "大拉翅", "氅衣", "花盆底"],
  ql_xinjun: ["清代晚期", "大檐军帽", "西式立领军服", "长筒皮靴"],
  ql_student: ["清代晚期", "学生操帽", "操衣"],
  ql_donated_merchant: ["清代晚期", "捐纳职衔商人", "孔雀", "蓝宝石"]
};
for (const [id, anchors] of Object.entries(specialAnchors)) {
  const look = erasData.looks.find((item) => item.id === id);
  run("state.templateId = 'sheet_2view'; applyLookData(" + JSON.stringify(look) + " ); loadBlocks();");
  const costume = run("costumeText()");
  const missed = anchors.filter((anchor) => costume.indexOf(anchor) < 0);
  ok(missed.length === 0, id + "：P2 专属锚点齐全" + (missed.length ? "（缺 " + missed.join("、") + "）" : ""));
  ok(!!look.evidence && !!look.evidence.level && Array.isArray(look.evidence.refs) && look.evidence.refs.length > 0, id + "：有证据元数据");
}
run("state.templateId = 'costume_breakdown'; applyLookData(" + JSON.stringify(erasData.looks.find((item) => item.id === 'qe_civil_1')) + " ); loadBlocks();");
const breakdownPrompt = run("compilePrompt()");
ok(breakdownPrompt.indexOf("五个独立的无文字细节窗") >= 0 && breakdownPrompt.indexOf("无文字纯色小方块") >= 0, "服饰拆解与色卡画幅带无文字拆解约束");

/* 全部身份卡 × 全部画幅：无残留变量、都在预算内、服饰句都进提示词 */
let crossFail = [];
for (const look of erasData.looks) {
  for (const tl of layouts) {
    run("state.templateId = '" + tl.id + "';");
    run("applyLookData(" + JSON.stringify(look) + ");");
    run("loadBlocks()");
    const costume = run("costumeText()");
    const prompt = run("compilePrompt()");
    const budget = run("budgetFor(templateOrient())");
    if (/\{\{\w+\}\}/.test(prompt)) crossFail.push(look.id + "/" + tl.id + " 残留变量");
    if (prompt.length > budget) crossFail.push(look.id + "/" + tl.id + " 超预算 " + prompt.length + ">" + budget);
    if (costume && prompt.indexOf(costume) < 0) crossFail.push(look.id + "/" + tl.id + " 服饰句没进提示词");
  }
}
ok(crossFail.length === 0, "全部身份卡 × 全部画幅：无残留变量、全部在预算内、服饰句都进提示词" + (crossFail.length ? "（" + crossFail.slice(0, 3).join("；") + "）" : ""));
run("state.templateId = 'portrait'; applyLookData(" + JSON.stringify(erasData.looks[0]) + "); loadBlocks();");
const pc = run("costumeText()");
ok(pc.indexOf("靴") < 0 && pc.indexOf("袍裾") < 0, "半身像服饰句不写鞋与下装");
ok(pc.length < 60, "半身像服饰句更短（" + pc.length + " 字）");
run("state.params.era = 'none';");
ok(run("costumeText()") === "", "切回素体：服饰句为空");
const basePrompt = run("compilePrompt()");
ok(basePrompt.indexOf("补褂") < 0, "切回素体：提示词里没有服饰句（无泄漏）");
ok(basePrompt.indexOf("服装：上身赤裸") >= 0, "素体态着装句未被服饰改写");
ok(run("budgetFor(templateOrient())") === 1800, "素体态预算回到 1800");

console.log("");
if (fails.length) { console.error("FAILED " + fails.length + ":"); for (const f of fails) console.error(" - " + f); process.exit(1); }
console.log("画幅逻辑回归测试通过（复用 web/app.js 真实函数体）。");
