import fs from "node:fs/promises";

const params = JSON.parse(await fs.readFile("data/params.json", "utf8"));
const templates = JSON.parse(await fs.readFile("data/templates.json", "utf8"));
const presets = JSON.parse(await fs.readFile("data/presets.json", "utf8"));
const appSrc = await fs.readFile("web/app.js", "utf8");
const errors = [];
const fail = (msg) => errors.push(msg);

const NEW_PARAM_IDS = ["faceProportion","noseShape","lipShape","lipTexture","browGap","noseTip","earShape","faceLines","teeth","makeup","bodyShape","handDetail","complexion","moles","hairLength","bangs","parting","flyaways"];
const STRUCTURE_IDS = ["format","layout","style","negative"];
const NON_PARAM_VARS = new Set([
  "aspectText","aspectRatio","sizePx","sexPhrase","sexLabel","underTop","outfitExtra","ageLook",
  "name","identity","trait","masculinity","personality","styleKeywords","bio","profileText","signatureSentence",
  "costume","costumeNeg"
]);
/* 非参数变量的真值在 web/app.js 的 CANVAS_VARS / META_VARS 里：把键名解析出来并入手写名单，
   免得以后 app.js 加了新变量、校验表还停在旧名单上。（解析不到就静静退回手写名单） */
function appVarKeys(constName) {
  const m = appSrc.match(new RegExp("const " + constName + " = \\{([\\s\\S]*?)\\n\\};"));
  if (!m) return [];
  const keys = [];
  m[1].replace(/(?:^|\n)\s*(\w+):/g, (all, key) => { keys.push(key); return all; });
  return keys;
}
for (const key of appVarKeys("CANVAS_VARS").concat(appVarKeys("META_VARS"))) NON_PARAM_VARS.add(key);

if (params.version !== 4) fail("params.version 应为 4，当前 " + params.version);

const paramMap = new Map();
const groupIds = new Set();
let optionCount = 0;
for (const g of params.groups) {
  if (groupIds.has(g.id)) fail("group id 重复: " + g.id);
  groupIds.add(g.id);
  for (const p of g.params) {
    if (paramMap.has(p.id)) fail("param id 重复: " + p.id);
    paramMap.set(p.id, p);
    if (!p.label) fail(p.id + " 缺 label");
    if (!p.note) fail(p.id + " 缺 note");
    if (!p.impact) fail(p.id + " 缺 impact");
    if (p.tier !== "core" && p.tier !== "advanced") fail(p.id + " tier 非法: " + p.tier);
    if (p.type === "choice" || p.type === "sex") {
      if (!Array.isArray(p.options) || !p.options.length) { fail(p.id + " 没有 options"); continue; }
      const values = new Set();
      for (const o of p.options) {
        optionCount++;
        if (!o.value || !o.label || !o.phrase) fail(p.id + " 选项缺 value/label/phrase: " + JSON.stringify(o));
        if (values.has(o.value)) fail(p.id + " 选项 value 重复: " + o.value);
        values.add(o.value);
        if (p.id !== "sex") {
          if (!o.w || typeof o.w !== "object") fail(p.id + "." + o.value + " 缺分性别权重 w");
          else {
            for (const s of ["male","female","neutral"]) {
              if (typeof o.w[s] !== "number") fail(p.id + "." + o.value + " 缺 w." + s);
            }
            if (!["male","female","neutral"].some((s) => o.w[s] > 0)) fail(p.id + "." + o.value + " 三个性别权重全为 0");
          }
        }
        if (NEW_PARAM_IDS.includes(p.id) && !o.desc) fail(p.id + "." + o.value + " 缺 desc");
      }
      if (!values.has(p.default)) fail(p.id + " default 不在选项里: " + p.default);
    } else if (p.type === "number") {
      if (typeof p.min !== "number" || typeof p.max !== "number") fail(p.id + " number 参数缺 min/max");
      if (p.bands) {
        let last = -Infinity;
        for (const b of p.bands) {
          if (typeof b.max !== "number" || !b.phrase) fail(p.id + " band 不完整");
          if (b.max < last) fail(p.id + " bands max 未升序");
          last = b.max;
        }
        if (last < p.max) fail(p.id + " bands 没有覆盖到 max=" + p.max);
      }
      if (p.sexRanges) {
        for (const s of ["male","female","neutral"]) {
          const r = p.sexRanges[s];
          if (r && (r[0] < p.min || r[1] > p.max || r[0] > r[1])) fail(p.id + ".sexRanges." + s + " 越界");
        }
      }
    } else {
      fail(p.id + " 未知 type: " + p.type);
    }
  }
}

