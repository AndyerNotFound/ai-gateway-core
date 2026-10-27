'use strict';
/* model-square - 模型广场(带筛选)
 *
 * 为什么做成插件页: 页面是服务端渲染的 gcui JSON, App 直接渲染,
 * 所以**改这里不用重编 App** —— 加筛选/改样式只要重启网关。
 *
 * 三个筛选维度:
 *   分组(group)     : 客户端可见模型名的"系列"; 管理员配了 modelMap 时, 别名本身就是一个分组
 *   提供商(provider): 渠道名
 *   用户分组(ugroup): 用户在「用户体系」里的分组; 渠道可配 groups:[] 白名单(空=所有分组可用)
 *
 * 筛选状态按 (uid|卡密) 存在插件数据里; 每次点筛选芯片 → intent → 服务端返回整页 → App 原地重渲染。
 */

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

/* ---- 多语言(i18n 插件公共库): require/读配置失败 → 一律回退中文原文 ---- */
let i18nBundle = null;
try { i18nBundle = require('../i18n/lib').bundle; } catch (_) { i18nBundle = null; }
function mkT(ctx, uk) {
  try { if (i18nBundle) return i18nBundle(ctx, uk); } catch (_) {}
  const t = function (s) { return s; };
  t.lang = 'zh-CN';
  return { lang: 'zh-CN', t: t };
}

