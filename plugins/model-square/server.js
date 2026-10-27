'use strict';
/** model-square - the model square (with filtering)
 *
   * why a plugin page: the page is server-rendered gcui JSON, rendered directly by the App,
 * so **editing this file needs no App rebuild** -- adding filters or restyling only requires a gateway restart.
 *
   * three filter dimensions:
 *   group           : the "family" of client-visible model names; with modelMap configured, an alias itself forms a group
 *   provider        : the channel name
 *   user group      : the user's group in the "user system"; a channel may set a groups:[] whitelist (empty = all groups allowed)
 *
   * filter state persists in plugin data per (uid|card); every filter-chip tap -> intent -> a full page back -> the App re-renders in place.
 */

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

/** ---- i18n shared library (the i18n plugin): require/config read failures always fall back to the original Chinese text ---- */
let i18nBundle = null;
try { i18nBundle = require('../i18n/lib').bundle; } catch (_) { i18nBundle = null; }
function mkT(ctx, uk) {
  try { if (i18nBundle) return i18nBundle(ctx, uk); } catch (_) {}
  const t = function (s) { return s; };
  t.lang = 'zh-CN';
  return { lang: 'zh-CN', t: t };
}

module.exports.activate = (ctx) => {
  const cfg = ctx.config;   /* ★this object reference must stay "alive" -- closures and saveCfg both point at it, see refreshCfg below (the reference is never replaced) */

  /* ---------------- Groups / model metadata ----------------
   * groups   : [{ name, rate }]  rate = billing multiplier
   * meta     : { "instance|channel|model": { group, alias, price:{in,out,cacheWrite,cacheRead}, perCall } }
   *            alias    = public name (empty = use the original)
   *            price    = currency / 1M tokens
   *            perCall  = a number means "billed per call" (per call); null = disabled
   */
  const DEFAULT_GROUP = 'Default';
  const normalize = () => {
    if (!cfg.filters || typeof cfg.filters !== 'object') cfg.filters = {};
    if (!Array.isArray(cfg.groups) || !cfg.groups.length) cfg.groups = [{ name: DEFAULT_GROUP, rate: 1 }];
    if (!cfg.groups.some(g => g && g.name === DEFAULT_GROUP)) cfg.groups.unshift({ name: DEFAULT_GROUP, rate: 1 });
    if (!cfg.modelMeta || typeof cfg.modelMeta !== 'object') cfg.modelMeta = {};
  };
  normalize();

  /* *multi-instance consistency (fixed 2026-09-18; user report: "priced a model on the Guili branch, switching back to default showed no price")
   *  This plugin's config (groups/pricing/aliases/rules) is **shared across all instances** (no scope in manifest -> global, stored under the _global key),
   *  but the kernel's activateOne() reads disk once at plugin activation -> each instance holds its own memory copy, never refreshed afterwards.
   *  the kernel has long provided the config version ctx.configRev (+1 after any instance's setPluginConfig, shared across the plugin's instances),
   *  auth-cardkey / auth-user both implemented cfgLive() per convention (see their "*multi-instance consistency" comments),
   *  this plugin alone never used it -> after changing prices on instance A, switching to B still showed B's startup-time stale copy.
   *  measured (2026-09-18): the 5 instances besides Guili saw only 231 entries; Guili's 29 prices were all null,
   *  groups degraded to name-prefix inference ("HY3"); only the writer Guili saw all 260.
   *  approach: check the version at each request entry; on change, **refresh the same cfg object in place** (swapping the whole reference would break closures and
   *  saveCfg keeps using the old object, so delete+assign must happen in place), and rerun normalize() while at it.
   *  a side benefit: what gets flushed is no longer a "stale copy", so whole-object writes can no longer clobber data another instance just saved. */
  let cfgRevSeen = -1;
  const refreshCfg = () => {
    const r = ctx.configRev ? ctx.configRev() : 0;
    if (r !== cfgRevSeen) {
      let fresh = null;
      try { fresh = ctx.getPluginConfig ? ctx.getPluginConfig('model-square') : null; } catch (_) { fresh = null; }
      if (fresh && typeof fresh === 'object') {
        for (const k of Object.keys(cfg)) delete cfg[k];
        Object.assign(cfg, fresh);
        normalize();
      }
      cfgRevSeen = r;
    }
    return cfg;
  };
  /** Every route is wrapped once: the entry refreshes config first (see above) */
  const route = (method, p, handler) => ctx.registerRoute(method, p, (req, res, prm) => {
    refreshCfg();
    return handler(req, res, prm);
  });
  const saveCfg = () => ctx.setPluginConfig(cfg);
  /* *key upgraded to instance|channel|model (2026-09-12 user request "organize quick groups into sections by instance+channel") */
  const metaKey = (inst, ch, m) => [String(inst || ''), String(ch), String(m)].join('|');
  const metaOf = (inst, ch, m) => cfg.modelMeta[metaKey(inst, ch, m)] || null;
  /* *fix: return '' when there is no meta -> the call site's || groupOfName(n) can then infer from the name prefix
   *  (it always returned Default, prefix inference never fired -> the group chip offered only Default) */
  const groupNameOf = (inst, ch, m) => (metaOf(inst, ch, m) || {}).group || '';
  const aliasOf = (inst, ch, m) => (metaOf(inst, ch, m) || {}).alias || '';
  const priceOf = (inst, ch, m) => (metaOf(inst, ch, m) || {}).price || null;
  const perCallOf = (inst, ch, m) => {
    const v = (metaOf(inst, ch, m) || {}).perCall;
    return (v === null || v === undefined || v === '') ? null : Number(v);
  };
  const groupNames = () => cfg.groups.map(g => g.name);

  /* ---------- Data ---------- */
  const fkey = (uk) => (uk && (uk.uid || uk.key)) || 'anon';

  const allFilter = () => ({ group: '', provider: '', vendor: '', ugroup: '', q: '', sort: '', cols: 1, limit: 150 });
  const filterOf = (uk) => Object.assign(allFilter(), cfg.filters[fkey(uk)] || {});
  /* Filter-state serialization (for open GET routes: guests can filter/sort/switch views too; state rides in the URL, no login needed)
   * ★Must be "key-driven": when the caller **explicitly passes a key, it goes into the URL** (even if the value is an empty string) --
   *   the server treats "is this key in the URL" as "should this field be changed".
   *   truthiness checks like if (o.sort) / Number(o.cols) === 2 silently swallowed empty sorts and cols=1,
   *   the symptom: "tap sort/switch view, the page refreshes but the state never changes" (user report 2026-09-15). */
  const qs = (f, ov) => {
    const o = Object.assign({}, f, ov || {});
    const P = [];
    const has = (k) => !!ov && Object.prototype.hasOwnProperty.call(ov, k);
    const put = (k, v) => P.push(k + '=' + encodeURIComponent(v === undefined || v === null ? '' : String(v)));
    if (o.view || has('view')) put('view', o.view);
    if (o.q || has('q')) put('q', o.q);
    if (o.sort || has('sort')) put('sort', o.sort);
    if (o.group || has('group')) put('group', o.group);
    if (o.provider || has('provider')) put('provider', o.provider);
    if (o.vendor || has('vendor')) put('vendor', o.vendor);
    if (o.ugroup || has('ugroup')) put('ugroup', o.ugroup);
    put('cols', Number(o.cols) === 2 ? 2 : 1);   /* 永远带上: 否则视图会被服务端已存的值莫名其妙地弹回 */
    put('limit', Math.max(1, Number(o.limit) || 150));   /* ★带上"已加载多少"(加载更多后切筛选不该缩回去) */
    return P.join('&');
  };
  /* the "other" filters carried on search submit (excluding q/view; q comes from {{input.q}}) */
  const qsCarry = (f) => {
    const P = [];
    if (f.sort) P.push('sort=' + f.sort);
    P.push('cols=' + (Number(f.cols) === 2 ? 2 : 1));   /* ★必带 */
    P.push('limit=' + Math.max(1, Number(f.limit) || 150));
    if (f.group) P.push('group=' + encodeURIComponent(f.group));
    if (f.provider) P.push('provider=' + encodeURIComponent(f.provider));
    if (f.vendor) P.push('vendor=' + encodeURIComponent(f.vendor));
    if (f.ugroup) P.push('ugroup=' + encodeURIComponent(f.ugroup));
    return P.join('&');
  };
  const parseQ = (req) => {
    const out = {};
    const seg = String((req.url || '').split('?')[1] || '');
    seg.split('&').forEach(pv => { if (!pv) return; const i = pv.indexOf('='); const k = i < 0 ? pv : pv.slice(0, i); out[k] = i < 0 ? '' : decodeURIComponent(pv.slice(i + 1)); });
    return out;
  };
  const saveFilter = (uk, patch) => {
    cfg.filters[fkey(uk)] = Object.assign(filterOf(uk), patch);
    ctx.setPluginConfig(cfg);
    return cfg.filters[fkey(uk)];
  };

  /** Deduplicated channel list (all channels, not just default anymore) */
  const channels = () => {
    const seen = new Map();
    const list = (ctx.gateway && ctx.gateway.instanceChannels) ? ctx.gateway.instanceChannels() : [];
    for (const ch of list) {
      if (ch && ch.name && !seen.has(ch.name)) seen.set(ch.name, ch);
    }
    return [...seen.values()];
  };

  /** Client-visible model names: the models list ∪ modelMap keys (aliases) */
  const namesOf = (ch) => {
    const mm = (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {};
    const set = new Set();
    for (const m of (Array.isArray(ch.models) ? ch.models : [])) if (m) set.add(String(m));
    for (const k of Object.keys(mm)) if (k) set.add(String(k));
    return [...set];
  };

  /** Group name: the first segment of the name (gpt-4o->gpt / claude-...->claude); an alias is itself its group */
  const groupOfName = (name) => {
    const n = String(name || '').trim();
    const first = n.split(/[-_./: ]+/)[0];
    return first || n;
  };

  /* ---------- Custom rules for derived groups, group-rules.txt (2026-09-18 user request) ----------
   * Same style as avatar-overrides.txt: plain text, one rule per line, # comments, takes effect on page refresh (mtime cache, no restart).
   *   `prefix*  = group name`   prefix match (longest wins)
   *   `exact model name = group name` exact match
   *   `mode = override`  makes the rule take **priority over admin config** (default fallback: applies only to "ungrouped" models)
   * An empty value = the line is ignored. A broken line never affects the others; see GET /group-rules for syntax hints. */
  const grCache = { mtime: 0, exact: {}, rules: [], mode: 'fallback', warn: '' };
  const groupRulesOf = () => {
    try {
      const fsx = require('fs');
      const p0 = require('path').join(__dirname, 'group-rules.txt');
      if (!fsx.existsSync(p0)) {
        if (grCache.mtime !== -1) { grCache.mtime = -1; grCache.exact = {}; grCache.rules = []; grCache.mode = 'fallback'; grCache.warn = ''; }
        return grCache;
      }
      const mt = fsx.statSync(p0).mtimeMs;
      if (mt === grCache.mtime) return grCache;
      const exact = {}, rules = [], warns = [];
      let mode = 'fallback';
      for (const line of String(fsx.readFileSync(p0, 'utf8') || '').split(/\r?\n/)) {
        const s0 = line.trim();
        if (!s0 || s0.startsWith('#') || s0.startsWith('//')) continue;
        const i = s0.indexOf('=');
        if (i < 0) { warns.push('缺少 "=": ' + s0.slice(0, 30)); continue; }
        const k = s0.slice(0, i).trim().replace(/^["']|["']$/g, '');
        const v = s0.slice(i + 1).trim().replace(/^["']|["']$/g, '');
        if (!k) continue;
        if (k.toLowerCase() === 'mode') { mode = (v.toLowerCase() === 'override') ? 'override' : 'fallback'; continue; }
        if (!v) continue;                        /* empty value = not participating */
        const kl = k.toLowerCase();
        /* *2026-09-18: supports `prefix*` / `*suffix` / `*contains*` / exact name (same semantics as avatar-overrides.txt) */
        if (kl.startsWith('*') && kl.endsWith('*') && kl.length > 2) rules.push({ kind: 'contains', stem: kl.slice(1, -1), group: v, raw: k });
        else if (kl.endsWith('*') && kl.length > 1) rules.push({ kind: 'prefix', stem: kl.slice(0, -1), group: v, raw: k });
        else if (kl.startsWith('*') && kl.length > 1) rules.push({ kind: 'suffix', stem: kl.slice(1), group: v, raw: k });
        else exact[kl] = v;
      }
      rules.sort((a, b) => b.stem.length - a.stem.length);   /* more specific (longer) first */
      grCache.mtime = mt; grCache.exact = exact; grCache.rules = rules; grCache.mode = mode;
      grCache.warn = warns.join('; ');
      return grCache;
    } catch (e) { grCache.warn = e.message; return grCache; }
  };
  /** A matching custom rule -> group name; no match returns ''
   *  matching semantics (extended 2026-09-18): exact name > `prefix*` / `*suffix` / `*contains*` (longer rules win);
   *  a final **tokenization** layer: if the whole name misses, try `prefix*` per token (x-deepseek-v4-pro -> deepseek* also hits). */
  const groupByRules = (name) => {
    const r = groupRulesOf();
    const n = String(name || '').toLowerCase();
    if (!n) return '';
    if (Object.prototype.hasOwnProperty.call(r.exact, n)) return r.exact[n];
    const hit = (x) => x.kind === 'prefix' ? n.startsWith(x.stem)
      : x.kind === 'suffix' ? n.endsWith(x.stem)
        : n.includes(x.stem);
    for (const x of r.rules) if (hit(x)) return x.group;
    const toks = n.split(/[-_./\s]+/).filter(Boolean);
    if (toks.length > 1) {
      for (const x of r.rules) {
        if (x.kind === 'prefix' && toks.some(t => t.startsWith(x.stem))) return x.group;
      }
    }
    return '';
  };
  /** Which group a model lands in: explicit admin config > custom rules (reversed when mode=override) > built-in prefix inference */
  const groupFor = (inst, ch, n) => {
    const explicit = groupNameOf(inst, ch, n);
    const byRule = groupByRules(n);
    if (byRule && groupRulesOf().mode === 'override') return byRule;
    return explicit || byRule || groupOfName(n);
  };

  /* ---------- lobehub avatar auto-matching (2026-09-13 user request) ----------
   * CDN: the @lobehub/icons-static-png static assets on npmmirror (Alibaba, direct connectivity in mainland China).
   * Prefer the -color variant (theme-agnostic); openai/grok have no color variant, so use the dark/ one (users are on dark themes).
   * No match -> '' -> the App falls back to a first-letter avatar automatically. The App's ImageLoader has an LruCache, so it downloads only once. */
  /* v1.1.3: full icon localization -- the lobehub static-svg package (906 svgs, 4.5MB) is pulled into the plugin's icons/ dir,
   *  served locally through this gateway's /icon?f= route, no external CDN dependency anymore (fast / offline / zero external traffic).
   *  openai/grok have no color SVG (mono renders via currentColor as black) -> use static-png's dark/ PNGs (local). */
  const AVATAR_MAP = [
    [/^agnes/, 'agnesai.svg'],
    [/^(gpt|o\d|chatgpt|dall|openai)/, 'dark-openai.png'],
    [/^nvidia|^nemotron/, 'nvidia-color.svg'],
    [/^claude/, 'claude-color.svg'],
    [/^gemini/, 'gemini-color.svg'],
    [/^gemma/, 'gemma.svg'],
    [/^deepseek/, 'deepseek-color.svg'],
    [/^qwen/, 'qwen-color.svg'],
    [/^grok/, 'dark-grok.png'],
    [/^kimi|^moonshot/, 'kimi-color.svg'],
    [/^doubao/, 'doubao-color.svg'],
    [/^minimax/, 'minimax-color.svg'],
    [/^hunyuan/, 'hunyuan-color.svg'],
    [/^glm|^chatglm/, 'chatglm-color.svg'],
    [/^llama/, 'meta.svg'],
    [/^mistral/, 'mistral.svg'],
    [/^ernie|^wenxin/, 'baidu.svg'],
  ];
  /* ---------- quick no-code fixes (2026-09-13 user request) ----------
   * Place an avatar-overrides.json next to server.js:
   *   { "exact model name": "icon.svg", "prefix*": "icon.svg", "model": "" }
   * value = a file name inside icons/; an empty string = force the letter avatar.
   * Priority: exact name > prefix* (longest first) > built-in mapping. Saved changes take effect on refresh (mtime cache). */
  const ovrCache = { mtime: 0, map: {}, warn: '' };
  /* Lenient parsing: standard JSON first; on failure extract "key": "value" line by line -- a hand-edited file missing one comma/quote must not void everything.
   * Syntax problems are recorded in warn and exposed via /avatar-rules (users can see exactly where they mistyped). */
  const parseOverrides = (txt) => {
    try {
      const o = JSON.parse(txt);
      return { map: (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}, warn: '' };
    } catch (e) {
      const out = {};
      const re = new RegExp('"((?:[^"\\\\]|\\\\.)*)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', 'g');
      let m;
      while ((m = re.exec(txt))) out[m[1]] = m[2];
      return { map: out, warn: 'JSON 语法错误(' + e.message + '), 已按行宽松解析' };
    }
  };

  /* *plain-text format (recommended, hard to get wrong by hand): one `prefix* = icon.svg` per line
   *   lines starting with # = comments; an empty value = force a text avatar; "key": "value" JSON-style lines also work. */
  const parseTxtOverrides = (txt) => {
    const out = {};
    for (const line of String(txt).split(/\r?\n/)) {
      const s0 = line.trim();
      if (!s0 || s0.startsWith('#') || s0.startsWith('//')) continue;
      const i = s0.indexOf('=');
      if (i < 0) continue;
      const k = s0.slice(0, i).trim().replace(/^["']|["']$/g, '').replace(/,$/, '').replace(/:$/, '');
      const v = s0.slice(i + 1).trim().replace(/^["']|["']$/g, '').replace(/,$/, '');
      if (k) out[k] = v;
    }
    return out;
  };
  const overridesOf = () => {
    try {
      const fs = require('fs');
      const fj0 = require('path').join(__dirname, 'avatar-overrides.json');
      const ft0 = require('path').join(__dirname, 'avatar-overrides.txt');
      let mt = 0;
      if (fs.existsSync(fj0)) mt += fs.statSync(fj0).mtimeMs;
      if (fs.existsSync(ft0)) mt += fs.statSync(ft0).mtimeMs;
      if (mt === 0) return {};
      const st = { mtimeMs: mt };
      if (st.mtimeMs !== ovrCache.mtime) {
        ovrCache.mtime = st.mtimeMs;
        const fj = require('path').join(__dirname, 'avatar-overrides.json');
        const ft = require('path').join(__dirname, 'avatar-overrides.txt');
        const merged = {};
        const warns = [];
        if (fs.existsSync(fj)) {
          const r = parseOverrides(fs.readFileSync(fj, 'utf8') || '{}');
          Object.assign(merged, r.map);
          if (r.warn) warns.push(r.warn);
        }
        if (fs.existsSync(ft)) Object.assign(merged, parseTxtOverrides(fs.readFileSync(ft, 'utf8')));
        ovrCache.map = merged;
        ovrCache.warn = warns.join('; ');
      }
      return ovrCache.map || {};
    } catch (_) { return {}; }
  };
  const iconUrl = (file, base) => base + '/plugins/model-square/icon?f=' + encodeURIComponent(file);
  /* *rule line matching (extended 2026-09-18): `prefix*` / `*suffix` / `*contains*` / exact name all supported
   *  Background: built-in rules are "starts with", and a user reported "x-deepseek-v4-pro is not matched by deepseek*" --
   *  vendor words in the middle of a name were always missed by the old logic. Now: (1) override rules can state `*deepseek*` explicitly;
   *  (2) built-in rules gain a **tokenization fallback** (see the end of avatarOf); both apply "only when everything earlier missed". */
  const ruleHit = (ruleKey, name) => {
    const k = String(ruleKey == null ? '' : ruleKey).toLowerCase();
    const n = String(name == null ? '' : name).toLowerCase();
    if (!k || !n) return '';
    if (k === n) return 'exact';
    if (k.startsWith('*') && k.endsWith('*') && k.length > 2) return n.includes(k.slice(1, -1)) ? 'contains' : '';
    if (k.endsWith('*') && k.length > 1) return n.startsWith(k.slice(0, -1)) ? 'prefix' : '';
    if (k.startsWith('*') && k.length > 1) return n.endsWith(k.slice(1)) ? 'suffix' : '';
    return '';
  };
  /** Override-rule matching (tried against each "candidate name"; returns {file} / null) */
  const ovMatch = (cand) => {
    const ov = overridesOf();
    const keys = Object.keys(ov);
    for (const k of keys) if (String(k).toLowerCase() === cand) return { file: ov[k] };   /* exact name */
    let best = null;
    for (const k of keys) {
      if (!ruleHit(k, cand)) continue;
      if (best === null || String(k).length > String(best).length) best = k;             /* more specific wins */
    }
    return best === null ? null : { file: ov[best] };
  };
  const avatarOf = (name, base) => {
    const n = String(name || '').toLowerCase();
    const tail = n.includes('/') ? n.slice(n.lastIndexOf('/') + 1) : '';
    const toks = n.split(/[-_./\s]+/).filter(Boolean);
    /* *candidate-name cascade (reordered 2026-09-18): full name -> after-slash segment -> individual tokens;
     *  each level checks **your override rules** before the built-in table, so `dbrx*` can catch
     *  `databricks/dbrx-instruct` (after the slash); `deepseek*` also catches `x-deepseek-v4-pro` (tokenization).
     *  an empty value = force a text avatar (a hit returns an empty string). */
    const cands = [n, tail, ...toks];
    for (const c of cands) {
      if (!c) continue;
      const r = ovMatch(c);
      if (r) return r.file ? iconUrl(r.file, base) : '';
    }
    for (const c of cands) {
      if (!c) continue;
      for (const [re, file] of AVATAR_MAP) if (re.test(c)) return iconUrl(file, base);
    }
    return '';
  };
  /* view currently effective rules (for troubleshooting) */
  route('GET', '/avatar-rules', (req, res, p) => {
    jsonRes(res, 200, {
      overrides: overridesOf(),
      warning: ovrCache.warn || '',
      builtIn: AVATAR_MAP.map(([re, file]) => [re.source, file]),
    });
  });

  /* Custom rules for derived groups (read-only): view active rules + syntax hints -- backed by group-rules.txt (2026-09-18) */
  route('GET', '/group-rules', (req, res, p) => {
    const r = groupRulesOf();
    jsonRes(res, 200, {
      file: require('path').join(__dirname, 'group-rules.txt'),
      mode: r.mode,
      exact: r.exact,
      rules: r.rules.map(x => x.raw + ' → ' + x.group),
      prefix: r.rules.filter(x => x.kind === 'prefix').map(x => x.raw + ' → ' + x.group),   /* 兼容旧字段名 */
      warning: r.warn || '',
      note: 'fallback(默认): 只作用于"未在管理端配置分组"的模型; override: 规则优先。规则串支持 前缀* / *后缀 / *包含* / 精确名',
    });
  });

  const modelsOf = (ch, instName) => {
    const mm = (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {};
    const groups = Array.isArray(ch.groups) ? ch.groups.map(String) : [];
    return namesOf(ch).map((n) => ({
      name: n,
      /* group: explicit admin config wins, else custom rules / name-prefix inference */
      instance: instName || '',
      group: groupFor(instName, ch.name, n),
      alias: aliasOf(instName, ch.name, n),
      display: aliasOf(instName, ch.name, n) || n,
      price: priceOf(instName, ch.name, n),
      perCall: perCallOf(instName, ch.name, n),
      upstream: mm[n] ? String(mm[n]) : '',
      channel: ch.name,
      type: ch.type || 'openai',
      groups,
    }));
  };

  /** All models (ordered by channel -> model) */
  /* *cross-instance aggregation (user decision 2026-09-12): the model list comes from [all enabled instances],
   *   same-named models merge with their "available instances" recorded -- the user-side model plaza shows everything at a glance, no longer limited to one's own path. */
  const myInst = () => { try { return ctx.getInstanceConfig() || {}; } catch (_) { return {}; } };
  const myInstName = () => myInst().name || 'default';
  const listInstancesSafe = () => {
    try { return (ctx.gateway.listInstances() || []).filter(x => x && x.enabled !== false); }
    catch (_) { return []; }
  };
  const allModels = () => {
    healOrphans();   /* *light self-heal before each render (once per 60s): configs orphaned by channel renames find their way back; details below */
    /* *dedup key = group + name (fixed 2026-09-17)
     *   the dedup key used to be just the model name -> group/price/alias were **first-come-wins**; a later same-named model
     *   merged into the first arrival, its group field never updated -> after the admin moved a same-named model to another group,
     *   that group in the square always showed 0 (user report: "filtering DeepSeek Official shows 0 models":
     *   deepseek-v4-pro was claimed first by default|fake as Default; deepseek-flash was claimed first by
     *   default|kwxxxllm's **alias key** as kwxxxllm, swallowing the DeepSeek instance's real-named model).
     *   now: **one card per (name, group)** (groups are the admin's own taxonomy, often split by source),
     *   same group+name (e.g. MotoMoto's 3 channels) still merge into one card. */
    const seen = new Map();
    const keyOf = (m) => String(m.group || '') + '\u0000' + String(m.name);
    const push = (m, instName) => {
      if (!m || !m.name) return;
      const k = keyOf(m);
      let e = seen.get(k);
      if (!e) {
        e = Object.assign({}, m, { instances: [], channels: [], sources: [] });
        seen.set(k, e);
      }
      if (instName && !e.instances.includes(instName)) e.instances.push(instName);
      if (m.channel && !e.channels.includes(m.channel)) e.channels.push(m.channel);
      if (!e.alias && m.alias) e.alias = m.alias;
      if (!e.price && m.price) e.price = m.price;
      /* *per-source prices (fixed in the same 2026-09-17 batch): after merging, e.price "first arrival wins" mismatches reality
       *  (a fake channel's bogus price masking the official one) -> record each source's price,
       *   the details page lists them one by one; the list card notes "prices differ", so nobody assumes one site-wide price. */
      const sig = JSON.stringify(m.price || null) + '|' + (m.perCall == null ? '' : m.perCall);
      const occ = instName || '';
      if (!e.sources.some(s => s.sig === sig && s.instance === occ && s.channel === (m.channel || ''))) {
        e.sources.push({ instance: occ, channel: m.channel || '', price: m.price || null, perCall: m.perCall == null ? null : m.perCall, sig });
      }
    };
    const self = myInstName();
    for (const ch of channels()) for (const m of modelsOf(ch, self)) push(m, self);
    for (const inst of listInstancesSafe()) {
      if (String(inst.uid) === String(myInst().uid)) continue;
      let ic = null;
      try { ic = ctx.getInstanceConfig(inst.uid); } catch (_) {}
      if (!ic || !Array.isArray(ic.channels)) continue;
      for (const ch of ic.channels) {
        if (!ch || !ch.name) continue;
        /* *reuse modelsOf: other instances count modelMap alias keys too (symmetric with the home instance).
         *  this used to iterate only ch.models -> aliased models vanished from the square (fixed in the same batch, 2026-09-17). */
        for (const m of modelsOf(ch, inst.name)) push(m, inst.name);
      }
    }
    for (const e of seen.values()) {
      e.priceDiff = new Set(e.sources.map(s => s.sig)).size > 1;
    }
    return [...seen.values()];
  };

  /* ---------- Orphaned-config self-heal (2026-09-18 user request) ----------
   * Background: a meta key is `instance|channel|model` -- after a channel is **renamed** every old key stops matching, and all models under that channel
   *  groups/prices/aliases **silently broke** (measured: one catcat->CatCat rename lost 49 config entries, 43 of them priced,
   *  shows up as "name-based groups turn into a mess" and "some channels are missing from the filter list").
   * Approach: when the key's channel no longer exists on that instance (or the channel no longer carries the model), and **exactly one** remaining
   *  channel serves that model name -> migrate the config there automatically (delete the old key, log it); with multiple or zero candidates, **log only, never touch data**
   *  (better to do too little than the wrong thing). Rate: at most once per 60s. See GET /admin/orphans; re-run manually via POST /admin/heal-meta. */
  const healState = { at: 0, last: null };
  const instChannelMaps = () => {
    const all = [];
    const self = myInstName();
    all.push({ name: self, uid: myInst().uid, channels: channels() });
    for (const inst of listInstancesSafe()) {
      if (String(inst.uid) === String(myInst().uid)) continue;
      let ic = null; try { ic = ctx.getInstanceConfig(inst.uid); } catch (_) {}
      all.push({ name: String(inst.name), uid: inst.uid, channels: (ic && ic.channels) || [] });
    }
    return all;
  };
  /** dry=true scans without changing anything (for read-only endpoints) */
  const scanOrphans = (dry) => {
    const out = { total: Object.keys(cfg.modelMeta).length, moved: [], pending: [] };
    const instByName = new Map(instChannelMaps().map(x => [String(x.name), x]));
    for (const k of Object.keys(cfg.modelMeta)) {
      const parts = String(k).split('|');
      if (parts.length < 3) { out.pending.push({ key: k, why: '键格式不对(应为 实例|渠道|模型)' }); continue; }
      const iName = parts[0], cName = parts[1], mName = parts.slice(2).join('|');
      const inst = instByName.get(iName);
      if (!inst) { out.pending.push({ key: k, why: '实例不存在: ' + iName }); continue; }
      const ch = inst.channels.find(c => c && String(c.name) === cName);
      if (ch && namesOf(ch).includes(mName)) continue;                 /* config still valid */
      const uniq = [...new Set(inst.channels.filter(c => c && c.name && namesOf(c).includes(mName)).map(c => String(c.name)))];
      if (uniq.length === 1) {
        const nk = metaKey(iName, uniq[0], mName);
        out.moved.push({ from: k, to: nk });
        if (!dry) {
          if (!cfg.modelMeta[nk]) cfg.modelMeta[nk] = cfg.modelMeta[k];
          delete cfg.modelMeta[k];
        }
      } else {
        out.pending.push({
          key: k,
          why: (ch ? '该渠道已不含此模型' : '渠道已不存在: ' + cName)
            + (uniq.length ? '（候选渠道 ' + uniq.join(' / ') + '，不唯一 → 不自动迁移）' : '（无候选渠道 → 不自动迁移）'),
        });
      }
    }
    return out;
  };
  const healOrphans = () => {
    const now = Date.now();
    if (now - healState.at < 60000) return healState.last;
    healState.at = now;
    try {
      const r = scanOrphans(false);
      if (r.moved.length) {
        saveCfg();
        for (const x of r.moved) ctx.log('[model-square] 孤儿配置自愈: ' + x.from + ' → ' + x.to);
      }
      healState.last = r;
      if (r.moved.length || r.pending.length) {
        ctx.log('[model-square] 孤儿配置扫描: 自动迁移 ' + r.moved.length + ' 条, 待人工处理 ' + r.pending.length + ' 条（GET /admin/orphans）');
      }
      return r;
    } catch (e) {
      ctx.log('[model-square] 孤儿自愈失败: ' + e.message);
      healState.last = null;
      return null;
    }
  };

  /** Whether a model is visible to a user group: an empty channel groups list = all groups may use it */
  const visibleToGroup = (m, g) => !g || !m.groups.length || m.groups.includes(g);

  /* ---------- User groups (reads the "user system" plugin's config) ---------- */
  const userOf = (uk) => {
    if (!uk || !uk.uid) return null;
    try {
      const c = ctx.getPluginConfig('auth-user');
      return ((c && c.users) || []).find(x => x && x.uid === uk.uid) || null;
    } catch (_) { return null; }
  };
  const groupsList = () => {
    try {
      const c = ctx.getPluginConfig('auth-user');
      if (c && Array.isArray(c.groups) && c.groups.length) return c.groups.map(String);
      if (c && c.defaultGroup) return [String(c.defaultGroup)];
    } catch (_) { }
    return ['默认'];   /* 用户体系还没落盘时给个兜底, 保证筛选栏始终可用 */
  };
  const myGroup = (uk) => {
    const u = userOf(uk);
    if (u && u.group) return String(u.group);
    const gs = groupsList();
    return gs.length ? gs[0] : '';
  };

  /* ---------- gcui pages ---------- */
  /* Filter chips: open(GET) instead of intent -- guests can use them too; current filters carry forward in the query */
  const chip = (label, selected, facet, value, view, f) => {
    const o = Object.assign({}, f, { [facet]: value, view: view || 'main' });
    const P = ['view=' + o.view, facet + '=' + encodeURIComponent(o[facet])];
    if (o.q) P.push('q=' + encodeURIComponent(o.q));
    if (o.sort) P.push('sort=' + o.sort);
    P.push('cols=' + (Number(o.cols) === 2 ? 2 : 1));
    ['group', 'provider', 'vendor', 'ugroup'].forEach(k => { if (k !== facet && o[k]) P.push(k + '=' + encodeURIComponent(o[k])); });
    P.push('limit=' + Math.max(1, Number(o.limit) || 150));
    return { type: 'chip', text: label, selected: !!selected, action: { type: 'open', target: 'page:square?' + P.join('&') } };
  };

  /* copy-model-name icon button */
  const copyBtn = (t, name) => ({
    type: 'iconButton', icon: 'msym:copy', container: 'outlined', size: 34,
    desc: t('复制模型名'), action: { type: 'copy', text: name, toast: t('已复制 {0}', name) },
  });

  /* Back-to-list button (detail / filter pages) */
  const backBtn = (t, label) => ({
    type: 'button', text: label || t('返回列表'), style: 'tonal', shape: 'pill',
    /* open (unsigned) instead of intent -- guests can return too; equivalent to intent filter{view:main} */
    /* *nav:'pop' = go back one level and show the list. Otherwise, back from "model details" pushed yet another page,
     *  pressing back again returned to details (one root cause of "back lands on the previous sub-page instead of the square root page" on the App). */
    action: { type: 'open', target: 'page:square', nav: 'pop' },
  });

  /* price display */
  const fmtN = (n) => { const v = Number(n) || 0; return (Math.round(v * 10000) / 10000).toString(); };

  /* *the full call name `instance:channel:model` (2026-09-18 user request)
   *  the kernel side (src/modelref.js) uses this shape only for **name-conflicted** models; pasting it lets clients target a source.
   *  ★Whitespace inside channel/instance names is **uniformly replaced with hyphens** (`DeepSeek Official` -> `DeepSeek-Official`) --
   *    kept in sync with src/modelref.js's tokenize() (plugins cannot require kernel modules, so these 2 lines are copied). */
  const REF_SEP = ':';
  const refTok = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, '-');
  const refOf = (inst, ch, model) => {
    const p = [refTok(inst), refTok(ch), String(model == null ? '' : model)];
    return (p[0] && p[1] && p[2]) ? p.join(REF_SEP) : '';
  };

  const typeTone = (t) => (t === 'claude' ? 'tertiary' : t === 'gemini' ? 'primary' : 'success');

  const buildPage = (uk, view, base, fOverride) => {
    const { t } = mkT(ctx, uk);
    const isFilter = view === 'filter';
    const f = fOverride || filterOf(uk);
    const models = allModels();
    const my = myGroup(uk);
    const ug = f.ugroup;   /* '' = any group */

    /* group chips: admin-defined groups first (fixed order), prefix-inferred ones appended after */
    const declared = groupNames();
    const derived = [...new Set(models.map(m => m.group))].filter(g => !declared.includes(g)).sort();
    const groups = declared.concat(derived);
    /* ★The provider chip spans **all channels** (2026-09-18): one merged card may cross several channels; the old code took only the "first channel"
     *  -> channels like MotoMoto 2 / MotoMoto 3 that "only ever appear as non-first channels" never made it into the filter table. */
    const chansOf = (m) => ((m.channels && m.channels.length) ? m.channels : [m.channel]).filter(Boolean);
    const providers = [...new Set(models.flatMap(m => chansOf(m)))].sort();
    /* *vendor (2026-09-18): auto-derived from model names via group-rules.txt; independent of "group" (admin-configured) and "provider" (channel name) */
    const vendorOf = (m) => groupByRules(m.name);
    const vendors = [...new Set(models.map(m => vendorOf(m)).filter(Boolean))].sort();
    const unmatched = models.filter(m => !vendorOf(m)).length;
    const ugroups = groupsList();

    const match = (m, ff) =>
      (!ff.group || m.group === ff.group) &&
      (!ff.provider || chansOf(m).includes(ff.provider)) &&
      (!ff.vendor || (ff.vendor === '__none__' ? !vendorOf(m) : vendorOf(m) === ff.vendor)) &&
      (!ff.q || ((m.name || '') + ' ' + (m.alias || '') + ' ' + chansOf(m).join(' ') + ' ' + (m.group || '')).toLowerCase().includes(String(ff.q).toLowerCase())) &&
      visibleToGroup(m, ff.ugroup);
    let shown = models.filter(m => match(m, f));
    /* sort: '' default / name / group */
    if (f.sort === 'name') shown = shown.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    else if (f.sort === 'group') shown = shown.slice().sort((a, b) => String(a.group).localeCompare(String(b.group)) || String(a.name).localeCompare(String(b.name)));

    /** visible count after applying the patch (other dimensions keep current filters); gives the chip a number */
    const countFor = (patch) => models.filter(m => match(m, {
      group: patch.group !== undefined ? patch.group : f.group,
      provider: patch.provider !== undefined ? patch.provider : f.provider,
      vendor: patch.vendor !== undefined ? patch.vendor : f.vendor,
      ugroup: patch.ugroup !== undefined ? patch.ugroup : ug,
    })).length;

    const children = [];
    const active = [];
    if (f.group) active.push(t('分组 {0}', f.group));
    if (f.provider) active.push(t('提供商 {0}', f.provider));
    if (f.vendor) active.push(t('厂商 {0}', (f.vendor === '__none__' ? t('未匹配') : f.vendor)));
    if (ug) active.push(t('用户分组 {0}', ug));

    if (isFilter) {
      /* ---------- Filter page (instead of a dialog: the intent returns a full page; the App swaps in place) ---------- */
      children.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: [
          { type: 'row', gap: 12, children: [
            { type: 'column', weight: 1, gap: 4, children: [
              { type: 'text', text: t('筛选'), style: 'title3' },
              { type: 'text', text: t('点选条件立即生效') + (active.length ? t(' · 当前: ') + active.join(' · ') : t(' · 未筛选')), style: 'caption' },
            ] },
            { type: 'iconButton', icon: 'msym:check', container: 'filled', size: 44,
              desc: t('完成，返回模型列表'),
              action: { type: 'open', target: 'page:square?' + qs(f, { view: 'main' }), nav: 'pop' } },
          ] },
        ],
      });

      const section = (title, desc, items) => {
        const cols = [{ type: 'text', text: title, style: 'title4' }];
        if (desc) cols.push({ type: 'text', text: desc, style: 'caption' });
        cols.push({ type: 'hscroll', gap: 8, children: items });
        children.push({ type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 6, children: cols });
      };
      section(t('分组'), '', [
        chip(t('全部 ({0})', countFor({ group: '' })), !f.group, 'group', '', 'filter', f),
        ...groups.map(g => chip(g + ' (' + countFor({ group: g }) + ')', f.group === g, 'group', g, 'filter', f)),
      ]);
      section(t('提供商'), '', [
        chip(t('全部 ({0})', countFor({ provider: '' })), !f.provider, 'provider', '', 'filter', f),
        ...providers.map(pp => chip(pp + ' (' + countFor({ provider: pp }) + ')', f.provider === pp, 'provider', pp, 'filter', f)),
      ]);
      /* *vendor (2026-09-18): auto-derived from group-rules.txt; independent of "group" and "provider" */
      section(t('厂商'), t('按模型名自动推导（group-rules.txt）'), [
        chip(t('全部 ({0})', countFor({ vendor: '' })), !f.vendor, 'vendor', '', 'filter', f),
        ...vendors.map(v => chip(v + ' (' + countFor({ vendor: v }) + ')', f.vendor === v, 'vendor', v, 'filter', f)),
        ...(unmatched ? [chip(t('未匹配 ({0})', unmatched), f.vendor === '__none__', 'vendor', '__none__', 'filter', f)] : []),
      ]);
      if (ugroups.length) {
        section(t('用户分组'), '', [
          chip(t('不限 ({0})', countFor({ ugroup: '' })), !ug, 'ugroup', '', 'filter', f),
          ...ugroups.map(g => chip(g + ' (' + countFor({ ugroup: g }) + ')', ug === g, 'ugroup', g, 'filter', f)),
        ]);
      }

      children.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: [
          { type: 'row', gap: 10, children: [
            { type: 'button', text: t('重置全部条件'), style: 'tonal', shape: 'pill',
              action: { type: 'open', target: 'page:square?view=filter&reset=1' } },
            { type: 'button', text: t('完成'), style: 'filled', shape: 'pill',
              action: { type: 'open', target: 'page:square?' + qs(f, { view: 'main' }), nav: 'pop' } },
          ] },
        ],
      });
    } else {
      /* ---------- Home: slimmer overview + tappable model cards ---------- */
      /* *top card (user-specified style): search box (Enter submits) + one row of [Sort] [View] [Filter] */
      /* *2026-10-08 modeled on the admin design: sort/view went from "cycle-through" to **directly visible chip groups**
       *  (current state visible at a glance + tap straight to the target instead of three taps) -- user report: "buried too deep".
       *  the filter page stays (all 8 dimensions); the main view gains a row of common filter chips (group/provider/vendor) for one-tap access. */
      const sortChips = [
        { v: '', label: t('默认') }, { v: 'name', label: t('名称') }, { v: 'group', label: t('分组') },
      ].map(x => ({ type: 'chip', text: x.label,
        selected: f.sort === x.v,
        action: { type: 'open', target: 'page:square?' + qs(f, { sort: x.v }) } }));
      const viewChips = [
        { v: 1, label: t('列表') }, { v: 2, label: t('网格') },
      ].map(x => ({ type: 'chip', text: x.label,
        selected: Number(f.cols) === x.v,
        action: { type: 'open', target: 'page:square?' + qs(f, { cols: x.v }) } }));
      children.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: [
          { type: 'input', key: 'q', value: f.q || '', leadingIcon: 'msym:search',
            hint: t('搜索模型名 / 厂商…'),
            submit: { type: 'open', target: 'page:square?q={{input.q}}' + (qsCarry(f) ? '&' + qsCarry(f) : '') } },
          { type: 'hscroll', gap: 6, children: [
            { type: 'chip', text: t('排序'), icon: 'msym:sort', desc: t('选择排序方式') },
          ].concat(sortChips) },
          { type: 'hscroll', gap: 6, children: [
            { type: 'chip', text: t('视图'), icon: 'msym:grid', desc: t('选择列表/网格'),
              action: { type: 'open', target: 'page:square?' + qs(f, { view: 'filter' }), nav: 'push' } },
          ].concat(viewChips) },
          { type: 'hscroll', gap: 6, children: [
            { type: 'chip', text: t('筛选') + (active.length ? ' (' + active.length + ')' : ''), icon: 'msym:filter',
              selected: active.length > 0, desc: t('全部筛选维度'),
              /* *the filter page is a sub-view with its own back semantics -> push it (back returns to the model square list, not out of the square) */
              action: { type: 'open', target: 'page:square?' + qs(f, { view: 'filter' }), nav: 'push' } } ]
            .concat([{ type: 'chip', text: t('分组:') + (f.group || t('全部')), selected: !!f.group,
              action: { type: 'open', target: 'page:square?' + qs(f, { view: 'filter' }), nav: 'push' } }]) },
          { type: 'text', text: t('共 {0} 个模型 · 显示 {1} 个', models.length, shown.length)
              + (active.length ? ' · ' + active.join(' · ') : '') + (f.q ? t(' · 搜索「{0}」', f.q) : ''), style: 'caption' },
        ],
      });

      if (!shown.length) {
        children.push({
          type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 8, children: [
            { type: 'text', text: t('没有符合条件的模型'), style: 'body' },
            { type: 'text', text: t('点右上角「筛选」换个条件试试；或在管理端「模型列表」里同步上游模型。'), style: 'caption' },
          ],
        });
      } else {
        /* *batched rendering (2026-09-18 user report "why only 150 models"): default 150, with bottom
         *  "show N more" / "show all" buttons -- no more hiding the rest behind "only the first 150 shown". */
        const lim = Math.max(1, Math.min(100000, Number(f.limit) || 150));
        const twoCol = Number(f.cols) === 2;
        const rows = [];
        for (const m of shown.slice(0, lim)) {
          const insts = m.instances || [];
          /* *channel display (2026-09-18 user request "just show which channel"): one merged card may span several channels,
           *  showing only the first channel suggests everything came from it -> list all (fold into "+N" past 3). */
          const chNames = ((m.channels && m.channels.length) ? m.channels : [m.channel]).filter(Boolean);
          const chTxt = chNames.length > 3
            ? chNames.slice(0, 3).join(' / ') + ' +' + (chNames.length - 3)
            : chNames.join(' / ');
          const meta = m.group + ' · ' + chTxt + (insts.length > 1 ? ' · ' + t('{0} 实例', insts.length) : '')
            + (m.priceDiff ? ' · ' + t('价格不一') : '');
          const title = (m.alias ? (m.alias + ' → ' + m.name) : m.name);
          const avatar = { type: 'avatar', url: avatarOf(m.name, base), text: String(m.name).slice(0, 1).toUpperCase(), size: twoCol ? 22 : 26 };
          /* *narrow cards need maxLines:1 -- long model names would wrap one char per line and blow up the card */
          /* *card quick actions (2026-10-08, modeled on the admin action row): copy the full call name without opening details --
           *  one chip row at the bottom of single-column cards; omitted in the tighter two-column view. */
          const refFast = refOf((m.instances || [])[0] || '', m.channel, m.name);
          const kids = twoCol
            ? [
                { type: 'row', gap: 8, children: [avatar, { type: 'text', text: title, style: 'body', weight: 1, maxLines: 1 }] },
                { type: 'text', text: meta, style: 'caption', maxLines: 1 },
              ]
            : [
                { type: 'row', gap: 10, children: [
                  avatar,
                  { type: 'text', text: title, style: 'body', weight: 1, maxLines: 1 },
                  { type: 'text', text: meta, style: 'caption', maxLines: 1 },
                ] },
                { type: 'hscroll', gap: 6, children: [
                  { type: 'chip', text: t('复制调用名'), icon: 'msym:content_copy',
                    desc: refFast || t('（无可用来源）'),
                    action: { type: 'copy', text: refFast || title, toast: t('调用名已复制') } },
                  { type: 'chip', text: t('详情'), icon: 'msym:info',
                    action: { type: 'open', target: 'page:detail?model=' + encodeURIComponent(m.name) + '&group=' + encodeURIComponent(m.group || '') } },
                ] },
              ];
          rows.push({
            type: 'card', variant: 'outlined', shape: 'large', gap: twoCol ? 4 : 0,
            desc: t('查看 {0} 详情', m.name),
            /* *carry group: same-named models in different groups are two cards; details must be located by "name + group",
             *  otherwise every card opens the same (wrong) details (2026-09-17) */
            action: { type: 'open', target: 'page:detail?model=' + encodeURIComponent(m.name) + '&group=' + encodeURIComponent(m.group || '') },
            children: kids,
          });
        }
        if (Number(f.cols) === 2) {
          /* grid view (two columns) */
          const grid = [];
          for (let i = 0; i < rows.length; i += 2) {
            const pair = [Object.assign({}, rows[i], { weight: 1 })];
            if (rows[i + 1]) pair.push(Object.assign({}, rows[i + 1], { weight: 1 }));
            grid.push({ type: 'row', gap: 6, children: pair });
          }
          children.push({ type: 'column', gap: 6, children: grid });
        } else {
          children.push({ type: 'column', gap: 3, children: rows });
        }
        if (shown.length > lim) {
          /* bottom "load more": +150 each time; plus a "show all at once" option (large lists render slowly in the App; user's choice) */
          const step = 150;
          const next = Math.min(shown.length, lim + step);
          children.push({
            type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 8, children: [
              { type: 'text', text: t('已显示 {0} / {1} 个模型', lim, shown.length), style: 'caption' },
              { type: 'row', gap: 8, children: [
                { type: 'button', text: t('再看 {0} 个', next - lim), style: 'filled', shape: 'pill', weight: 1,
                  action: { type: 'open', target: 'page:square?' + qs(f, { limit: next }) } },
                { type: 'button', text: t('一次显示全部'), style: 'tonal', shape: 'pill', weight: 1,
                  action: { type: 'open', target: 'page:square?' + qs(f, { limit: shown.length }) } },
              ] },
              { type: 'text', text: t('想少看一点就用「筛选」缩小范围'), style: 'caption' },
            ],
          });
        }
      }
    }

    return { gcui: 1, title: isFilter ? t('筛选') : t('模型广场'), root: { type: 'column', gap: 8, children } };
  };

  /* currency symbol (site profile serverInfo.currencySymbol; falls back to the yuan sign when the old kernel has no gateway.serverInfo) */
  const curSym = () => { try { return (ctx.gateway.serverInfo ? ((ctx.gateway.serverInfo().currencySymbol || '') || '元') : '元'); } catch (_) { return '元'; } };

  /* ---------- Model detail page (read-only, opened via GET /ui/detail, guest-accessible) ---------- */
  const buildDetail = (uk, name, base, group) => {
    const { t } = mkT(ctx, uk);
    const models = allModels();
    /* *locate by "name + group" (2026-09-17): same name in different groups = two cards; searching by name alone cross-wires them */
    const m = models.find(x => x.name === name && (!group || String(x.group || '') === String(group)))
      || models.find(x => x.name === name) || null;
    const kids = [];
    if (!m) {
      kids.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', children: [
          { type: 'text', text: t('没有找到模型: {0}', name), style: 'body' },
        ],
      });
    } else {
      const g = cfg.groups.find(x => x.name === m.group) || {};
      const rate = Number(g.rate) || 1;
      const kv = [];
      kv.push({ label: t('模型名'), value: m.name });
      if (m.alias) kv.push({ label: t('对外名称'), value: m.alias });
      if (m.upstream) kv.push({ label: t('上游模型'), value: m.upstream });
      kv.push({ label: t('分组'), value: m.group + (rate !== 1 ? t('（计费倍率 ×{0}）', rate) : '') });
      /* *list **all** channels (2026-09-18): a merged card may span channels; writing only the first misleads */
      const allCh = ((m.channels && m.channels.length) ? m.channels : [m.channel]).filter(Boolean);
      kv.push({ label: t('提供商(渠道)'), value: allCh.join(' / ') || '—' });
      kv.push({ label: t('协议类型'), value: m.type });
      kv.push({ label: t('可用实例'), value: (m.instances || []).join(' / ') || '—' });
      if (m.groups.length) kv.push({ label: t('用户分组限制'), value: t('仅 {0}', m.groups.join(' / ')) });
      /* *price row (2026-09-18): on merged cards spanning channels/instances, m.price is merely the "first arrival's" price --
       *  when sources disagree, the top **no longer shows a single value** (it read as "one site-wide price"); it just points to the list below;
       *  with only one priced source it still displays normally (no information loss). */
      const srcsAll = (m.sources || []).filter(s => s.price || s.perCall != null);
      const multiPrice = m.priceDiff && srcsAll.length > 1;
      if (multiPrice) {
        kv.push({ label: t('价格'), value: t('各来源不一致 —— 逐条见下（{0} / 1M tokens）', curSym()) });
      } else if (m.price) {
        const pp = m.price;
        const sym = curSym();
        kv.push({ label: t('输入价格'), value: fmtN(pp['in']) + ' ' + sym + ' / 1M tokens' });
        kv.push({ label: t('输出价格'), value: fmtN(pp.out) + ' ' + sym + ' / 1M tokens' });
        if (Number(pp.cacheWrite) > 0) kv.push({ label: t('缓存写入'), value: fmtN(pp.cacheWrite) + ' ' + sym + ' / 1M tokens' });
        if (Number(pp.cacheRead) > 0) kv.push({ label: t('缓存读取'), value: fmtN(pp.cacheRead) + ' ' + sym + ' / 1M tokens' });
      } else if (m.perCall == null) {
        kv.push({ label: t('价格'), value: t('（未在管理端配置）') });
      }
      if (m.perCall != null) kv.push({ label: t('按次计费'), value: fmtN(m.perCall) + ' ' + curSym() + t(' / 次') });
      /* *per-source prices (fixed in the same 2026-09-17 batch): after cross-channel same-name+group merging, the rows above are only the "first arrival's" price,
       *  real prices can differ per channel (a fake channel's price masking the official one) -> list each entry clearly, no more misleading.
       *  single compact line (no wrap): "fake 1/1 · SenseNova Router 0.9/2.7"; units live in the labels. */
      const srcs = (m.sources || []).filter(s => s.price || s.perCall != null);
      if (m.priceDiff && srcs.length > 1) {
        const one = (s) => {
          const nm = String(s.channel || '—').slice(0, 20);
          if (s.price) return nm + ' ' + fmtN(s.price['in']) + '/' + fmtN(s.price.out);
          return nm + ' ' + t('未配价');
        };
        kv.push({ label: t('各来源价格（输入/输出 {0}/1M）', curSym()), value: srcs.slice(0, 4).map(one).join(' · ') + (srcs.length > 4 ? ' …' : '') });
      }
      /* *full call name (2026-09-18 user request): on conflicts /v1/models returns `instance:channel:model`,
       *  each source is listed with a copy button -- paste into any AI client to target it exactly, no manual assembly. */
      const refs = ((m.sources && m.sources.length) ? m.sources : [{ instance: (m.instances || [])[0] || '', channel: m.channel }])
        .map(s => refOf(s.instance, s.channel, m.name)).filter(Boolean);
      if (refs.length) {
        kv.push({ label: t('完整调用名'), value: refs.length > 1 ? t('（同名冲突时用它指定来源）') : '' });
        kv.push({ label: '\u200b', value: refs.slice(0, 4).join('   ') });
        if (refs.length > 4) kv.push({ label: '\u200b', value: t('…另有 {0} 个来源', refs.length - 4) });
      }
      kids.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: [
          { type: 'row', gap: 10, children: [
            { type: 'avatar', url: avatarOf(m.name, base), text: String(m.name).slice(0, 1).toUpperCase(), size: 36 },
            { type: 'column', weight: 1, gap: 3, children: [
              { type: 'text', text: (m.alias ? (m.alias + '  →  ' + m.name) : m.name), style: 'title3' },
              { type: 'text', text: (m.instances || []).join(' / ') || m.channel, style: 'caption' },
            ] },
            copyBtn(t, m.name),
          ] },
          { type: 'kv', label: kv[0].label, value: kv[0].value },
          ...kv.slice(1).map(x => ({ type: 'kv', label: x.label, value: x.value })),
        ],
      });
    }
    kids.push({
      type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: [
        { type: 'row', gap: 10, children: [backBtn(t)] },
      ],
    });
    return { gcui: 1, title: t('模型详情'), root: { type: 'column', gap: 12, children: kids } };
  };

  /* ---------- Routing ---------- */
  /* card lookup through the same source as auth-cardkey; only with the uid can we know the user's group */
  const apis = () => ctx.gateway.authApis();
  const ukOf = (p) => {
    /* *prefer the auth chain's result (an admin key can serve as a user key too; see the kernel's params.userKey) */
    if (p && p.userKey) return p.userKey;
    const t = (p && p.token) || '';
    if (!t || !apis().findKey) return null;
    let uk = null;
    try { uk = apis().findKey(null, t); } catch (_) { uk = null; }
    return (uk && uk.enable !== false) ? uk : null;
  };

  const baseOf = (req) => 'http://' + ((req && req.headers && req.headers.host) || '127.0.0.1:16484');

  route('GET', '/ui/square', (req, res, p) => {
    /* guests can filter/sort/switch views too: state rides the query; the server stays stateless (guest choices never persist);
     *  logged-in users persist to cfg.filters so the choice survives. */
    const uk = ukOf(p);
    const qp = parseQ(req);
    const view = qp.view === 'filter' ? 'filter' : 'main';
    let f;
    if (qp.reset) {
      if (uk) saveFilter(uk, allFilter());
      f = allFilter();
    } else {
      const patch = {};
      if ('q' in qp) patch.q = String(qp.q || '').slice(0, 60);
      if ('sort' in qp) patch.sort = ['', 'name', 'group'].includes(qp.sort) ? qp.sort : '';
      if ('cols' in qp) patch.cols = Number(qp.cols) === 2 ? 2 : 1;
      if ('limit' in qp) patch.limit = Math.max(1, Math.min(100000, Number(qp.limit) || 150));
      if ('group' in qp) patch.group = qp.group;
      if ('provider' in qp) patch.provider = qp.provider;
      if ('vendor' in qp) patch.vendor = qp.vendor;
      if ('ugroup' in qp) patch.ugroup = qp.ugroup;
      if (Object.keys(patch).length) {
        f = uk ? saveFilter(uk, patch) : Object.assign({}, filterOf(uk), patch);
      } else {
        f = filterOf(uk);
      }
    }
    const page = buildPage(uk, view, baseOf(req), f);
    if (!uk) {
      const { t } = mkT(ctx, null);   /* guest = default language */
      page.guest = true;
      page.root.children.unshift({ type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 6, children: [
        { type: 'text', text: t('未登录 · 游客浏览'), style: 'title4' },
        { type: 'text', text: t('可以看模型清单、详情, 也能筛选、排序、切换视图。登录后可调用模型、管理卡密。'), style: 'caption' },
      ] });
    }
    jsonRes(res, 200, page);
  });

  /* local icon serving (no auth: icons are public statics; f is strictly whitelisted against path traversal) */
  route('GET', '/icon', (req, res, p) => {
    const q = String((req.url || '').split('?')[1] || '');
    const m = q.match(/(?:^|&)f=([^&]+)/);
    const name = m ? decodeURIComponent(m[1]) : '';
    if (!/^[\w.-]+\.(svg|png)$/.test(name)) return jsonRes(res, 400, { error: 'bad file' });
    try {
      const fs = require('fs');
      const path = require('path');
      const file = path.join(__dirname, 'icons', name);
      if (!fs.existsSync(file)) return jsonRes(res, 404, { error: 'not found' });
      res.writeHead(200, {
        'Content-Type': name.endsWith('.png') ? 'image/png' : 'image/svg+xml',
        'Cache-Control': 'max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(fs.readFileSync(file));
    } catch (e) { return jsonRes(res, 500, { error: e.message }); }
  });

  /* JSON for the web side (structured filter data; the web page renders it itself) */
  route('GET', '/data/square', (req, res, p) => {
    const uk = ukOf(p);
    const models = allModels();
    jsonRes(res, 200, {
      ok: true,
      guest: !uk,
      myGroup: uk ? myGroup(uk) : '',
      groups: [...new Set(models.map(m => m.group))].sort(),
      providers: [...new Set(allModels().map(m => m.channel).filter(Boolean))].sort(),
      ugroups: groupsList(),
      models,
    });
  });

  /* ==================== Admin: groups / model metadata ==================== */

  /* *2026-09-17 "same-name model merging": within one instance, the same model name exposed by multiple channels (incl. modelMap renames)
   *  merged into one card in "quick groups". For aggregate edits/bulk, pass channel='*'; the server expands to every channel under the instance
   *  every channel exposing that model name gets a metaKey (instance|channel|model) written one by one.
   *  Background: cards used to be listed per channel->model, so when several channels exposed the same model (or the same name after a modelMap rename)
   *  it emitted one card per channel, so price/group changes had to be repeated; users called it inconvenient. */
  const uidOfInst = (instName) => {
    if (String(instName) === String(myInstName())) return myInst().uid;
    for (const inst of listInstancesSafe()) if (String(inst.name) === String(instName)) return inst.uid;
    return null;
  };
  const chsOfInst = (instName, uid) => {
    if (uid == null || String(instName) === String(myInstName())) return channels();
    let ic = null; try { ic = ctx.getInstanceConfig(uid); } catch (_) {}
    return (ic && Array.isArray(ic.channels)) ? ic.channels : [];
  };
  /** Which channels on an instance expose a model name (modelMap aliases included) */
  const chNamesExposing = (instName, modelName) => {
    const m = String(modelName);
    return chsOfInst(instName, uidOfInst(instName))
      .filter(ch => ch && ch.name && namesOf(ch).includes(m))
      .map(ch => ch.name);
  };
  /** Merge the per-channel model lists by model name: same-named entries (including modelMap-renamed ones) collapse into one item, recording channel count and divergence flags */
  const mergeModels = (chs) => {
    const map = new Map();
    for (const c of chs) for (const m of (c.models || [])) {
      let e = map.get(m.name);
      if (!e) { e = { name: m.name, group: m.group, alias: m.alias, price: m.price, perCall: m.perCall, channels: [], chCount: 0, diff: false }; map.set(m.name, e); }
      e.channels.push(c.name); e.chCount++;
      if ((m.group || '') !== (e.group || '')) e.diff = true;
      if ((m.alias || '') !== (e.alias || '')) e.diff = true;
      if (m.price) { if (!e.price) e.price = m.price; else if (JSON.stringify(m.price) !== JSON.stringify(e.price)) e.diff = true; }
      if (m.perCall != null) { if (e.perCall == null) e.perCall = m.perCall; else if (m.perCall !== e.perCall) e.diff = true; }
    }
    return [...map.values()];
  };

  /* ---------- Orphaned configs: view / manually rerun the self-heal (2026-09-18) ---------- */
  route('GET', '/admin/orphans', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const r = scanOrphans(true);   /* read-only scan; data untouched */
    jsonRes(res, 200, {
      ok: true,
      total: r.total,
      autoMigratable: r.moved,
      pending: r.pending,
      lastHeal: healState.last ? { moved: (healState.last.moved || []).length, at: healState.at } : null,
      note: 'autoMigratable = 下一次自愈会自动迁移的键; pending = 候选不唯一/无候选, 需人工处理',
    });
  });
  route('POST', '/admin/heal-meta', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    healState.at = 0;                     /* break the 60s throttle; rerun immediately */
    const r = healOrphans();
    jsonRes(res, 200, { ok: true, moved: (r && r.moved) || [], pending: (r && r.pending) || [] });
  });

  /** Model-list data (shared by the "model groups" SDUI page, quick groups, and the /admin/groups endpoint -- one single source of truth)
   *  instances[].merged = merged same-name cards (with channels[] exposed names / chCount / diff);
   *  the current instance's channels[] additionally carry maps/mapSize (modelMap renames, for the channel overview). */
  const groupsData = () => {
    const self = myInstName();
    const insts = [];
    /* current instance */
    insts.push({
      name: self, uid: myInst().uid, current: true,
      channels: channels().map(ch => ({
        name: ch.name, type: ch.type || 'openai',
        mapSize: (ch.modelMap && typeof ch.modelMap === 'object') ? Object.keys(ch.modelMap).length : 0,
        maps: (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {},
        models: modelsOf(ch, self).map(m => ({ name: m.name, group: m.group, alias: m.alias, price: m.price, perCall: m.perCall })),
      })),
      merged: mergeModels(channels().map(ch => ({
        name: ch.name,
        models: modelsOf(ch, self).map(m => ({ name: m.name, group: m.group, alias: m.alias, price: m.price, perCall: m.perCall })),
      }))),
    });
    /* Other instances */
    for (const inst of listInstancesSafe()) {
      if (String(inst.uid) === String(myInst().uid)) continue;
      let ic = null;
      try { ic = ctx.getInstanceConfig(inst.uid); } catch (_) {}
      if (!ic || !Array.isArray(ic.channels)) continue;
      const chs = ic.channels.filter(ch => ch && ch.name).map(ch => ({
        name: ch.name, type: ch.type || 'openai',
        mapSize: (ch.modelMap && typeof ch.modelMap === 'object') ? Object.keys(ch.modelMap).length : 0,
        maps: (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {},
        models: (Array.isArray(ch.models) ? ch.models : []).map(n => ({
          name: n,
          group: groupFor(inst.name, ch.name, n),
          alias: aliasOf(inst.name, ch.name, n),
          price: priceOf(inst.name, ch.name, n),
          perCall: perCallOf(inst.name, ch.name, n),
        })),
      }));
      if (chs.length) insts.push({ name: inst.name, uid: inst.uid, current: false, channels: chs, merged: mergeModels(chs) });
    }
    const counts = {};
    for (const g of cfg.groups) counts[g.name] = 0;
    for (const it of insts) for (const c of it.channels) for (const m of c.models) counts[m.group] = (counts[m.group] || 0) + 1;
    return {
      defaultGroup: DEFAULT_GROUP,
      groups: cfg.groups.map(g => ({ name: g.name, rate: Number(g.rate) || 1 })),
      counts,
      instances: insts,
      channels: insts[0] ? insts[0].channels : [],
    };
  };

  /** Model list (for the "quick groups" page): grouped by channel + each model's current metadata */
  route('GET', '/admin/groups', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    jsonRes(res, 200, Object.assign({ ok: true }, groupsData()));
  });

  /** Group add/remove/edit + single-model / bulk group, name, and price updates */
  route('POST', '/admin/groups', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const j = p.body || {};
    const act = String(j.action || '');
    const ok = () => jsonRes(res, 200, { ok: true, groups: cfg.groups.map(g => ({ name: g.name, rate: Number(g.rate) || 1 })) });

    if (act === 'addGroup') {
      const name = String(j.name || '').trim().slice(0, 32);
      if (!name) return jsonRes(res, 400, { error: '分组名不能为空' });
      if (cfg.groups.some(g => g.name === name)) return jsonRes(res, 409, { error: '分组已存在' });
      cfg.groups.push({ name, rate: Number(j.rate) || 1 });
      saveCfg(); return ok();
    }
    if (act === 'renameGroup') {
      const name = String(j.name || '').trim(), nn = String(j.newName || '').trim().slice(0, 32);
      if (!nn) return jsonRes(res, 400, { error: '新名称不能为空' });
      if (name === DEFAULT_GROUP) return jsonRes(res, 400, { error: 'Default 分组不能改名' });
      if (cfg.groups.some(g => g.name === nn)) return jsonRes(res, 409, { error: '新名称已存在' });
      const g = cfg.groups.find(x => x.name === name); if (!g) return jsonRes(res, 404, { error: '分组不存在' });
      g.name = nn;
      for (const k of Object.keys(cfg.modelMeta)) if (cfg.modelMeta[k].group === name) cfg.modelMeta[k].group = nn;
      saveCfg(); return ok();
    }
    if (act === 'removeGroup') {
      const name = String(j.name || '').trim();
      if (name === DEFAULT_GROUP) return jsonRes(res, 400, { error: 'Default 分组不能删除' });
      const before = cfg.groups.length;
      cfg.groups = cfg.groups.filter(g => g.name !== name);
      if (cfg.groups.length === before) return jsonRes(res, 404, { error: '分组不存在' });
      let moved = 0;
      for (const k of Object.keys(cfg.modelMeta)) if (cfg.modelMeta[k].group === name) { cfg.modelMeta[k].group = DEFAULT_GROUP; moved++; }
      saveCfg(); return jsonRes(res, 200, { ok: true, moved, groups: cfg.groups });
    }
    if (act === 'setGroupRate') {
      const g = cfg.groups.find(x => x.name === String(j.name || ''));
      if (!g) return jsonRes(res, 404, { error: '分组不存在' });
      const r = Number(j.rate);
      if (!(r >= 0)) return jsonRes(res, 400, { error: '倍率无效' });
      g.rate = r; saveCfg(); return ok();
    }
    /** Single model: {channel, model, group?, alias?, price?, perCall?, rules?}
     *  *channel='*' = merged-name editing: expands to every channel under the instance exposing that model name */
    if (act === 'setModel') {
      const ch = String(j.channel || ''), m = String(j.model || '');
      const inst = String(j.instance || myInstName());
      if (!ch || !m) return jsonRes(res, 400, { error: '缺少 channel / model' });
      const chList = ch === '*' ? chNamesExposing(inst, m) : [ch];
      if (!chList.length) return jsonRes(res, 400, { error: '该实例下没有渠道暴露这个模型' });
      let lastKey = '';
      for (const c of chList) {
        const k = metaKey(inst, c, m);
        const cur = cfg.modelMeta[k] || {};
        if (j.group !== undefined) cur.group = String(j.group);
        if (j.alias !== undefined) cur.alias = String(j.alias).slice(0, 96);
        if (j.price !== undefined && j.price !== null) {
          const pr = j.price || {};
          cur.price = {
            in: Number(pr['in']) || 0, out: Number(pr.out) || 0,
            cacheWrite: Number(pr.cacheWrite) || 0, cacheRead: Number(pr.cacheRead) || 0,
          };
        }
        if (j.perCall !== undefined) cur.perCall = (j.perCall === null || j.perCall === '') ? null : Number(j.perCall);
        if (j.rules !== undefined) cur.rules = Array.isArray(j.rules) ? j.rules : [];
        if (!cur.group) cur.group = DEFAULT_GROUP;
        cfg.modelMeta[k] = cur; lastKey = k;
      }
      saveCfg();
      return jsonRes(res, 200, { ok: true, applied: chList, meta: Object.assign({ key: lastKey }, cfg.modelMeta[lastKey]) });
    }
    /** bulk: {items:[{channel,model}], group?, price?, perCall?, alias?} */
    if (act === 'bulk') {
      const items = Array.isArray(j.items) ? j.items : [];
      if (!items.length) return jsonRes(res, 400, { error: '没有选中模型' });
      let n = 0;
      for (const raw of items) {
        /* *SDUI page multi-select is a checkbox set ({{selected}} expands to a string array at render time) ->
         *  accepts both "instance|channel|model" strings and {instance,channel,model} objects.
         *  (model names may contain '|' -> split on the first two separators only; the rest is the model name, matching the App's native page) */
        const it = (typeof raw === 'string')
          ? (function () { const a = String(raw).split('|'); return { instance: a[0], channel: a[1], model: a.slice(2).join('|') }; })()
          : raw;
        const ch = String((it && it.channel) || ''), m = String((it && it.model) || '');
        const inst = String((it && it.instance) || j.instance || myInstName());
        if (!ch || !m) continue;
        /* *channel='*' = merged-name bulk: expands to every channel of the instance exposing that model name */
        const chList = ch === '*' ? chNamesExposing(inst, m) : [ch];
        for (const c of chList) {
          const k = metaKey(inst, c, m);
          const cur = cfg.modelMeta[k] || {};
          if (j.group !== undefined) cur.group = String(j.group);
          if (j.alias !== undefined) cur.alias = String(j.alias).slice(0, 96);
          if (j.price !== undefined && j.price !== null) {
            const pr = j.price || {};
            cur.price = {
              in: Number(pr['in']) || 0, out: Number(pr.out) || 0,
              cacheWrite: Number(pr.cacheWrite) || 0, cacheRead: Number(pr.cacheRead) || 0,
            };
          }
          if (j.perCall !== undefined) cur.perCall = (j.perCall === null || j.perCall === '') ? null : Number(j.perCall);
          if (j.rules !== undefined) cur.rules = Array.isArray(j.rules) ? j.rules : [];
          if (!cur.group) cur.group = DEFAULT_GROUP;
          cfg.modelMeta[k] = cur; n++;
        }
      }
      saveCfg();
      return jsonRes(res, 200, { ok: true, updated: n });
    }
    /* *2026-09-17 the App model-edit page's "add rule" (shares the rule format/storage with the web rule editor; interops naturally).
     *  assemble "trigger type+op+value" and "effect type+value" into the billing engine's when/then and append to the model's rules.
     *  with channel='*' it expands to every channel of the instance exposing that name. */
    if (act === 'addRule') {
      const ch = String(j.channel || ''), m = String(j.model || '');
      const inst = String(j.instance || myInstName());
      if (!m) return jsonRes(res, 400, { error: '缺少 model' });
      const chList = ch === '*' ? chNamesExposing(inst, m) : [ch];
      if (!chList.length) return jsonRes(res, 400, { error: '该实例下没有渠道暴露这个模型' });
      const trig = String(j.trig || 'none'), op = String(j.op || 'eq');
      const val = j.v == null ? '' : String(j.v);
      const eff = String(j.eff || 'mult'), effVal = String(j.effVal == null ? '' : j.effVal);
      /* assembling the trigger condition */
      const when = [];
      const trigK = { model: 'model', ugroup: 'ugroup', hour: 'hour', weekday: 'weekday', ctxLen: 'ctxLen' }[trig];
      if (trig === 'expr') when.push({ k: 'expr', op: 'eq', v: val });
      else if (trig !== 'none' && trigK) {
        let v = val;
        if (op === 'in' || op === 'nin') v = val.split(',').map(s => s.trim()).filter(Boolean);
        else if (op === 'between') v = val.split(',').map(s => Number(s.trim()) || 0).slice(0, 2);
        when.push({ k: trigK, op, v });
      }
      /* assembling the effect */
      const then = [];
      if (eff === 'free') then.push({ k: 'free' });
      else if (eff === 'mult') then.push({ k: 'mult', v: Number(effVal) || 0 });
      else if (eff === 'perCall') then.push({ k: 'perCall', v: Number(effVal) || 0 });
      else if (eff === 'priceIn') then.push({ k: 'price', field: 'input', mode: 'set', v: Number(effVal) || 0 });
      else if (eff === 'priceOut') then.push({ k: 'price', field: 'output', mode: 'set', v: Number(effVal) || 0 });
      else if (eff === 'priceCR') then.push({ k: 'price', field: 'cacheRead', mode: 'set', v: Number(effVal) || 0 });
      if (!then.length) return jsonRes(res, 400, { error: '效果类型无效' });
      const rule = { note: String(j.note || '').slice(0, 80), on: true, when, then };
      for (const c of chList) {
        const k = metaKey(inst, c, m);
        const cur = cfg.modelMeta[k] || {};
        if (!Array.isArray(cur.rules)) cur.rules = [];
        cur.rules.push(rule);
        if (!cur.group) cur.group = DEFAULT_GROUP;
        cfg.modelMeta[k] = cur;
      }
      saveCfg();
      return jsonRes(res, 200, { ok: true, added: chList.length });
    }
    return jsonRes(res, 400, { error: '未知操作: ' + act });
  });

  route('POST', '/intent/square/filter', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(ctx, null).t('需要登录') };
    const b = p.body || {};
    if (b.reset) {
      cfg.filters[fkey(uk)] = allFilter();
      ctx.setPluginConfig(cfg);
    } else {
      const facet = String(b.facet || '');
      if (facet) {
        if (!['group', 'provider', 'ugroup'].includes(facet)) return { ok: false, error: '未知筛选项: ' + facet };
        saveFilter(uk, { [facet]: String(b.value == null ? '' : b.value) });
      }
      /* search term / sort / view column count (top card) */
      if (b.q !== undefined) saveFilter(uk, { q: String(b.q == null ? '' : b.q).slice(0, 60) });
      if (b.sort !== undefined) saveFilter(uk, { sort: ['', 'name', 'group'].includes(String(b.sort)) ? String(b.sort) : '' });
      if (b.cols !== undefined) saveFilter(uk, { cols: Number(b.cols) === 2 ? 2 : 1 });
      /* no facet = switch view only, filters untouched */
    }
    const view = String(b.view || 'main') === 'filter' ? 'filter' : 'main';
    /* same-page in-place refresh (view/sort/search/clear filter) -> never pushes */
    return { ok: true, nav: 'replace', ui: buildPage(uk, view, baseOf(req)) };
  }));

  /* model details (tapping a model card -> a read-only detail page: price/group/multiplier/available instances) */
  /* the GET variant of model details: guests can view it too (read-only metadata, no signature/login; the App's open page:detail?model=xxx lands here) */
  route('GET', '/ui/detail', (req, res, p) => {
    const q = String((req.url || '').split('?')[1] || '');
    const mm = q.match(/(?:^|&)model=([^&]+)/);
    const name = mm ? decodeURIComponent(mm[1]) : '';
    /* *group: same name, different groups = two cards -> details locate by "name + group" (2026-09-17; old links without group still work) */
    const mg = q.match(/(?:^|&)group=([^&]+)/);
    const group = mg ? decodeURIComponent(mg[1]) : '';
    if (!name) return jsonRes(res, 400, { error: '需要 model 参数' });
    const uk = ukOf(p);
    jsonRes(res, 200, buildDetail(uk, name, baseOf(req), group));
  });

  /* the structured-JSON variant of model details (for the web; guest-accessible, read-only metadata; data/ is on the zero-quota whitelist) */
  route('GET', '/data/detail', (req, res, p) => {
    const q = String((req.url || '').split('?')[1] || '');
    const mm = q.match(/(?:^|&)model=([^&]+)/);
    const name = mm ? decodeURIComponent(mm[1]) : '';
    const mg = q.match(/(?:^|&)group=([^&]+)/);
    const group = mg ? decodeURIComponent(mg[1]) : '';
    if (!name) return jsonRes(res, 400, { ok: false, error: '需要 model 参数' });
    const models = allModels();
    const m = models.find(x => x.name === name && (!group || String(x.group || '') === String(group)))
      || models.find(x => x.name === name) || null;
    if (!m) return jsonRes(res, 404, { ok: false, error: '没有找到模型: ' + name });
    const g = cfg.groups.find(x => x.name === m.group) || {};
    const rate = Number(g.rate) || 1;
    jsonRes(res, 200, {
      ok: true,
      model: {
        name: m.name, alias: m.alias || '', upstream: m.upstream || '',
        group: m.group, groupRate: rate, channel: m.channel,
        channels: m.channels || [], type: m.type || '', instances: m.instances || [],
        userGroups: m.groups || [], price: m.price || null,
        perCall: m.perCall == null ? null : m.perCall,
        /* *2026-09-17: same name+group may span channels (differing prices) -> return every source; the web UI can present them */
        priceDiff: !!m.priceDiff,
        sources: (m.sources || []).map(s => ({ instance: s.instance, channel: s.channel, price: s.price, perCall: s.perCall })),
        /* *full call name (instance:channel:model) -- what /v1/models exposes on name conflicts (2026-09-18) */
        refs: ((m.sources && m.sources.length) ? m.sources : [{ instance: (m.instances || [])[0] || '', channel: m.channel }])
          .map(s => refOf(s.instance, s.channel, m.name)).filter(Boolean),
        avatarUrl: avatarOf(m.name, baseOf(req)),
      },
    });
  });

  route('POST', '/intent/square/detail', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(ctx, null).t('需要登录') };
    const b = p.body || {};
    /* model details = a real sub-page (pushed); read-only -> may re-run on refresh */
    return { ok: true, nav: 'push', ui: buildDetail(uk, String(b.model || ''), baseOf(req), String(b.group || '')), refresh: 'intent' };
  }));