const contentIds = Object.keys(templates.content || {});
for (const id of contentIds) if (!templates.order.includes(id)) fail("content 段未出现在 order: " + id);
for (const id of templates.order) {
  if (!contentIds.includes(id) && !STRUCTURE_IDS.includes(id)) fail("order 里有未知段: " + id);
}
for (const id of STRUCTURE_IDS) if (!templates.order.includes(id)) fail("order 缺结构段: " + id);
for (const id of ["detailFace","detailBody","profile","signature"]) {
  if (!templates.content[id]) fail("缺内容段: " + id);
}

const VAR_RE = /\{\{(\w+)\}\}/g;
const collectVars = (text) => {
  const out = [];
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(String(text)))) out.push(m[1]);
  return out;
};
const resolves = (key) => {
  if (NON_PARAM_VARS.has(key)) return true;
  if (paramMap.has(key)) return true;
  const m = /^(\w+)Phrase$/.exec(key);
  return !!(m && paramMap.has(m[1]));
};

const allTexts = [];
for (const [id, b] of Object.entries(templates.content)) allTexts.push({ where: "content." + id, text: b.text || "" });
for (const t of templates.templates || []) {
  for (const [id, b] of Object.entries(t.structure || {})) allTexts.push({ where: t.id + ".structure." + id, text: b.text || "" });
}
for (const item of allTexts) {
  for (const key of collectVars(item.text)) {
    if (!resolves(key)) fail(item.where + " 引用了无法解析的变量 {{" + key + "}}");
  }
}

/* ---------- 画幅结构校验：templates.templates 与运行时的 data/layouts.json 用同一套规则 ----------
   vars      = 本画幅对共用内容段取值的改写（键必须是已存在的变量）
   suppress  = 本画幅不参与拼装的内容段 id */
function checkLayoutList(list, where) {
  const seen = new Set();
  for (const t of list || []) {
    if (!t || !t.id) { fail(where + " 有画幅缺 id"); continue; }
    if (seen.has(t.id)) fail(where + " 画幅 id 重复: " + t.id);
    seen.add(t.id);
    if (!t.label) fail(where + " " + t.id + " 缺 label");
    if (t.orient !== undefined && ["landscape", "portrait", "square", "any"].indexOf(t.orient) < 0) {
      fail(where + " " + t.id + ".orient 只能是 landscape / portrait / square / any");
    }
    for (const k of Object.keys(t.structure || {})) {
      if (!STRUCTURE_IDS.includes(k) && !contentIds.includes(k)) fail(where + " " + t.id + " 的 structure 有未知段: " + k);
    }
    for (const k of STRUCTURE_IDS) {
      const s = (t.structure || {})[k];
      if (!s || !String(s.text || "").trim()) fail(where + " " + t.id + " 缺结构段: " + k);
      for (const key of collectVars(s ? s.text : "")) {
        if (!resolves(key)) fail(where + " " + t.id + ".structure." + k + " 引用了无法解析的变量 {{" + key + "}}");
      }
    }
    if (t.vars !== undefined) {
      if (!t.vars || typeof t.vars !== "object" || Array.isArray(t.vars)) fail(where + " " + t.id + ".vars 必须是对象");
      else {
        for (const [k, v] of Object.entries(t.vars)) {
          if (typeof v !== "string") fail(where + " " + t.id + ".vars." + k + " 必须是字符串");
          if (!resolves(k)) fail(where + " " + t.id + ".vars 覆盖了不存在的变量: " + k);
        }
      }
    }
    if (t.suppress !== undefined) {
      if (!Array.isArray(t.suppress)) fail(where + " " + t.id + ".suppress 必须是数组");
      else {
        for (const id of t.suppress) {
          if (!contentIds.includes(id)) fail(where + " " + t.id + ".suppress 引用了不存在的内容段: " + id);
        }
      }
    }
  }
}
checkLayoutList(templates.templates, "templates.json");
try {
  const jl = JSON.parse(await fs.readFile("data/layouts.json", "utf8"));
  if (Array.isArray(jl.layouts) && jl.layouts.length) {
    checkLayoutList(jl.layouts, "layouts.json");
    /* layouts.json 是运行时优先的数据；允许和 templates.json 不同（用户可能手改/在界面上改过），
       但两份漂移是「改了不生效」的头号来源，所以这里明确提示。 */
    const tplById = new Map((templates.templates || []).map((t) => [t.id, t]));
    const drift = [];
    for (const l of jl.layouts) {
      const t = tplById.get(l.id);
      if (!t) continue;
      if ((t.orient || "any") !== (l.orient || "any")) drift.push(l.id + ".orient");
      for (const k of ["format", "layout", "style", "negative"]) {
        if (!t.structure[k] || !l.structure[k]) continue;
        if (t.structure[k].text !== l.structure[k].text) drift.push(l.id + ".structure." + k);
      }
      if (JSON.stringify(t.vars || {}) !== JSON.stringify(l.vars || {})) drift.push(l.id + ".vars");
      if (JSON.stringify(t.suppress || []) !== JSON.stringify(l.suppress || [])) drift.push(l.id + ".suppress");
    }
    if (drift.length) {
      console.warn("提示：data/layouts.json 与 data/templates.json 有 " + drift.length + " 处不同（运行时以 layouts.json 为准；改默认值时两处要同步）：" + drift.slice(0, 8).join("、") + (drift.length > 8 ? " …" : ""));
    }
  }
} catch (e) {
  /* 没有 layouts.json 时运行时用 templates.json 的默认画幅，不影响校验 */
}

