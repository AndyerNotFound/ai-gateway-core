'use strict';
/* i18n/lib.js -- shared multilingual library.
 * After any plugin does require('../i18n/lib'):  const { bundle } = require('../i18n/lib');
 *   const { lang, t } = bundle(ctx, uk);   // fetch once per page render, then reuse t() through the closure
 *   t('剩余额度')           -> returns the translation for that user's language, falling back to the Chinese original when none exists
 *   t('我的卡密 ({0})', 3)  -> {0} positional substitution
 *
 * ★Iron rule of fault tolerance: this library never throws -- missing i18n plugin, broken config, disk failure -> always fall back to the Chinese original.
 *   (auth-user is a type:auth plugin; a failed activation fail-closed blocks all plugins, so stay conservative.)
 *
 * ★Performance: the core's getPluginConfig reads the disk file fresh on every call, so bundle() reads once per page render,
 *   and every t() in the same render reuses that single config read -- never one disk read per string. */

const LANGS = ['zh-CN', 'en', 'zh-TW'];

function bundle(ctx, uk) {
  let lang = 'zh-CN', dict = null;
  try {
    const c = (ctx && ctx.getPluginConfig) ? ctx.getPluginConfig('i18n') : null;
    const o = (c && typeof c === 'object') ? c : {};
    const f = uk ? String(uk.uid || uk.key || '') : '';
    lang = (f && o.prefs && o.prefs[f]) || o.defaultLang || 'zh-CN';
    if (lang === 'zh-CN') {
      dict = null;                      /* zh-CN = the key is the original text, no table lookup */
    } else {
      dict = (o.dict && o.dict[lang]) || null;
      if (!dict || typeof dict !== 'object') dict = null;
    }
  } catch (_) { /* fall back to zh-CN */ }
  const fmt = (s, args) => (args && args.length
    ? String(s).replace(/\{(\d+)\}/g, (_, i) => (args[i] === undefined || args[i] === null ? '' : String(args[i])))
    : s);
  const t = function (src) {
    const args = (arguments.length > 1) ? Array.prototype.slice.call(arguments, 1) : null;
    if (typeof src !== 'string' || !src) return src;
    const v = dict ? dict[src] : undefined;
    return fmt((v === undefined || v === null || v === '') ? src : String(v), args);
  };
  return { lang: lang, t: t };
}

module.exports = { bundle: bundle, LANGS: LANGS };
