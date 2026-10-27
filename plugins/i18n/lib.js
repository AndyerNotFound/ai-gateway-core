'use strict';
/* i18n/lib.js —— 多语言公共库。
 * 任何插件 require('../i18n/lib') 后:  const { bundle } = require('../i18n/lib');
 *   const { lang, t } = bundle(ctx, uk);   // 每次页面渲染取一次, 之后 t() 闭包复用
 *   t('剩余额度')           → 按该用户语言返回译文, 没有译文回退中文原文
 *   t('我的卡密 ({0})', 3)  → {0} 位置参数替换
 *
 * ★容错铁律: 本库绝不抛错 —— i18n 插件不在、配置坏了、读盘失败 → 一律回退中文原文。
 *   (auth-user 是 type:auth 插件, 激活失败会 fail-closed 阻断全部插件, 必须保守。)
 *
 * ★性能: 内核 getPluginConfig 每次现读磁盘文件, 所以 bundle() 每次页面渲染只读一次,
 *   之后同一次渲染里的所有 t() 调用都复用这一份配置 —— 绝不每条字符串读一次盘。 */

const LANGS = ['zh-CN', 'en', 'zh-TW'];

function bundle(ctx, uk) {
  let lang = 'zh-CN', dict = null;
  try {
    const c = (ctx && ctx.getPluginConfig) ? ctx.getPluginConfig('i18n') : null;
    const o = (c && typeof c === 'object') ? c : {};
    const f = uk ? String(uk.uid || uk.key || '') : '';
    lang = (f && o.prefs && o.prefs[f]) || o.defaultLang || 'zh-CN';
    if (lang === 'zh-CN') {
      dict = null;                      /* 简中 = 键即原文, 不查表 */
    } else {
      dict = (o.dict && o.dict[lang]) || null;
      if (!dict || typeof dict !== 'object') dict = null;
    }
  } catch (_) { /* 回退 zh-CN */ }
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