/* 复合变量：一个段正文里只放 {{costume}}，由 covers 声明它代为落地了哪些参数 */
const coveredIds = new Set();
for (const [id, b] of Object.entries(templates.content)) {
  if (!Array.isArray(b.covers)) continue;
  for (const k of b.covers) {
    if (!paramMap.has(k)) fail("内容段 " + id + " 的 covers 引用了不存在的参数: " + k);
    coveredIds.add(k);
  }
}
for (const [id, p] of paramMap) {
  if (id === "sex" || p.virtual) continue;
  const re = new RegExp("\\{\\{" + id + "(Phrase)?\\}\\}");
  const used = Object.values(templates.content).some((b) => re.test(String(b.text || ""))) || coveredIds.has(id);
  if (!used) fail("参数没有被任何内容段引用（或没进 covers）: " + id);
}

const ruleIds = new Set();
for (const rule of params.conflictRules || []) {
  if (!rule.id || ruleIds.has(rule.id)) fail("conflictRule id 缺失或重复: " + rule.id);
  ruleIds.add(rule.id);
  for (const [id, values] of Object.entries(rule.when || {})) {
    const p = paramMap.get(id);
    if (!p) { fail("conflictRule " + rule.id + " 引用不存在的参数 " + id); continue; }
    if (p.type === "choice") {
      const valid = new Set(p.options.map((o) => o.value));
      for (const v of values) if (!valid.has(v)) fail("conflictRule " + rule.id + " 引用不存在的值 " + id + "." + v);
    }
  }
  for (const [id, value] of Object.entries(rule.fix || {})) {
    const p = paramMap.get(id);
    if (!p) { fail("conflictRule " + rule.id + " fix 引用不存在的参数 " + id); continue; }
    if (p.type === "choice" && !p.options.some((o) => o.value === value)) fail("conflictRule " + rule.id + " fix 值不存在 " + id + "." + value);
  }
}


/* ---------- 画幅预设：尺寸与版面必须和 web/app.js 的实际比例表一致 ---------- */
const ratioMatch = appSrc.match(/const RATIOS = (\[[\s\S]*?\n\]);/);
const resMatch = appSrc.match(/const RES_LIST = (\[[^\]]*\]);/);
let RATIOS = [];
let RES_LIST = [];
if (!ratioMatch) fail("web/app.js 里找不到 RATIOS 表");
else {
  try { RATIOS = new Function("return " + ratioMatch[1])(); }
  catch (e) { fail("web/app.js 的 RATIOS 解析失败: " + e.message); }
}
if (!resMatch) fail("web/app.js 里找不到 RES_LIST");
else {
  try { RES_LIST = new Function("return " + resMatch[1])(); }
  catch (e) { fail("web/app.js 的 RES_LIST 解析失败: " + e.message); }
}

