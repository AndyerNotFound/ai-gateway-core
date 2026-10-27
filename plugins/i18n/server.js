'use strict';
/* i18n plugin -- multilingual foundation service
 * Endpoints (all admin-side):
 *   GET  /plugins/i18n/admin/state        translation dictionary + default language + preference stats
 *   POST /plugins/i18n/admin/save-key     add/update one translation { src, en, tw } (empty string = delete that language's entry)
 *   POST /plugins/i18n/admin/del-key      delete the whole entry { src }
 *   POST /plugins/i18n/admin/default-lang change the default language { lang }
 *   POST /plugins/i18n/admin/reseed       re-merge seed translations (fills gaps only, never overwrites manual edits)
 *
 * User language preference: switching in auth-user's "profile page" -> intent -> event bus
 *   auth-user ctx.emit('setLang', {fkey, lang}) -> persisted here via ctx.on('auth-user:setLang').
 *   (emit is synchronous: after the switch auth-user re-renders the profile page immediately, so the new language lands instantly)
 *
 * Storage: everything lives in this plugin's config (scope:global, shared across instances) -- other plugins use
 *   ctx.getPluginConfig('i18n') to read (wrapped by lib.js's bundle(), one read per render).
 *   configSchema is left empty: the config holds data (dictionary/preferences), not form settings,
 *   preventing the admin form save's whole-object replace from wiping the dictionary (same precedent as model-square).
 *
 * Dictionary shape: { "en": { "中文原文": "English" }, "zh-TW": { "中文原文": "繁體中文" } }
 *   key = the simplified-Chinese original; zh-CN needs no table (key = original), and any missed lookup falls back to the original. */
const fs = require('fs');
const path = require('path');

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

