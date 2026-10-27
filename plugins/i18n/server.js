'use strict';
/* i18n 插件 - 多语言基础服务
 * 端点(全部管理端):
 *   GET  /plugins/i18n/admin/state        译文字典 + 默认语言 + 偏好统计
 *   POST /plugins/i18n/admin/save-key     增改一条译文 { src, en, tw } (空串=删除该语言译文)
 *   POST /plugins/i18n/admin/del-key      整条删除 { src }
 *   POST /plugins/i18n/admin/default-lang 改默认语言 { lang }
 *   POST /plugins/i18n/admin/reseed       重新合并种子译文(只补缺, 不覆盖手改)
 *
 * 用户语言偏好: auth-user 的「个人页」里切语言 → intent → 事件总线
 *   auth-user ctx.emit('setLang', {fkey, lang}) → 这里 ctx.on('auth-user:setLang') 落盘。
 *   (emit 是同步的, 切完语言 auth-user 立即重渲染个人页, 新语言当场生效)
 *
 * 存储: 全部在本插件配置里(scope:global 全实例共享) —— 其它插件用
 *   ctx.getPluginConfig('i18n') 读(经 lib.js 的 bundle() 封装, 每次渲染读一次)。
 *   configSchema 留空: 配置里存的是数据(字典/偏好), 不放表单设置项,
 *   避免管理端表单保存时整体替换把字典冲掉(model-square 同款先例)。
 *
 * 字典结构: { "en": { "中文原文": "English" }, "zh-TW": { "中文原文": "繁體中文" } }
 *   键 = 简中原文; zh-CN 不需要表(键即原文), 没查到译文一律回退原文。 */
const fs = require('fs');
const path = require('path');

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

module.exports = { activate(ctx) {
  const LANGS = require('./lib').LANGS;   /* ['zh-CN','en','zh-TW'] */

  /* ★配置代理(与 auth-user 同款): 每次访问按内核版本号判断要不要重读,
   *   保证多实例下其它实例/本实例写完立刻能看到最新值。 */
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
  /* 归一化 */
  if (!LANGS.includes(cfg.defaultLang)) cfg.defaultLang = 'zh-CN';
  cfg.prefs = (cfg.prefs && typeof cfg.prefs === 'object' && !Array.isArray(cfg.prefs)) ? cfg.prefs : {};
  cfg.dict = (cfg.dict && typeof cfg.dict === 'object' && !Array.isArray(cfg.dict)) ? cfg.dict : {};

  /* ★写盘用内存快照(不把 Proxy 交给内核), 写完同步本地版本号(见 auth-user 注释) */
  const save = () => {
    const snap = {};
    for (const k of Object.keys(cfg)) snap[k] = cfg[k];
    ctx.setPluginConfig(snap);
    if (ctx.configRev) _cfgRev = ctx.configRev();
  };

  /* ---------- 种子译文: 只补缺, 不覆盖手改(激活时合并一次) ---------- */
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

  /* ---------- 用户切换语言(auth-user 经事件总线送来, 同步生效) ---------- */
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

  /* ---------- 管理端点(全部 authAdmin) ---------- */
  const adminOnly = (p, res) => {
    const a = p.authAdmin();
    if (!a || !a.ok) { jsonRes(res, (a && a.status) || 401, { error: (a && a.error) || 'unauthorized' }); return false; }
    return true;
  };
  /** 写后回读校验: 确认真的写进去了(不假装成功) */
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
    /* 写后回读: 只校验非空写入真的进了盘 */
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