const presetList = Array.isArray(presets.presets) ? presets.presets : null;
if (presets.version !== 1) fail("presets.version 应为 1，当前 " + presets.version);
if (!presetList) fail("data/presets.json 缺少 presets 数组");
const ratioById = new Map(RATIOS.map((r) => [r.id, r]));
const resIds = new Set(RES_LIST);
const tplIds = new Set((templates.templates || []).map((t) => t.id));
/* 版面文案的方向约束：横版文案不能配竖版画布；中性版面不限 */
const LAYOUT_ORIENT = {
  sheet_2view: "landscape",
  sheet_3view: "landscape",
  fullbody: "any",
  portrait: "any",
  expression_grid: "any"
};
/* 画幅对象上声明的 orient（app.js 会据此禁用不兼容的比例） */
const layoutOrientMap = new Map((templates.templates || []).map((t) => [t.id, t.orient || "any"]));
const presetIds = new Set();
let recommendedCount = 0;
for (const p of presetList || []) {
  if (!p || typeof p !== "object") { fail("preset 不是对象"); continue; }
  const where = "preset " + (p.id || "(无 id)");
  if (!/^[a-z0-9_]+$/.test(p.id || "")) fail(where + " 的 id 只能用小写字母 / 数字 / 下划线");
  if (presetIds.has(p.id)) fail(where + " 的 id 重复");
  presetIds.add(p.id);
  if (!p.label) fail(where + " 缺 label");
  if (["asset", "publish"].indexOf(p.group) < 0) fail(where + " 的 group 必须是 asset 或 publish");
  if (!tplIds.has(p.layoutId)) fail(where + " 的 layoutId 不存在: " + p.layoutId);
  const ratio = ratioById.get(p.ratio);
  if (!ratio) { fail(where + " 的 ratio 不存在: " + p.ratio); continue; }
  if (!resIds.has(p.res)) { fail(where + " 的 res 不存在: " + p.res); continue; }
  const size = ratio.sizes && ratio.sizes[p.res];
  if (!Array.isArray(size)) { fail(where + " 取不到像素: " + p.ratio + " " + p.res); continue; }
  const w = size[0], h = size[1];
  if (w % 16 || h % 16) fail(where + " 像素不是 16 的倍数: " + w + "x" + h);
  if (w < 720 || h < 720 || w > 3840 || h > 3840) fail(where + " 像素越界: " + w + "x" + h);
  if (w * h < 786432) fail(where + " 总像素不足: " + w + "x" + h);
  const orient = w > h ? "landscape" : w < h ? "portrait" : "square";
  if (p.group === "asset" && orient === "portrait") fail(where + " asset 组不能配竖版画布");
  if (p.group === "publish" && orient !== "portrait") fail(where + " publish 组应配竖版画布");
  const lo = LAYOUT_ORIENT[p.layoutId];
  if (lo === "landscape" && orient !== "landscape") fail(where + " 横版版面配了非横版画布");
  if (lo === "portrait" && orient !== "portrait") fail(where + " 竖版版面配了非竖版画布");
  const tplOrient = layoutOrientMap.get(p.layoutId);
  if (tplOrient && tplOrient !== "any" && tplOrient !== orient) {
    fail(where + " 画幅 " + p.layoutId + " 的 orient=" + tplOrient + "，但预设画布是 " + orient);
  }
  if (p.recommended !== undefined && typeof p.recommended !== "boolean") fail(where + " 的 recommended 必须是布尔值");
  if (p.recommended === true) recommendedCount++;
  if (p.note !== undefined && typeof p.note !== "string") fail(where + " 的 note 必须是字符串");
}
if (recommendedCount !== 1) fail("presets 里 recommended 应恰好 1 个，当前 " + recommendedCount);
console.log("画幅预设: " + (presetList ? presetList.length : 0) + " 个");

