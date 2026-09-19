'use strict';




























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
    if (c === '=') { out.push({ t: 'op', v: '==' }); i++; continue; } 
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
      else if (op === '/') v = r === 0 ? 0 : v / r;   
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




function matchOne(cond, ctx) {
  if (!cond || typeof cond !== 'object') return false;
  const k = String(cond.k || '');
  const op = String(cond.op || 'eq');
  const v = cond.v;
  const numOf = x => (typeof x === 'number' ? x : (x === true ? 1 : x === false ? 0 : Number(x) || 0));
  

  const rawV = (op === 'between' || op === 'in' || op === 'nin') ? v : undefined;
  const S = (x) => String(x == null ? '' : x);
  const N = (x) => numOf(x);
  switch (k) {
    case 'expr': {
      try { return !!evalExpr(v, ctx); } catch (_) { return false; }   
    }
    case 'model': return rawV !== undefined ? cmp(S(ctx.model), op, rawV) : cmp(S(ctx.model), op, S(v));
    case 'group': return rawV !== undefined ? cmp(S(ctx.group), op, rawV) : cmp(S(ctx.group), op, S(v));
    case 'ugroup': return rawV !== undefined ? cmp(S(ctx.ugroup), op, rawV) : cmp(S(ctx.ugroup), op, S(v));
    case 'channel': return rawV !== undefined ? cmp(S(ctx.channel), op, rawV) : cmp(S(ctx.channel), op, S(v));
    case 'ctxLen': return cmp(N(ctx.ctxLen), op, rawV !== undefined ? rawV : N(v));
    case 'hour': return cmp(N(ctx.hour), op, rawV !== undefined ? rawV : N(v));
    case 'day': return cmp(N(ctx.day), op, rawV !== undefined ? rawV : N(v));
    case 'weekday': return cmp(N(ctx.weekday), op, rawV !== undefined ? rawV : N(v));
    case 'cache': {  
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


function matchRule(rule, ctx) {
  if (!rule || rule.on === false) return false;
  const when = Array.isArray(rule.when) ? rule.when : [];
  if (!when.length) return true;
  return when.every(c => matchOne(c, ctx));
}









function compute(usage, opt) {
  const o = opt || {};
  const cfg = o.cfg || {};
  const at = o.at instanceof Date ? o.at : new Date(o.at || Date.now());

  const input = Math.max(0, Number(usage.input) || 0);
  const output = Math.max(0, Number(usage.output) || 0);
  const cacheRead = Math.min(Math.max(0, Number(usage.cacheRead) || 0), input); 
  const cacheWrite = Math.max(0, Number(usage.cacheWrite) || 0);
  const fresh = Math.max(0, input - cacheRead);   
  const total = input + output;

  
  const pr = o.price || {};
  let P = {
    in: Number(pr['in']) || (pr['in'] === 0 ? 0 : 1),
    out: Number(pr.out) || (pr.out === 0 ? 0 : 1),
    cacheRead: Number(pr.cacheRead) || (pr.cacheRead === 0 ? 0 : 1),
    cacheWrite: Number(pr.cacheWrite) || (pr.cacheWrite === 0 ? 0 : 1),
  };
  

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
    ctxLen: input + cacheRead,        
    input, output, cacheRead, cacheWrite, total,
    hour: at.getHours(), minute: at.getMinutes(), day: at.getDate(), weekday: at.getDay(),
    perCall: false, priceIn: P.in, priceOut: P.out,
  };

  const hits = [];
  let mult = 1;        
  let free = false;    
  let perCallCharge = null;

  
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

  



  const hasPrice = !!(o.price && typeof o.price === 'object' && Object.keys(o.price).length);
  const hasPerCallCfg = o.perCall != null && o.perCall !== '' && Number(o.perCall) > 0;
  if (!hasPrice && !hits.length && !hasPerCallCfg) return null;

  if (free) return { charged: 0, detail: { mode: 'free', hits, price: P } };

  

  const modelPerCall = (o.perCall != null && o.perCall !== '' && Number(o.perCall) > 0) ? Number(o.perCall) : null;
  if (perCallCharge != null || modelPerCall != null) {
    let c = perCallCharge != null ? perCallCharge : modelPerCall;
    c *= mult;
    c *= discountOf(cfg, o.ugroup);
    return { charged: roundCharge(c, cfg), detail: { mode: 'perCall', unit: c, hits, price: P } };
  }

  const raw = fresh * P.in + cacheRead * P.cacheRead + cacheWrite * P.cacheWrite + output * P.out;
  




  const BASE = (cfg.miBase === true) ? 1048576 : 1e6;
  let charged = (raw / BASE) * mult * discountOf(cfg, o.ugroup);

  


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


function roundCharge(v, cfg) {
  let x = Number(v);
  if (!isFinite(x) || x < 0) x = 0;      
  const p = Number((cfg && cfg.chargePrecision));
  if (p > 0 && p <= 6) { const m = Math.pow(10, p); return Math.round(x * m) / m; }
  return Math.round(x);
}

module.exports = { compute, matchRule, matchOne, evalExpr, EXPR_VARS, roundCharge };