/** the model-edit SDUI page (registered via model-square's registerAdminUi; a menu:false sub-page)
   * tapping a model card in "quick groups" -> the App opens /admin/ui/model-edit?instance=...&channel=...&model=...
   * returns gcui JSON: a form (alias/group/per-call/price) + the rule list + save/close buttons
   * *design decisions:
 *   - The per-call billing switch is gone -- an empty perCall field = pay-per-token; a number = pay-per-call (the server maps empty strings to null)
 *   - Groups use a text input (existing group names are listed as hints) -- chip selection needs state+setState wiring, too heavy inside a dialog
 *   - ★2026-09-17 rules can be added directly on this page (segmented tab style + a submit button reading {{input.xxx}}),
 *     same when/then format as the web rule editor, same storage (model-square meta.rules), so they interoperate naturally;
 *     deletion writes the filtered rules array back through setModel. With channel='*' it fans out to all same-named channels.
 *   - Saving submits only form fields, never rules (setModel updates only provided fields -> rules survive)
 */
  ctx.registerAdminUi({
    id: 'model-edit',
    title: '编辑模型',
    icon: 'edit',
    menu: false,
    render: (gw, c, q, caps) => { refreshCfg();   /* *multi-instance consistency: see the refreshCfg comment at the top */
      /* model-square lacks the global txt/gap/btn helpers (only billing has them); defined locally here */
      const txt = (text, style, color) => { const o = { type: 'text', text }; if (style) o.style = style; if (color) o.color = color; return o; };
      /* *capability-aware degradation (2026-10-07): caps are injected by the kernel (the 4th render arg of registerAdminUi).
       *  segmented joined gcui late -- older Apps render it as a red error block.
       *  before **generating the page**, ask "does this App know segmented"; if not, substitute an input
       *  (input existed in gcui v1, so every App knows it). Without caps (web) -> use segmented (unchanged).
       *  note: the kernel outlet still has a fallback negotiation (admin-ui's negotiate); this is just an earlier, more graceful degradation. */
      const canSeg = !caps || caps.hasComponent('segmented');
      const seg = (o) => {
        if (canSeg) return o;
        const opts = (o.options || []).map(x => x.text + '=' + x.value).join(' / ');
        return {
          type: 'input', key: o.key, label: '（此 App 不支持标签选择，请填值：' + opts + '）',
          value: '', action: o.action,
        };
      };
      const gap = (h) => ({ type: 'spacer', height: h || 8 });
      const btn = (text, style, action) => Object.assign({ type: 'button', text, style: style, action: action }, {});
      const inst = String((q && q.get) ? q.get('instance') : '') || myInstName();
      const chName = String((q && q.get) ? q.get('channel') : '');
      const modelName = String((q && q.get) ? q.get('model') : '');
      const groups = cfg.groups.map(g => g.name);
      const sym = curSym();
      const call = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call', body: { plugin: 'model-square', path: '/admin/groups', method: 'POST', body: body } });

      /* *2026-09-17 channel='*' = merged-name editing: aggregates the meta of every channel under this instance exposing that name
       *  (first non-empty wins; a diff warning marks disagreement). Save/add-rule/delete-rule all pass channel:'*',
       *  the server's setModel/addRule expand to every channel. Background: cards used to be per channel, so the same model (incl. modelMap
       *  renames) producing one card each; changing price/group meant repeating the edit. */
      const merged = chName === '*';
      const variantMetas = merged ? chNamesExposing(inst, modelName).map(ch => metaOf(inst, ch, modelName) || {}).filter(m => m && Object.keys(m).length) : [];
      const meta = merged
        ? variantMetas.reduce((a, m) => {
            if (!a) return Object.assign({}, m);
            if (!a.group && m.group) a.group = m.group;
            if (!a.alias && m.alias) a.alias = m.alias;
            if (!a.price && m.price) a.price = m.price;
            if (a.perCall == null && m.perCall != null) a.perCall = m.perCall;
            if (!Array.isArray(a.rules) && Array.isArray(m.rules)) a.rules = m.rules;
            return a;
          }, null) || { group: DEFAULT_GROUP }
        : (metaOf(inst, chName, modelName) || { group: DEFAULT_GROUP });
      const diff = merged && variantMetas.length > 1 && variantMetas.some(m =>
        (m.group || '') !== (meta.group || '') || (m.alias || '') !== (meta.alias || '') ||
        JSON.stringify(m.price || {}) !== JSON.stringify(meta.price || {}) ||
        (m.perCall == null ? null : m.perCall) !== (meta.perCall == null ? null : meta.perCall));
      const price = meta.price || {};
      const rules = Array.isArray(meta.rules) ? meta.rules : [];
      const chLabel = merged ? (variantMetas.length + ' 个渠道') : chName;

      const kids = [
        txt(meta.alias || modelName, 'title3'),
        txt(inst + ' · ' + chLabel + '  /  ' + modelName, 'caption', '$onSurfaceVariant'),
      ];
      if (merged && diff) kids.push(txt('⚠ 各渠道配置不一致，保存将统一覆盖到全部 ' + variantMetas.length + ' 个渠道。', 'caption', '$error'));
      kids.push(gap(8),
        {
          type: 'form', submitText: '保存', submitShape: 'large',
          fields: [
            { type: 'input', key: 'alias', label: '对外名称（留空 = 用原名）', value: meta.alias || '' },
            { type: 'input', key: 'group', label: '分组（可选: ' + groups.join(', ') + '）', value: meta.group || DEFAULT_GROUP },
            { type: 'input', key: 'perCall', label: '按次价格（' + sym + '/次，留空 = 按量计费）', inputType: 'number', value: meta.perCall != null ? String(meta.perCall) : '' },
            { type: 'input', key: 'priceIn', label: '输入（' + sym + ' / 1M tokens）', inputType: 'number', value: String(price['in'] || 0) },
            { type: 'input', key: 'priceOut', label: '输出（' + sym + ' / 1M tokens）', inputType: 'number', value: String(price.out || 0) },
            { type: 'input', key: 'priceCW', label: '缓存写入（' + sym + ' / 1M tokens）', inputType: 'number', value: String(price.cacheWrite || 0) },
            { type: 'input', key: 'priceCR', label: '缓存读取（' + sym + ' / 1M tokens）', inputType: 'number', value: String(price.cacheRead || 0) },
          ],
          submit: Object.assign(call({
            action: 'setModel', instance: inst, channel: chName, model: modelName,
            group: '{{form.group}}', alias: '{{form.alias}}', perCall: '{{form.perCall}}',
            price: { in: '{{form.priceIn}}', out: '{{form.priceOut}}', cacheWrite: '{{form.priceCW}}', cacheRead: '{{form.priceCR}}' },
          }), { then: 'close' }),
        },
        txt('两种计费方式二选一：填了「按次价格」就按次收，否则按 token 单价；都填 0 = 免费。', 'caption', '$onSurfaceVariant'),
        gap(12),
        txt('计费规则（该模型专属，会覆盖全局规则）', 'title3'),
      );

      if (!rules.length) {
        kids.push(txt('没有模型级规则。上面的价格字段已经决定基础扣费。点下面「添加规则」可以直接在这里加。', 'caption', '$onSurfaceVariant'));
      } else {
        for (let i = 0; i < rules.length; i++) {
          const r = rules[i];
          const wTxt = (r.when || []).map(c => c.k + ' ' + (c.op || 'eq') + ' ' + (Array.isArray(c.v) ? c.v.join(',') : c.v)).join(' 且 ') || '无条件';
          const tTxt = (r.then || []).map(e => e.k + (e.k === 'price' ? '(' + (e.field || 'all') + ',' + (e.mode || 'set') + '):' + e.v : ':' + e.v)).join('，');
          kids.push({
            type: 'card', variant: 'outlined', gap: 6, children: [
              txt((r.note || ('规则 ' + (i + 1))) + (r.on === false ? '（已停用）' : ''), 'body'),
              txt('触发: ' + wTxt, 'caption', '$onSurfaceVariant'),
              txt('效果: ' + tTxt, 'caption', '$onSurfaceVariant'),
              btn('删除规则', 'text', call({ action: 'setModel', instance: inst, channel: chName, model: modelName, rules: rules.filter((_, j) => j !== i) })),
            ],
          });
        }
      }

      /* *2026-09-17 added a rule editor (state-driven; shares the when/then format and storage with the web rule editor, so they interop naturally).
       *  segmented with key -> the selected value writes to inputs live; input with key -> a TextWatcher writes inputs live;
       *  submit buttons read the current selection/input straight via {{input.xxx}}; after submit, then:'reload' (default) refreshes the page. */
      kids.push(gap(8));
      kids.push(btn('添加规则', 'tonal', { type: 'setState', patch: { draft: '1' } }));
      kids.push({
        type: 'card', variant: 'outlined', gap: 8, visible: '{{state.draft}}', children: [
          txt('新建模型级规则', 'title3'),
          txt('触发条件（全部满足才生效；选「无条件」= 对所有请求生效）', 'caption', '$onSurfaceVariant'),
          seg({ type: 'segmented', key: 'trig', selected: '{{state.trig}}', options: [
            { value: 'none', text: '无条件' }, { value: 'model', text: '模型' }, { value: 'ugroup', text: '用户组' },
            { value: 'hour', text: '时段' }, { value: 'weekday', text: '星期' }, { value: 'ctxLen', text: '上下文' }, { value: 'expr', text: '表达式' },
          ], action: { type: 'setState', patch: { trig: '{{input._value}}' } } }),
          seg({ type: 'segmented', key: 'op', selected: '{{state.op}}', options: [
            { value: 'eq', text: '=' }, { value: 'ne', text: '≠' }, { value: 'gt', text: '>' }, { value: 'gte', text: '≥' },
            { value: 'lt', text: '<' }, { value: 'lte', text: '≤' }, { value: 'in', text: '属于' }, { value: 'between', text: '介于' },
          ], action: { type: 'setState', patch: { op: '{{input._value}}' } } }),
          { type: 'input', key: 'val', label: '触发值（属于/介于用逗号分隔；表达式如 hour>=22 && ctxLen>8000）', value: '' },
          txt('触发效果（按顺序叠加）', 'caption', '$onSurfaceVariant'),
          seg({ type: 'segmented', key: 'eff', selected: '{{state.eff}}', options: [
            { value: 'mult', text: '整体倍率' }, { value: 'priceIn', text: '输入特价' }, { value: 'priceOut', text: '输出特价' },
            { value: 'priceCR', text: '缓存读特价' }, { value: 'perCall', text: '按次价' }, { value: 'free', text: '免费' },
          ], action: { type: 'setState', patch: { eff: '{{input._value}}' } } }),
          { type: 'input', key: 'effVal', label: '效果值（倍率 0.5 / 特价 2 / 按次 0.01；免费不用填）', inputType: 'number', value: '' },
          { type: 'input', key: 'note', label: '备注（可选）', value: '' },
          btn('添加这条规则', 'filled', Object.assign(call({
            action: 'addRule', instance: inst, channel: chName, model: modelName,
            trig: '{{input.trig}}', op: '{{input.op}}', v: '{{input.val}}', eff: '{{input.eff}}', effVal: '{{input.effVal}}', note: '{{input.note}}',
          }), { then: 'reload' })),
          btn('取消', 'text', { type: 'setState', patch: { draft: '' } }),
        ],
      });

      kids.push(gap(8));
      kids.push(btn('关闭', 'text', { type: 'close' }));

      return { title: '编辑模型', state: {}, root: { type: 'column', gap: 10, children: kids } };
    },
  });


  /* ==================== the "Model groups" page (server-side SDUI, 2026-09-19) ====================
   * Background: this page used to exist only as a native App implementation (AdminPages.buildModels + the "quick groups" sub-page),
   *      every UI change meant rebuilding the APK. This plugin now registers id='models' (matching the App-side menu id)
   *      -> the App admin page table's "Model groups" points at /admin/ui/models; UI edits touch only here (hot reload).
   * ★Fallback safety net (triple on the App side, the native implementation kept line-for-line):
   *   (1) the settings master switch "admin uses server-side UI" off -> immediately all-native (no network/restart needed);
   *   (2) this page failing to load/render/timeout -> the App switches back to the native page with a notice (no retry for 5 minutes);
   *   (3) the "Model groups" page's top-right "Quick groups" button is still the native page (long-press multi-select / bottom action bar / group management).
   * ★Why filtering runs server-side: SDUI templates (Template.resolve) support only {{path}} lookups + truthiness checks,
   *   no comparison operators, so item.channel == state.ch cannot be expressed -- hence a chip tap = open the same page with a query
   *   (nav:'replace' swaps pages in place, no push), re-rendering after server-side filtering. Cost: one request + one redraw per filter change.
   * ★Multi-select: the checkbox component ships with a selection set ({{selected}} / {{selectedCount}}). A checkbox itself carries no action
   *   -> triggers an in-place re-render (the count and the bulk action's items rebind). Selection survives filter changes.
   *   bulk actions' items use {{selected}}: the template resolves into a JSON array from the render scope **at render time**
   *   (Template.bindJson expands the whole template into an array) -> the server's bulk path must accept "instance|channel|model" strings too.
   * ★Page JSON size: at most MODELS_PAGE_LIMIT cards render per page (193 models at once is too large); narrow the rest with filters.
   */
  const MODELS_PAGE_LIMIT = 40;      /* ★Default cards per page: each card is ~8 native Views, and full-page rebuild latency during filtering
                                      *   is dominated by this (60 cards ~ 500 Views still make users wait half a second).
                                      *   Default 40; tap "show more" when it is not enough (limit += 40). */
  const MODELS_LIMIT_STEP = 40;
  const MODELS_LIMIT_MAX = 2000;   /* Backstop for "show all" (true "all" is decided by all=1, not by the tier limit) */

  /** Price shape: per-call / priced / unpriced (matches the badge semantics on the App's native quick-group cards) */
  const priceKindOf = (m) => (m && m.perCall != null) ? 'percall'
    : ((m && m.price && typeof m.price === 'object') ? 'has' : 'none');

  const buildModelsPage = (q, caps) => {
    refreshCfg();
    const get = (k) => { try { return (q && q.get) ? String(q.get(k) || '') : ''; } catch (_) { return ''; } };
    const enc = encodeURIComponent;
    const fInst = get('inst'), fCh = get('ch'), fPrice = get('price'), fGrp = get('grp');
    const kw = get('kw').trim(), kwl = kw.toLowerCase();
    const cols = Math.min(4, Math.max(2, Number(get('cols')) || 2));
    /* limit: how many cards render per page (smaller = faster). Filter chips' jump() deliberately **omits limit** -- changing a filter returns to the default,
     * avoiding "tapped show-more a few times, then every filter re-rendered 300 cards". */
    /* ★all=1 = the "show all" state: render everything at once (and **filters still apply** -- the user's jump() carries all,
     *   otherwise "show all -> change filter -> back to 40" would have users tapping endlessly). */
    const showAll = get('all') === '1';
    const lim = showAll ? MODELS_LIMIT_MAX
      : Math.min(MODELS_LIMIT_MAX, Math.max(1, Number(get('limit')) || MODELS_PAGE_LIMIT));
    const d = groupsData();
    const insts = Array.isArray(d.instances) ? d.instances : [];
    const self = myInstName();
    const sym = curSym();

    /* ---- gcui assembly helpers ---- */
    const txt = (text, style, color) => { const o = { type: 'text', text: text }; if (style) o.style = style; if (color) o.color = color; return o; };
    const gap = (h) => ({ type: 'spacer', height: h || 8 });
    const btn = (text, style, action) => { const o = { type: 'button', text: text, style: style }; if (action) o.action = action; return o; };
    const chip = (text, on, action) => { const o = { type: 'chip', text: text, selected: !!on }; if (action) o.action = action; return o; };
    const badge = (text, tone) => ({ type: 'badge', text: text, tone: tone });
    /* in-page writes uniformly go through kernel proxy calls: the SDUI adminApi whitelist covers /admin/*, while plugin endpoints sit at /plugins/<id>/admin/* */
    const call = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
      body: { plugin: 'model-square', path: '/admin/groups', method: 'POST', body: body } });
    const syncCall = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
      body: { plugin: 'model-sync', path: '/admin/run', method: 'POST', body: body } });

    /* ---- Options ---- */
    const instOpts = [], chOpts = [];
    const grpOpts = (d.groups || []).map(g => g.name);
    for (const it of insts) {
      instOpts.push(it.name);
      for (const ch of (it.channels || [])) if (ch.name && chOpts.indexOf(ch.name) < 0) chOpts.push(ch.name);
    }

    /* ---- same-page navigation (filter chips / search submits both use it; cols also rides the URL, avoiding two sources of truth) ---- */
    const mkUrl = (pairs) => {
      const keep = [];
      for (const pair of pairs) {
        const k = pair[0], v = pair[1];
        if (v === undefined || v === null || String(v) === '') continue;
        const s = String(v);
        /* {{...}} placeholders must not be encoded (the App resolves them at tap time with the live input values) */
        keep.push(k + '=' + (s.indexOf('{{') === 0 ? s : enc(s)));
      }
      return '/admin/ui/models' + (keep.length ? ('?' + keep.join('&')) : '');
    };
    const jump = (over) => {
      const m = { inst: fInst, ch: fCh, price: fPrice, grp: fGrp, kw: kw, cols: String(cols), all: showAll ? '1' : '' };
      Object.keys(over || {}).forEach(k => { m[k] = over[k]; });
      return { type: 'open', nav: 'replace',
        target: 'page:' + mkUrl([['inst', m.inst], ['ch', m.ch], ['price', m.price], ['grp', m.grp], ['kw', m.kw], ['cols', m.cols], ['all', m.all]]) };
    };
    /* "show more": keeps current filters and just raises limit one notch */
    const moreUrl = 'page:' + mkUrl([['inst', fInst], ['ch', fCh], ['price', fPrice], ['grp', fGrp], ['kw', kw],
      ['cols', String(cols)], ['limit', String(Math.min(MODELS_LIMIT_MAX, lim + MODELS_LIMIT_STEP))]]);
    const openPage = (path) => ({ type: 'open', target: 'page:' + path, nav: 'push' });

    /* ★Kit (2.70): dual-mode components moved into the core's ctx.gcui -- a plugin only declares "what to filter"
     *  (state key/URL key/row machine field/operator/current value); caps probing and the setState/open branches are all in the kernel.
     *  field is the row machine field (data semantics belong to the plugin); a new plugin wanting local filtering = one line declaring a dimension. */
    const D_INST = { key: 'fInst', url: 'inst', field: 'inst', op: 'eq', cur: fInst };
    const D_CH = { key: 'fCh', url: 'ch', field: 'chs', op: 'has', cur: fCh };
    const D_PRICE = { key: 'fPrice', url: 'price', field: 'kinds', op: 'has', cur: fPrice };
    const D_GRP = { key: 'fGrp', url: 'grp', field: 'groups', op: 'has', cur: fGrp };
    const D_KW = { key: 'fKw', url: 'kw', field: 'hay', op: 'contains', cur: kw };
    const D_COLS = { key: 'cols', url: 'cols', cur: String(cols) };
    const F = ctx.gcui.filters(caps, [D_INST, D_CH, D_PRICE, D_GRP, D_KW], jump);

    /* ---- filtering: merged same-name cards (same convention as the native "quick groups") ---- */
    let totalMerged = 0, totalModels = 0, totalCh = 0;
    for (const it of insts) {
      totalMerged += (it.merged || []).length;
      for (const ch of (it.channels || [])) { totalCh++; totalModels += (ch.models || []).length; }
    }
    /* a per-channel shape index of same-named models (alias fallback + group/price kinds)
     * *2026-09-19 user asked "what if deepseek-v4.1-flash exists under both kwxxxllm and CatCat" -> two improvements:
     *   (1) a specific channel is filtered -> cards render from **that channel's own config** (open/bulk touches only it, no more first-come-wins);
     *   (2) no channel filter (merged same-name card) -> the filter becomes "any channel hit counts" (union); differing values display side by side.
* without touching the shared mergeModels(), fallbacks live only on this page -- keeping native pages and the /admin/groups endpoint unaffected. */
    const aliasIdx = {}, variantIdx = {};
    for (const it of insts) {
      const am = {}, vm = {};
      for (const ch of (it.channels || [])) for (const m of (ch.models || [])) {
        const nm = String(m.name || '');
        const a = String(m.alias || '');
        if (a && !am[nm]) am[nm] = a;
        let v = vm[nm];
        if (!v) v = vm[nm] = { groups: [], kinds: [], chs: [] };
        const g = String(m.group || DEFAULT_GROUP);
        if (v.groups.indexOf(g) < 0) v.groups.push(g);
        const k = priceKindOf(m);
        if (v.kinds.indexOf(k) < 0) v.kinds.push(k);
        if (v.chs.indexOf(ch.name) < 0) v.chs.push(ch.name);
      }
      aliasIdx[it.name] = am; variantIdx[it.name] = vm;
    }
    const kindLabel = (k) => (k === 'percall' ? '按次' : (k === 'has' ? '有价格' : '未定价'));
    const rows = [];
    for (const it of insts) {
      /* *cond: no filtering -- rows must be the full pool, or clearing the filter locally has nothing to come back to;
       *  the inst dimension goes to list.where(item.inst eq state.fInst). URL mode keeps server-side filtering. */
      if (!F.can && fInst && it.name !== fInst) continue;
      const am = aliasIdx[it.name] || {}, vm = variantIdx[it.name] || {};
      /* ---- Mode A: channel filtered -> expand per channel (each card = that channel's own entry; open/bulk touches only it) ----
       *  *cond: do not expand -- channels are a live local filter; once the row set is frozen, clearing the filter cannot come back;
       *  merged card (chs set) + where(chs has fCh) are semantically aligned; editUrl is already channel=*. */
      if (!F.can && fCh) {
        const ch = (it.channels || []).find(c => c.name === fCh);
        if (!ch) continue;
        for (const m of (ch.models || [])) {
          const nm = String(m.name || ''), kind = priceKindOf(m), gname = String(m.group || DEFAULT_GROUP);
          if (fPrice && kind !== fPrice) continue;
          if (fGrp && gname !== fGrp) continue;
          if (kwl && ((nm + ' ' + String(m.alias || '')).toLowerCase().indexOf(kwl) < 0)) continue;
          rows.push({
            inst: it.name, name: nm,
            key: it.name + '|' + fCh + '|' + nm,
            /* *2026-10-08 machine fields (cond where): hay = the search corpus (localized display text cannot be a filter key),
             *  chs/kinds/groups = channel/billing-kind/group sets (redundant in URL mode but harmless; one convention for both modes) */
            hay: nm + ' ' + String(m.alias || ''),
            chs: [fCh], kinds: [kind], groups: [gname],
            label: String(m.alias || nm),
            sub: it.name + ' · 渠道 ' + fCh,
            gText: gname, gTone: gname === DEFAULT_GROUP ? 'neutral' : 'primary',
            pText: kind === 'percall' ? ('按次 ' + sym + m.perCall) : (kind === 'has' ? '有价格' : '未定价'),
            pTone: kind === 'percall' ? 'warning' : (kind === 'has' ? 'success' : 'neutral'),
            editUrl: '/admin/ui/model-edit?instance=' + enc(it.name) + '&channel=' + enc(fCh) + '&model=' + enc(nm),
          });
        }
        continue;
      }
      /* ---- Mode B: no channel filter -> merged same-name card (any channel hit counts; differences shown side by side) ---- */
      for (const m of (it.merged || [])) {
        const nm = String(m.name || ''), kind = priceKindOf(m), gname = String(m.group || DEFAULT_GROUP);
        const v = vm[nm];
        const kinds = (v && v.kinds.length) ? v.kinds : [kind];
        const groups = (v && v.groups.length) ? v.groups : [gname];
        const chs = (v && v.chs.length) ? v.chs : (m.channels || []);
        /* *cond: price/group/search handled by the local where(kinds/groups/hay); the server only ships the full pool */
        if (!F.can) {
          if (fPrice && kinds.indexOf(fPrice) < 0) continue;
          if (fGrp && groups.indexOf(fGrp) < 0) continue;
          if (kwl && ((nm + ' ' + String(m.alias || am[nm] || '')).toLowerCase().indexOf(kwl) < 0)) continue;
        }
        const multiG = groups.length > 1, multiK = kinds.length > 1;
        rows.push({
          inst: it.name, name: nm,
          key: it.name + '|*|' + nm,
          hay: nm + ' ' + String(m.alias || am[nm] || ''),
          chs: chs, kinds: kinds, groups: groups,
          label: String(m.alias || am[nm] || nm),
          sub: it.name + ' · ' + (Number(m.chCount) || 1) + ' 个渠道（' + chs.slice(0, 3).join(' / ') + (chs.length > 3 ? ' …' : '') + '）'
            + ((m.diff || multiG || multiK) ? ' · 配置不一致' : ''),
          gText: multiG ? groups.join(' / ') : gname,
          gTone: multiG ? 'warning' : (gname === DEFAULT_GROUP ? 'neutral' : 'primary'),
          pText: multiK ? kinds.map(kindLabel).join(' / ')
            : (kind === 'percall' ? ('按次 ' + sym + m.perCall) : (kind === 'has' ? '有价格' : '未定价')),
          pTone: multiK ? 'warning' : (kind === 'percall' ? 'warning' : (kind === 'has' ? 'success' : 'neutral')),
          editUrl: '/admin/ui/model-edit?instance=' + enc(it.name) + '&channel=*&model=' + enc(nm),
        });
      }
    }
    const shown = rows.slice(0, lim);
    const filtered = !!(fInst || fCh || fPrice || fGrp || kwl);

    /* model card template (the server ships data; the card renders the template once) */
    const cardTpl = {
      type: 'card', variant: 'outlined', gap: 6,
      action: { type: 'open', target: 'page:{{item.editUrl}}', nav: 'push' },
      /* *long-press a card = select/deselect (the App supports toggleSelect since v0.18.43) --
       *  aligned with the native "quick groups" page's long-press multi-select feel; checkboxes still work. */
      longAction: { type: 'toggleSelect', value: '{{item.key}}' },
      children: [
        { type: 'row', gap: 8, children: [
          { type: 'text', text: '{{item.label}}', style: 'title3', weight: 1 },
          { type: 'checkbox', value: '{{item.key}}' },
        ] },
        txt('{{item.sub}}', 'caption', '$onSurfaceVariant'),
        { type: 'row', gap: 6, children: [
          { type: 'badge', text: '{{item.gText}}', tone: '{{item.gTone}}' },
          { type: 'badge', text: '{{item.pText}}', tone: '{{item.pTone}}' },
        ] },
      ],
    };

    const kids = [];

    /* ---------- 1. Overview ---------- */
    kids.push({ type: 'card', variant: 'outlined', gap: 8, children: [
      txt('模型列表 · ' + self, 'title3'),
      txt('共 ' + totalCh + ' 个渠道 / ' + totalModels + ' 个模型（同名合并后 ' + totalMerged + ' 个，跨 ' + insts.length + ' 个实例）', 'caption', '$onSurfaceVariant'),
      { type: 'row', gap: 8, children: [
        { type: 'metricTile', value: String(totalCh), label: '渠道', weight: 1 },
        { type: 'metricTile', value: String(totalMerged), label: '模型(合并)', weight: 1 },
        { type: 'metricTile', value: String(grpOpts.length), label: '分组', weight: 1 },
      ] },
      txt('本页由服务端渲染（服务端页面优先，失败自动回原生）。全回原生：设置页关掉「管理端使用服务端界面」。', 'caption', '$onSurfaceVariant'),
    ] });

    /* ---------- 2. Filtering ---------- */
    const kwTarget = 'page:' + mkUrl([
      ['inst', fInst], ['ch', fCh], ['price', fPrice], ['grp', fGrp], ['kw', '{{input.kw}}'], ['cols', String(cols)],
    ]);
    const fkids = [
      txt('筛选', 'title3'),
      F.input('kw', 'fKw', kw, '搜索模型名 / 别名（输入后按键盘的搜索键）', 'msym:search',
        { type: 'open', target: kwTarget, nav: 'replace' }),
      { type: 'hscroll', gap: 6, children: [
        F.clearAll('全部', filtered, { limit: '40' }),
        F.chip(D_PRICE, '未定价', 'none'),
        F.chip(D_PRICE, '按次计费', 'percall'),
        F.chip(D_PRICE, '有价格', 'has'),
        F.chip(D_GRP, '无分组(Default)', 'Default'),
      ] },
      ctx.gcui.filterRow('实例', [F.all(D_INST)].concat(instOpts.map(n => F.chip(D_INST, n, n)))),
      ctx.gcui.filterRow('渠道', [F.all(D_CH)].concat(chOpts.map(n => F.chip(D_CH, n, n)))),
      ctx.gcui.filterRow('价格', [F.all(D_PRICE)].concat([['has', '有价格'], ['percall', '按次计费'], ['none', '未定价']].map(p => F.chip(D_PRICE, p[1], p[0])))),
      ctx.gcui.filterRow('分组', [F.all(D_GRP)].concat(grpOpts.map(n => F.chip(D_GRP, n, n)))),
      F.can
        ? txt('共 ' + rows.length + ' 个模型 · 筛选/搜索/分页均在本机即时执行（不再整页往返）', 'caption', '$onSurfaceVariant')
        : txt('显示 ' + shown.length + ' / 共 ' + rows.length + ' 个模型'
            + (fCh ? '（已按渠道「' + fCh + '」展开：卡片是该渠道自己的分组/价格，点开或批量**只改这一条**）'
                   : '（全库同名合并后 ' + totalMerged + ' 个；分组/价格不一致时会并排列出）')
            + (filtered ? ' · 已筛选' : '') + (showAll ? ' · **全部显示**模式' : ' · 单页 ' + lim + ' 个（越小越快）'), 'caption', '$onSurfaceVariant'),
    ];
    /* *moved reset-filters out of if(filtered): cond-mode filtering happens locally, so the server's filtered is always false
     *  (no fCh expansion, the triple filter is exempt) -- server-side condition buttons would simply never appear.
     *  URL mode: behavior unchanged (still appears only while filtered). */
    fkids.push({ type: 'hscroll', gap: 6, children: [
      F.reset('重置筛选'),
    ] });
    kids.push({ type: 'card', variant: 'outlined', gap: 8, children: fkids });

    /* ---------- 3. View / sync / admin ---------- */
    const viewChips = [
      txt('列数', 'caption', '$onSurfaceVariant'),
      F.viewChip(D_COLS, '2', '2'),
      F.viewChip(D_COLS, '3', '3'),
      F.viewChip(D_COLS, '4', '4'),
    ];
    kids.push({ type: 'card', variant: 'outlined', gap: 8, children: [
      { type: 'row', gap: 6, children: viewChips },
      { type: 'hscroll', gap: 6, children: [
        chip('立即同步全部', false, Object.assign(syncCall({}), { confirm: '从上游拉取全部渠道的模型列表？' })),
        chip('同步设置', false, openPage('/admin/ui/plugin?pid=model-sync')),
        chip('分组管理', false, openPage('/admin/ui/model-groups')),
      ] },
    ] });

    /* ---------- 4. Selection and actions (both entries are sub-pages) ----------
     * *2026-09-19 user-measured "checkboxes and some buttons still lag ~1s" -> the main list page rebuilt the **whole page** on every filter change,
     *   so "form + long list" moved to sub-pages: the main page keeps only overview + filter + tools + grid (half the views).
     *   the selected count uses {{selectedCount}} -- the App rebinds just that one text node instead of rebuilding the view tree (instant). */
    kids.push({ type: 'card', variant: 'outlined', gap: 8, children: [
      txt('选中与操作', 'title3'),
      txt('勾选卡片右上角的方框、或**长按卡片** = 选中/取消该模型（切换筛选后已选仍保留；没有「全清」，逐个取消即可）。', 'caption', '$onSurfaceVariant'),
      { type: 'hscroll', gap: 6, children: [
        chip('批量操作 · 已选 {{selectedCount}} 个', false, openPage('/admin/ui/model-bulk')),
        chip('渠道一览', false, openPage('/admin/ui/model-channels')),
      ] },
    ] });

    /* ---------- 5. Model grid ---------- */
    kids.push(F.can
      ? txt('模型 · 筛选/分页在本机执行', 'title3')
      : txt('模型（显示 ' + shown.length + ' / ' + rows.length
        + (rows.length > shown.length ? '，还有 ' + (rows.length - shown.length) + ' 个未显示' : '') + '）', 'title3'));
    if (!shown.length) {
      kids.push(txt(rows.length ? '（本页没有可显示的行）' : '没有符合筛选条件的模型。', 'body', '$onSurfaceVariant'));
    } else {
      /* *cond mode: all rows live in state.models, filtered locally across five dimensions; mode A (channel-expand)
       *  same row-field convention as mode B (merged cards) (label/sub/gText/gTone/pText/pTone/key); conditions are shared.
       *  URL mode: items are already the server-filtered shown set; behavior unchanged. */
      kids.push(F.can
        ? { type: 'list', items: '{{state.models}}', columns: '{{state.cols}}', limit: '{{state.limit}}', template: cardTpl,
            /* *where is generated by the kit from dims (field = row machine field; data semantics belong to the plugin); conditions with an empty right side
             *  the App skips them automatically (dimension inactive) -- the five dimensions share one full pool. */
            where: F.where() }
        : { type: 'list', items: '{{state.models}}', columns: cols, template: cardTpl });
      /* *pagination (2.69 round 2): all three chips always render; visibility is the App's job via limit/rowsTotal numeric comparison
       *  (the visible-object form) -- show/hide follows local +/-limit automatically; server-baked visibility would go stale locally
       *  dead value across re-renders (the "show more" button would not disappear after tapping). URL mode unchanged. */
      const pager = F.pager({ limitKey: 'limit', totalKey: 'rowsTotal', total: rows.length,
        step: MODELS_LIMIT_STEP, pageLimit: MODELS_PAGE_LIMIT, max: MODELS_LIMIT_MAX });
      if (pager) {
        kids.push(pager);
      } else if (rows.length > shown.length || showAll) {
        const mv = [];
        if (rows.length > shown.length) {
          mv.push(chip('显示更多 +' + MODELS_LIMIT_STEP + '（还有 ' + (rows.length - shown.length) + ' 个）', false,
            { type: 'open', target: moreUrl, nav: 'replace' }));
          mv.push(chip('全部显示（' + rows.length + ' 个）', false, jump({ all: '1' })));
        } else if (showAll) {
          mv.push(chip('只看前 ' + MODELS_LIMIT_STEP + ' 个（更快）', false, jump({ all: '' })));
        }
        kids.push({ type: 'hscroll', gap: 6, children: mv });
      }
      if (!F.can && shown.length > 100) {
        kids.push(txt('⚠ 正在一次渲染 ' + shown.length + ' 张卡：**切换筛选会明显变慢**（每次筛选都是整页重建）。'
          + '想跟手就用上面的筛选收窄，或点「只看前 ' + MODELS_LIMIT_STEP + ' 个」。', 'caption', '$error'));
      }
    }

    /* *cond mode: state = the full row pool + kit-generated five-dimension/view param initial values (key order = dims declaration order) */
    if (F.can) {
      return {
        title: '模型分组',
        state: Object.assign({ models: rows }, F.state, {
          cols: String(cols), limit: String(lim), rowsTotal: rows.length,
          bulkGroup: grpOpts.length ? grpOpts[0] : DEFAULT_GROUP,
        }),
        root: { type: 'column', gap: 10, children: kids },
      };
    }
    return {
      title: '模型分组',
      state: { models: shown, bulkGroup: grpOpts.length ? grpOpts[0] : DEFAULT_GROUP },
      root: { type: 'column', gap: 10, children: kids },
    };
  };

  /* ---------- Bulk sub-pages (menu:false): operate on the "selected" models ----------
   * Why a separate page: (1) the main list page must stay short (a full rebuild per filter change); (2) the form here uses {{selected}} --
   * which the App **deliberately does not resolve at render time** (see Renderer.bindAction); it reads the live set at the moment of the tap. */
  const buildBulkPage = () => {
    refreshCfg();
    const txt = (text, style, color) => { const o = { type: 'text', text: text }; if (style) o.style = style; if (color) o.color = color; return o; };
    const gap = (h) => ({ type: 'spacer', height: h || 8 });
    const btn = (text, style, action) => { const o = { type: 'button', text: text, style: style }; if (action) o.action = action; return o; };
    const chip = (text, on, action) => { const o = { type: 'chip', text: text, selected: !!on }; if (action) o.action = action; return o; };
    const d = groupsData();
    const grpOpts = (d.groups || []).map(g => g.name);
    const sym = curSym();
    const call = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
      body: { plugin: 'model-square', path: '/admin/groups', method: 'POST', body: body } });
    const back = { type: 'open', target: 'page:/admin/ui/models', nav: 'pop' };
    return {
      title: '批量操作',
      state: { bulkGroup: grpOpts.length ? grpOpts[0] : DEFAULT_GROUP },
      root: { type: 'column', gap: 10, children: [
        txt('批量操作', 'title3'),
        txt('作用于「模型分组」页里勾选 / 长按选中的模型：当前已选 {{selectedCount}} 个。'
          + '选择跨页面、跨筛选保留；两个表单都是"提交才生效"。', 'caption', '$onSurfaceVariant'),
        { type: 'card', variant: 'outlined', gap: 8, children: [
          txt('设为分组', 'caption', '$onSurfaceVariant'),
          { type: 'segmented', key: 'bulkGroup', selected: '{{state.bulkGroup}}',
            options: grpOpts.map(g => ({ value: g, text: g })),
            action: { type: 'setState', patch: { bulkGroup: '{{input._value}}' } } },
          btn('把已选模型设为「{{state.bulkGroup}}」', 'filled',
            Object.assign(call({ action: 'bulk', group: '{{state.bulkGroup}}', items: '{{selected}}' }),
              { confirm: '把已选模型移到该分组？' })),
        ] },
        { type: 'card', variant: 'outlined', gap: 8, children: [
          txt('批量改价（' + sym + ' / 1M tokens）—— 空着的项会按 0 写入', 'caption', '$onSurfaceVariant'),
          { type: 'form', submitText: '应用改价到已选模型', fields: [
            { type: 'input', key: 'pIn', label: '输入', inputType: 'number', value: '0' },
            { type: 'input', key: 'pOut', label: '输出', inputType: 'number', value: '0' },
            { type: 'input', key: 'pCW', label: '缓存写入', inputType: 'number', value: '0' },
            { type: 'input', key: 'pCR', label: '缓存读取', inputType: 'number', value: '0' },
          ], submit: Object.assign(call({ action: 'bulk',
            price: { in: '{{form.pIn}}', out: '{{form.pOut}}', cacheWrite: '{{form.pCW}}', cacheRead: '{{form.pCR}}' },
            items: '{{selected}}' }), { confirm: '把上面这套价格应用到已选模型？' }) },
          gap(4),
          { type: 'form', submitText: '应用按次计费到已选模型', fields: [
            { type: 'input', key: 'pc', label: '按次价格（' + sym + ' / 次；留空提交 = 清除按次、回到按量）', inputType: 'number', value: '' },
          ], submit: Object.assign(call({ action: 'bulk', perCall: '{{form.pc}}', items: '{{selected}}' }),
            { confirm: '把该按次价格应用到已选模型？（留空 = 清除按次）' }) },
        ] },
        { type: 'hscroll', gap: 6, children: [
          chip('← 返回模型列表', false, back),
          chip('分组管理', false, { type: 'open', target: 'page:/admin/ui/model-groups', nav: 'push' }),
        ] },
      ] },
    };
  };

  /* ---------- Channel overview sub-page (menu:false): per-instance channels / model counts / rename maps ---------- */
  const buildChannelsPage = () => {
    refreshCfg();
    const txt = (text, style, color) => { const o = { type: 'text', text: text }; if (style) o.style = style; if (color) o.color = color; return o; };
    const chip = (text, on, action) => { const o = { type: 'chip', text: text, selected: !!on }; if (action) o.action = action; return o; };
    const badge = (text, tone) => ({ type: 'badge', text: text, tone: tone });
    const enc2 = encodeURIComponent;
    const syncCall = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
      body: { plugin: 'model-sync', path: '/admin/run', method: 'POST', body: body } });
    const d = groupsData();
    const kids = [txt('渠道一览', 'title3'),
      txt('模型数 / 分组数按各实例口径；改名映射（modelMap）在渠道页编辑。', 'caption', '$onSurfaceVariant')];
    let n = 0;
    for (const it of (d.instances || [])) {
      const chs = it.channels || [];
      if (!chs.length) continue;
      kids.push(txt('实例 · ' + it.name + (it.current ? '（当前）' : ''), 'caption', '$onSurfaceVariant'));
      for (const ch of chs) {
        n++;
        const names = (ch.models || []).slice(0, 4).map(x => x.name).join(', ');
        const mapN = Number(ch.mapSize) || Object.keys(ch.maps || {}).length || 0;
        const mapText = (ch.maps && typeof ch.maps === 'object')
          ? Object.keys(ch.maps).slice(0, 8).map(k => k + ' → ' + ch.maps[k]).join('   ') : '';
        const cc = [
          txt(ch.name, 'title3'),
          { type: 'row', gap: 6, children: [
            badge((ch.models || []).length + ' 模型', (ch.models || []).length ? 'primary' : 'neutral'),
            badge(mapN + ' 分组', mapN ? 'success' : 'neutral'),
            badge(it.name, it.current ? 'primary' : 'neutral'),
          ] },
          txt((ch.models || []).length ? (names + ((ch.models || []).length > 4 ? ' … 共 ' + (ch.models || []).length + ' 个' : ''))
            : '还没有模型 —— 点「同步该渠道」从上游拉取', 'caption', '$onSurfaceVariant'),
        ];
        if (mapText) cc.push(txt(mapText, 'caption', '$onSurfaceVariant'));
        cc.push({ type: 'hscroll', gap: 6, children: [
          /* nav:'pop' -- back to the list page carrying that channel's filter (not another push) */
          chip('看这个渠道的模型', false,
            { type: 'open', target: 'page:/admin/ui/models?inst=' + enc2(it.name) + '&ch=' + enc2(ch.name), nav: 'pop' }),
          chip('同步该渠道', false, Object.assign(syncCall({ channel: ch.name }), { confirm: '从上游同步渠道「' + ch.name + '」的模型列表？' })),
          chip('编辑渠道 / 改名映射', false, { type: 'open', target: 'page:/admin/ui/channel-edit?name=' + enc2(ch.name), nav: 'push' }),
        ] });
        kids.push({ type: 'card', variant: 'outlined', gap: 6, children: cc });
      }
    }
    if (!n) kids.push(txt('还没有渠道。', 'caption', '$onSurfaceVariant'));
    kids.push(chip('← 返回模型列表', false, { type: 'open', target: 'page:/admin/ui/models', nav: 'pop' }));
    return { title: '渠道一览', state: {}, root: { type: 'column', gap: 10, children: kids } };
  };

  /* the "group management" sub-page (menu:false; opened from the chips above or a direct link) */
  const buildGroupManagePage = () => {
    refreshCfg();
    const txt = (text, style, color) => { const o = { type: 'text', text: text }; if (style) o.style = style; if (color) o.color = color; return o; };
    const gap = (h) => ({ type: 'spacer', height: h || 8 });
    const btn = (text, style, action) => { const o = { type: 'button', text: text, style: style }; if (action) o.action = action; return o; };
    const bad = (text, tone) => ({ type: 'badge', text: text, tone: tone });
    const call = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
      body: { plugin: 'model-square', path: '/admin/groups', method: 'POST', body: body } });
    const d = groupsData();
    const counts = d.counts || {};
    const kids = [txt('分组管理', 'title3'), txt('共 ' + (d.groups || []).length + ' 个分组 · 倍率用于「按分组计价」', 'caption', '$onSurfaceVariant')];
    for (const g of (d.groups || [])) {
      const gkids = [
        { type: 'row', gap: 6, children: [
          { type: 'text', text: g.name, style: 'body', weight: 1 },
          bad('×' + g.rate, g.name === DEFAULT_GROUP ? 'neutral' : 'primary'),
          bad((counts[g.name] || 0) + ' 个模型', 'neutral'),
        ] },
        { type: 'form', submitText: '改倍率', fields: [
          { type: 'input', key: 'rate_' + g.name, label: '计费倍率（1 = 不加价）', inputType: 'number', value: String(g.rate) },
        ], submit: call({ action: 'setGroupRate', name: g.name, rate: '{{form.rate_' + g.name + '}}' }) },
      ];
      if (g.name !== DEFAULT_GROUP) {
        gkids.push(btn('删除「' + g.name + '」', 'text', Object.assign(call({ action: 'removeGroup', name: g.name }),
          { confirm: '删除分组「' + g.name + '」？该分组的模型会回到 Default。' })));
      }
      kids.push({ type: 'card', variant: 'outlined', gap: 8, children: gkids });
    }
    kids.push(gap(4));
    kids.push({ type: 'card', variant: 'outlined', gap: 8, children: [
      txt('新建分组', 'title3'),
      { type: 'form', submitText: '创建分组', fields: [
        { type: 'input', key: 'gname', label: '分组名称', value: '' },
        { type: 'input', key: 'grate', label: '计费倍率（1 = 不加价）', inputType: 'number', value: '1' },
      ], submit: call({ action: 'addGroup', name: '{{form.gname}}', rate: '{{form.grate}}' }) },
    ] });
    return { title: '分组管理', state: {}, root: { type: 'column', gap: 10, children: kids } };
  };

  ctx.registerAdminUi({
    id: 'models',
    title: '模型分组',
    subtitle: '客户端 name → 上游名',
    icon: 'sort',
    menu: true,
    render: (gw, c, q, caps) => buildModelsPage(q, caps),
  });
  ctx.registerAdminUi({
    id: 'model-bulk',
    title: '批量操作',
    subtitle: '对已选模型批量改价 / 设分组',
    icon: 'edit',
    menu: false,
    render: () => buildBulkPage(),
  });
  ctx.registerAdminUi({
    id: 'model-channels',
    title: '渠道一览',
    subtitle: '各实例渠道与模型数',
    icon: 'apps',
    menu: false,
    render: () => buildChannelsPage(),
  });
  ctx.registerAdminUi({
    id: 'model-groups',
    title: '分组管理',
    subtitle: '模型分组的加减与计费倍率',
    icon: 'sort',
    menu: false,
    render: () => buildGroupManagePage(),
  });

  /* *capability registration (2026-10-07 deep refactor, capability inversion section)
   *  billing used to hard-code ctx.getPluginConfig('model-square', 0) -- swapping in another pricing plugin would crash it,
   *  and "the core/plugins must know the name model-square" is coupling in itself.
   *  Now: this plugin registers the "price lookup" capability, and anyone who needs it calls requireCapability('model-pricing'),
   *  with zero need to know the provider. Fields: price per 1M tokens, perCall per call, group, alias (public name).
   *  *must pass a getter, not a snapshot: cfg is refreshed in place (see the cfgRevSeen comment above); a snapshot would read stale prices. */
  ctx.provideCapability('model-pricing', {
    /** fetch metadata for an instance/channel/model (price/perCall/group/alias included); missing -> null */
    metaOf: (inst, ch, model) => {
      try {
        const k = [String(inst || ''), String(ch || ''), String(model || '')].join('|');
        return cfg.modelMeta[k] || null;
      } catch (_) { return null; }
    },
    /** All metadata (keyed "instance|channel|model") -- consumers iterate / fall back to matching on their own */
    allMeta: () => {
      try { return cfg.modelMeta || {}; } catch (_) { return {}; }
    },
    /** Group list [{name, rate}] -- the source of billing multipliers */
    groups: () => {
      try { return Array.isArray(cfg.groups) ? cfg.groups : []; } catch (_) { return []; }
    },
    /** Per-call price metadata (CNY per 1M) -- unset -> null */
    priceOf: (inst, ch, model) => {
      try {
        const k = [String(inst || ''), String(ch || ''), String(model || '')].join('|');
        const m = cfg.modelMeta[k];
        return (m && m.price) || null;
      } catch (_) { return null; }
    },
    /** version: incremented on config change; consumers may key cache invalidation off it */
    rev: () => cfgRevSeen,
  });

  ctx.log('模型广场已激活 (bottomBar 页面 ui=/ui/square) · 已提供能力 model-pricing');
};