module.exports.activate = (ctx) => {
  const cfg = ctx.config;   /* ★这个对象引用必须"活的" —— 闭包与 saveCfg 都指着它, 见下面 refreshCfg (永不替换引用) */

  /* ---------------- 分组 / 模型元数据 ----------------
   * groups   : [{ name, rate }]  rate = 计费倍率
   * meta     : { "实例名|渠道名|模型名": { group, alias, price:{in,out,cacheWrite,cacheRead}, perCall } }
   *            alias    = 对外名称(空 = 用原名)
   *            price    = 元 / 1M tokens
   *            perCall  = 数字时表示"使用按次计费"(元/次), null = 不用
   */
  const DEFAULT_GROUP = 'Default';
  const normalize = () => {
    if (!cfg.filters || typeof cfg.filters !== 'object') cfg.filters = {};
    if (!Array.isArray(cfg.groups) || !cfg.groups.length) cfg.groups = [{ name: DEFAULT_GROUP, rate: 1 }];
    if (!cfg.groups.some(g => g && g.name === DEFAULT_GROUP)) cfg.groups.unshift({ name: DEFAULT_GROUP, rate: 1 });
    if (!cfg.modelMeta || typeof cfg.modelMeta !== 'object') cfg.modelMeta = {};
  };
  normalize();

  /* ★多实例一致性 (2026-09-18 修; 用户报「进入实例Guili分支配了价格, 切回default分支显示无价格」)
   *  本插件配置(分组/价格/别名/规则)是**全实例共享**的(manifest 未写 scope → 全局, 存 _global 键),
   *  但内核 activateOne() 只在插件激活时读一次盘 → 每个实例各持一份内存副本, 之后永不刷新。
   *  内核早就给了配置版本号 ctx.configRev(任何实例 setPluginConfig 后 +1, 同插件所有实例共享),
   *  auth-cardkey / auth-user 都按约定实现过 cfgLive()(见它们的「★多实例一致性」注释),
   *  只有本插件从没用过 → 在 A 实例改完价格, 切到 B 实例看到的还是 B 启动时的旧副本。
   *  实测(2026-09-18): 除 Guili 外的 5 个实例都只看到 231 条, Guili 的 29 条价格全 null、
   *  分组退化成名字前缀推导("HY3"); 只有写入方 Guili 实例看到 260 条。
   *  做法: 每个请求入口先查版本号, 变了就**原地刷新同一个 cfg 对象**(整对象换引用会让闭包和
   *  saveCfg 继续用旧对象, 所以必须原地 delete+assign), 顺带重跑 normalize()。
   *  附带好处: 写盘交出的不再是"旧副本", 不会再整对象覆盖掉别实例刚写的数据。 */
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
  /** 所有路由统一包一层: 入口先刷新配置(见上) */
  const route = (method, p, handler) => ctx.registerRoute(method, p, (req, res, prm) => {
    refreshCfg();
    return handler(req, res, prm);
  });
  const saveCfg = () => ctx.setPluginConfig(cfg);
  /* ★键升级为 实例|渠道|模型 (2026-09-12 用户要求"快速分组按 实例+渠道 分板块整理") */
  const metaKey = (inst, ch, m) => [String(inst || ''), String(ch), String(m)].join('|');
  const metaOf = (inst, ch, m) => cfg.modelMeta[metaKey(inst, ch, m)] || null;
  /* ★修复: 无 meta 时返回 '' → 调用点的 || groupOfName(n) 才能按名称前缀推导
   *  (原来永远返回 Default, 前缀推导永不触发 → 分组芯片只剩 Default 一个) */
  const groupNameOf = (inst, ch, m) => (metaOf(inst, ch, m) || {}).group || '';
  const aliasOf = (inst, ch, m) => (metaOf(inst, ch, m) || {}).alias || '';
  const priceOf = (inst, ch, m) => (metaOf(inst, ch, m) || {}).price || null;
  const perCallOf = (inst, ch, m) => {
    const v = (metaOf(inst, ch, m) || {}).perCall;
    return (v === null || v === undefined || v === '') ? null : Number(v);
  };
  const groupNames = () => cfg.groups.map(g => g.name);

  /* ---------- 数据 ---------- */
  const fkey = (uk) => (uk && (uk.uid || uk.key)) || 'anon';

  const allFilter = () => ({ group: '', provider: '', vendor: '', ugroup: '', q: '', sort: '', cols: 1, limit: 150 });
  const filterOf = (uk) => Object.assign(allFilter(), cfg.filters[fkey(uk)] || {});
  /* 筛选状态序列化 (open GET 路由用: 游客也能筛/排序/切视图, 状态随 URL 携带, 不依赖登录)
   * ★必须"键驱动": 调用方**显式给了某个键就要写进 URL**(哪怕值是空串) ——
   *   服务端把"URL 里有没有这个键"当作"要不要改这一项"。
   *   以前用 if (o.sort) / Number(o.cols) === 2 判真值 → 空排序、cols=1 会被静默吞掉,
   *   表现就是"点了排序/切视图, 页面刷新了但状态纹丝不动"(2026-09-15 用户报障)。 */
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
  /* 搜索框提交时携带的"其它"筛选(不含 q/view, q 由 {{input.q}} 提供) */
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

  /** 去重后的渠道列表 (全部渠道, 不再只取 default) */
  const channels = () => {
    const seen = new Map();
    const list = (ctx.gateway && ctx.gateway.instanceChannels) ? ctx.gateway.instanceChannels() : [];
    for (const ch of list) {
      if (ch && ch.name && !seen.has(ch.name)) seen.set(ch.name, ch);
    }
    return [...seen.values()];
  };

  /** 客户端可见的模型名: models 列表 ∪ modelMap 的 key(别名) */
  const namesOf = (ch) => {
    const mm = (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {};
    const set = new Set();
    for (const m of (Array.isArray(ch.models) ? ch.models : [])) if (m) set.add(String(m));
    for (const k of Object.keys(mm)) if (k) set.add(String(k));
    return [...set];
  };

  /** 分组名: 取名字的第一段(gpt-4o→gpt / claude-…→claude); 别名则自身即分组 */
  const groupOfName = (name) => {
    const n = String(name || '').trim();
    const first = n.split(/[-_./: ]+/)[0];
    return first || n;
  };

  /* ---------- 派生分组的自定义规则 group-rules.txt (2026-09-18 用户要求) ----------
   * 与 avatar-overrides.txt 同风格: 纯文本、一行一条、# 注释、改完刷新页面即生效(mtime 缓存, 不用重启)。
   *   `前缀*  = 分组名`   前缀匹配(最长优先)
   *   `精确模型名 = 分组名` 精确匹配
   *   `mode = override`  让规则**优先于管理端配置**(默认 fallback: 只作用于"没配分组"的模型)
   * 值留空 = 忽略该行。写错不影响其他行; 语法提示见 GET /group-rules。 */
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
        if (!v) continue;                        /* 值留空 = 不参与 */
        const kl = k.toLowerCase();
        /* ★2026-09-18: 支持 `前缀*` / `*后缀` / `*包含*` / 精确名（与 avatar-overrides.txt 同一套语义） */
        if (kl.startsWith('*') && kl.endsWith('*') && kl.length > 2) rules.push({ kind: 'contains', stem: kl.slice(1, -1), group: v, raw: k });
        else if (kl.endsWith('*') && kl.length > 1) rules.push({ kind: 'prefix', stem: kl.slice(0, -1), group: v, raw: k });
        else if (kl.startsWith('*') && kl.length > 1) rules.push({ kind: 'suffix', stem: kl.slice(1), group: v, raw: k });
        else exact[kl] = v;
      }
      rules.sort((a, b) => b.stem.length - a.stem.length);   /* 越具体(串越长)越优先 */
      grCache.mtime = mt; grCache.exact = exact; grCache.rules = rules; grCache.mode = mode;
      grCache.warn = warns.join('; ');
      return grCache;
    } catch (e) { grCache.warn = e.message; return grCache; }
  };
  /** 命中自定义规则 → 分组名; 没命中返回 ''
   *  匹配语义（2026-09-18 扩展）：精确名 > `前缀*` / `*后缀` / `*包含*`（规则串越长越优先）；
   *  再兜一层**分词**：整名没中就逐词试 `前缀*`（x-deepseek-v4-pro → deepseek* 也能中）。 */
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
  /** 一个模型最终落在哪个分组: 管理端显式配置 > 自定义规则(mode=override 时反过来) > 内置前缀推导 */
  const groupFor = (inst, ch, n) => {
    const explicit = groupNameOf(inst, ch, n);
    const byRule = groupByRules(n);
    if (byRule && groupRulesOf().mode === 'override') return byRule;
    return explicit || byRule || groupOfName(n);
  };

  /* ---------- lobehub 头像自动匹配 (2026-09-13 用户要求) ----------
   * CDN: npmmirror(阿里, 国内直连) 的 @lobehub/icons-static-png 静态资源。
   * 优先 -color 变体(主题无关); openai/grok 无 color 变体, 用 dark/ 版(用户深色主题)。
   * 未匹配 → '' → App 端自动回退文字首字母头像。App ImageLoader 有 LruCache, 只下载一次。 */
  /* v1.1.3: 图标全量本地化 —— lobehub static-svg 包(906 个 svg, 4.5MB)已拉到插件 icons/ 目录,
   *  经本网关 /icon?f= 路由本地分发, 不再依赖外部 CDN (快/离线/零外网流量)。
   *  openai/grok 无 color SVG(mono 是 currentColor 渲染成黑) → 用 static-png 的 dark/ PNG(本地)。 */
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
  /* ---------- 免改代码的快速修正 (2026-09-13 用户要求) ----------
   * 与 server.js 同目录放 avatar-overrides.json:
   *   { "精确模型名": "图标文件.svg", "前缀*": "图标文件.svg", "模型名": "" }
   * 值 = icons/ 目录里的文件名; 空字符串 = 强制文字头像。
   * 优先级: 精确名 > 前缀*(最长优先) > 内置映射。改完保存, 刷新页面即生效(mtime 缓存)。 */
  const ovrCache = { mtime: 0, map: {}, warn: '' };
  /* 宽松解析: 先标准 JSON; 失败则逐行提取 "键": "值" —— 手写文件少个逗号/引号不至于整份失效。
   * 同时把语法问题记到 warn 里, 经 /avatar-rules 暴露出来 (用户能看到哪里写错了)。 */
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

  /* ★纯文本格式 (推荐, 手写不易错): 每行 `前缀* = 图标文件.svg`
   *   # 开头 = 注释; 值留空 = 强制文字头像; 也支持 "键": "值" 这种从 JSON 抄来的写法。 */
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
  /* ★规则行匹配（2026-09-18 扩展）：`前缀*` / `*后缀` / `*包含*` / 精确名 都支持
   *  背景：内置规则是"以…开头"，用户报「x-deepseek-v4-pro 没被 deepseek* 匹配到」——
   *  厂商词出现在名字中间时旧逻辑一律漏掉。现在：①覆盖规则能显式写 `*deepseek*`；
   *  ②内置规则多一层**分词兜底**（见 avatarOf 末尾），两者都是"只在前面全都没命中时才生效"。 */
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
  /** 覆盖规则匹配（对"候选名"逐个试；返回 {file} / null） */
  const ovMatch = (cand) => {
    const ov = overridesOf();
    const keys = Object.keys(ov);
    for (const k of keys) if (String(k).toLowerCase() === cand) return { file: ov[k] };   /* 精确名 */
    let best = null;
    for (const k of keys) {
      if (!ruleHit(k, cand)) continue;
      if (best === null || String(k).length > String(best).length) best = k;             /* 越具体越优先 */
    }
    return best === null ? null : { file: ov[best] };
  };
  const avatarOf = (name, base) => {
    const n = String(name || '').toLowerCase();
    const tail = n.includes('/') ? n.slice(n.lastIndexOf('/') + 1) : '';
    const toks = n.split(/[-_./\s]+/).filter(Boolean);
    /* ★候选名级联（2026-09-18 重排）：全名 → 斜杠后段 → 逐个分词；
     *  每一级都先看**你的覆盖规则**，再看内置表。这样 `dbrx*` 能抓到
     *  `databricks/dbrx-instruct`（斜杠后段），`deepseek*` 能抓到 `x-deepseek-v4-pro`（分词）。
     *  值留空 = 强制用文字头像（命中即返回空串）。 */
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
  /* 查看当前生效规则 (排查用) */
  route('GET', '/avatar-rules', (req, res, p) => {
    jsonRes(res, 200, {
      overrides: overridesOf(),
      warning: ovrCache.warn || '',
      builtIn: AVATAR_MAP.map(([re, file]) => [re.source, file]),
    });
  });

  /* 派生分组的自定义规则(只读): 看当前生效的规则 + 语法提示 —— 对应 group-rules.txt (2026-09-18) */
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
      /* 分组: 管理端显式指定的优先, 否则自定义规则 / 名称前缀推导 */
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

  /** 全部模型(按 渠道 → 模型 顺序) */
  /* ★跨实例聚合(2026-09-12 用户决策): 模型清单来自【所有已启用实例】,
   *   同名模型合并, 记录"可用实例" —— 用户端模型广场一眼看全, 不再被自己路径限制。 */
  const myInst = () => { try { return ctx.getInstanceConfig() || {}; } catch (_) { return {}; } };
  const myInstName = () => myInst().name || 'default';
  const listInstancesSafe = () => {
    try { return (ctx.gateway.listInstances() || []).filter(x => x && x.enabled !== false); }
    catch (_) { return []; }
  };
  const allModels = () => {
    healOrphans();   /* ★每次渲染前轻量自愈(60s 一次): 渠道改名丢的配置能自动找回来, 详见下方 */
    /* ★去重键 = 分组 + 名称 (2026-09-17 修复)
     *   原来只用"模型名"做全局去重键 → 分组/价格/别名**先到先占**, 后到的同名模型
     *   被并进先到的那条, group 字段永不更新 → 管理端把同名模型分到别的分组后,
     *   广场里那个分组永远是 0 个 (用户报「筛选 DeepSeek Official 显示 0 个模型」:
     *   deepseek-v4-pro 先被 default|fake 占位成 Default; deepseek-flash 先被
     *   default|kwxxxllm 的**别名键**占位成 kwxxxllm, DeepSeek 实例的真名模型被吞掉)。
     *   现在: **同名不同分组各出一张卡**(分组本来就是管理员的分类, 也常按来源拆开),
     *   同组同名(如 MotoMoto 的 3 个渠道)仍合并成一张。 */
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
      /* ★各来源价格 (2026-09-17 同批修): 合并后 e.price 取"先到者"会张冠李戴
       *  (fake 渠道的假价盖住官方渠道的真价) → 把每个来源的价格记下来,
       *   详情页逐条列出; 列表卡上提示"价格不一", 不再让人误以为全站都是那个价。 */
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
        /* ★复用 modelsOf: 别的实例也把 modelMap 的别名键算进来(与自身实例对称)。
         *  原来这里只遍历 ch.models → 别名模型在广场里凭空消失(2026-09-17 同批修)。 */
        for (const m of modelsOf(ch, inst.name)) push(m, inst.name);
      }
    }
    for (const e of seen.values()) {
      e.priceDiff = new Set(e.sources.map(s => s.sig)).size > 1;
    }
    return [...seen.values()];
  };

  /* ---------- 孤儿配置自愈 (2026-09-18 用户要求) ----------
   * 背景: meta 键是 `实例名|渠道名|模型名` —— 渠道**改名**后旧键全部对不上号, 该渠道下所有模型的
   *  分组/价格/别名**静默失效**（实测: 猫猫→CatCat 一次丢了 49 条配置, 其中 43 条带价格,
   *  表现为"按名称分组乱成一团""有些渠道没在筛选表里"）。
   * 做法: 键里的渠道名在该实例**已不存在**(或该渠道已不含此模型) 时, 若该实例下**恰好只有一个**
   *  渠道暴露这个模型名 → 自动把配置迁到那个渠道（删旧键、写日志）；多候选/无候选**只记日志不动数据**
   *  （宁可少动, 不可错动）。频率: 60s 最多一次。查看 GET /admin/orphans, 手动重跑 POST /admin/heal-meta。 */
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
  /** dry=true 只扫描不改动(给只读端点用) */
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
      if (ch && namesOf(ch).includes(mName)) continue;                 /* 配置有效 */
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

  /** 该模型对某用户分组是否可见: 渠道 groups 空 = 所有分组都可用 */
  const visibleToGroup = (m, g) => !g || !m.groups.length || m.groups.includes(g);

  /* ---------- 用户分组(读「用户体系」插件的配置) ---------- */
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

  /* ---------- gcui 页面 ---------- */
  /* 筛选芯片: open(GET) 而非 intent —— 游客也能用; 当前筛选随 query 向前携带 */
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

  /* 复制模型名 iconButton */
  const copyBtn = (t, name) => ({
    type: 'iconButton', icon: 'msym:copy', container: 'outlined', size: 34,
    desc: t('复制模型名'), action: { type: 'copy', text: name, toast: t('已复制 {0}', name) },
  });

  /* 返回列表按钮 (详情页/筛选页用) */
  const backBtn = (t, label) => ({
    type: 'button', text: label || t('返回列表'), style: 'tonal', shape: 'pill',
    /* open(不签名) 而不是 intent —— 游客也能返回; 效果与 intent filter{view:main} 等同 */
    /* ★nav:'pop' = 退回上一层再显示列表。否则从"模型详情"点返回列表会再压一层新页面,
     *  再按返回又回到详情(App 端"返回到达的是上一个子页而不是模型广场根页"的根因之一)。 */
    action: { type: 'open', target: 'page:square', nav: 'pop' },
  });

  /* 价格展示 */
  const fmtN = (n) => { const v = Number(n) || 0; return (Math.round(v * 10000) / 10000).toString(); };

  /* ★完整调用名 `实例:渠道:模型名`（2026-09-18 用户要求）
   *  内核侧（src/modelref.js）对**同名冲突**的模型才用这个形态暴露，客户端粘它就能指定来源。
   *  ★渠道/实例名里的**空白统一换成连字符**（`DeepSeek Official` → `DeepSeek-Official`）——
   *    与 src/modelref.js 的 tokenize() 保持一致（插件不能 require 内核模块，只能照抄这 2 行）。 */
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
    const ug = f.ugroup;   /* '' = 不限分组 */

    /* 分组芯片: 管理端定义的分组在前(固定顺序), 其余(按前缀推导的)补在后面 */
    const declared = groupNames();
    const derived = [...new Set(models.map(m => m.group))].filter(g => !declared.includes(g)).sort();
    const groups = declared.concat(derived);
    /* ★提供商芯片覆盖**全部渠道**(2026-09-18): 一条合并卡可能跨多个渠道, 原来只取"首渠道"
     *  → MotoMoto 2 / MotoMoto 3 这种"只作为非首渠道出现"的渠道在筛选表里根本不出现。 */
    const chansOf = (m) => ((m.channels && m.channels.length) ? m.channels : [m.channel]).filter(Boolean);
    const providers = [...new Set(models.flatMap(m => chansOf(m)))].sort();
    /* ★厂商(2026-09-18): 按模型名用 group-rules.txt 自动推导, 与"分组"(管理端配)和"提供商"(渠道名)是独立维度 */
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
    /* 排序: '' 默认 / name 名称 / group 分组 */
    if (f.sort === 'name') shown = shown.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    else if (f.sort === 'group') shown = shown.slice().sort((a, b) => String(a.group).localeCompare(String(b.group)) || String(a.name).localeCompare(String(b.name)));

    /** 应用 patch 后的可见数量(其余维度沿用当前筛选), 给芯片带个数字 */
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
      /* ---------- 筛选页(代替弹窗: intent 返回整页, App 原地换页) ---------- */
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
      /* ★厂商(2026-09-18): 按 group-rules.txt 自动推导, 与"分组""提供商"独立 */
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
      /* ---------- 主页: 概览瘦身 + 可点模型卡 ---------- */
      /* ★顶部卡片(用户指定的样式): 搜索框(回车提交) + 一行 [排序] [视图] [筛选] */
      /* ★2026-10-08 参考管理端设计: 排序/视图从「循环切换」改成**直接可见 chip 组**
       *  (当前态一眼看到 + 直接点目标, 不用连点三下才到想要的档位) —— 用户报「藏得深」。
       *  筛选页保留(全量 8 维度), main 视图补一行常用筛选 chip(分组/供应商/厂商)一步直达。 */
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
              /* ★筛选页是有独立返回语义的子视图 → 压栈(返回键回到模型广场列表, 而不是直接退出广场) */
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
        /* ★分批渲染（2026-09-18 用户报「怎么只显示150个模型」）：默认 150 条，底部给
         *  「再看 N 个」/「一次显示全部」按钮 —— 不再把后面的模型藏起来只说一句"只显示了前 150 个"。 */
        const lim = Math.max(1, Math.min(100000, Number(f.limit) || 150));
        const twoCol = Number(f.cols) === 2;
        const rows = [];
        for (const m of shown.slice(0, lim)) {
          const insts = m.instances || [];
          /* ★渠道显示（2026-09-18 用户要求「能标明渠道是哪一个就行了」）：一条合并卡可能跨多个渠道，
           *  只显示第一个渠道会让人误以为整条都来自那个渠道 → 全部列出（超过 3 个折成 "+N"）。 */
          const chNames = ((m.channels && m.channels.length) ? m.channels : [m.channel]).filter(Boolean);
          const chTxt = chNames.length > 3
            ? chNames.slice(0, 3).join(' / ') + ' +' + (chNames.length - 3)
            : chNames.join(' / ');
          const meta = m.group + ' · ' + chTxt + (insts.length > 1 ? ' · ' + t('{0} 实例', insts.length) : '')
            + (m.priceDiff ? ' · ' + t('价格不一') : '');
          const title = (m.alias ? (m.alias + ' → ' + m.name) : m.name);
          const avatar = { type: 'avatar', url: avatarOf(m.name, base), text: String(m.name).slice(0, 1).toUpperCase(), size: twoCol ? 22 : 26 };
          /* ★窄卡片必须 maxLines:1 —— 否则长模型名会逐字竖排并把卡片撑爆 */
          /* ★卡片快速操作(2026-10-08 参考管理端操作行): 复制完整调用名不用进详情 ——
           *  单列视图卡片底部一行 chip; 双列空间小不加。 */
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
            /* ★带上 group: 同名不同分组的模型是两张卡, 详情必须按"名称+分组"定位,
             *  否则点哪张都进同一份(错的)详情 (2026-09-17) */
            action: { type: 'open', target: 'page:detail?model=' + encodeURIComponent(m.name) + '&group=' + encodeURIComponent(m.group || '') },
            children: kids,
          });
        }
        if (Number(f.cols) === 2) {
          /* 网格视图(两列) */
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
          /* 底部"加载更多"：每次 +150；也给一个"一次显示全部"（条目多时 App 渲染会慢，用户自己选） */
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

  /* 代币符号 (站点资料 serverInfo.currencySymbol; 旧内核无 gateway.serverInfo 时兜底 元) */
  const curSym = () => { try { return (ctx.gateway.serverInfo ? ((ctx.gateway.serverInfo().currencySymbol || '') || '元') : '元'); } catch (_) { return '元'; } };

  /* ---------- 模型详情页(只读, GET /ui/detail 打开, 游客可用) ---------- */
  const buildDetail = (uk, name, base, group) => {
    const { t } = mkT(ctx, uk);
    const models = allModels();
    /* ★按"名称 + 分组"定位 (2026-09-17): 同名不同分组是两张卡, 只按名字找会串台 */
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
      /* ★列出**全部**渠道（2026-09-18）：一条合并卡可能跨渠道，只写第一个渠道会误导 */
      const allCh = ((m.channels && m.channels.length) ? m.channels : [m.channel]).filter(Boolean);
      kv.push({ label: t('提供商(渠道)'), value: allCh.join(' / ') || '—' });
      kv.push({ label: t('协议类型'), value: m.type });
      kv.push({ label: t('可用实例'), value: (m.instances || []).join(' / ') || '—' });
      if (m.groups.length) kv.push({ label: t('用户分组限制'), value: t('仅 {0}', m.groups.join(' / ')) });
      /* ★价格行 (2026-09-18): 合并卡跨多渠道/实例时, m.price 只是"先到者"的价格 ——
       *  若各来源价不一致, 顶部**不再写单值**(会误导成"全站都是这个价"), 只提示逐条看下面;
       *  只有一个来源配了价时仍照常显示(信息无损)。 */
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
      /* ★各来源价格 (2026-09-17 同批修): 同名同组跨渠道合并后, 上面几行只是"先到者"的价格,
       *  真价可能因渠道而异(fake 渠道的假价盖住官方渠道的真价) → 逐条列清楚, 不再误导。
       *  单行紧凑格式(不换行): "fake 1/1 · SenseNova Router 0.9/2.7", 单位写在标签里。 */
      const srcs = (m.sources || []).filter(s => s.price || s.perCall != null);
      if (m.priceDiff && srcs.length > 1) {
        const one = (s) => {
          const nm = String(s.channel || '—').slice(0, 20);
          if (s.price) return nm + ' ' + fmtN(s.price['in']) + '/' + fmtN(s.price.out);
          return nm + ' ' + t('未配价');
        };
        kv.push({ label: t('各来源价格（输入/输出 {0}/1M）', curSym()), value: srcs.slice(0, 4).map(one).join(' · ') + (srcs.length > 4 ? ' …' : '') });
      }
      /* ★完整调用名（2026-09-18 用户要求）：同名冲突时 /v1/models 给出的是 `实例:渠道:模型名`，
       *  这里逐个来源列出来 + 复制按钮 —— 直接粘到 AI 客户端就能精确指定来源，不用自己拼。 */
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

  /* ---------- 路由 ---------- */
  /* 与 auth-cardkey 同源查卡, 拿到 uid → 才能知道用户属于哪个分组 */
  const apis = () => ctx.gateway.authApis();
  const ukOf = (p) => {
    /* ★优先用认证链结果(管理员密钥也能当用户密钥用, 见内核 params.userKey) */
    if (p && p.userKey) return p.userKey;
    const t = (p && p.token) || '';
    if (!t || !apis().findKey) return null;
    let uk = null;
    try { uk = apis().findKey(null, t); } catch (_) { uk = null; }
    return (uk && uk.enable !== false) ? uk : null;
  };

  const baseOf = (req) => 'http://' + ((req && req.headers && req.headers.host) || '127.0.0.1:16484');

  route('GET', '/ui/square', (req, res, p) => {
    /* 游客也能筛/排序/切视图: 状态随 query 携带, 服务端无状态(游客不持久化);
     *  登录用户则持久化到 cfg.filters 以便下次保留。 */
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
      const { t } = mkT(ctx, null);   /* 游客 = 默认语言 */
      page.guest = true;
      page.root.children.unshift({ type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 6, children: [
        { type: 'text', text: t('未登录 · 游客浏览'), style: 'title4' },
        { type: 'text', text: t('可以看模型清单、详情, 也能筛选、排序、切换视图。登录后可调用模型、管理卡密。'), style: 'caption' },
      ] });
    }
    jsonRes(res, 200, page);
  });

  /* 本地图标分发 (无鉴权: 图标是公开静态资源; f 严格白名单防目录穿越) */
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

  /* 给网页端用的 JSON(结构化的筛选数据, 网页自己渲染) */
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

  /* ==================== 管理端: 分组 / 模型元数据 ==================== */

  /* ★2026-09-17「同名模型归并」: 同一实例下，多个渠道(含 modelMap 改名)暴露的同一模型名
   *  在「快速分组」里合并成一张卡。聚合编辑/批量时 channel 传 '*'，服务端展开到该实例下
   *  所有暴露该模型名的渠道，逐个写 metaKey(实例|渠道|模型)。
   *  背景: 之前按 渠道→模型 出卡，同一模型被多个渠道暴露(或经 modelMap 改名后同名)时
   *  会出多张卡，改价/改分组要重复操作，用户报「不便」。 */
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
  /** 该实例下哪些渠道暴露了某模型名(含 modelMap 别名) */
  const chNamesExposing = (instName, modelName) => {
    const m = String(modelName);
    return chsOfInst(instName, uidOfInst(instName))
      .filter(ch => ch && ch.name && namesOf(ch).includes(m))
      .map(ch => ch.name);
  };
  /** 把「按渠道的模型清单」按模型名归并：同名(含 modelMap 改名后同名)合成一项，记录渠道数与差异标记 */
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

  /* ---------- 孤儿配置: 查看 / 手动重跑自愈 (2026-09-18) ---------- */
  route('GET', '/admin/orphans', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const r = scanOrphans(true);   /* 只读扫描, 不改数据 */
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
    healState.at = 0;                     /* 破掉 60s 节流, 立刻重跑 */
    const r = healOrphans();
    jsonRes(res, 200, { ok: true, moved: (r && r.moved) || [], pending: (r && r.pending) || [] });
  });

  /** 模型清单数据（「模型分组」SDUI 页 / 快速分组 / /admin/groups 端点共用同一份口径）
   *  instances[].merged = 同名归并卡（含 channels[] 暴露渠道名 / chCount / diff）；
   *  当前实例的 channels[] 额外带 maps/mapSize（modelMap 改名映射，渠道一览用）。 */
  const groupsData = () => {
    const self = myInstName();
    const insts = [];
    /* 当前实例 */
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
    /* 其它实例 */
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

  /** 模型清单(给「快速分组」页): 按渠道分组 + 每个模型的当前元数据 */
  route('GET', '/admin/groups', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    jsonRes(res, 200, Object.assign({ ok: true }, groupsData()));
  });

  /** 分组增删改 + 单模型 / 批量的分组、名称、价格 */
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
    /** 单模型: {channel, model, group?, alias?, price?, perCall?, rules?}
     *  ★channel='*' = 同名归并编辑：展开到该实例下所有暴露该模型名的渠道 */
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
    /** 批量: {items:[{channel,model}], group?, price?, perCall?, alias?} */
    if (act === 'bulk') {
      const items = Array.isArray(j.items) ? j.items : [];
      if (!items.length) return jsonRes(res, 400, { error: '没有选中模型' });
      let n = 0;
      for (const raw of items) {
        /* ★SDUI 页面的多选是 checkbox 集合（{{selected}} 在渲染期展开成字符串数组）→
         *  这里同时认 "实例|渠道|模型" 字符串与 {instance,channel,model} 对象两种形态。
         *  （模型名里可能有 '|' → 只按前两个分隔符切，剩下全算模型名，与 App 原生页一致） */
        const it = (typeof raw === 'string')
          ? (function () { const a = String(raw).split('|'); return { instance: a[0], channel: a[1], model: a.slice(2).join('|') }; })()
          : raw;
        const ch = String((it && it.channel) || ''), m = String((it && it.model) || '');
        const inst = String((it && it.instance) || j.instance || myInstName());
        if (!ch || !m) continue;
        /* ★channel='*' = 同名归并批量：展开到该实例所有暴露该模型名的渠道 */
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
    /* ★2026-09-17 App 端模型编辑页的「添加规则」（与网页端规则编辑器同一套规则格式/存储，天然互通）。
     *  把「触发类型+操作+值」「效果类型+值」组装成 billing 引擎的 when/then，追加到该模型的 rules。
     *  channel='*' 时展开到该实例所有暴露该名的渠道。 */
    if (act === 'addRule') {
      const ch = String(j.channel || ''), m = String(j.model || '');
      const inst = String(j.instance || myInstName());
      if (!m) return jsonRes(res, 400, { error: '缺少 model' });
      const chList = ch === '*' ? chNamesExposing(inst, m) : [ch];
      if (!chList.length) return jsonRes(res, 400, { error: '该实例下没有渠道暴露这个模型' });
      const trig = String(j.trig || 'none'), op = String(j.op || 'eq');
      const val = j.v == null ? '' : String(j.v);
      const eff = String(j.eff || 'mult'), effVal = String(j.effVal == null ? '' : j.effVal);
      /* 组装触发条件 */
      const when = [];
      const trigK = { model: 'model', ugroup: 'ugroup', hour: 'hour', weekday: 'weekday', ctxLen: 'ctxLen' }[trig];
      if (trig === 'expr') when.push({ k: 'expr', op: 'eq', v: val });
      else if (trig !== 'none' && trigK) {
        let v = val;
        if (op === 'in' || op === 'nin') v = val.split(',').map(s => s.trim()).filter(Boolean);
        else if (op === 'between') v = val.split(',').map(s => Number(s.trim()) || 0).slice(0, 2);
        when.push({ k: trigK, op, v });
      }
      /* 组装效果 */
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
      /* 搜索词 / 排序 / 视图列数 (顶部卡片) */
      if (b.q !== undefined) saveFilter(uk, { q: String(b.q == null ? '' : b.q).slice(0, 60) });
      if (b.sort !== undefined) saveFilter(uk, { sort: ['', 'name', 'group'].includes(String(b.sort)) ? String(b.sort) : '' });
      if (b.cols !== undefined) saveFilter(uk, { cols: Number(b.cols) === 2 ? 2 : 1 });
      /* 无 facet = 只切视图, 不动筛选 */
    }
    const view = String(b.view || 'main') === 'filter' ? 'filter' : 'main';
    /* 同页就地刷新(切视图/排序/搜索/取消筛选) → 不压栈 */
    return { ok: true, nav: 'replace', ui: buildPage(uk, view, baseOf(req)) };
  }));

  /* 模型详情 (点模型卡片 → 只读详情页: 价格/分组/倍率/可用实例) */
  /* 模型详情 GET 版: 游客也能看 (只读元数据, 不需要签名/登录; App 端 open page:detail?model=xxx 走这里) */
  route('GET', '/ui/detail', (req, res, p) => {
    const q = String((req.url || '').split('?')[1] || '');
    const mm = q.match(/(?:^|&)model=([^&]+)/);
    const name = mm ? decodeURIComponent(mm[1]) : '';
    /* ★group: 同名不同分组是两张卡 → 详情按"名称+分组"定位 (2026-09-17; 老链接不带 group 也能用) */
    const mg = q.match(/(?:^|&)group=([^&]+)/);
    const group = mg ? decodeURIComponent(mg[1]) : '';
    if (!name) return jsonRes(res, 400, { error: '需要 model 参数' });
    const uk = ukOf(p);
    jsonRes(res, 200, buildDetail(uk, name, baseOf(req), group));
  });

  /* 模型详情结构化 JSON 版 (网页端用; 游客可用, 只读元数据, data/ 在零额度白名单内) */
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
        /* ★2026-09-17: 同名同组可能跨渠道(价格不一) → 一并给出各来源, 网页端可自行展示 */
        priceDiff: !!m.priceDiff,
        sources: (m.sources || []).map(s => ({ instance: s.instance, channel: s.channel, price: s.price, perCall: s.perCall })),
        /* ★完整调用名（实例:渠道:模型名）—— 同名冲突时 /v1/models 暴露的就是这个形态 (2026-09-18) */
        refs: ((m.sources && m.sources.length) ? m.sources : [{ instance: (m.instances || [])[0] || '', channel: m.channel }])
          .map(s => refOf(s.instance, s.channel, m.name)).filter(Boolean),
        avatarUrl: avatarOf(m.name, baseOf(req)),
      },
    });
  });

  route('POST', '/intent/square/detail', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(ctx, null).t('需要登录') };
    const b = p.body || {};
    /* 模型详情 = 真子页(压栈); 只读 → 允许刷新时重跑 */
    return { ok: true, nav: 'push', ui: buildDetail(uk, String(b.model || ''), baseOf(req), String(b.group || '')), refresh: 'intent' };
  }));

