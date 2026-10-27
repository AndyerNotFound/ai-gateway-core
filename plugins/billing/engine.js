'use strict';
/* billing/engine.js — 动态计费引擎（纯计算，无副作用，可单测）
 *
 * 计费口径（一句话）：把一次请求的用量换算成「应扣多少额度」。
 *
 *   charged = Σ(各字段 token × 该字段单价权重)
 *             × 命中规则的倍率 / 命中规则的直接定价
 *             × 用户组折扣
 *
 * 关键设计（都是踩过坑后的结论）：
 *   1. **price 一律按「额度 / 1M tokens」解释**（★2026-09-18 修正口径：此前权重模式漏了 /1e6，
 *      把「0.85 / 1M」当成「0.85 / token」，实际多扣 100 万倍 —— 已发卡密的额度尺度随之变小
 *      100 万倍，等价于额度更耐用；本部署的卡额是 2^32 级"近似无限"，无需迁移）。
 *      想按真金白银定价时把 weightMode 关掉，引擎按 moneyPerToken 汇率换算（见 cfg.moneyPerToken）。
 *      ★2026-09-19 新增 cfg.miBase 开关：true = 权重模式按 1Mi tokens(2²⁰) 计费，false = 1M(10⁶)。
 *   2. **缓存命中要从 input 里拆出来**：上游的 input 通常**已包含** cacheRead，
 *      若不拆就会「既按新价算一次、又按输入价算一次」→ 双重计费（严重超扣）。
 *      所以先算 fresh = max(0, input - cacheRead)。
 *   3. **不返回负数**：规则可以乱配，引擎必须兜底，否则会变成「刷额度」。
 *   4. **规则不命中 = 返回 null**（交给内核走老口径），而不是返回 0。
 *      0 是"这次免费"的合法值，两者语义完全不同（桩测试专门盯这条）。
 */

/* ==================== 安全表达式求值 ====================
 * 用户自定义规则里要能写 `ctxLen >= 32000 && hour < 8` 这种条件。
 * ★绝对不用 eval / new Function：那是任意代码执行，等于把网关交给页面作者。
 * 这里实现一个**受限文法**的递归下降求值器，只认白名单里的东西，别的字符直接报错。
 * 支持：数字、标识符（变量名）、+ - * / %、比较、&& || !、括号、三元不用（用规则表达）
 */
const EXPR_VARS = ['ctxLen', 'input', 'output', 'cacheRead', 'cacheWrite', 'total', 'hour', 'minute', 'day', 'weekday', 'perCall', 'priceIn', 'priceOut'];

function tokenize(src) {
  const out = [];
  const s = String(src == null ? '' : src);
  let i = 0;
  const isDigit = c => c >= '0' && c <= '9';
  const isIdStart = c => /[A-Za-z_]/.test(c);
  const isId = c => /[A-Za-z0-9_]/.test(c);
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1]))) {
      let j = i; while (j < s.length && (isDigit(s[j]) || s[j] === '.')) j++;
      out.push({ t: 'num', v: Number(s.slice(i, j)) }); i = j; continue;
    }
    if (isIdStart(c)) {
      let j = i; while (j < s.length && isId(s[j])) j++;
      out.push({ t: 'id', v: s.slice(i, j) }); i = j; continue;
    }
    const two = s.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '>=', '<='].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%<>!()'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === '=') { out.push({ t: 'op', v: '==' }); i++; continue; } // 容忍写单个 =
    throw new Error('表达式含不支持的字符: ' + c);
  }
  return out;
}