console.log("参数: " + paramMap.size + " 项 / 选项: " + optionCount + " 个 / 内容段: " + contentIds.length + " 段 / 冲突规则: " + (params.conflictRules || []).length + " 条");


/* ---------- 朝代 / 服饰数据（data/eras.json） ---------- */
let E = null;
try {
  const erasRaw = await fs.readFile("data/eras.json", "utf8");
  E = JSON.parse(erasRaw);
  const eraIds = new Set((E.eras || []).map((e) => e.id));
  const commIds = new Set((E.communities || []).map((x) => x.id));
  const roleIds = new Set((E.roles || []).map((x) => x.id));
  const occIds = new Set((E.occasions || []).map((x) => x.id));
  const slotDefs = E.slots || [];
  const slotIds = new Set(slotDefs.map((s) => s.id));
  for (const sid of slotIds) if (!paramMap.has(sid)) fail("eras.slots 里的槽位在 params 里不存在: " + sid);
  for (const kind of ["civil", "military"]) {
    const table = (E.ranks || {})[kind] || {};
    for (let i = 1; i <= 9; i++) {
      const row = table[String(i)];
      if (!row || !row.badge || !row.jewel) fail("ranks." + kind + "." + i + " 缺 badge/jewel");
    }
  }
  const seenLook = new Set();
  for (const l of E.looks || []) {
    if (seenLook.has(l.id)) fail("look id 重复: " + l.id);
    seenLook.add(l.id);
    if (!eraIds.has(l.era)) fail("look " + l.id + " 的 era 不存在: " + l.era);
    if (l.community && l.community !== "none" && !commIds.has(l.community)) fail("look " + l.id + " 的 community 不存在");
    if (l.role && l.role !== "none" && !roleIds.has(l.role)) fail("look " + l.id + " 的 role 不存在");
    if (l.occasion && !occIds.has(l.occasion)) fail("look " + l.id + " 的 occasion 不存在");
    for (const [sid, val] of Object.entries(l.slots || {})) {
      if (!slotIds.has(sid) || !paramMap.has(sid)) { fail("look " + l.id + " 的槽位未知: " + sid); continue; }
      const slotParam = paramMap.get(sid);
      const o = slotParam.options.find((x) => x.value === val);
      if (!o) { fail("look " + l.id + " 的 " + sid + " 值不存在: " + val); continue; }
      /* 预设必须满足自己的门控，否则套用时会被 clamp 掉 */
      for (const [gk, arr] of Object.entries(o.g || {})) {
        const ctxVal = l[gk];
        if (arr.indexOf(ctxVal) < 0) fail("look " + l.id + " 的 " + sid + "=" + val + " 不满足门控 " + gk + "=" + ctxVal);
      }
      if (o.w && !(o.w[l.sex] > 0)) fail("look " + l.id + " 的 " + sid + " 不适用性别 " + l.sex);
    }
    if (!l.confidence) fail("look " + l.id + " 缺 confidence");
    const evidence = l.evidence;
    if (!evidence || !evidence.level) fail("look " + l.id + " 缺 evidence.level");
    if (!evidence || !Array.isArray(evidence.refs) || !evidence.refs.length) fail("look " + l.id + " 缺 evidence.refs");
    for (const ref of (evidence && evidence.refs) || []) if (!(E.refs || {})[ref]) fail("look " + l.id + " 引用了不存在的证据来源: " + ref);
  }
  const late = (E.looks || []).filter((l) => l.era === "qing_late");
  if (!late.length) fail("P2 缺 qing_late 身份卡");
  const early = (E.looks || []).filter((l) => l.era === "qing_early");
  for (const l of early) {
    const values = Object.values(l.slots || {});
    if (values.some((v) => ["dalachi", "huapendi", "late_qing_changyi", "xinjun_uniform", "cao_yi"].includes(v))) fail("盛清卡混入晚清专属形制: " + l.id);
  }
  for (const kind of ["civil", "military"]) {
    for (let i = 1; i <= 9; i++) {
      const row = (E.ranks || {})[kind]?.[String(i)];
      if (!row?.badge || !row?.jewel || typeof row.pearls !== "boolean") fail("P2 " + kind + " " + i + " 品缺完整补子/顶珠/朝珠规则");
    }
  }
} catch (e) {
  fail("eras.json 读取或解析失败: " + String(e && e.message || e));
}