module.exports = { activate(ctx) {
  const LANGS = require('./lib').LANGS;   /* ['zh-CN','en','zh-TW'] */

  /* ★Config proxy (same as auth-user): every access checks the core's version to decide whether to re-read,
   *   guaranteeing that once any instance writes, everyone sees the fresh value immediately. */
  let _cfgCache = null, _cfgRev = -1;
  const cfgFresh = () => {
    const r = ctx.configRev ? ctx.configRev() : 0;
    if (!_cfgCache || r !== _cfgRev) {
      const fresh = ctx.getPluginConfig('i18n');
      _cfgCache = (fresh && typeof fresh === 'object') ? fresh : Object.assign({ defaultLang: 'zh-CN', prefs: {}, dict: {} }, ctx.config || {});
      _cfgRev = r;
    }
    return _cfgCache;
  };
  const cfg = new Proxy({}, {
    get: (_, k) => cfgFresh()[k],
    set: (_, k, v) => { cfgFresh()[k] = v; return true; },
    has: (_, k) => k in cfgFresh(),
    deleteProperty: (_, k) => { delete cfgFresh()[k]; return true; },
    ownKeys: () => Reflect.ownKeys(cfgFresh()),
    getOwnPropertyDescriptor: (_, k) => Object.getOwnPropertyDescriptor(cfgFresh(), k),
  });
  /* Normalization */
  if (!LANGS.includes(cfg.defaultLang)) cfg.defaultLang = 'zh-CN';
  cfg.prefs = (cfg.prefs && typeof cfg.prefs === 'object' && !Array.isArray(cfg.prefs)) ? cfg.prefs : {};
  cfg.dict = (cfg.dict && typeof cfg.dict === 'object' && !Array.isArray(cfg.dict)) ? cfg.dict : {};

  /* ★Disk writes use an in-memory snapshot (never hand the Proxy to the core), then sync the local version (see the auth-user comment) */
  const save = () => {
    const snap = {};
    for (const k of Object.keys(cfg)) snap[k] = cfg[k];
    ctx.setPluginConfig(snap);
    if (ctx.configRev) _cfgRev = ctx.configRev();
  };

  /* ---------- Seed translations: fill gaps only, never overwrite manual edits (merged once at activation) ---------- */
  const seedFile = path.join(__dirname, 'dict-seed.json');
  const loadSeed = () => {
    try { return JSON.parse(fs.readFileSync(seedFile, 'utf8')) || {}; } catch (_) { return {}; }
  };
  const seedCount = { en: 0, 'zh-TW': 0 };
  let seeded = 0;
  for (const lang of ['en', 'zh-TW']) {
    const seed = loadSeed()[lang] || {};
    if (!cfg.dict[lang] || typeof cfg.dict[lang] !== 'object') cfg.dict[lang] = {};
    for (const k of Object.keys(seed)) {
      seedCount[lang]++;
      if (cfg.dict[lang][k] === undefined) { cfg.dict[lang][k] = seed[k]; seeded++; }
    }
  }
  if (seeded > 0) save();
  ctx.log('[i18n] 已激活: 种子译文 en=' + seedCount.en + ' 条 / zh-TW=' + seedCount['zh-TW'] + ' 条, 本次补缺 ' + seeded + ' 条');

  /* ---------- User language switch (sent by auth-user over the event bus, effective synchronously) ---------- */
  ctx.on('auth-user:setLang', (d) => {
    try {
      if (!d || !d.fkey) return;
      const lang = String(d.lang || '');
      if (!LANGS.includes(lang)) return;
      cfg.prefs[String(d.fkey)] = lang;
      save();
      ctx.log('[i18n] 用户 ' + String(d.fkey).slice(0, 12) + '… 语言偏好 → ' + lang);
    } catch (e) { ctx.log('[i18n] setLang 失败: ' + e.message); }
  });

  /* ---------- Admin endpoints (all authAdmin) ---------- */
  const adminOnly = (p, res) => {
    const a = p.authAdmin();
    if (!a || !a.ok) { jsonRes(res, (a && a.status) || 401, { error: (a && a.error) || 'unauthorized' }); return false; }
    return true;
  };
  /** Write-then-read verification: confirm it truly landed (never fake success) */
  const verifyKey = (src, lang) => {
    try {
      const c = ctx.getPluginConfig('i18n') || {};
      return (c.dict && c.dict[lang] && c.dict[lang][src] !== undefined);
    } catch (_) { return false; }
  };

  ctx.registerRoute('GET', '/admin/state', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    const dict = {};
    for (const lang of ['en', 'zh-TW']) dict[lang] = Object.assign({}, cfg.dict[lang] || {});
    jsonRes(res, 200, {
      ok: true,
      langs: LANGS,
      defaultLang: cfg.defaultLang,
      prefsCount: Object.keys(cfg.prefs || {}).length,
      seedCount: seedCount,
      dict: dict,
    });
  });

  ctx.registerRoute('POST', '/admin/save-key', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    const j = p.body || {};
    const src = String(j.src == null ? '' : j.src).trim();
    if (!src) return jsonRes(res, 400, { error: '原文(键)不能为空' });
    const vals = { en: String(j.en == null ? '' : j.en), 'zh-TW': String(j.tw == null ? '' : j.tw) };
    let changed = 0;
    for (const lang of Object.keys(vals)) {
      if (!cfg.dict[lang] || typeof cfg.dict[lang] !== 'object') cfg.dict[lang] = {};
      if (vals[lang]) { if (cfg.dict[lang][src] !== vals[lang]) { cfg.dict[lang][src] = vals[lang]; changed++; } }
      else if (cfg.dict[lang][src] !== undefined) { delete cfg.dict[lang][src]; changed++; }
    }
    if (changed > 0) save();
    /* Write-then-read: verify only that non-empty writes really reached disk */
    const okEn = vals.en ? verifyKey(src, 'en') : true;
    const okTw = vals['zh-TW'] ? verifyKey(src, 'zh-TW') : true;
    if (!okEn || !okTw) return jsonRes(res, 500, { error: '写入后回读不一致(en=' + okEn + ', tw=' + okTw + ')' });
    jsonRes(res, 200, { ok: true, changed: changed });
  });

  ctx.registerRoute('POST', '/admin/del-key', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    const src = String((p.body && p.body.src) == null ? '' : p.body.src).trim();
    if (!src) return jsonRes(res, 400, { error: '原文(键)不能为空' });
    let del = 0;
    for (const lang of ['en', 'zh-TW']) {
      if (cfg.dict[lang] && cfg.dict[lang][src] !== undefined) { delete cfg.dict[lang][src]; del++; }
    }
    if (del > 0) save();
    jsonRes(res, 200, { ok: true, deleted: del });
  });

  ctx.registerRoute('POST', '/admin/default-lang', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    const lang = String((p.body && p.body.lang) || '');
    if (!LANGS.includes(lang)) return jsonRes(res, 400, { error: '语言只能是 ' + LANGS.join(' / ') });
    cfg.defaultLang = lang;
    save();
    jsonRes(res, 200, { ok: true, defaultLang: lang });
  });

  ctx.registerRoute('POST', '/admin/reseed', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    const seed = loadSeed();
    let added = 0;
    for (const lang of ['en', 'zh-TW']) {
      const s = seed[lang] || {};
      if (!cfg.dict[lang] || typeof cfg.dict[lang] !== 'object') cfg.dict[lang] = {};
      for (const k of Object.keys(s)) {
        if (cfg.dict[lang][k] === undefined) { cfg.dict[lang][k] = s[k]; added++; }
      }
    }
    if (added > 0) save();
    jsonRes(res, 200, { ok: true, added: added, note: '只补缺, 手改过的不会被覆盖' });
  });
} };