function evalExpr(src, vars) {
  const tk = tokenize(src);
  let p = 0;
  const peek = () => tk[p];
  const eat = (v) => { const x = tk[p]; if (!x || x.v !== v) throw new Error('表达式语法错误（缺少 ' + v + '）'); p++; return x; };

  function primary() {
    const x = peek();
    if (!x) throw new Error('表达式不完整');
    if (x.t === 'num') { p++; return x.v; }
    if (x.t === 'id') {
      p++;
      if (x.v === 'true') return 1;
      if (x.v === 'false') return 0;
      if (!EXPR_VARS.includes(x.v)) throw new Error('不认识的变量: ' + x.v + '（可用: ' + EXPR_VARS.join(', ') + '）');
      const v = vars[x.v];
      return typeof v === 'number' ? v : (v ? 1 : 0);
    }
    if (x.v === '(') { p++; const v = orExpr(); eat(')'); return v; }
    if (x.v === '!') { p++; return primary() ? 0 : 1; }
    if (x.v === '-') { p++; return -primary(); }
    throw new Error('表达式语法错误（意外记号 ' + x.v + '）');
  }
  function mulExpr() {
    let v = primary();
    while (peek() && (peek().v === '*' || peek().v === '/' || peek().v === '%')) {
      const op = tk[p++].v; const r = primary();
      if (op === '*') v = v * r;
      else if (op === '/') v = r === 0 ? 0 : v / r;   // 除零 → 0（不让规则把网关搞崩）
      else v = r === 0 ? 0 : v % r;
    }
    return v;
  }
  function addExpr() {
    let v = mulExpr();
    while (peek() && (peek().v === '+' || peek().v === '-')) {
      const op = tk[p++].v; const r = mulExpr();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function cmpExpr() {
    let v = addExpr();
    while (peek() && ['>', '<', '>=', '<=', '==', '!='].includes(peek().v)) {
      const op = tk[p++].v; const r = addExpr();
      v = op === '>' ? (v > r) : op === '<' ? (v < r) : op === '>=' ? (v >= r) : op === '<=' ? (v <= r) : op === '==' ? (v === r) : (v !== r);
      v = v ? 1 : 0;
    }
    return v;
  }
  function andExpr() {
    let v = cmpExpr();
    while (peek() && peek().v === '&&') { p++; const r = cmpExpr(); v = (v && r) ? 1 : 0; }
    return v;
  }
  function orExpr() {
    let v = andExpr();
    while (peek() && peek().v === '||') { p++; const r = andExpr(); v = (v || r) ? 1 : 0; }
    return v;
  }
  const val = orExpr();
  if (p !== tk.length) throw new Error('表达式尾部有多余内容');
  return val;
}

/* ==================== 规则匹配 ==================== */

/** 单条 when 条件 → bool。ctx: {model,group,ugroup,ctxLen,hour,minute,day,weekday,cacheRead,cacheWrite,input,output,perCall} */
function matchOne(cond, ctx) {
  if (!cond || typeof cond !== 'object') return false;
  const k = String(cond.k || '');
  const op = String(cond.op || 'eq');
  const v = cond.v;
  const numOf = x => (typeof x === 'number' ? x : (x === true ? 1 : x === false ? 0 : Number(x) || 0));
  /* ★in / nin / between 的 v 是**数组**，绝不能被 num()/String() 先吃掉
   *  （`Number([8,18])` = NaN → 区间判断恒为 false，桩测试抓到过）。*/
  const rawV = (op === 'between' || op === 'in' || op === 'nin') ? v : undefined;
  const S = (x) => String(x == null ? '' : x);
  const N = (x) => numOf(x);
  switch (k) {
    case 'expr': {
      try { return !!evalExpr(v, ctx); } catch (_) { return false; }   // 表达式写错 → 该条不命中（不报错中断）
    }
    case 'model': return rawV !== undefined ? cmp(S(ctx.model), op, rawV) : cmp(S(ctx.model), op, S(v));
    case 'group': return rawV !== undefined ? cmp(S(ctx.group), op, rawV) : cmp(S(ctx.group), op, S(v));
    case 'ugroup': return rawV !== undefined ? cmp(S(ctx.ugroup), op, rawV) : cmp(S(ctx.ugroup), op, S(v));
    case 'channel': return rawV !== undefined ? cmp(S(ctx.channel), op, rawV) : cmp(S(ctx.channel), op, S(v));
    case 'ctxLen': return cmp(N(ctx.ctxLen), op, rawV !== undefined ? rawV : N(v));
    case 'hour': return cmp(N(ctx.hour), op, rawV !== undefined ? rawV : N(v));
    case 'day': return cmp(N(ctx.day), op, rawV !== undefined ? rawV : N(v));
    case 'weekday': return cmp(N(ctx.weekday), op, rawV !== undefined ? rawV : N(v));
    case 'cache': {  // 'hit' | 'write' | 'none'
      const want = S(v);
      const has = ctx.cacheRead > 0 ? 'hit' : (ctx.cacheWrite > 0 ? 'write' : 'none');
      return cmp(has, op, want);
    }
    case 'perCall': return cmp(ctx.perCall ? 1 : 0, op, rawV !== undefined ? rawV : N(v));
    default: return false;
  }
}

function cmp(a, op, b) {
  const N = x => (typeof x === 'number' ? x : (Number(x) || 0));
  switch (op) {
    case 'eq': case 'is': return a === b;
    case 'ne': case 'not': return a !== b;
    case 'gt': return N(a) > N(b);
    case 'gte': case 'ge': return N(a) >= N(b);
    case 'lt': return N(a) < N(b);
    case 'lte': case 'le': return N(a) <= N(b);
    case 'in': return Array.isArray(b) ? b.some(x => String(x) === String(a)) : String(b).split(',').map(s => s.trim()).includes(String(a));
    case 'nin': return Array.isArray(b) ? !b.some(x => String(x) === String(a)) : !String(b).split(',').map(s => s.trim()).includes(String(a));
    case 'between': {
      const lo = N(Array.isArray(b) ? b[0] : String(b).split(',')[0]);
      const hi = N(Array.isArray(b) ? b[1] : String(b).split(',')[1]);
      const x = N(a);
      return x >= lo && x <= hi;
    }
    default: return false;
  }
}

/** 规则是否命中（when 全部满足；空 when = 无条件命中） */
function matchRule(rule, ctx) {
  if (!rule || rule.on === false) return false;
  const when = Array.isArray(rule.when) ? rule.when : [];
  if (!when.length) return true;
  return when.every(c => matchOne(c, ctx));
}

/* ==================== 计费主函数 ==================== */

/**
 * 算一次请求该扣多少。
 * @param usage { input, output, cacheRead, cacheWrite, model, channel }
 * @param opt   { price:{in,out,cacheRead,cacheWrite}, perCall, rules:[], globalRules:[], cfg:{weightMode,moneyPerToken,ugroupDiscount}, at:Date, ugroup }
 * @returns { charged, detail }
 */
function compute(usage, opt) {
  const o = opt || {};
  const cfg = o.cfg || {};
  const at = o.at instanceof Date ? o.at : new Date(o.at || Date.now());

  const input = Math.max(0, Number(usage.input) || 0);
  const output = Math.max(0, Number(usage.output) || 0);
  const cacheRead = Math.min(Math.max(0, Number(usage.cacheRead) || 0), input); // 命中量不会超过 input
  const cacheWrite = Math.max(0, Number(usage.cacheWrite) || 0);
  const fresh = Math.max(0, input - cacheRead);   // ★关键：input 已含命中量，先拆开
  const total = input + output;

  /* 价格（权重）——没配 = 全 1 */
  const pr = o.price || {};
  let P = {
    in: Number(pr['in']) || (pr['in'] === 0 ? 0 : 1),
    out: Number(pr.out) || (pr.out === 0 ? 0 : 1),
    cacheRead: Number(pr.cacheRead) || (pr.cacheRead === 0 ? 0 : 1),
    cacheWrite: Number(pr.cacheWrite) || (pr.cacheWrite === 0 ? 0 : 1),
  };
  /* ★"填了 0" 与 "没填" 语义不同：填 0 = 免费（合法的促销配置）。
   *  上面用 `Number(x) || ...` 会把 0 吃掉，所以显式判 undefined。 */
  if (pr['in'] === undefined || pr['in'] === null || pr['in'] === '') P.in = 1;
  else P.in = Math.max(0, Number(pr['in']) || 0);
  if (pr.out === undefined || pr.out === null || pr.out === '') P.out = 1;
  else P.out = Math.max(0, Number(pr.out) || 0);
  if (pr.cacheRead === undefined || pr.cacheRead === null || pr.cacheRead === '') P.cacheRead = P.in;
  else P.cacheRead = Math.max(0, Number(pr.cacheRead) || 0);
  if (pr.cacheWrite === undefined || pr.cacheWrite === null || pr.cacheWrite === '') P.cacheWrite = P.in;
  else P.cacheWrite = Math.max(0, Number(pr.cacheWrite) || 0);

  const ctx = {
    model: String(usage.model || ''), channel: String(usage.channel || ''),
    group: String(o.group || ''), ugroup: String(o.ugroup || ''),
    ctxLen: input + cacheRead,        // 上下文长度按"输入总长"算（含命中部分）
    input, output, cacheRead, cacheWrite, total,
    hour: at.getHours(), minute: at.getMinutes(), day: at.getDate(), weekday: at.getDay(),
    perCall: false, priceIn: P.in, priceOut: P.out,
  };

  const hits = [];
  let mult = 1;        // 全局倍率
  let free = false;    // 直接免费
  let perCallCharge = null;

  /* 规则顺序：全局规则 → 模型规则（模型的更具体，后作用，可覆盖全局） */
  const rules = [].concat(o.globalRules || [], o.rules || []);
  for (const r of rules) {
    if (!matchRule(r, ctx)) continue;
    hits.push(String(r.id || r.note || '未命名'));
    const then = Array.isArray(r.then) ? r.then : [];
    for (const e of then) {
      if (!e || typeof e !== 'object') continue;
      const k = String(e.k || '');
      const v = Number(e.v);
      const f = String(e.field || 'all');
      if (k === 'free') { free = true; continue; }
      if (k === 'perCall' || k === 'percall') { perCallCharge = Math.max(0, v || 0); continue; }
      if (k === 'mult') { mult *= Math.max(0, v || 0); continue; }
      if (k === 'price') {
        const mode = String(e.mode || 'set');
        const apply = (cur) => {
          if (mode === 'set') return Math.max(0, v || 0);
          if (mode === 'mult') return Math.max(0, cur * (v || 0));
          if (mode === 'add') return Math.max(0, cur + (v || 0));
          return cur;
        };
        if (f === 'all' || f === 'input' || f === 'in') P.in = apply(P.in);
        if (f === 'all' || f === 'output' || f === 'out') P.out = apply(P.out);
        if (f === 'all' || f === 'cacheRead') P.cacheRead = apply(P.cacheRead);
        if (f === 'all' || f === 'cacheWrite') P.cacheWrite = apply(P.cacheWrite);
      }
    }
  }

  /* ★向后兼容的第一道闸（放在**匹配之后**，语义才准）：
   *  模型没配价格 + 没有任何规则命中 + 不是按次 → 返回 null，交给内核按老口径
   *  (input+output) 扣。这样"没配过计费的模型"扣费与今天逐字节一致，已发卡密零迁移。
   *  ⚠️不能只判断"存在已启用的规则"——规则存在但这次没命中，也同样不该插手。 */
  const hasPrice = !!(o.price && typeof o.price === 'object' && Object.keys(o.price).length);
  const hasPerCallCfg = o.perCall != null && o.perCall !== '' && Number(o.perCall) > 0;
  if (!hasPrice && !hits.length && !hasPerCallCfg) return null;

  if (free) return { charged: 0, detail: { mode: 'free', hits, price: P } };

  /* 按次计费：命中 perCall 规则 或 模型配了 perCall（且开了开关）
   * ★按次时不再叠加 token 计费 —— 两者是"二选一"，叠加会重复收钱。 */
  const modelPerCall = (o.perCall != null && o.perCall !== '' && Number(o.perCall) > 0) ? Number(o.perCall) : null;
  if (perCallCharge != null || modelPerCall != null) {
    let c = perCallCharge != null ? perCallCharge : modelPerCall;
    c *= mult;
    c *= discountOf(cfg, o.ugroup);
    return { charged: roundCharge(c, cfg), detail: { mode: 'perCall', unit: c, hits, price: P } };
  }

  const raw = fresh * P.in + cacheRead * P.cacheRead + cacheWrite * P.cacheWrite + output * P.out;
  /* ★口径统一 (2026-09-18)：price **一律按「额度 / 1M tokens」**解释（界面与文档一直这么写）。
   *  此前权重模式漏了 /1e6 → 把「0.85 / 1M」当成「0.85 / token」，实际多扣 100 万倍
   *  （实测：界面填 0.85 / 4.25 的 Claude，一次请求被扣 6916，正确值 0.0069）。
   *  ★计费基数开关 miBase (2026-09-19)：true = 按 1Mi tokens(2²⁰=1048576) 计费，
   *  false(默认) = 按 1M tokens(10⁶) 计费；价格表填的数含义不变，只换分母。 */
  const BASE = (cfg.miBase === true) ? 1048576 : 1e6;
  let charged = (raw / BASE) * mult * discountOf(cfg, o.ugroup);

  /* weightMode=false：price 当「元/1M tokens」→ 先换回额度（除以每 token 的钱）。
   *  ★金额模式的分母**不受 miBase 开关影响**：元/1M tokens 是行业定价惯例
   *  （与模型广场官价同口径），Mi 基数只作用于权重模式的额度扣费。 */
  if (cfg.weightMode === false) {
    const mpt = Number(cfg.moneyPerToken) || 0;
    charged = mpt > 0 ? (raw / 1e6) / mpt * mult * discountOf(cfg, o.ugroup) : charged;
  }

  return {
    charged: roundCharge(charged, cfg),
    detail: {
      mode: cfg.weightMode === false ? 'money' : 'weight',
      fresh, cacheRead, cacheWrite, output, price: P, mult,
      discount: discountOf(cfg, o.ugroup), raw, hits,
    },
  };
}

function discountOf(cfg, ugroup) {
  const m = (cfg && cfg.ugroupDiscount) || {};
  const d = Number(m[String(ugroup || '')]);
  return (d > 0 && d <= 10) ? d : 1;
}

/** 取整策略：默认 round（整数额度）；cfg.chargePrecision 可设小数位 */
function roundCharge(v, cfg) {
  let x = Number(v);
  if (!isFinite(x) || x < 0) x = 0;      // ★兜底：规则乱配也绝不产生负数/NaN
  const p = Number((cfg && cfg.chargePrecision));
  if (p > 0 && p <= 6) { const m = Math.pow(10, p); return Math.round(x * m) / m; }
  return Math.round(x);
}

module.exports = { compute, matchRule, matchOne, evalExpr, EXPR_VARS, roundCharge };