/* ---------- 追加校验：身份卡 / 覆盖 / 槽位 / 画幅改写 / 冲突规则 ----------
   这一组只看数据自洽：身份卡（looks）的上下文、overrides、slots，内容段的 covers，
   画幅的 vars / suppress，以及 conflictRules 的参数与取值。坏数据 push 到 errors。 */
if (E) {
  const lookIds = new Set();
  const lookLabels = new Set();
  const eraIds = new Set((E.eras || []).map((e) => e.id));
  const slotIdSet = new Set(((E.slots || []).map((s) => s.id)));
  /* 这几种发型不会露出刘海与分缝；剃发只能配寸头发长（派生规则与 identity 卡同一套口径） */
  const HAIR_STYLES_TIED = new Set(["shaved", "queue", "qipan", "hanji_hair", "updo", "bun"]);
  const WEIRD_CHARS = /[\s\u00a0\u3000\u200b-\u200f\u2028\u2029\ufeff\u0000-\u001f]/;
  const optionValuesOf = (id) => {
    const p = paramMap.get(id);
    return new Set(((p && p.options) || []).map((o) => o.value));
  };
  const IDENTITY_FIELDS = ["community", "role", "rank", "occasion"];

  for (const l of E.looks || []) {
    const where = "身份卡 " + (l.id || "(无 id)");
    if (!l.id) fail(where + " 缺 id");
    else {
      if (lookIds.has(l.id)) fail(where + " 的 id 重复");
      lookIds.add(l.id);
    }
    const label = l.label == null ? "" : String(l.label);
    if (!label.trim()) fail(where + " 缺 label");
    else {
      if (WEIRD_CHARS.test(label)) fail(where + " 的 label 含空白或怪字符: " + JSON.stringify(label));
      if (lookLabels.has(label)) fail(where + " 的 label 与其它身份卡重复: " + label);
      lookLabels.add(label);
    }
    if (!eraIds.has(l.era)) fail(where + " 的 era 不在 eras.eras 里: " + l.era);
    if (l.sex !== undefined && ["male", "female", "neutral"].indexOf(l.sex) < 0) {
      fail(where + " 的 sex 只能是 male / female / neutral 或缺省，当前 " + JSON.stringify(l.sex));
    }
    for (const key of IDENTITY_FIELDS) {
      if (l[key] === undefined) continue;
      const v = String(l[key]);
      if (v !== "none" && !optionValuesOf(key).has(v)) fail(where + " 的 " + key + " 不是 identity 参数的合法选项: " + v);
    }

    /* overrides：key 必须是真实参数，value 必须是该参数的合法选项；发型与刘海/分缝/发长必须自洽 */
    const overrides = l.overrides || {};
    for (const [k, v] of Object.entries(overrides)) {
      const p = paramMap.get(k);
      if (!p) { fail(where + " 的 overrides 引用了不存在的参数: " + k); continue; }
      if (!p.options || !p.options.some((o) => o.value === v)) {
        fail(where + " 的 overrides." + k + " 不是合法选项值: " + JSON.stringify(v));
      }
    }
    if (HAIR_STYLES_TIED.has(overrides.hairStyle)) {
      if (overrides.bangs !== "none") fail(where + " 的 hairStyle=" + overrides.hairStyle + " 必须写 bangs=\"none\"，当前 " + JSON.stringify(overrides.bangs));
      if (overrides.parting !== "none") fail(where + " 的 hairStyle=" + overrides.hairStyle + " 必须写 parting=\"none\"，当前 " + JSON.stringify(overrides.parting));
    }
    if (overrides.hairStyle === "shaved" && overrides.hairLength !== "buzz") {
      fail(where + " 的 hairStyle=shaved 必须写 hairLength=\"buzz\"，当前 " + JSON.stringify(overrides.hairLength));
    }

    /* slots：key 只能是 9 个服饰槽位，value 必须是非空的合法选项值 */
    for (const [sid, val] of Object.entries(l.slots || {})) {
      if (!slotIdSet.has(sid)) { fail(where + " 的槽位 key 不在 eras.slots 的 9 个槽位里: " + sid); continue; }
      const p = paramMap.get(sid);
      if (!p) { fail(where + " 的槽位在 params 里不存在: " + sid); continue; }
      if (typeof val !== "string" || !val.trim()) { fail(where + " 的槽位 " + sid + " 值为空"); continue; }
      if (!(p.options || []).some((o) => o.value === val)) fail(where + " 的槽位 " + sid + " 不是合法选项值: " + val);
    }
  }

  /* covers：只有着装段可以声明（现有结构里只在 outfit），id 必须是真实参数且不重复 */
  for (const [id, b] of Object.entries(templates.content || {})) {
    if (!Array.isArray(b.covers)) continue;
    if (id !== "outfit") fail("内容段 " + id + " 声明了 covers；现有结构里 covers 只出现在 outfit");
    const seenCover = new Set();
    for (const k of b.covers) {
      if (seenCover.has(k)) fail("内容段 " + id + " 的 covers 有重复 id: " + k);
      seenCover.add(k);
      if (!paramMap.has(k)) fail("内容段 " + id + " 的 covers 引用了不存在的参数: " + k);
    }
  }

  /* 画幅改写：vars 的 key 必须能解析成变量、value 必须是非空字符串；suppress 只允许内容段 id */
  const checkLayoutVars = (list, where) => {
    for (const t of list || []) {
      if (!t || !t.id) continue;
      for (const [k, v] of Object.entries(t.vars || {})) {
        if (!resolves(k)) fail(where + " " + t.id + ".vars 覆盖了不存在的变量: " + k);
        if (typeof v !== "string" || !v.trim()) fail(where + " " + t.id + ".vars." + k + " 必须是非空字符串");
      }
      for (const id of t.suppress || []) {
        if (!contentIds.includes(id)) fail(where + " " + t.id + ".suppress 只能写内容段 id: " + id);
      }
    }
  };
  checkLayoutVars(templates.templates, "templates.json");
  try {
    const jl2 = JSON.parse(await fs.readFile("data/layouts.json", "utf8"));
    checkLayoutVars(jl2.layouts, "layouts.json");
  } catch (e) {
    /* 没有 layouts.json 时运行时用 templates.json 的默认画幅，不影响校验 */
  }

  /* conflictRules：when 的 key 是真实参数、值在该参数选项里；fix 的 key/value 同样要合法 */
  for (const rule of params.conflictRules || []) {
    const where = "conflictRule " + (rule.id || "(无 id)");
    if (!rule.when || typeof rule.when !== "object" || Array.isArray(rule.when)) { fail(where + " 缺 when 对象"); continue; }
    for (const [id, values] of Object.entries(rule.when)) {
      const p = paramMap.get(id);
      if (!p) { fail(where + " 的 when 引用了不存在的参数: " + id); continue; }
      if (!Array.isArray(values) || !values.length) { fail(where + " 的 when." + id + " 必须是非空数组"); continue; }
      for (const v of values) {
        if (p.type === "choice" || p.type === "sex") {
          if (!(p.options || []).some((o) => o.value === String(v))) fail(where + " 的 when." + id + " 引用了不存在的值: " + JSON.stringify(v));
        } else if (p.type === "number") {
          const n = Number(v);
          if (!isFinite(n) || n < p.min || n > p.max) fail(where + " 的 when." + id + " 超出 number 范围: " + JSON.stringify(v));
        }
      }
    }
    for (const [id, value] of Object.entries(rule.fix || {})) {
      const p = paramMap.get(id);
      if (!p) { fail(where + " 的 fix 引用了不存在的参数: " + id); continue; }
      if (p.type === "choice" || p.type === "sex") {
        if (!(p.options || []).some((o) => o.value === String(value))) fail(where + " 的 fix." + id + " 不是合法选项值: " + JSON.stringify(value));
      } else if (p.type === "number") {
        const n = Number(value);
        if (!isFinite(n) || n < p.min || n > p.max) fail(where + " 的 fix." + id + " 超出 number 范围: " + JSON.stringify(value));
      }
    }
  }
}

if (errors.length) {
  console.error("\n发现 " + errors.length + " 个问题:");
  for (const error of errors) console.error(" - " + error);
  process.exit(1);
}
console.log("数据与全部时代身份卡校验通过。");