/* model-edit SDUI 页面（由 model-square registerAdminUi 注册，menu:false 子页）
 * 在「快速分组」里点模型卡 → App 打开 /admin/ui/model-edit?instance=...&channel=...&model=...
 * 返回 gcui JSON：表单（别名/分组/按次/价格）+ 规则列表 + 保存/关闭按钮
 * ★设计决策：
 *   - 按次计费用的 switch 砍了——留空 perCall 字段 = 按量计费，填了数值 = 按次（服务端已处理空串→null）
 *   - 分组用文本输入（列出可选分组名做提示）——chip 选择需要 state+setState 联动，弹窗里太重
 *   - ★2026-09-17 规则可在本页直接新增（segmented 标签式 + 提交按钮读 {{input.xxx}}），
 *     与网页端规则编辑器同一套 when/then 格式、同一份存储（model-square meta.rules），天然互通；
 *     删除走 setModel 回写过滤后的 rules 数组。channel='*' 时展开到全部同名渠道。
 *   - 保存只提交表单字段，不碰 rules（setModel 只更新提供的字段 → rules 保留）
 */
  ctx.registerAdminUi({
    id: 'model-edit',
    title: '编辑模型',
    icon: 'edit',
    menu: false,
    render: (gw, c, q, caps) => { refreshCfg();   /* ★多实例一致性: 见顶部 refreshCfg 注释 */
      /* model-square 没有全局 txt/gap/btn 辅助函数（billing 插件才有），这里自己定义 */
      const txt = (text, style, color) => { const o = { type: 'text', text }; if (style) o.style = style; if (color) o.color = color; return o; };
      /* ★能力自检降级 (2026-10-07): caps 由内核注入(registerAdminUi 的 render 第4参数)。
       *  segmented 是较晚加入 gcui 的组件 —— 老 App 不认识会渲染成红色错误块。
       *  这里在**生成页面之前**就问一句"这台 App 认不认 segmented", 不认就用 input 替代
       *  (input 是 gcui 第一版就有的组件, 一定认)。拿不到 caps(网页端) → 用 segmented(不变)。
       *  注意: 内核出口还有一层兜底协商(admin-ui 的 negotiate), 这里只是"更早、更体面地降级"。 */
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

      /* ★2026-09-17 channel='*' = 同名归并编辑：聚合该实例下所有暴露该名的渠道的 meta
       *  （取首个有值的；各渠道不一致时标记 diff 警告）。保存/加规则/删规则都传 channel:'*'，
       *  服务端 setModel/addRule 会展开到每个渠道。背景：之前按渠道出卡，同名模型(含 modelMap
       *  改名)出多张卡，改价/改分组要重复操作。 */
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

      /* ★2026-09-17 添加规则编辑器（state 驱动；与网页端规则编辑器同一套 when/then 格式/存储，天然互通）。
       *  segmented 带 key → 选中值实时写 inputs；input 带 key → TextWatcher 实时写 inputs；
       *  提交按钮的 action 直接用 {{input.xxx}} 读当前选择/输入。提交后 then:'reload'（默认）刷新本页。 */
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


  /* ==================== 「模型分组」页（服务端 SDUI，2026-09-19） ====================
   * 背景：这一页原来只有 App 原生实现（AdminPages.buildModels + 二级页「快速分组」），
   *      每改一次界面都要重编 APK。现在本插件注册 id='models'（与 App 侧菜单 id 一致）
   *      → App 的管理端页面表里「模型分组」指向 /admin/ui/models，改界面只改这里（热重载）。
   * ★回退保底（App 侧三重，原生实现一行未删）：
   *   ① 设置页「管理端使用服务端界面」总开关关掉 → 立即全原生（无需联网/重启）；
   *   ② 本页加载/渲染失败/超时 → App 自动切回原生页并提示（该页 5 分钟内不再重试）；
   *   ③ 「模型分组」页右上角「快速分组」按钮仍是原生页（长按多选 / 底部操作条 / 分组管理）。
   * ★筛选为什么走服务端：SDUI 模板（Template.resolve）只支持 {{路径}} 取值 + truthy 判断，
   *   没有比较运算符，写不出 item.channel == state.ch —— 所以 chip 点击 = open 同页带 query
   *   （nav:'replace' 原地换页，不压栈），服务端过滤后重渲染。代价：每次筛选一次请求 + 重绘。
   * ★多选：checkbox 组件自带多选集合（{{selected}} / {{selectedCount}}）。勾选框不写 action
   *   → 触发原地重渲染（计数与批量动作的 items 重新绑定）。选择跨筛选保留。
   *   批量动作的 items 用 {{selected}}：模板在**渲染期**就从渲染作用域解析成 JSON 数组
   *   （Template.bindJson 把整串模板展开成数组）→ 服务端 bulk 必须同时认 "实例|渠道|模型" 字符串。
   * ★页面 JSON 体积：单页最多渲染 MODELS_PAGE_LIMIT 张卡（193 个模型全渲染太大），其余靠筛选收窄。
   */
  const MODELS_PAGE_LIMIT = 40;      /* ★默认单页卡片数：每张卡 ~8 个原生 View，筛选时整页重建的延迟
                                      *   几乎全在这里（60 张≈500 个 View 仍要让用户等半秒）。
                                      *   默认 40，不够就点「显示更多」（limit += 40）。 */
  const MODELS_LIMIT_STEP = 40;
  const MODELS_LIMIT_MAX = 2000;   /* 「全部显示」用它兜底（真·全部由 all=1 决定，不受档位限制） */

  /** 价格形态：按次 / 有价格 / 未定价（与 App 原生快速分组卡上的徽章口径一致） */
  const priceKindOf = (m) => (m && m.perCall != null) ? 'percall'
    : ((m && m.price && typeof m.price === 'object') ? 'has' : 'none');

  const buildModelsPage = (q, caps) => {
    refreshCfg();
    const get = (k) => { try { return (q && q.get) ? String(q.get(k) || '') : ''; } catch (_) { return ''; } };
    const enc = encodeURIComponent;
    const fInst = get('inst'), fCh = get('ch'), fPrice = get('price'), fGrp = get('grp');
    const kw = get('kw').trim(), kwl = kw.toLowerCase();
    const cols = Math.min(4, Math.max(2, Number(get('cols')) || 2));
    /* limit：单页渲染多少张卡（越小越快）。筛选 chip 的 jump() **不带 limit** —— 换筛选就回到默认值，
     * 免得"先点了几次显示更多、之后每次筛选都重渲染 300 张"。 */
    /* ★all=1 = 「全部显示」状态：一次性渲染完（并**跟着筛选走** —— 用户在 jump() 里会带 all，
     *   否则"点全部显示 → 换个筛选 → 又只剩 40 个"会让人反复点）。 */
    const showAll = get('all') === '1';
    const lim = showAll ? MODELS_LIMIT_MAX
      : Math.min(MODELS_LIMIT_MAX, Math.max(1, Number(get('limit')) || MODELS_PAGE_LIMIT));
    const d = groupsData();
    const insts = Array.isArray(d.instances) ? d.instances : [];
    const self = myInstName();
    const sym = curSym();

    /* ---- gcui 拼装小工具 ---- */
    const txt = (text, style, color) => { const o = { type: 'text', text: text }; if (style) o.style = style; if (color) o.color = color; return o; };
    const gap = (h) => ({ type: 'spacer', height: h || 8 });
    const btn = (text, style, action) => { const o = { type: 'button', text: text, style: style }; if (action) o.action = action; return o; };
    const chip = (text, on, action) => { const o = { type: 'chip', text: text, selected: !!on }; if (action) o.action = action; return o; };
    const badge = (text, tone) => ({ type: 'badge', text: text, tone: tone });
    /* 页面里的写操作统一走内核代调：SDUI 的 adminApi 白名单是 /admin/*，插件端点在 /plugins/<id>/admin/* */
    const call = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
      body: { plugin: 'model-square', path: '/admin/groups', method: 'POST', body: body } });
    const syncCall = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
      body: { plugin: 'model-sync', path: '/admin/run', method: 'POST', body: body } });

    /* ---- 可选项 ---- */
    const instOpts = [], chOpts = [];
    const grpOpts = (d.groups || []).map(g => g.name);
    for (const it of insts) {
      instOpts.push(it.name);
      for (const ch of (it.channels || [])) if (ch.name && chOpts.indexOf(ch.name) < 0) chOpts.push(ch.name);
    }

    /* ---- 同页跳转（筛选 chip / 搜索提交都走它；cols 也走 URL，避免 state 与 URL 两份真相） ---- */
    const mkUrl = (pairs) => {
      const keep = [];
      for (const pair of pairs) {
        const k = pair[0], v = pair[1];
        if (v === undefined || v === null || String(v) === '') continue;
        const s = String(v);
        /* {{...}} 占位符不能编码（要留给 App 在点击时用输入框的值解析） */
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
    /* 「显示更多」：保留当前筛选，只把 limit 往上加一档 */
    const moreUrl = 'page:' + mkUrl([['inst', fInst], ['ch', fCh], ['price', fPrice], ['grp', fGrp], ['kw', kw],
      ['cols', String(cols)], ['limit', String(Math.min(MODELS_LIMIT_MAX, lim + MODELS_LIMIT_STEP))]]);
    const openPage = (path) => ({ type: 'open', target: 'page:' + path, nav: 'push' });

    /* ★Kit(2.70): 双模式构件收进内核 ctx.gcui —— 插件只声明「筛什么」
     *  (state键/URL键/行机器字段/算子/现值), caps 探测与 setState/open 分支全在内核。
     *  field 是行机器字段(数据语义归插件); 新插件要本机筛选 = 声明维度一行事。 */
    const D_INST = { key: 'fInst', url: 'inst', field: 'inst', op: 'eq', cur: fInst };
    const D_CH = { key: 'fCh', url: 'ch', field: 'chs', op: 'has', cur: fCh };
    const D_PRICE = { key: 'fPrice', url: 'price', field: 'kinds', op: 'has', cur: fPrice };
    const D_GRP = { key: 'fGrp', url: 'grp', field: 'groups', op: 'has', cur: fGrp };
    const D_KW = { key: 'fKw', url: 'kw', field: 'hay', op: 'contains', cur: kw };
    const D_COLS = { key: 'cols', url: 'cols', cur: String(cols) };
    const F = ctx.gcui.filters(caps, [D_INST, D_CH, D_PRICE, D_GRP, D_KW], jump);

    /* ---- 过滤：同名合并卡（与原生「快速分组」同一口径） ---- */
    let totalMerged = 0, totalModels = 0, totalCh = 0;
    for (const it of insts) {
      totalMerged += (it.merged || []).length;
      for (const ch of (it.channels || [])) { totalCh++; totalModels += (ch.models || []).length; }
    }
    /* 同名模型在各渠道的形态索引（别名兜底 + 分组/价格种类）
     * ★2026-09-19 用户问「kwxxxllm 与 CatCat 下都有 deepseek-v4.1-flash 怎么办」→ 两条改良：
     *   ① 筛了具体渠道 → 卡片按**该渠道自己的配置**出（点开/批量只动这一条，不再"先到先占"）；
     *   ② 不筛渠道（同名合并卡）→ 筛选改「任一渠道命中即算」(union)，不一致就把各值并排显示。
     * 都不改共享的 mergeModels()，只在本页兜底 —— 避免影响原生页与 /admin/groups 端点。 */
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
      /* ★cond: 不过滤 —— rows 必须是全量池, 本机清筛选后才有行可回来;
       *  inst 维度交给 list.where(item.inst eq state.fInst)。URL 模式照旧服务端过滤。 */
      if (!F.can && fInst && it.name !== fInst) continue;
      const am = aliasIdx[it.name] || {}, vm = variantIdx[it.name] || {};
      /* ---- 模式 A：筛了渠道 → 按该渠道展开（每张卡 = 该渠道自己那一条，点开/批量只改它） ----
       *  ★cond: 不展开 —— 渠道是本机动态筛选, 展开行集固定后清筛选就回不去;
       *  合并卡(chs 集合) + where(chs has fCh) 语义一致, editUrl 本就是 channel=*。 */
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
            /* ★2026-10-08 机器字段(cond where): hay=搜索干(显示文本本地化不能当过滤键),
             *  chs/kinds/groups=渠道/计费种类/分组集合(URL 模式冗余但无害, 两模式口径统一) */
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
      /* ---- 模式 B：不筛渠道 → 同名合并卡（任一渠道命中即算，不一致并排显示） ---- */
      for (const m of (it.merged || [])) {
        const nm = String(m.name || ''), kind = priceKindOf(m), gname = String(m.group || DEFAULT_GROUP);
        const v = vm[nm];
        const kinds = (v && v.kinds.length) ? v.kinds : [kind];
        const groups = (v && v.groups.length) ? v.groups : [gname];
        const chs = (v && v.chs.length) ? v.chs : (m.channels || []);
        /* ★cond: 价格/分组/搜索交本机 where(kinds/groups/hay), 服务端只出全量池 */
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

    /* 模型卡模板（服务端只给数据，卡片只渲染一次模板） */
    const cardTpl = {
      type: 'card', variant: 'outlined', gap: 6,
      action: { type: 'open', target: 'page:{{item.editUrl}}', nav: 'push' },
      /* ★长按卡片 = 选中/取消（App v0.18.43 起支持 toggleSelect 动作）——
       *  与原生「快速分组」页的长按多选手感对齐；勾选框仍然可用。 */
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

    /* ---------- 1. 概览 ---------- */
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

    /* ---------- 2. 筛选 ---------- */
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
    /* ★重置筛选移出 if(filtered): cond 模式过滤发生在本机, 服务端的 filtered 恒 false
     *  (没有 fCh 展开、三连过滤被豁免) —— 靠服务端条件按钮永远不出现。
     *  URL 模式: 行为不变(仍只在已筛选时出现)。 */
    fkids.push({ type: 'hscroll', gap: 6, children: [
      F.reset('重置筛选'),
    ] });
    kids.push({ type: 'card', variant: 'outlined', gap: 8, children: fkids });

    /* ---------- 3. 视图 / 同步 / 管理 ---------- */
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

    /* ---------- 4. 选中与操作（两个入口都做成子页）----------
     * ★2026-09-19 用户实测「勾选和一些按钮还有 1s 左右延迟」→ 主列表页每次筛选都要**整页重建**，
     *   所以把"表单 + 长列表"搬去子页：主页面只剩 概览 + 筛选 + 工具 + 网格（视图数少一半）。
     *   已选计数用 {{selectedCount}} —— App 侧只重绑这一个文本节点，不重建视图树（秒回）。 */
    kids.push({ type: 'card', variant: 'outlined', gap: 8, children: [
      txt('选中与操作', 'title3'),
      txt('勾选卡片右上角的方框、或**长按卡片** = 选中/取消该模型（切换筛选后已选仍保留；没有「全清」，逐个取消即可）。', 'caption', '$onSurfaceVariant'),
      { type: 'hscroll', gap: 6, children: [
        chip('批量操作 · 已选 {{selectedCount}} 个', false, openPage('/admin/ui/model-bulk')),
        chip('渠道一览', false, openPage('/admin/ui/model-channels')),
      ] },
    ] });

    /* ---------- 5. 模型网格 ---------- */
    kids.push(F.can
      ? txt('模型 · 筛选/分页在本机执行', 'title3')
      : txt('模型（显示 ' + shown.length + ' / ' + rows.length
        + (rows.length > shown.length ? '，还有 ' + (rows.length - shown.length) + ' 个未显示' : '') + '）', 'title3'));
    if (!shown.length) {
      kids.push(txt(rows.length ? '（本页没有可显示的行）' : '没有符合筛选条件的模型。', 'body', '$onSurfaceVariant'));
    } else {
      /* ★cond 模式: rows 全量在 state.models 里, 本机按五维过滤; 模式 A(筛渠道展开)
       *  与模式 B(合并卡)的行字段口径一致(label/sub/gText/gTone/pText/pTone/key), 条件通用。
       *  URL 模式: items 已是服务端过滤后的 shown, 行为不变。 */
      kids.push(F.can
        ? { type: 'list', items: '{{state.models}}', columns: '{{state.cols}}', limit: '{{state.limit}}', template: cardTpl,
            /* ★where 由 kit 按 dims 生成(字段=行机器字段, 数据语义归插件); right 空的条件
             *  App 端自动跳过(维度未激活) —— 五维共用一份全量池。 */
            where: F.where() }
        : { type: 'list', items: '{{state.models}}', columns: cols, template: cardTpl });
      /* ★分页(2.69 二轮): 三个 chip 全渲染, 显隐交给 App 按 limit/rowsTotal 数值比较推导
       *  (visible 对象写法) —— 本地 ±limit 后显隐自动跟着变; 服务端烤死的显隐在本地
       *  重渲染下是死值(点了「显示更多」按钮自己不消失)。URL 模式不变。 */
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

    /* ★cond 模式: state = 全量行池 + kit 生成的五维/视图参数初值(键序 = dims 声明序) */
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

  /* ---------- 批量子页（menu:false）：作用于"已选"的模型 ----------
   * 单独一页的理由：① 主列表页要短（每次筛选整页重建）；② 这里的表单用 {{selected}} ——
   * App 端**故意不在渲染期解析**它（见 Renderer.bindAction），而是点击那一刻取实时集合。 */
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

  /* ---------- 渠道一览子页（menu:false）：各实例的渠道 / 模型数 / 改名映射 ---------- */
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
          /* nav:'pop' —— 回到列表页并带上该渠道的筛选（不是再压一层） */
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

  /* 「分组管理」子页（menu:false，从上面页面的 chip 或直链打开） */
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

  /* ★能力注册 (2026-10-07 深度改造 §能力倒置)
   *  以前 billing 硬编码 ctx.getPluginConfig('model-square', 0) —— 换一个插件提供价格就崩,
   *  而且"内核/插件必须知道 model-square 这个名字"这件事本身就是耦合。
   *  现在改成: 本插件把"价格查询"这个能力注册出去, 谁需要就 requireCapability('model-pricing'),
   *  完全不需要知道提供方是谁。字段: price 元/1M tokens, perCall 元/次, group 分组, alias 对外名。
   *  ★必须传 getter 而不是快照: cfg 会被原地刷新(见上面 cfgRevSeen 注释), 快照会读到旧价格。 */
  ctx.provideCapability('model-pricing', {
    /** 取某 实例/渠道/模型 的元数据(含 price/perCall/group/alias); 找不到 → null */
    metaOf: (inst, ch, model) => {
      try {
        const k = [String(inst || ''), String(ch || ''), String(model || '')].join('|');
        return cfg.modelMeta[k] || null;
      } catch (_) { return null; }
    },
    /** 全部元数据 (键 "实例|渠道|模型") —— 消费方自行遍历/回退匹配 */
    allMeta: () => {
      try { return cfg.modelMeta || {}; } catch (_) { return {}; }
    },
    /** 分组清单 [{name, rate}] —— 计费倍率来源 */
    groups: () => {
      try { return Array.isArray(cfg.groups) ? cfg.groups : []; } catch (_) { return []; }
    },
    /** 单次调用价格元数据(元/1M) —— 没配 → null */
    priceOf: (inst, ch, model) => {
      try {
        const k = [String(inst || ''), String(ch || ''), String(model || '')].join('|');
        const m = cfg.modelMeta[k];
        return (m && m.price) || null;
      } catch (_) { return null; }
    },
    /** 版本号: 配置变更时自增, 消费方可用它做缓存失效 */
    rev: () => cfgRevSeen,
  });

  ctx.log('模型广场已激活 (bottomBar 页面 ui=/ui/square) · 已提供能力 model-pricing');
};
