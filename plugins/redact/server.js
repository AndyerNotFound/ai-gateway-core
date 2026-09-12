'use strict';
                                
                                                                               
                                                                                                          
   
const redactCache = require('../../src/redact-cache.js');

const REDACT_FIELD_RE = /api[-_]?key|apikey|secret|password|passwd|token|authorization/i;

function rpCompile(rules) {
  const out = [];
  for (const r of (rules || [])) {
    if (!r || !r.re) continue;
    try { out.push({ re: new RegExp(r.re, (r.ci ? 'i' : '') + 'g'), to: String(r.to == null ? '' : r.to) }); } catch (_) {}
  }
  return out;
}
function rpApplyText(s, rules) { for (const r of rules) s = s.replace(r.re, r.to); return s; }
function rpWalk(v, rules, depth, skipModel) {
  if (v == null || depth > 12) return v;
  if (typeof v === 'string') return v.startsWith('data:') ? v : rpApplyText(v, rules);
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = rpWalk(v[i], rules, depth + 1, skipModel); return v; }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (skipModel && k === 'model') continue;                     
      v[k] = rpWalk(v[k], rules, depth + 1, skipModel);
    }
    return v;
  }
  return v;
}
function redactText(s, extra) { return redactCache.redactSmart(s, extra); }
function redactDeep(v, extra, depth) {
  if (v == null || depth > 12) return v;
  if (typeof v === 'string') return v.startsWith('data:') ? v : redactText(v, extra);
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = redactDeep(v[i], extra, depth + 1); return v; }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (typeof val === 'string' && val && REDACT_FIELD_RE.test(k)) v[k] = '***';
      else v[k] = redactDeep(val, extra, depth + 1);
    }
    return v;
  }
  return v;
}

module.exports.activate = (ctx) => {
  const cfg = ctx.config;
  const replace = (cfg.replace && typeof cfg.replace === 'object') ? cfg.replace : { out: [], inc: [] };
  const outRules = rpCompile(replace.out);
  const incRules = rpCompile(replace.inc);
  const extra = String(cfg.extra || '').split(',').map(s => s.trim()).filter(Boolean);

                                      
  const effRedact = (c) => {
    if (!cfg.enable) return false;
    const uk = c && c.urlInfo && c.urlInfo.userKey;
    if (uk && uk.redact === false) return false;
    return true;
  };

  if (cfg.enable || outRules.length) {
    ctx.hook('onRequestBody', (reqObj, c) => {
      if (effRedact(c)) redactDeep(reqObj, extra, 0);
      if (outRules.length) rpWalk(reqObj, outRules, 0, true);
    });
  }
  if (incRules.length) {
    ctx.hook('onResponseEvent', (ev) => { rpWalk(ev, incRules, 0, true); });
    ctx.hook('onResponseLine', (line) => rpApplyText(line, incRules));
    ctx.hook('onResponseBody', (b) => { rpWalk(b, incRules, 0, true); });
  }
  ctx.hook('sanitizeText', (t) => cfg.enable ? redactText(t, extra) : t);

  ctx.log('redact 已激活: 隐私过滤', cfg.enable ? '开' : '关', '替换 out', outRules.length, '条 / inc', incRules.length, '条');
};
