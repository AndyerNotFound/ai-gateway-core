'use strict';
/* admin-ui.js — 管理端 SDUI 页面（gcui v1, 2026-09-15）
 *
 * 为什么有这个文件：
 *   管理端原来是 App 里硬编码的原生页（AdminPages.kt 2694 行），改一次界面就得重编 APK。
 *   现在把页面搬到服务端渲染成 gcui JSON，App 只负责「渲染 + 执行动作」。
 *
 * 安全边界（与 App 侧 SduiController.adminApiScope 配套）：
 *   - 这里渲染的页面只有 App 的**管理端内核页**会加载（GET /admin/ui/<id>，需 x-admin-key）
 *   - App 侧只允许这类页面执行 adminApi（内核页白名单 /admin/），插件页面拿不到
 *   - 页面里**绝不放** adminKey / 上游 apiKey 等敏感字段：页面 JSON 会进 App 内存
 *
 * 回退：页面渲染或加载失败时，App 自动切回原生页（三重回退, 见 gay-core docs/ADMIN-SDUI-PLAN.md）
 */

/* gcui 规范版本（App 的 SduiCapabilities.GCUI_VERSION 低于此值时会拒绝渲染并回退原生） */
const UI_VERSION = 1;

/* ==================== App 能力协商 (2026-10-07 深度改造 §C) ====================
 * 背景: App 的 SduiCapabilities.headers() 一直在上报 X-GCUI-Components / X-GCUI-Icons /
 *   X-GCUI-Version, 但**服务端从来没有任何代码读它们**(全仓只有一处拿 x-gcui-version 判"是不是 App")。
 *   于是契约断在这里: App 上报了能力, 插件却不知道要降级什么 → 真机上渲染成红色错误块。
 * 现在: 服务端按上报能力**主动裁剪/降级**页面, 让插件无需自己适配每一版 App。
 *   拿不到头(网页端/老 App) → caps 为 null, 一切照旧(向后兼容)。
 */
function parseCaps(headers) {
  if (!headers) return null;
  const ver = Number(headers['x-gcui-version']);
  if (!ver) return null;                     // 没上报 → 不做任何裁剪(旧行为)
  const split = k => String(headers[k] || '').split(',').map(x => x.trim()).filter(Boolean);
  const comps = split('x-gcui-components');
  const icons = split('x-gcui-icons');
  const navs = split('x-gcui-nav');
  return {
    version: ver,
    components: comps.length ? new Set(comps) : null,   // null = 未上报具体清单 → 不裁剪
    icons: icons.length ? new Set(icons) : null,
    nav: navs.length ? new Set(navs) : null,
  };
}
/** 图标降级: 白名单外 → 换成通用图标(而不是 App 端静默空白) */
const ICON_FALLBACK = 'apps';
function downgradeIcon(name, caps) {
  if (!caps || !caps.icons) return name;
  const n = String(name || '').replace(/^msym:/, '');
  return caps.icons.has(n) ? name : ICON_FALLBACK;
}
/** 页面裁剪: 递归走 gcui 树 —— 未知组件降级成 text(可读的降级提示), 未知图标换通用图标。
 *  返回 {page, dropped:[]} 便于日志/自检。 */
function downgradePage(node, caps, dropped) {
  if (!caps) return node;
  if (Array.isArray(node)) return node.map(n => downgradePage(n, caps, dropped)).filter(Boolean);
  if (!node || typeof node !== 'object') return node;
  let out = node;
  /* 组件白名单: 未知 → 降级成一行可读文本(App 会渲染成红色错误块, 不如给明确提示) */
  if (node.type && caps.components && !caps.components.has(node.type)) {
    dropped.push(node.type);
    out = {
      type: 'text',
      text: '（此组件需要更新 App：' + node.type + '）',
      style: 'caption',
      color: '$onSurfaceVariant',
    };
  } else {
    out = Object.assign({}, node);
    if (out.icon) out.icon = downgradeIcon(out.icon, caps);
    /* nav 模式降级: 不支持的 nav → 去掉(旧 App 按默认规则走, 不会坏) */
    if (out.action && out.action.nav && caps.nav && !caps.nav.has(out.action.nav)) {
      out.action = Object.assign({}, out.action); delete out.action.nav;
    }
  }
  if (out.children) out.children = downgradePage(out.children, caps, dropped);
  if (out.template) out.template = downgradePage(out.template, caps, dropped);
  return out;
}
/** 供插件自检用的能力视图 (2026-10-07): 只暴露"能用什么", 不暴露内部集合。
 *  ctx.clientCaps() 返回它 —— 插件可在渲染前先问"这台 App 认不认我要用的组件"。
 *  拿不到头(网页端/旧 App) → null(插件应回退到"按最保守写法渲染")。 */
function capsView(caps) {
  if (!caps) return null;
  return {
    version: caps.version,
    /** 组件白名单(数组); 未上报具体清单 → null(= 不做限制) */
    components: caps.components ? [...caps.components] : null,
    icons: caps.icons ? [...caps.icons] : null,
    nav: caps.nav ? [...caps.nav] : null,
    /** 支持某组件? 未上报清单 → 一律 true(不限制) */
    hasComponent: (t) => !caps.components || caps.components.has(String(t || '')),
    /** 支持某图标?(自动去 msym: 前缀) 未上报 → true */
    hasIcon: (i) => !caps.icons || caps.icons.has(String(i || '').replace(/^msym:/, '')),
    /** 支持某导航模式? 未上报 → true */
    hasNav: (n) => !caps.nav || caps.nav.has(String(n || '')),
    /** 从组件列表里挑出本 App 认识的(插件可据此决定渲染哪几个) */
    pick: (list) => (Array.isArray(list) ? list : []).filter(t => !caps.components || caps.components.has(String(t || ''))),
  };
}

/** 对整页做能力协商; caps 为 null → 原样返回(零开销、零行为变化) */
function negotiate(page, caps) {
  if (!caps || !page || !page.root) return page;
  const dropped = [];
  const root = downgradePage(page.root, caps, dropped);
  if (dropped.length) {
    /* 明确告知(而不是静默降级): 让管理员知道"这页在旧 App 上少了什么" */
    const uniq = [...new Set(dropped)];
    root.children = (root.children || []).concat([{
      type: 'text', style: 'caption', color: '$onSurfaceVariant',
      text: '（已按当前 App 版本降级，暂不支持：' + uniq.join('、') + '）',
    }]);
  }
  return Object.assign({}, page, { root });
}

/* ==================== 组件小工具 ==================== */
/* ★2026-10-08 多语言治本(用户报「英文语言下还是几乎全是中文」):
 *  内核页 107 处文案硬编码中文 + dict-seed 的 en 只覆盖 3/24 内核页 key。
 *  治本 = 模块级 _t(render 时从 i18n bundle 取, 失败回退恒等) + txt/chip 助手过 _t()。 */
let _t = (s) => (typeof s === 'string' ? s : s);
const txt = (text, style, color) => {
  text = _t(text);
  const o = { type: 'text', text };
  if (style) o.style = style;
  if (color) o.color = color;
  return o;
};
const gap = h => ({ type: 'spacer', height: h });
const kv = (label, value) => ({ type: 'kv', label: label, value: value });
const badge = (text, tone) => ({ type: 'badge', text: text, tone: tone });
const tile = (value, label) => ({ type: 'metricTile', value: value, label: label, weight: 1 });
const btn = (text, style, action, extra) =>
  Object.assign({ type: 'button', text: text, style: style, action: action }, extra || {});

/** 药丸小按钮（原生实例卡的按钮就是 chip，比大按钮紧凑得多） */
const chip = (text, icon, action, extra) => {
  text = _t(text);
  const o = { type: 'chip', text: text };
  if (icon) o.icon = 'msym:' + icon;
  if (action) o.action = action;
  return Object.assign(o, extra || {});
};

/* 确认文案统一加一句"操作对象"，避免误点 */
const confirmText = s => s + '\n\n（该操作立即生效）';

/* ==================== 实例页 ==================== */
function buildInstances(gw, cfg) {
  let reqs = 0, errs = 0;
  const insts = (gw.store.index.instances || []).map(m => {
    const ic = gw.pool.instances.get(m.uid) || {};
    const s = ic._stats || {};
    const running = gw.pool.instances.has(m.uid);
    const enabled = m.enabled !== false;
    const current = m.name === cfg._name;
    reqs += Number(s.requests) || 0;
    errs += Number(s.errors) || 0;
    return {
      uid: m.uid,
      name: m.name,
      port: m.port || 0,
      running: running,
      enabled: enabled,
      current: current,
      statusText: running ? '运行中' : (enabled ? '未运行' : '已停用'),
      statusTone: running ? 'success' : (enabled ? 'warning' : 'neutral'),
      reqErr: (Number(s.requests) || 0) + ' / ' + (Number(s.errors) || 0),
      /* 紧凑版：把端口/UID/请求合并成一行说明；子页 URL 服务端预生成 */
      meta: '端口 ' + (m.port || 0) + ' · UID ' + m.uid + ' · 请求/错误 ' +
        (Number(s.requests) || 0) + '/' + (Number(s.errors) || 0) +
        (running ? '' : ' · 未占用内存'),
      detailUrl: '/admin/ui/instance-detail?uid=' + m.uid,
      editUrl: '/admin/ui/instance-edit?uid=' + m.uid,
      canSwitch: !current,
      canStart: !running,
      canStop: running,
    };
  });

  /* ★实例卡片模板：list 的 template，`{{item.xxx}}` 指向当前实例 */
  const instCard = {
    type: 'card',
    variant: 'outlined',
    gap: 6,
    children: [
      {
        type: 'row', gap: 8, children: [
          Object.assign(txt('{{item.name}}', 'title3'), { weight: 1 }),
          badge('{{item.statusText}}', '{{item.statusTone}}'),
        ],
      },
      txt('{{item.meta}}', 'caption', '$onSurfaceVariant'),
      Object.assign(txt('✓ 当前管理实例', 'caption', '$primary'), { visible: '{{item.current}}' }),
      /* 多选（勾中的 uid 进入 {{selected}}；没写 action 时 App 会自己刷新计数） */
      { type: 'checkbox', value: '{{item.uid}}', label: '选择' },
      {
        type: 'row', gap: 6, children: [
          chip('用这个', 'check', { type: 'client', action: 'switchInstance', value: '{{item.name}}' }, { visible: '{{item.canSwitch}}' }),
          chip('启动', 'check', { type: 'adminApi', method: 'POST', path: '/admin/api/instance/{{item.uid}}/enable', body: { enable: true } }, { visible: '{{item.canStart}}' }),
          chip('停止', 'block', { type: 'adminApi', method: 'POST', path: '/admin/api/instance/{{item.uid}}/enable', body: { enable: false } }, { visible: '{{item.canStop}}' }),
          chip('重载', 'refresh', { type: 'adminApi', method: 'POST', path: '/admin/api/instance/{{item.uid}}/reload' }),
        ],
      },
      {
        type: 'row', gap: 6, children: [
          chip('详情', 'info', { type: 'open', target: 'page:{{item.detailUrl}}' }),
          chip('编辑', 'edit', { type: 'open', target: 'page:{{item.editUrl}}' }),
          chip('删除', 'delete', {
            type: 'adminApi', method: 'DELETE', path: '/admin/api/instance/{{item.uid}}',
            confirm: '确定删除「{{item.name}}」？\n\n实例配置会一并移除，无法恢复。',
          }),
        ],
      },
    ],
  };

  return {
    title: '网关实例',
    state: {
      instances: insts,
      count: insts.length,
      running: insts.filter(i => i.running).length,
      requests: reqs,
      errors: errs,
    },
    root: {
      type: 'column',
      gap: 10,
      children: [
        txt('网关实例', 'title3'),
        txt('单进程托管全部实例，各自独立端口与路径前缀', 'caption', '$onSurfaceVariant'),
        {
          type: 'row', gap: 8, children: [
            tile('{{state.count}}', '实例总数'),
            tile('{{state.running}}', '运行中'),
            tile('{{state.requests}}', '总请求'),
          ],
        },
        gap(6),
        txt('实例列表', 'title3'),
        txt('共 {{state.count}} 个 · 错误 {{state.errors}}', 'caption', '$onSurfaceVariant'),
        {
          type: 'list',
          items: '{{state.instances}}',
          columns: 1,
          template: instCard,
        },
        gap(6),
        txt('批量操作', 'title3'),
        txt('勾选实例后点「启动选中 / 停止选中」；不勾 = 作用于全部', 'caption', '$onSurfaceVariant'),
        txt('已选 {{selectedCount}} 个', 'caption', '$primary'),
        {
          type: 'row', gap: 10, children: [
            btn('启动选中', 'tonal',
              { type: 'adminApi', method: 'POST', path: '/admin/api/instance/batch', body: { enable: true, uids: '{{selected}}' } },
              { weight: 1, confirm: confirmText('将对**已勾选的**实例执行「启动」') }),
            btn('停止选中', 'tonal',
              { type: 'adminApi', method: 'POST', path: '/admin/api/instance/batch', body: { enable: false, uids: '{{selected}}' } },
              { weight: 1, confirm: confirmText('将对**已勾选的**实例执行「停止」') }),
          ],
        },
        {
          type: 'row', gap: 10, children: [
            btn('全部启动', 'outlined',
              { type: 'adminApi', method: 'POST', path: '/admin/api/instance/batch', body: { enable: true } },
              { weight: 1, confirm: confirmText('将对**所有实例**执行「启动」') }),
            btn('全部停止', 'outlined',
              { type: 'adminApi', method: 'POST', path: '/admin/api/instance/batch', body: { enable: false } },
              { weight: 1, confirm: confirmText('将对**所有实例**执行「停止」') }),
          ],
        },
        gap(4),
        btn('新建实例', 'filled',
          { type: 'open', target: 'page:/admin/ui/instance-new' }),
      ],
    },
  };
}

/* ==================== 使用统计页（2026-09-18 重做：时段 / 折点粒度 / 持久历史） ==================== */
/* 数据分两层（页面底部会向用户说明，别让用户以为每块都跟随时段）：
 *   ① 曲线 + 指标卡 = **持久历史**（usage-history.js：小时桶永久、10 分钟桶 30 天）
 *      → 可查任意时段、重启网关不丢；
 *   ② 渠道排行 / 最近请求 = 内存 `_stats`（各实例最近 200 条明细、重启清空）
 *      → 没有渠道×时间的历史维度，只能"自启动累计"。
 * 交互：切时段/粒度走 `open` + **同页换 query** → App 端判为"同页就地刷新"，不压栈
 *   （见 SduiController 内联导航语义）。两端页面路径不同（管理端 /admin/ui/usage、
 *   用户端 /ui/usage），所以 base 由 core.js 通过 render 的 ctx 传进来。
 * ★gcui 模板只认**纯路径**（`{{state.x}}`），不认 `{{a=='b'}}` 这种表达式
 *   → 选中态一律由服务端在 state 里算好纯值（spanA/spanB 为空即"本行无选中"）。
 */
const usageHist = require('./usage-history');

const U_HOUR = 3600000;
/** 本地时区偏移（毫秒）：**展示/输入用本地时间**，存储桶一律 UTC */
function uTzMin() { return -new Date().getTimezoneOffset(); }
/** 毫秒 → 本地 'YYYY-MM-DD HH:MM' */
function uLocal(ms) {
  const s = new Date(ms + uTzMin() * 60000).toISOString();
  return s.slice(0, 10) + ' ' + s.slice(11, 16);
}
/** 毫秒 → 本地 'HH:MM:SS'（最近请求列表） */
function uLocalTime(ms) {
  return new Date(ms + uTzMin() * 60000).toISOString().slice(11, 19);
}
/** 用户输入（本地时间）→ 毫秒；接受 '2026-09-18 08' / '2026-09-18T08:30' / '2026-09-18' */
function uParseLocal(v) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2})(?::(\d{1,2}))?)?/.exec(String(v || '').trim());
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0) - uTzMin() * 60000;
}
const U_SPANS = ['1h', '6h', '24h', '7d', 'today', 'yesterday', 'all', 'custom'];
const U_GRANS = ['min10', 'min30', 'hour', 'day'];
const U_GRAN_TEXT = { min10: '10 分钟', min30: '30 分钟', hour: '1 小时', day: '1 天' };
const U_SPAN_A = [{ value: '1h', text: '近 1 小时' }, { value: '6h', text: '近 6 小时' }, { value: '24h', text: '近 24 小时' }, { value: '7d', text: '近 7 天' }];
const U_SPAN_B = [{ value: 'today', text: '今天' }, { value: 'yesterday', text: '昨天' }, { value: 'all', text: '全部' }, { value: 'custom', text: '自定义' }];
const U_GRAN_OPTS = [{ value: 'min10', text: '10 分' }, { value: 'min30', text: '30 分' }, { value: 'hour', text: '小时' }, { value: 'day', text: '天' }];

/** 分段选择器：点击时把 value 写进 inputs[key]（Renderer.segmented 行为），动作里用 {{input.<key>}} 取 */
const seg = (key, options, selected, action) => ({ type: 'segmented', key: key, options: options, selected: selected, action: action });

/** 时段 → [fromMs, toMs]（本地语义）；非法输入回退默认窗口，绝不抛错 */
function uResolveRange(span, q, now, keyId) {
  const dayStart = (ms) => { const d = new Date(ms + uTzMin() * 60000); d.setUTCHours(0, 0, 0, 0); return d.getTime() - uTzMin() * 60000; };
  switch (span) {
    case '1h': return { from: now - U_HOUR, to: now };
    case '6h': return { from: now - 6 * U_HOUR, to: now };
    case '7d': return { from: now - 7 * 24 * U_HOUR, to: now };
    case 'today': return { from: dayStart(now), to: now };
    case 'yesterday': { const y = dayStart(now) - 24 * U_HOUR; return { from: y, to: y + 24 * U_HOUR - 1 }; }
    case 'all': { const r = usageHist.range(keyId); return { from: r.minMs || (now - 24 * U_HOUR), to: now }; }
    case 'custom': {
      const f = uParseLocal(q.get('from')), t = uParseLocal(q.get('to'));
      /* 输入精确到小时 → 该小时整段都算进去（+59:59.999） */
      if (f && t && t >= f) return { from: f, to: t + U_HOUR - 1 };
      const r = usageHist.range(keyId); return { from: r.minMs || (now - 24 * U_HOUR), to: now };
    }
    default: return { from: now - 24 * U_HOUR, to: now };
  }
}

function buildUsage(gw, cfg, q, ctx) {
  const ic = gw.pool.instances.get(cfg._uid);
  const base = (ctx && ctx.base) || '/admin/ui/usage';
  /* ★按用户隔离（2026-09-18）：ctx.scope = { keyId, name }，由 core.js 从**请求自带的卡密**解析
   *   （只有用户端 /ui/usage 会带；管理端 /admin/ui/usage 不带 = 全站视图，行为不变）。
   *   为什么：用户端页面以前忽略请求里的卡密，任何持卡用户打开都看到**全站**请求
   *   —— 表现为"另一个从没调用过的用户也能看到请求"。 */
  const scope = (ctx && ctx.scope) || null;
  const meKey = (scope && scope.keyId) ? String(scope.keyId) : '';
  const meMode = !!meKey;
  const meName = (scope && scope.name) || '';
  /* ★身份不明（卡密无效/过期/没带凭证）→ **隐藏统计**，绝不退回全站视图：
   *   否则"卡密失效的用户"反而能看到别人的请求（安全默认 = 宁可不给）。 */
  if (scope && scope.denied) {
    return {
      title: '使用统计',
      state: { upMin: 0 },
      root: {
        type: 'column', gap: 10, children: [
          txt('使用统计', 'title3'),
          txt('无法识别你的身份（卡密无效、已过期或未登录），已隐藏统计。请在 App「站点信息」里检查卡密后重试。', 'body', '$onSurfaceVariant'),
        ],
      },
    };
  }
  if (!ic) {
    return {
      title: '使用统计',
      state: { upMin: 0 },
      root: {
        type: 'column', gap: 10, children: [
          txt('使用统计', 'title3'),
          txt('该实例当前未运行，没有统计数据。', 'caption', '$onSurfaceVariant'),
          btn('去实例页启动', 'tonal', { type: 'client', action: 'openNative', value: 'instances' }),
        ],
      },
    };
  }

  const qq = (q && typeof q.get === 'function') ? q : new URLSearchParams();
  const span = U_SPANS.indexOf(qq.get('span')) >= 0 ? qq.get('span') : '24h';
  const gran = U_GRANS.indexOf(qq.get('g')) >= 0 ? qq.get('g') : 'hour';
  const now = Date.now();
  const rg = uResolveRange(span, qq, now, meMode ? meKey : undefined);

  /* ★default 聚合全实例(§45)：跨实例路由的请求计入**目标实例**的 _stats，
   *   只看 cfg._uid 会漏掉它们。历史桶同样要按多 uid 合并查。
   *   ★meMode（用户端）时历史桶改查 **per-key 桶**（queryMany 的第 5 参 keyId）。 */
  const isDef = cfg._name === 'default';
  const targets = isDef ? [...gw.pool.instances.values()].filter(x => x) : [ic];
  const uids = targets.map(x => x._uid);
  const hist = usageHist.queryMany(uids, rg.from, rg.to, gran, meMode ? meKey : undefined);
  const series = hist.series.map(x => ({ label: x.label, count: x.count, errors: x.errors }));
  const peak = series.reduce((m, x) => (x.count > m ? x.count : m), 0);
  const sum = series.reduce((a, x) => a + x.count, 0);
  const avg = series.length ? Math.round((sum / series.length) * 10) / 10 : 0;

  /* ---- 内存侧（渠道排行 / 最近请求 / 运行时长）---- */
  let startMs = 0; const allRecent = []; const byChMap = {};
  let myCharged = 0;
  for (const tt of targets) {
    const s = (tt && tt._stats) || {};
    if (meMode) {
      /* ★只看自己的：累计量取 stats.byKey[<keyId>]，明细取 recent 里 keyId 相同的那些 */
      const b = (s.byKey || {})[meKey];
      if (b) {
        const st0 = b.startedAt ? new Date(String(b.startedAt).replace(' ', 'T') + 'Z').getTime() : 0;
        if (st0 && (!startMs || st0 < startMs)) startMs = st0;
        myCharged += Number(b.chargedTokens) || 0;
        for (const [name, v] of Object.entries(b.byChannel || {})) {
          const dst = byChMap[name] || (byChMap[name] = { requests: 0, inputTokens: 0, outputTokens: 0 });
          dst.requests += v.requests || 0; dst.inputTokens += v.inputTokens || 0; dst.outputTokens += v.outputTokens || 0;
        }
      }
      for (const r of (s.recent || [])) if (r.keyId === meKey) allRecent.push(r);
      continue;
    }
    const st = s.startedAt ? new Date(String(s.startedAt).replace(' ', 'T') + 'Z').getTime() : 0;
    if (st && (!startMs || st < startMs)) startMs = st;
    for (const [name, v] of Object.entries(s.byChannel || {})) {
      const key = (isDef && targets.length > 1) ? (tt._name + ' / ' + name) : name;
      const dst = byChMap[key] || (byChMap[key] = { requests: 0, inputTokens: 0, outputTokens: 0 });
      dst.requests += v.requests || 0; dst.inputTokens += v.inputTokens || 0; dst.outputTokens += v.outputTokens || 0;
    }
    for (const r of (s.recent || [])) allRecent.push(isDef ? Object.assign({}, r, { instance: tt._name }) : r);
  }
  const byChannel = Object.entries(byChMap)
    .map(([name, v]) => ({
      name: name,
      reqs: Number(v.requests) || 0,
      tok: (Number(v.inputTokens) || 0) + ' / ' + (Number(v.outputTokens) || 0),
    }))
    .sort((a, b) => b.reqs - a.reqs)
    .slice(0, 10);
  /* 最近请求：明细只在内存里 → **按所选时段过滤**（时段超出内存范围时就是空，页面会说明） */
  const recent = allRecent
    .map(r => ({ r: r, ms: new Date(String(r.time || '').replace(' ', 'T') + 'Z').getTime() }))
    .filter(x => isFinite(x.ms) && x.ms >= rg.from && x.ms <= rg.to)
    .sort((a, b) => a.ms - b.ms)
    .slice(-20).reverse()
    .map(x => ({
      time: uLocalTime(x.ms),
      model: String(x.r.model || x.r.channel || '-').slice(0, 36),
      status: String(x.r.status == null ? '' : x.r.status),
      tone: Number(x.r.status) >= 400 ? 'error' : 'success',
    }));
  const upMin = startMs ? Math.round((now - startMs) / 60000) : 0;

  const isCustom = span === 'custom';
  const granNote = hist.covered ? U_GRAN_TEXT[hist.gran] : (U_GRAN_TEXT[hist.asked] + ' → 自动降为 ' + U_GRAN_TEXT[hist.gran]);
  const state = {
    span: span,
    gran: hist.gran,
    /* 两行分段控件各自的高亮值：不在本行 → 空串（该行无高亮） */
    spanA: U_SPAN_A.some(o => o.value === span) ? span : '',
    spanB: U_SPAN_B.some(o => o.value === span) ? span : '',
    series: series,
    rangeText: uLocal(rg.from) + ' ~ ' + uLocal(rg.to) + '（本地时间）',
    granText: granNote,
    buckets: series.length,
    inFrom: isCustom ? uLocal(rg.from) : '',
    inTo: isCustom ? uLocal(rg.to) : '',
    req: hist.total.r,
    err: hist.total.e,
    tokIn: hist.total.i,
    tokOut: hist.total.o,
    charged: Math.round(hist.total.c * 1e6) / 1e6,
    peak: peak,
    sum: sum,
    avg: avg,
    upMin: upMin,
    channels: byChannel,
    recent: recent,
    hasChannels: byChannel.length > 0,
    meMode: meMode,
    scopeName: meName,
    /* 第三个指标卡：管理端看"运行时长"，用户端那没意义 → 换成他自己的累计计费量 */
    tile3: meMode ? (Math.round(myCharged * 1e6) / 1e6) : upMin,
    tile3Label: meMode ? '计费(自启动)' : '运行(分)',
    memNote: meMode
      ? '明细来自内存（最近 200 条，重启网关后清空）'
      : '渠道排行 / 最近请求来自内存（各实例最近 200 条，重启网关后清空）',
    histNote: meMode
      ? '曲线与指标只统计你发起的请求：小时桶永久保存 · 10 分钟桶保留 30 天'
      : '曲线与指标来自持久历史：小时桶永久保存 · 10 分钟桶保留 30 天',
  };

  /* ★2026-09-18: target 必须带 `page:` 协议前缀 —— App 端 open 动作只认
   *   `page:` / `http(s)://`，裸路径会被判「未知页面: /ui/usage?span=…」直接丢弃。
   *   （GCUI 的导航协议：换页/换 query 一律 page:<path>[?query]，见 SduiController.dispatch） */
  const openTo = (qs) => ({ type: 'open', nav: 'replace', target: 'page:' + base + '?' + qs });

  return {
    title: meMode ? '我的使用统计' : '使用统计',
    state: state,
    root: {
      type: 'column', gap: 10, children: [
        txt(meMode ? '我的使用统计' : '使用统计', 'title3'),
        ...(meMode ? [txt('只统计「' + (meName || '当前卡密') + '」发起的请求。管理端「使用」页可查看全站统计。', 'caption', '$onSurfaceVariant')] : []),
        txt('{{state.rangeText}}', 'caption', '$onSurfaceVariant'),
        /* ---- 时段：两行分段（一行 4 个，避免 7 个选项在手机上挤成一团）---- */
        seg('spanA', U_SPAN_A, '{{state.spanA}}', openTo('span={{input.spanA}}&g={{state.gran}}')),
        seg('spanB', U_SPAN_B, '{{state.spanB}}', openTo('span={{input.spanB}}&g={{state.gran}}')),
        ...(isCustom ? [
          {
            type: 'row', gap: 8, children: [
              Object.assign({ type: 'input', key: 'cfrom', label: '起（如 2026-09-18 08）', value: '{{state.inFrom}}' }, { weight: 1 }),
              Object.assign({ type: 'input', key: 'cto', label: '止（含该小时）', value: '{{state.inTo}}' }, { weight: 1 }),
            ],
          },
          btn('应用时段', 'tonal', openTo('span=custom&from={{input.cfrom}}&to={{input.cto}}&g={{state.gran}}')),
        ] : []),
        /* ---- 折点粒度（动态缩放：桶少 = 折点密，桶多 = 自动变稀）---- */
        txt('折点粒度', 'caption', '$onSurfaceVariant'),
        seg('granSel', U_GRAN_OPTS, '{{state.gran}}', openTo('span={{state.span}}&g={{input.granSel}}')),
        gap(4),
        /* ---- 指标卡（跟随时段）---- */
        {
          type: 'row', gap: 8, children: [
            tile('{{state.req}}', '请求'),
            tile('{{state.err}}', '错误'),
            tile('{{state.tile3}}', meMode ? '计费(自启动)' : '运行(分)'),
          ],
        },
        txt('时段内 token：输入 {{state.tokIn}} / 输出 {{state.tokOut}} · 计费量 {{state.charged}}', 'caption', '$onSurfaceVariant'),
        gap(4),
        txt('请求量（{{state.buckets}} 个点 · {{state.granText}}）', 'title3'),
        { type: 'chart', kind: 'line', items: '{{state.series}}', x: 'label', y: 'count', height: 150, yTicks: 4, yMax: 'auto', xLabels: true },
        txt('峰值 {{state.peak}} · 合计 {{state.sum}} · 每点均值 {{state.avg}}', 'caption', '$onSurfaceVariant'),
        gap(6),
        txt(meMode ? '我的渠道排行（自启动累计）' : '渠道排行（自启动累计）', 'title3'),
        ...(byChannel.length ? [{
          type: 'list', items: '{{state.channels}}', columns: 1, template: {
            type: 'card', variant: 'outlined', children: [
              {
                type: 'row', gap: 8, children: [
                  Object.assign(txt('{{item.name}}', 'body'), { weight: 1 }),
                  badge('{{item.reqs}} 次', 'primary'),
                ],
              },
              kv('输入 / 输出 token', '{{item.tok}}'),
            ],
          },
        }] : [txt(meMode ? '你还没有渠道请求记录。' : '还没有渠道请求记录。', 'caption', '$onSurfaceVariant')]),
        gap(6),
        txt(meMode ? '我的最近请求（所选时段内）' : '最近请求（所选时段内）', 'title3'),
        ...(recent.length ? [{
          type: 'list', items: '{{state.recent}}', columns: 1, template: {
            type: 'row', gap: 8, children: [
              badge('{{item.status}}', '{{item.tone}}'),
              Object.assign(txt('{{item.model}}', 'caption'), { weight: 1 }),
              txt('{{item.time}}', 'caption', '$onSurfaceVariant'),
            ],
          },
        }] : [txt(meMode ? '该时段内你还没有请求明细（明细只保留最近 200 条）。' : '该时段内没有请求明细（明细只保留最近 200 条，更早的时段只有曲线统计）。', 'caption', '$onSurfaceVariant')]),
        gap(8),
        txt('{{state.histNote}}', 'caption', '$onSurfaceVariant'),
        txt('{{state.memNote}}', 'caption', '$onSurfaceVariant'),
      ],
    },
  };
}

/* ==================== 渠道页 ==================== */

/** 当前实例配置（loadInstance 不在时给空对象，便于测试桩） */
function instCfg(gw, uid) {
  return (typeof gw.store.loadInstance === 'function') ? (gw.store.loadInstance(uid) || {}) : {};
}

/** 实例路径前缀（非 default 实例的插件路由要带 /<name> 前缀） */
function instPrefix(cfg) {
  return (cfg && cfg._name && cfg._name !== 'default') ? '/' + cfg._name : '';
}

/* 探测成功率缓存 —— probe 插件是异步的，而页面渲染必须**同步**（gcui 契约）。
 * 策略：读上次结果 + 后台刷新。首次打开可能还没成功率，刷新一下就有；
 * 好处是整页不会为了一个 badge 去等 HTTP（probe 没装时也不拖慢页面）。 */
const rateCache = { uid: 0, at: 0, data: null, busy: false };

async function refreshRates(gw, cfg) {
  if (rateCache.busy || typeof gw.selfReq !== 'function') return;
  rateCache.busy = true;
  try {
    const st = await gw.selfReq(cfg, 'GET', instPrefix(cfg) + '/plugins/probe/status', null, 2000);
    if (st && st.channels && typeof st.channels === 'object') rateCache.data = st.channels;
    rateCache.uid = cfg._uid;
    rateCache.at = Date.now();
  } finally {
    rateCache.busy = false;
  }
}

function buildChannels(gw, cfg) {
  const uid = cfg._uid;
  const c = instCfg(gw, uid);
  const channels = Array.isArray(c.channels) ? c.channels : [];
  const rates = (rateCache.uid === uid) ? rateCache.data : null;
  if (Date.now() - rateCache.at > 15000) refreshRates(gw, cfg);   /* 后台刷，不等待 */

  const list = channels.map((ch, i) => {
    const nm = String(ch.name || '?');
    const rt = (rates && rates[nm] && rates[nm].rate != null) ? Number(rates[nm].rate) : null;
    const models = Array.isArray(ch.models) ? ch.models.length : 0;
    const maps = (ch.modelMap && typeof ch.modelMap === 'object') ? Object.keys(ch.modelMap).length : 0;
    return {
      idx: i,
      name: nm,
      type: String(ch.type || 'openai'),
      baseUrl: String(ch.baseUrl || ''),
      defaultText: ch.default ? '默认' : '',
      rateText: rt == null ? '' : (rt + '% 成功率'),
      rateTone: (rt != null && rt < 80) ? 'error' : 'neutral',
      summary: '模型 ' + models + ' 个 · 分组 ' + maps + ' 条' +
        (ch.useResponses ? ' · ⚡Responses' : '') +
        (ch.proxy ? ' · 代理 ' + ch.proxy : '') +
        (ch.insecure ? ' · 跳过证书校验' : ''),
      /* ★URL 在服务端就编码好：渠道名可能是中文，App 直接拼进 URL 会报非法地址 */
      editUrl: '/admin/ui/channel-edit?name=' + encodeURIComponent(nm),
    };
  });

  const card = {
    type: 'card',
    variant: 'outlined',
    children: [
      {
        type: 'row', gap: 6, children: [
          Object.assign(txt('{{item.name}}', 'title3'), { weight: 1 }),
          badge('{{item.defaultText}}', 'primary'),
          badge('{{item.type}}', '{{item.rateTone}}'),
        ],
      },
      txt('{{item.baseUrl}}', 'caption', '$onSurfaceVariant'),
      txt('{{item.summary}}', 'caption', '$onSurfaceVariant'),
      Object.assign(txt('{{item.rateText}}', 'caption', '$primary'), { visible: '{{item.rateText}}' }),
      gap(6),
      {
        type: 'row', gap: 8, children: [
          btn('编辑', 'tonal',
            { type: 'open', target: 'page:{{item.editUrl}}' },
            { weight: 1 }),
          btn('同步模型', 'text',
            {
              type: 'adminApi', method: 'POST',
              path: '/admin/api/instance/' + uid + '/channel-action',
              body: { action: 'sync', channel: '{{item.name}}' },
              confirm: '从上游拉取「{{item.name}}」的模型列表？',
            },
            { weight: 1 }),
          btn('查余额', 'text',
            {
              type: 'adminApi', method: 'POST',
              path: '/admin/api/instance/' + uid + '/channel-action',
              body: { action: 'balance', channel: '{{item.name}}' },
            },
            { weight: 1 }),
          btn('删除', 'text',
            {
              type: 'adminApi', method: 'DELETE',
              path: '/admin/api/instance/' + uid + '/channel',
              body: { name: '{{item.name}}' },
              confirm: '确定删除渠道「{{item.name}}」？',
            },
            { weight: 1 }),
        ],
      },
    ],
  };

  const kids = [
    txt('渠道', 'title3'),
    txt('当前实例「' + String(cfg._name || '') + '」共 ' + list.length +
      ' 个渠道 · 选择顺序：modelMap → models → 默认 → 轮询', 'caption', '$onSurfaceVariant'),
  ];
  if (!list.length) {
    kids.push({
      type: 'card', variant: 'outlined', children: [
        txt('还没有渠道，点下面「新增渠道」开始。', 'body', '$onSurfaceVariant'),
      ],
    });
  } else {
    kids.push({ type: 'list', items: '{{state.channels}}', columns: 1, template: card });
  }
  kids.push(gap(4));
  kids.push(btn('新增渠道', 'filled', { type: 'open', target: 'page:/admin/ui/channel-new' }));
  kids.push(btn('探测成功率', 'outlined', {
    type: 'adminApi', method: 'POST',
    path: '/admin/api/instance/' + uid + '/channel-action',
    body: { action: 'probe' },
    confirm: '对所有渠道发起一次可用性探测？',
  }));

  return {
    title: '渠道',
    state: { channels: list },
    root: { type: 'column', gap: 10, children: kids },
  };
}

/** 编辑/新增渠道的表单字段（两边共用） */
function channelFormFields(ch, isNew) {
  const modelsTxt = Array.isArray(ch.models) ? ch.models.join(', ') : '';
  const mapTxt = (ch.modelMap && typeof ch.modelMap === 'object')
    ? Object.entries(ch.modelMap).map(kv => kv[0] + '=' + kv[1]).join('\n')
    : '';
  return [
    { type: 'input', key: 'name', label: '渠道名称（唯一）', value: String(ch.name || '') },
    { type: 'input', key: 'type', label: '类型：openai / claude / gemini', value: String(ch.type || 'openai') },
    { type: 'input', key: 'baseUrl', label: 'Base URL（如 https://api.deepseek.com）', value: String(ch.baseUrl || '') },
    { type: 'input', key: 'apiKey', label: isNew ? 'API Key' : 'API Key（留空保持不变）', inputType: 'password' },
    { type: 'input', key: 'models', label: '模型列表（逗号分隔）', value: modelsTxt, multiline: true, height: 110 },
    { type: 'input', key: 'modelMap', label: '模型改名（每行：对外名=上游名，可空）', value: mapTxt, multiline: true, height: 110 },
    { type: 'input', key: 'proxy', label: '代理名（可选）', value: String(ch.proxy || '') },
    { type: 'input', key: 'delayMs', label: '请求延迟（毫秒，0 = 关）', value: String(ch.delayMs == null ? 0 : ch.delayMs), inputType: 'number' },
    { type: 'switch', key: 'isDefault', label: '设为默认渠道（兜底）', checked: !!ch.default },
    { type: 'switch', key: 'useResponses', label: '上游用 Responses API（仅 openai 类型）', checked: !!ch.useResponses },
    { type: 'switch', key: 'insecure', label: '跳过证书校验（自签中转站）', checked: !!ch.insecure },
  ];
}

/** 提交体：origName 由服务端填（App 的表单只管字段值） */
function channelSubmitBody(uid, origName) {
  const body = { origName: origName || '' };
  const keys = ['name', 'type', 'baseUrl', 'apiKey', 'models', 'modelMap', 'proxy', 'delayMs', 'isDefault', 'useResponses', 'insecure'];
  for (const k of keys) body[k] = '{{form.' + k + '}}';
  return body;
}

function buildChannelEdit(gw, cfg, q) {
  const name = String((q && q.get ? q.get('name') : '') || '');
  const c = instCfg(gw, cfg._uid);
  const channels = Array.isArray(c.channels) ? c.channels : [];
  const ch = channels.find(x => x && String(x.name) === name);
  if (!ch) return missingPage('找不到这个渠道（可能已被删除）。');
  return {
    title: '编辑渠道',
    state: {},
    root: {
      type: 'column', gap: 10, children: [
        txt('编辑渠道', 'title3'),
        txt('「' + name + '」。留空的字段保持原值；模型改名支持「对外名=上游名」每行一条。', 'caption', '$onSurfaceVariant'),
        {
          type: 'form', submitText: '保存',
          fields: channelFormFields(ch, false),
          submit: {
            type: 'adminApi', method: 'POST',
            path: '/admin/api/instance/' + cfg._uid + '/channel',
            body: channelSubmitBody(cfg._uid, name),
          },
        },
        btn('返回渠道列表', 'text', { type: 'open', target: 'page:/admin/ui/channels', nav: 'replace' }),
      ],
    },
  };
}

function buildChannelNew(gw, cfg, q) {
  return {
    title: '新增渠道',
    state: {},
    root: {
      type: 'column', gap: 10, children: [
        txt('新增渠道', 'title3'),
        txt('名称 / 类型 / Base URL / API Key 必填；模型列表留空表示该渠道不限制模型。', 'caption', '$onSurfaceVariant'),
        {
          type: 'form', submitText: '创建',
          fields: channelFormFields({ type: 'openai' }, true),
          submit: {
            type: 'adminApi', method: 'POST',
            path: '/admin/api/instance/' + cfg._uid + '/channel',
            body: channelSubmitBody(cfg._uid, ''),
          },
        },
        btn('返回渠道列表', 'text', { type: 'open', target: 'page:/admin/ui/channels', nav: 'replace' }),
      ],
    },
  };
}

/* ==================== 插件页 ==================== */

/** 当前实例的插件清单（来自插件系统，异常不该拖垮页面） */
function pluginList(gw, cfg) {
  try {
    if (gw.plugins && typeof gw.plugins.listForInstance === 'function') {
      return gw.plugins.listForInstance(cfg._uid, cfg) || [];
    }
  } catch (_) { /* 忽略 */ }
  return [];
}

function buildPlugins(gw, cfg, q) {
  const all = pluginList(gw, cfg);
  const kw = String((q && q.get ? q.get('q') : '') || '').trim().toLowerCase();
  const matched = all.filter(p => {
    if (!kw) return true;
    const hay = (String(p.name || '') + ' ' + String(p.id || '') + ' ' + String(p.description || '')).toLowerCase();
    return hay.indexOf(kw) >= 0;
  });
  const list = matched.map(p => {
    const id = String(p.id || '');
    const on = p.enable !== false;
    return {
      id: id,
      name: String(p.name || id || '?'),
      version: 'v' + String(p.version || '?') + ' · ' + String(p.type || ''),
      desc: String(p.description || ''),
      enabled: on,
      builtinText: p.builtin ? '内置' : '',
      stateText: on ? (p.running ? '运行中' : '已启用') : '已停用',
      stateTone: on ? (p.running ? 'success' : 'warning') : 'neutral',
      detailUrl: '/admin/ui/plugin?pid=' + encodeURIComponent(id),
    };
  });
  const off = list.filter(x => !x.enabled).length;

  const card = {
    type: 'card',
    variant: 'outlined',
    children: [
      {
        type: 'row', gap: 6, children: [
          Object.assign(txt('{{item.name}}', 'title3'), { weight: 1 }),
          badge('{{item.builtinText}}', 'tertiary'),
          badge('{{item.stateText}}', '{{item.stateTone}}'),
        ],
      },
      txt('{{item.version}}', 'caption', '$onSurfaceVariant'),
      txt('{{item.desc}}', 'caption', '$onSurfaceVariant'),
      gap(6),
      {
        type: 'row', gap: 8, children: [
          {
            type: 'switch', label: '启用', checked: '{{item.enabled}}',
            action: {
              type: 'adminApi', method: 'POST',
              path: '/admin/api/plugin-enable',
              body: { id: '{{item.id}}', enable: '{{input._checked}}' },
            },
          },
          btn('设置', 'tonal', { type: 'open', target: 'page:{{item.detailUrl}}' }, { weight: 1 }),
        ],
      },
    ],
  };

  const kids = [
    txt('插件', 'title3'),
    txt('当前实例「' + String(cfg._name || '') + '」共 ' + all.length + ' 个插件，已停用 ' + off + ' 个',
      'caption', '$onSurfaceVariant'),
    /* 搜索：input + submit（输入框的值靠点击时的完整作用域解析） */
    {
      type: 'input', key: 'q', label: '搜索插件（名称 / ID / 说明）', value: kw,
      shape: 'pill', leadingIcon: 'msym:search',
      submit: { type: 'open', target: 'page:/admin/ui/plugins?q={{input.q}}', nav: 'replace' },
    },
  ];
  if (kw) {
    kids.push(btn('清除搜索', 'text', { type: 'open', target: 'page:/admin/ui/plugins', nav: 'replace' }));
  }
  if (!list.length) {
    kids.push({
      type: 'card', variant: 'outlined', children: [
        txt(all.length ? ('没有匹配「' + kw + '」的插件') : '此实例没有可用插件', 'body', '$onSurfaceVariant'),
      ],
    });
  } else {
    kids.push({ type: 'list', items: '{{state.plugins}}', columns: 1, template: card });
  }

  return {
    title: '插件',
    state: { plugins: list },
    root: { type: 'column', gap: 10, children: kids },
  };
}

/** 插件 schema → 表单字段（type: string/number/boolean） */
function pluginConfigFields(schema, config) {
  const out = [];
  for (const f of (schema || [])) {
    const key = String(f.key || '');
    if (!key) continue;
    const label = String(f.label || key);
    const cur = (config && config[key] !== undefined) ? config[key] : f.default;
    if (String(f.type) === 'boolean') {
      out.push({ type: 'switch', key: key, label: label, checked: !!cur });
    } else {
      out.push({
        type: 'input', key: key, label: label,
        value: cur == null ? '' : String(cur),
        inputType: String(f.type) === 'number' ? 'number' : 'text',
      });
    }
  }
  return out;
}

function buildPlugin(gw, cfg, q) {
  const pid = String((q && q.get ? q.get('pid') : '') || '');
  const p = pluginList(gw, cfg).find(x => String(x.id) === pid);
  if (!p) return missingPage('该插件在当前实例不可用。');
  const schema = Array.isArray(p.schema) ? p.schema : [];
  const conf = (p.config && typeof p.config === 'object') ? p.config : {};
  const on = p.enable !== false;

  const kids = [
    txt(String(p.name || pid), 'title3'),
    txt('v' + String(p.version || '?') + ' · ' + pid + ' · ' + String(p.type || ''), 'caption', '$onSurfaceVariant'),
  ];
  if (p.description) kids.push(txt(String(p.description), 'caption', '$onSurfaceVariant'));
  kids.push({
    type: 'card', variant: 'outlined', children: [
      kv('状态', on ? (p.running ? '运行中' : '已启用') : '已停用'),
      kv('类型', String(p.type || '-')),
      kv('提供能力', (Array.isArray(p.provides) && p.provides.length) ? p.provides.join('、') : '无'),
      kv('权限', (Array.isArray(p.permissions) && p.permissions.length) ? p.permissions.join('、') : '无'),
      kv('插件包', p.builtin ? '内置（不可卸载）' : (p.sha256 ? 'sha256 ' + String(p.sha256).slice(0, 12) + '…' : '-')),
    ],
  });
  kids.push({
    type: 'switch', label: '启用该插件', checked: on,
    action: {
      type: 'adminApi', method: 'POST', path: '/admin/api/plugin-enable',
      body: { id: pid, enable: '{{input._checked}}' },
      confirm: '切换该插件的启用状态？停用后它提供的接口会立即失效。',
    },
  });
  /* ★兜底入口（2026-09-19 事故修复）：两个**写死布尔**的按钮，不依赖任何模板变量。
   *  背景：App 把 _checked 注在 action 上、body 却用渲染作用域解析 → {{_checked}} 解析成空串，
   *  旧服务端 !!"": false → 插件"关得掉、永远开不起来"。这里保证任何情况下都能改状态。 */
  kids.push({
    type: 'row', gap: 8, children: [
      btn('启用该插件', 'tonal', { type: 'adminApi', method: 'POST', path: '/admin/api/plugin-enable', body: { id: pid, enable: true } }, { weight: 1 }),
      btn('停用该插件', 'outlined', { type: 'adminApi', method: 'POST', path: '/admin/api/plugin-enable', body: { id: pid, enable: false } }, { weight: 1 }),
    ],
  });
  if (p.hasAdminPage) {
    kids.push(btn('打开插件管理页', 'tonal',
      { type: 'client', action: 'openNative', value: 'pp:' + pid }));
  }
  if (schema.length) {
    kids.push(txt('插件配置', 'title3'));
    kids.push({
      type: 'form', submitText: '保存配置',
      fields: pluginConfigFields(schema, conf),
      submit: {
        type: 'adminApi', method: 'POST',
        path: '/admin/api/plugin-config/' + cfg._uid + '/' + pid,
        body: '{{form}}',
      },
    });
  } else {
    kids.push(txt('该插件不需要配置 —— 装上就在工作。', 'caption', '$onSurfaceVariant'));
  }
  kids.push(btn('返回插件列表', 'text', { type: 'open', target: 'page:/admin/ui/plugins', nav: 'replace' }));

  return { title: '插件', state: {}, root: { type: 'column', gap: 10, children: kids } };
}

/* ==================== 公告页 ==================== */
/* 公告是 serverInfo.announcement 里的**一个字符串**（一行一条），格式与 App 的 Notices.kt 完全一致：
 *   普通公告 / [2026/09/12 13:20] 内容 / @u1234 内容 / [时间] @u1 内容
 * ⚠️ 定向只是展示层过滤，原文仍在公开串里（任何能读 bootstrap 的人都能看到），别发敏感内容。 */
function noticeParse(raw) {
  const out = [];
  for (const line of String(raw == null ? '' : raw).split('\n')) {
    let t = line.trim();
    if (!t) continue;
    let time = '';
    if (t.charAt(0) === '[') {
      const close = t.indexOf(']');
      if (close > 0) { time = t.slice(1, close).trim(); t = t.slice(close + 1).trim(); }
    }
    let target = '';
    if (t.charAt(0) === '@') {
      const sp = t.indexOf(' ');
      if (sp > 0) { target = t.slice(1, sp).trim(); t = t.slice(sp + 1).trim(); }
    }
    if (!t) continue;
    out.push({ time: time, target: target, body: t });
  }
  return out;
}

function noticeEncode(list) {
  return list.map(it => {
    let s = '';
    if (it.time) s += '[' + it.time + '] ';
    if (it.target) s += '@' + it.target + ' ';
    return s + it.body;
  }).join('\n');
}

function nowStamp() {
  const d = new Date();
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function buildNotice(gw, cfg) {
  const si = (typeof gw.store.getServerInfo === 'function') ? (gw.store.getServerInfo() || {}) : {};
  const raw = String(si.announcement || '');
  const items = noticeParse(raw);
  const list = items.map((it, i) => ({
    idx: i,
    body: it.body,
    timeText: it.time || '',
    targetText: it.target ? ('定向 @' + it.target) : '全站可见',
    tone: it.target ? 'tertiary' : 'neutral',
    editUrl: '/admin/ui/notice-edit?i=' + i,
  }));

  const kids = [
    txt('公告', 'title3'),
    txt('用户端首页会展示这里的内容。一行一条；带 [时间] 前缀的进时间线，带 @uid 的只对该用户可见。',
      'caption', '$onSurfaceVariant'),
    txt('共 ' + list.length + ' 条 · ' + raw.length + '/2000 字', 'caption', '$onSurfaceVariant'),
  ];
  if (!list.length) {
    kids.push({ type: 'card', variant: 'outlined', children: [txt('还没有公告。', 'body', '$onSurfaceVariant')] });
  } else {
    kids.push({
      type: 'list', items: '{{state.notices}}', columns: 1, template: {
        type: 'card', variant: 'outlined', children: [
          Object.assign(txt('{{item.body}}', 'body'), { maxLines: 4 }),
          gap(4),
          {
            type: 'row', gap: 6, children: [
              badge('{{item.targetText}}', '{{item.tone}}'),
              Object.assign(txt('{{item.timeText}}', 'caption', '$onSurfaceVariant'), { weight: 1 }),
            ],
          },
          gap(6),
          {
            type: 'row', gap: 8, children: [
              btn('编辑', 'text', { type: 'open', target: 'page:{{item.editUrl}}' }, { weight: 1 }),
              btn('删除', 'text',
                {
                  type: 'adminApi', method: 'POST', path: '/admin/api/notice',
                  body: { op: 'delete', idx: '{{item.idx}}' },
                  confirm: '删除这条公告？',
                },
                { weight: 1 }),
            ],
          },
        ],
      },
    });
  }
  kids.push(gap(4));
  /* 两个入口（对齐原生：新增公告 / 添加时间线） */
  kids.push({
    type: 'row', gap: 10, children: [
      btn('新增公告', 'filled', { type: 'open', target: 'page:/admin/ui/notice-new?timed=0' }, { weight: 1 }),
      btn('添加时间线', 'tonal', { type: 'open', target: 'page:/admin/ui/notice-new?timed=1' }, { weight: 1 }),
    ],
  });

  return { title: '公告', state: { notices: list }, root: { type: 'column', gap: 10, children: kids } };
}

/** 新增公告 / 添加时间线（timed=1 时预置时间戳） */
function buildNoticeNew(gw, cfg, q) {
  const timed = String((q && q.get ? q.get('timed') : '1') || '1') !== '0';
  return {
    title: timed ? '添加时间线' : '新增公告',
    state: {},
    root: {
      type: 'column', gap: 10, children: [
        txt(timed ? '添加时间线' : '新增公告', 'title3'),
        txt('内容一行一条；定向 uid 留空 = 全站可见。' + (timed ? '时间线会带上当前时间戳。' : ''),
          'caption', '$onSurfaceVariant'),
        {
          type: 'form', submitText: timed ? '添加到时间线' : '发布',
          fields: [
            { type: 'input', key: 'body', label: '公告内容', multiline: true, height: 120 },
            { type: 'input', key: 'target', label: '定向 uid（留空 = 全站可见）' },
            { type: 'switch', key: 'timed', label: '加时间戳（进时间线）', checked: timed },
          ],
          submit: {
            type: 'adminApi', method: 'POST', path: '/admin/api/notice',
            body: { op: 'add', body: '{{form.body}}', target: '{{form.target}}', timed: '{{form.timed}}' },
          },
        },
        btn('返回公告列表', 'text', { type: 'open', target: 'page:/admin/ui/notice', nav: 'replace' }),
      ],
    },
  };
}

/** 编辑公告（只改内容，时间/定向保持原样） */
function buildNoticeEdit(gw, cfg, q) {
  const i = Number((q && q.get ? q.get('i') : 0) || 0);
  const si = (typeof gw.store.getServerInfo === 'function') ? (gw.store.getServerInfo() || {}) : {};
  const list = noticeParse(si.announcement);
  const it = list[i];
  if (!it) return missingPage('这条公告不存在（可能已被删除）。');
  return {
    title: '编辑公告',
    state: {},
    root: {
      type: 'column', gap: 10, children: [
        txt('编辑公告', 'title3'),
        txt((it.time ? '时间线 ' + it.time + ' ' : '') + (it.target ? '定向 @' + it.target : '全站可见'),
          'caption', '$onSurfaceVariant'),
        {
          type: 'form', submitText: '保存',
          fields: [{ type: 'input', key: 'body', label: '公告内容', value: it.body, multiline: true, height: 120 }],
          submit: {
            type: 'adminApi', method: 'POST', path: '/admin/api/notice',
            body: { op: 'edit', idx: String(i), body: '{{form.body}}' },
          },
        },
        btn('返回公告列表', 'text', { type: 'open', target: 'page:/admin/ui/notice', nav: 'replace' }),
      ],
    },
  };
}

/* ==================== 用户 / 卡密页 ==================== */

/** 代调插件管理端点（页面渲染期直接读数据，不走 App 的 adminApi） */
async function pluginGet(gw, cfg, plugin, sub) {
  if (typeof gw.selfReq !== 'function') return null;
  return gw.selfReq(cfg, 'GET', instPrefix(cfg) + '/plugins/' + plugin + sub, null, 9000);
}

/* ★能力查询 (2026-10-07 深度改造): 内核页不再写死插件名。
 * 以前 buildUsers() 里是 pluginGet(gw, cfg, 'auth-user', '/admin/users') —— 内核必须知道
 * 认证插件叫 auth-user。现在改成问「谁提供 user-admin 能力」, 提供方是谁内核完全不关心。
 * 返回 {cap, adm} —— adm 是提供方自报的动作路径(pluginId + 各端点), 用于拼 adminApi 动作。 */
function capOf(gw, cfg, name) {
  try {
    const pm = gw && gw.plugins;
    if (!pm || typeof pm.requireCapability !== 'function') return null;
    return pm.requireCapability(cfg._uid, name) || null;
  } catch (_) { return null; }
}
/** 取能力提供方声明的动作面(含 pluginId); 缺能力 → null(页面据此显示空态, 不崩) */
function capAdmin(gw, cfg, name) {
  const cap = capOf(gw, cfg, name);
  if (!cap || typeof cap.adminApi !== 'function') return null;
  try { const a = cap.adminApi(); return (a && a.pluginId) ? a : null; } catch (_) { return null; }
}

async function buildUsers(gw, cfg, q) {
  const get = k => String((q && q.get ? q.get(k) : '') || '');
  const tab = get('tab') === 'keys' ? 'keys' : 'users';
  const kw = get('q').trim().toLowerCase();
  const page = Math.max(1, Number(get('page')) || 1);
  const size = 20;
  const uid = cfg._uid;

  let items = [], total = 0, rawCount = 0;
  if (tab === 'keys') {
    /* ★能力优先: 谁提供 cardkey-admin 就用谁; 拿不到 → 空态(而不是 404/崩溃) */
    const ckCap = capOf(gw, cfg, 'cardkey-admin');
    const all = ckCap && typeof ckCap.listKeys === 'function' ? (ckCap.listKeys() || []) : [];
    rawCount = all.length;
    const hit = all.filter(k => !kw ||
      String(k.key || '').toLowerCase().indexOf(kw) >= 0 ||
      String(k.name || '').toLowerCase().indexOf(kw) >= 0 ||
      String(k.note || '').toLowerCase().indexOf(kw) >= 0);
    total = hit.length;
    items = hit.slice((page - 1) * size, page * size).map(k => {
      const key = String(k.key || '');
      const on = k.enable !== false;
      const quota = Number(k.quotaTokens);
      return {
        name: String(k.name || '(未命名)'),
        avatar: String(k.name || k.key || '?').trim().charAt(0).toUpperCase(),
        sub: '卡密 ' + key.slice(0, 8) + '…' + key.slice(-4) + ' · 额度 ' + (quota < 0 ? '不限' : quota.toLocaleString()) +
          ' · 已用 ' + (Number(k.usedTokens) || 0).toLocaleString(),
        note: String(k.note || ''),
        stateText: on ? '启用' : '已停用',
        stateTone: on ? 'success' : 'neutral',
        canEnable: !on,
        canDisable: on,
        k: key,
      };
    });
  } else {
    /* ★能力优先: 谁提供 user-admin 就用谁 */
    const usrCap = capOf(gw, cfg, 'user-admin');
    const all = usrCap && typeof usrCap.listUsers === 'function' ? (usrCap.listUsers() || []) : [];
    rawCount = all.length;
    const hit = all.filter(u => !kw ||
      String(u.uid || '').toLowerCase().indexOf(kw) >= 0 ||
      String(u.nickname || '').toLowerCase().indexOf(kw) >= 0 ||
      String(u.name || '').toLowerCase().indexOf(kw) >= 0 ||
      String(u.email || '').toLowerCase().indexOf(kw) >= 0 ||
      String(u.note || '').toLowerCase().indexOf(kw) >= 0);
    total = hit.length;
    items = hit.slice((page - 1) * size, page * size).map(u => {
      const banned = !!u.banned;
      return {
        name: String(u.nickname || u.name || u.uid || '(未命名)'),
        avatar: String(u.nickname || u.name || u.uid || '?').trim().charAt(0).toUpperCase(),
        avatarUrl: String(u.avatar || ''),
        sub: 'UID ' + String(u.uid || '') + (u.email ? ' · ' + String(u.email) : '') +
          (u.note ? ' · ' + String(u.note) : ''),
        note: banned ? ('已封禁' + (u.banReason ? '：' + u.banReason : '')) : '',
        stateText: banned ? '已封禁' : '正常',
        stateTone: banned ? 'error' : 'success',
        canBan: !banned,
        canUnban: banned,
        uid: String(u.uid || ''),
      };
    });
  }

  const pages = Math.max(1, Math.ceil(total / size));
  const base = '/admin/ui/users?tab=' + tab + (kw ? '&q=' + encodeURIComponent(kw) : '');
  /* 动作路径由**能力提供方自报**(不再写死 'auth-user'); 缺能力 → 动作指向空, 按钮不可见 */
  const userAdm = capAdmin(gw, cfg, 'user-admin') || { pluginId: '', list: '' };
  const keyAdm = capAdmin(gw, cfg, 'cardkey-admin') || { pluginId: '', list: '', update: '' };
  const canAct = !!(userAdm.pluginId), canActKey = !!(keyAdm.pluginId);
  /* ★2026-10-08 对齐原生页功能: ①头像(UID 首字) ②点卡片→编辑 ③操作行改 chip(药丸, 窄屏不换行)
   *  ④补「复制 UID」。SDUI 组件全支持(avatar/chip/card), App 零参与, 不用重编。 */
  const userCard = {
    type: 'card', variant: 'outlined', action: { type: 'open', target: 'page:/admin/ui/user-edit?uid={{item.uid}}' },
    children: [
      {
        type: 'row', gap: 10, children: [
          { type: 'avatar', text: '{{item.avatar}}', url: '{{item.avatarUrl}}', size: 40 },
          { type: 'column', gap: 2, weight: 1, children: [
            { type: 'row', gap: 6, children: [
              Object.assign(txt('{{item.name}}', 'title3'), { weight: 1 }),
              badge('{{item.stateText}}', '{{item.stateTone}}'),
            ] },
            txt('{{item.sub}}', 'caption', '$onSurfaceVariant'),
          ] },
        ],
      },
      Object.assign(txt('{{item.note}}', 'caption', '$error'), { visible: '{{item.note}}' }),
      gap(6),
      {
        type: 'hscroll', gap: 6, children: [
          chip('复制 UID', 'content_copy', { type: 'copy', text: '{{item.uid}}' }),
          chip('编辑资料', 'edit', { type: 'open', target: 'page:/admin/ui/user-edit?uid={{item.uid}}' }),
          chip('封禁', 'block',
            {
              type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
              body: { plugin: userAdm.pluginId, path: userAdm.list, method: 'POST', body: { action: 'ban', uid: '{{item.uid}}' } },
              confirm: '封禁「{{item.name}}」？该用户所有卡密会立即失效。',
            },
            { visible: '{{item.canBan}}' }),
          chip('解封', 'check_circle',
            {
              type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
              body: { plugin: userAdm.pluginId, path: userAdm.list, method: 'POST', body: { action: 'unban', uid: '{{item.uid}}' } },
            },
            { visible: '{{item.canUnban}}' }),
          chip('重置密码', 'key',
            {
              type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
              body: { plugin: userAdm.pluginId, path: userAdm.list, method: 'POST', body: { action: 'resetPassword', uid: '{{item.uid}}' } },
              confirm: '把「{{item.name}}」的登录密码重置为随机密码？',
            }),
          chip('删除', 'delete',
            {
              type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
              body: { plugin: userAdm.pluginId, path: userAdm.list, method: 'POST', body: { action: 'delete', uid: '{{item.uid}}' } },
              confirm: '删除「{{item.name}}」？该账号会一并删除，无法恢复。',
            }),
        ],
      },
    ],
  };
  /* ★2026-10-08 keyCard 对齐 userCard: ①头像(卡名首字) ②点卡片→编辑(key-edit) ③chip 操作行 */
  const keyCard = {
    type: 'card', variant: 'outlined', action: { type: 'open', target: 'page:/admin/ui/key-edit?key={{item.k}}' },
    children: [
      {
        type: 'row', gap: 10, children: [
          { type: 'avatar', text: '{{item.avatar}}', size: 40 },
          { type: 'column', gap: 2, weight: 1, children: [
            { type: 'row', gap: 6, children: [
              Object.assign(txt('{{item.name}}', 'title3'), { weight: 1 }),
              badge('{{item.stateText}}', '{{item.stateTone}}'),
            ] },
            txt('{{item.sub}}', 'caption', '$onSurfaceVariant'),
          ] },
        ],
      },
      Object.assign(txt('{{item.note}}', 'caption', '$onSurfaceVariant'), { visible: '{{item.note}}' }),
      gap(6),
      {
        type: 'hscroll', gap: 6, children: [
          chip('复制', 'content_copy', { type: 'copy', text: '{{item.k}}', toast: '卡密已复制' }),
          chip('编辑', 'edit', { type: 'open', target: 'page:/admin/ui/key-edit?key={{item.k}}' }),
          chip('启用', 'check_circle',
            {
              type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
              body: { plugin: keyAdm.pluginId, path: keyAdm.update, method: 'POST', body: { key: '{{item.k}}', enable: true } },
            },
            { visible: '{{item.canEnable}}' }),
          chip('停用', 'block',
            {
              type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
              body: { plugin: keyAdm.pluginId, path: keyAdm.update, method: 'POST', body: { key: '{{item.k}}', enable: false } },
            },
            { visible: '{{item.canDisable}}' }),
          chip('删除', 'delete',
            {
              type: 'adminApi', method: 'DELETE', path: '/admin/api/plugin-call',
              body: { plugin: keyAdm.pluginId, path: keyAdm.list, method: 'DELETE', body: { key: '{{item.k}}' } },
              confirm: '删除这张卡密？',
            }),
        ],
      },
    ],
  };

  const kids = [
    txt(tab === 'keys' ? '卡密' : '用户', 'title3'),
    txt('当前实例共 ' + rawCount + ' 条' + (kw ? '，匹配「' + kw + '」' + total + ' 条' : '') +
      ' · 第 ' + page + '/' + pages + ' 页', 'caption', '$onSurfaceVariant'),
    {
      type: 'segmented', selected: tab, options: [
        { value: 'users', text: '用户' },
        { value: 'keys', text: '卡密' },
      ],
      action: { type: 'open', target: 'page:/admin/ui/users?tab={{_value}}', nav: 'replace' },
    },
    {
      type: 'input', key: 'q', label: '搜索（UID / 昵称 / 邮箱 / 卡密 / 备注）', value: kw,
      shape: 'pill', leadingIcon: 'msym:search',
      submit: { type: 'open', target: 'page:' + base + '&page=1&q={{input.q}}', nav: 'replace' },
    },
  ];
  if (!items.length) {
    kids.push({
      type: 'card', variant: 'outlined', children: [
        txt(rawCount ? '没有匹配的记录' : (tab === 'keys' ? '还没有卡密' : '还没有用户'), 'body', '$onSurfaceVariant'),
      ],
    });
  } else {
    kids.push({ type: 'list', items: '{{state.items}}', columns: 1, template: tab === 'keys' ? keyCard : userCard });
  }
  /* ★添加入口(2026-10-08): 移到搜索框下面(高频操作一眼看到), 与原生页底部按钮同能力 */
  kids.push({
    type: 'button', text: tab === 'keys' ? '生成卡密' : '添加用户', style: 'filled', shape: 'pill', icon: 'msym:add',
    action: { type: 'open', target: tab === 'keys' ? 'page:/admin/ui/key-create' : 'page:/admin/ui/user-create' },
  });
  if (pages > 1) {
    kids.push({
      type: 'pagination', page: String(page), total: String(total), pageSize: String(size),
      action: { type: 'open', target: 'page:' + base + '&page={{_page}}', nav: 'replace' },
    });
  }

  return {
    title: tab === 'keys' ? '卡密' : '用户管理',
    state: { items: items },
    root: { type: 'column', gap: 10, children: kids },
  };
}

/* ==================== 用户添加 / 编辑(内核子页, menu:false) ====================
 * ★2026-10-08: App 原生页的「添加用户/编辑资料」退役为回退 —— 治本 = 内核页驱动。
 * 端点走能力(capOf 'user-admin'), 不写死 auth-user。表单提交 = adminApi + {{input.*}}
 * (App 端点击时用完整作用域解析)。 */

/** 用户添加表单: 用户名/密码/昵称/分组/额度, 创建后自动发主卡 */
async function buildUserCreate(gw, cfg, q) {
  const usrCap = capOf(gw, cfg, 'user-admin');
  const groups = (() => { try { const c = capOf(gw, cfg, 'user-groups'); return c && c.groups ? (c.groups() || []) : []; } catch (_) { return []; } })();
  if (!usrCap || !usrCap.api || !usrCap.api().endpoints) {
    return missingPage('没有可用的用户管理能力（user-admin）——请确认用户体系插件已启用。');
  }
  const ep = usrCap.api().endpoints;
  const act = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
    body: { plugin: usrCap.pluginId || '', path: ep.action || ep.list, method: 'POST', body } });
  return {
    title: '添加用户',
    state: {},
    root: { type: 'column', gap: 10, children: [
      txt('创建后自动发一张主卡（否则用户登录不上）。', 'caption', '$onSurfaceVariant'),
      { type: 'input', key: 'username', label: '用户名（3-32 位字母/数字/_-）', value: '' },
      { type: 'input', key: 'password', label: '初始密码（留空 = changeme）', value: '', inputType: 'password' },
      { type: 'input', key: 'nickname', label: '昵称（可选）', value: '' },
      { type: 'input', key: 'group', label: '分组（可选' + (groups.length ? ': ' + groups.join(' / ') : '') + '）', value: '' },
      { type: 'input', key: 'quota', label: '主卡额度（token 数，留空 = 注册默认）', value: '', inputType: 'number' },
      { type: 'button', text: '创建用户', style: 'filled', shape: 'pill', icon: 'msym:add',
        action: act({ action: 'create', username: '{{input.username}}', password: '{{input.password}}', nickname: '{{input.nickname}}', group: '{{input.group}}', quotaTokens: '{{input.quota}}' }) },
      btn('返回用户列表', 'text', { type: 'open', target: 'page:/admin/ui/users', nav: 'replace' }),
    ] },
  };
}

/** 用户编辑表单: 资料(名称/昵称/邮箱/备注/分组) + 重置密码 + 封禁/解封 + 删除 */
async function buildUserEdit(gw, cfg, q) {
  const usrCap = capOf(gw, cfg, 'user-admin');
  if (!usrCap || !usrCap.listUsers) return missingPage('没有可用的用户管理能力（user-admin）。');
  const uid = String(q && q.get ? (q.get('uid') || '') : '');
  const u = (usrCap.listUsers() || []).find(x => String(x.uid || '') === uid);
  if (!u) return missingPage('用户不存在或已被删除（UID: ' + (uid || '(空)') + '）。');
  const groups = (() => { try { const c = capOf(gw, cfg, 'user-groups'); return c && c.groups ? (c.groups() || []) : []; } catch (_) { return []; } })();
  const ep = usrCap.api ? usrCap.api().endpoints : { action: '/admin/users' };
  const act = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
    body: { plugin: usrCap.pluginId || '', path: ep.action || ep.list, method: 'POST', body } });
  const banned = !!u.banned;
  return {
    title: '编辑用户',
    state: {},
    root: { type: 'column', gap: 10, children: [
      txt(u.nickname || u.name || u.uid, 'title3'),
      txt('UID: ' + (u.uid || '') + (banned ? ' · 已封禁' + (u.banReason ? '（' + u.banReason + '）' : '') : ''), 'caption', banned ? '$error' : '$onSurfaceVariant'),
      { type: 'input', key: 'name', label: '名称', value: u.name || '' },
      { type: 'input', key: 'nickname', label: '昵称', value: u.nickname || '' },
      { type: 'input', key: 'email', label: '邮箱', value: u.email || '' },
      { type: 'input', key: 'note', label: '备注', value: u.note || '' },
      { type: 'input', key: 'group', label: '分组（填分组名，留空=不变' + (groups.length ? '；可选: ' + groups.join(' / ') : '') + '）', value: '' },
      { type: 'button', text: '保存资料', style: 'filled', shape: 'pill', icon: 'msym:check',
        action: act({ action: 'update', uid: u.uid, name: '{{input.name}}', nickname: '{{input.nickname}}', email: '{{input.email}}', note: '{{input.note}}', group: '{{input.group}}' }) },
      txt('重置密码', 'title3'),
      { type: 'input', key: 'newpass', label: '新密码（至少 8 位）', value: '', inputType: 'password' },
      { type: 'button', text: '重置密码', style: 'tonal', shape: 'pill', icon: 'msym:key',
        action: Object.assign(act({ action: 'resetPassword', uid: u.uid, password: '{{input.newpass}}' }), { confirm: '确定重置该用户的密码？' }) },
      { type: 'row', gap: 8, children: [
        banned
          ? { type: 'button', text: '解封', style: 'tonal', shape: 'pill', weight: 1, action: act({ action: 'unban', uid: u.uid }) }
          : { type: 'button', text: '封禁', style: 'tonal', shape: 'pill', weight: 1, action: Object.assign(act({ action: 'ban', uid: u.uid }), { confirm: '确定封禁该用户？' }) },
        { type: 'button', text: '删除用户', style: 'outlined', shape: 'pill', weight: 1,
          action: Object.assign(act({ action: 'delete', uid: u.uid }), { confirm: '最后确认: 删除该用户及其所有卡密？不可恢复!' }) },
      ] },
      btn('返回用户列表', 'text', { type: 'open', target: 'page:/admin/ui/users', nav: 'replace' }),
    ] },
  };
}

/* ==================== 实例详情 / 改名 / 新建 ==================== */

/** 统一取 query 里的 uid + 实例 meta（找不到返回 null → 页面显示提示） */
function instMeta(gw, q) {
  const uid = Number(q && q.get ? (q.get('uid') || 0) : 0);
  const list = gw.store.index.instances || [];
  return { uid: uid, meta: list.find(m => m.uid === uid) || null };
}

/** 找不到对象时的兜底页（不让 App 收到 404 而回退到原生页） */
function missingPage(msg) {
  return {
    title: '注意',
    state: {},
    root: {
      type: 'column', gap: 10, children: [
        txt(msg, 'body', '$error'),
        btn('返回实例列表', 'tonal', { type: 'open', target: 'page:/admin/ui/instances', nav: 'replace' }),
      ],
    },
  };
}

function buildInstanceDetail(gw, cfg, q) {
  const r = instMeta(gw, q);
  if (!r.meta) return missingPage('实例不存在或已被删除。');
  const uid = r.uid;
  const enabled = r.meta.enabled !== false;
  const running = gw.pool.instances.has(uid);
  const s = (gw.pool.instances.get(uid) || {})._stats || {};
  const full = (typeof gw.store.instanceFull === 'function') ? (gw.store.instanceFull(uid) || {}) : {};
  const c = full.config || {};
  const chCount = Array.isArray(c.channels) ? c.channels.length : 0;
  return {
    title: '实例详情',
    state: {},
    root: {
      type: 'column', gap: 10, children: [
        txt('实例详情', 'title3'),
        {
          type: 'card', variant: 'outlined', children: [
            {
              type: 'row', gap: 8, children: [
                Object.assign(txt(r.meta.name, 'title3'), { weight: 1 }),
                badge(running ? '运行中' : (enabled ? '未运行' : '已停用'), running ? 'success' : 'neutral'),
              ],
            },
            gap(6),
            kv('UID', String(uid)),
            kv('端口', String(r.meta.port || 0)),
            kv('路径前缀', '/' + r.meta.name + '/'),
            kv('启用', enabled ? '是' : '否'),
            kv('运行中', running ? '是' : '否'),
            kv('渠道数', String(chCount)),
            kv('管理密钥', c.adminKey ? '已设置' : '未设置（免密管理）'),
            kv('请求 / 错误', (Number(s.requests) || 0) + ' / ' + (Number(s.errors) || 0)),
            kv('内存', running ? '与其他实例共享进程' : '未占用'),
          ],
        },
        txt('配置里的密钥字段在服务端已打码，页面不会出现明文。', 'caption', '$onSurfaceVariant'),
        gap(4),
        btn('改名', 'tonal', { type: 'open', target: 'page:/admin/ui/instance-edit?uid=' + uid }),
        btn('返回实例列表', 'text', { type: 'open', target: 'page:/admin/ui/instances', nav: 'replace' }),
      ],
    },
  };
}

/** 「编辑实例」= 接入参数表单（对齐旧版 App：名称 / 端口 / 监听地址 / adminKey） */
function buildInstanceEdit(gw, cfg, q) {
  const r = instMeta(gw, q);
  if (!r.meta) return missingPage('实例不存在或已被删除。');
  const uid = r.uid;
  const c = (typeof gw.store.loadInstance === 'function') ? (gw.store.loadInstance(uid) || {}) : {};
  const listen = c.listen || {};
  const enabled = r.meta.enabled !== false;
  const running = gw.pool.instances.has(uid);
  const isCurrent = r.meta.name === cfg._name;
  const hasKey = !!c.adminKey;
  const tlsOn = !!(c.tls && c.tls.enable);

  const kids = [
    txt('编辑实例', 'title3'),
    txt('「' + r.meta.name + '」的接入设置。留空的字段保持原值。', 'caption', '$onSurfaceVariant'),
  ];
  if (isCurrent) {
    kids.push(txt('⚠️ 这是当前管理实例：改端口后本 App 会连不上，需要回服务器列表里把地址的端口改掉。', 'caption', '$error'));
  }
  kids.push({
    type: 'form',
    submitText: '保存',
    fields: [
      { type: 'input', key: 'name', label: '实例名称（字母/数字/连字符）', value: r.meta.name },
      {
        type: 'input', key: 'port', label: '端口（0 = 不独占，走主端口+前缀；1-65535 独占）', inputType: 'number',
        value: String(listen.port == null ? '' : listen.port),
      },
      { type: 'input', key: 'host', label: '监听地址（0.0.0.0 = 允许局域网访问）', value: String(listen.host || '') },
      {
        type: 'input', key: 'adminKey', inputType: 'password',
        label: hasKey ? 'adminKey（留空保持不变）' : 'adminKey（可选）',
      },
    ],
    submit: { type: 'adminApi', method: 'POST', path: '/admin/api/instance/' + uid + '/basic', body: '{{form}}' },
  });
  kids.push(gap(4));
  kids.push(txt('TLS(HTTPS)：' + (tlsOn ? '已启用' : '未启用') + ' —— 证书/私钥需放在网关侧，目前请在网页端配置。', 'caption', '$onSurfaceVariant'));
  kids.push({
    type: 'card', variant: 'outlined', children: [
      txt('运行状态', 'title3'),
      gap(4),
      {
        type: 'switch',
        label: enabled ? '已启用（关闭即停用该实例）' : '已停用（打开即启用）',
        checked: enabled,
        action: {
          type: 'adminApi', method: 'POST',
          path: '/admin/api/instance/' + uid + '/enable',
          body: { enable: '{{input._checked}}' },
          confirm: '切换该实例的启用状态？停用后该实例的管理接口会不可用。',
        },
      },
      txt(running ? '当前正在运行' : '当前未运行', 'caption', '$onSurfaceVariant'),
    ],
  });
  /* 兜底入口：实例启停同样给写死布尔的按钮（误停一个实例的代价比误停插件大得多） */
  kids.push({
    type: 'row', gap: 8, children: [
      btn('启用该实例', 'tonal', { type: 'adminApi', method: 'POST', path: '/admin/api/instance/' + uid + '/enable', body: { enable: true } }, { weight: 1 }),
      btn('停用该实例', 'outlined', { type: 'adminApi', method: 'POST', path: '/admin/api/instance/' + uid + '/enable', body: { enable: false } }, { weight: 1 }),
    ],
  });
  kids.push(btn('重载配置', 'tonal', { type: 'adminApi', method: 'POST', path: '/admin/api/instance/' + uid + '/reload' }));
  kids.push(btn('查看详情', 'text', { type: 'open', target: 'page:/admin/ui/instance-detail?uid=' + uid }));
  kids.push(btn('返回实例列表', 'text', { type: 'open', target: 'page:/admin/ui/instances', nav: 'replace' }));

  return { title: '编辑实例', state: {}, root: { type: 'column', gap: 10, children: kids } };
}

function buildInstanceNew(gw, cfg, q) {
  return {
    title: '新建实例',
    state: {},
    root: {
      type: 'column', gap: 10, children: [
        txt('新建实例', 'title3'),
        txt('所有实例共用一个进程，各自独立端口与路径前缀。', 'caption', '$onSurfaceVariant'),
        {
          type: 'form', submitText: '创建实例',
          fields: [{ type: 'input', key: 'name', label: '实例名称（英文/数字/短横线）' }],
          submit: { type: 'adminApi', method: 'POST', path: '/admin/api/instance', body: '{{form}}' },
        },
        txt('创建成功后会出现在「实例」列表里，默认启用。', 'caption', '$onSurfaceVariant'),
        btn('返回实例列表', 'text', { type: 'open', target: 'page:/admin/ui/instances', nav: 'replace' }),
      ],
    },
  };
}

/* ==================== 页面注册表 ==================== */
/* ★新增页面：在这里加一项，并在 App 的内置页 id 里对应（或由 App 追加菜单项）。
 *  id 必须与 App 侧菜单 id 一致才会"替换"那一页；不一致则作为新菜单项追加。 */
const PAGES = {
  instances: { title: '实例', subtitle: '单进程托管全部实例', icon: 'grid', build: buildInstances },
  usage: { title: '使用', subtitle: '请求统计与排行', icon: 'wallet', build: buildUsage },
  channels: { title: '渠道', subtitle: '上游渠道与故障切换', icon: 'apps', build: buildChannels },
  plugins: { title: '插件', subtitle: '开关与参数', icon: 'star', build: buildPlugins },
  notice: { title: '公告', subtitle: '服务点公告', icon: 'info', build: buildNotice },
  users: { title: '用户管理', subtitle: '用户与卡密', icon: 'group', build: buildUsers },
  'user-create': { title: '添加用户', icon: 'add', menu: false, build: buildUserCreate },
  'user-edit': { title: '编辑用户', icon: 'edit', menu: false, build: buildUserEdit },
  'lang-set': { title: '语言 / Language', icon: 'translate', menu: true, build: buildLangSet },
  /* 子页：menu:false 不进侧边栏，只做菜单项过滤，仍可被 open 打开 */
  plugin: { title: '插件设置', icon: 'settings', menu: false, build: buildPlugin },
  'notice-new': { title: '新增公告', icon: 'add', menu: false, build: buildNoticeNew },
  'notice-edit': { title: '编辑公告', icon: 'edit', menu: false, build: buildNoticeEdit },
  /* 子页：menu:false 不进侧边栏，只做菜单项过滤，仍可被 open 打开 */
  'channel-edit': { title: '编辑渠道', icon: 'edit', menu: false, build: buildChannelEdit },
  'channel-new': { title: '新增渠道', icon: 'add', menu: false, build: buildChannelNew },
  /* 以下三页只是「实例页」的子页，**不进侧边栏**（menu:false）—— 只做菜单项过滤，仍可被 open 打开 */
  'instance-detail': { title: '实例详情', icon: 'info', menu: false, build: buildInstanceDetail },
  'instance-edit': { title: '编辑实例', icon: 'edit', menu: false, build: buildInstanceEdit },
  'instance-new': { title: '新建实例', icon: 'add', menu: false, build: buildInstanceNew },
};

/** 给 App 的 bootstrap.adminUi（服务端声明哪些管理页可用服务端界面）
 *  ★menu:false 的页不下发 —— 否则 App 会把「实例详情/改名/新建」当成侧边栏菜单项追加进去。 */
function manifest(extraPages) {
  const list = Object.keys(PAGES).filter(id => PAGES[id].menu !== false).map(id => ({
    id: id,
    title: PAGES[id].title,
    subtitle: PAGES[id].subtitle,
    icon: PAGES[id].icon,
    ui: '/admin/ui/' + id,
  }));
  /* 插件贡献的页面（registerAdminUi）：同名 id **覆盖**内核页（插件想接管某页时这么干）；
   * 新 id 追加为新菜单项。menu:false 的插件页不下发（只做子页）。 */
  for (const p of (extraPages || [])) {
    if (p.menu === false) continue;
    const i = list.findIndex(x => x.id === p.id);
    const item = { id: p.id, title: p.title, subtitle: p.subtitle || '插件页面', icon: p.icon || 'apps', ui: '/admin/ui/' + p.id };
    if (i >= 0) list[i] = item; else list.push(item);
  }
  return { version: 1, pages: list };
}

/** 渲染一页（q = URLSearchParams，子页靠它取 uid 之类的参数）；name 不存在 → null
 *  ctx（2026-09-18 加）：{ base, admin } —— 页面里的 `open` 目标要区分两端路径
 *  （管理端 /admin/ui/<id>、用户端 /ui/xxx），由 core.js 的两个调用点传入。 */
function render(gw, cfg, name, q, extraPages, ctx) {
  /* ★多语言(2026-10-08): 每次渲染取一次 i18n bundle → 模块级 _t, txt/chip/标题全部过 _t */
  try {
    const ib = require('../i18n/lib').bundle;
    if (ib && gw) _t = ib(gw, { uid: cfg && cfg._uid }).t || _t;
  } catch (_) { /* 回退恒等, 绝不因 i18n 影响页面 */ }
  /* ★能力协商(2026-10-07): ctx.caps 由调用方从请求头解析后传入; 没传 → 不裁剪(旧行为) */
  const caps = (ctx && ctx.caps) || null;
  /* ★插件页优先(2026-10-08): 与 App 端 buildPage 的 SDUI 优先分发**语义统一** ——
   *  旧顺序「内核页优先」让插件注册的同 id 页永远轮不到: App 端 sduiUsable('users')=true
   *  以为接管了, 服务端却返回内核内置页(长得和原生页像) → 用户「没变化」。
   *  插件页优先后, 内核页退役为兜底(插件没注册同 id 页时才用)。 */
  const pp = (extraPages || []).find(x => x.id === name);
  if (pp && typeof pp.render === 'function') {
    try {
      const page = pp.render(gw, cfg, q) || {};
      page.gcui = UI_VERSION;
      if (!page.title) page.title = pp.title || name;
      /* ★插件页也走同一套协商: 插件作者不用自己适配每一版 App */
      return negotiate(page, caps);
    } catch (e) {
      return {
        title: _t(pp.title || name),
        root: { type: 'column', gap: 10, children: [
          { type: 'text', text: '插件页面渲染失败：' + (e && e.message ? e.message : String(e)), style: 'body', color: '$error' },
          { type: 'text', text: '插件 ' + pp.pluginId + ' 的这一页出错了，其余页面不受影响。', style: 'caption', color: '$onSurfaceVariant' },
        ] },
      };
    }
  }
  /* 内核内置页(兜底): 插件没注册同 id 页时才轮到 —— async 页面 resolve 后再协商 */
  const p = PAGES[name];
  if (p) {
    const page = p.build(gw, cfg, q, ctx);
    if (page && typeof page.then === 'function') {
      return page.then(pg => { if (pg) pg.gcui = UI_VERSION; return negotiate(pg, caps); });
    }
    page.gcui = UI_VERSION;
    return negotiate(page, caps);
  }
  return null;
}

/* ★2026-10-08 管理端语言设置(用户报「找不到设置语言的入口」——两端都没有):
 *  radio → intent /admin/api/set-lang(core.js 落盘 i18n prefs[管理端 uid]) → then:'reload'
 *  → 当前页刷新, bundle 读到新语言 → 全部内核页文案跟着切。纯服务端, App 零参与。 */
function buildLangSet(gw, cfg, q, ctx) {
  let lang = 'zh-CN';
  try {
    /* ★内核惯例是 gw.store.getPluginConfig(本文件其它 build* 全用它; gw.getPluginConfig 不存在) */
    const pc = (gw.store && gw.store.getPluginConfig('i18n', cfg._uid, 'user')) || {};
    lang = (pc.prefs && pc.prefs[String(cfg._uid)]) || pc.defaultLang || 'zh-CN';
  } catch (_) {}
  const opt = (id, label) => ({
    /* ★checked 与 selected 双写: App 端 radio 读 checked(现状), 插件页/内核页习俗写 selected —— 双写两头都认 */
    type: 'radio', text: label, checked: lang === id, selected: lang === id,
    action: { type: 'intent', endpoint: '/admin/api/set-lang', body: { lang: id }, then: 'reload' },
  });
  return {
    title: _t('语言 / Language'), subtitle: _t('界面显示语言 / UI language'),
    gcui: 'admin-ui',
    children: [
      { type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 8, children: [
        txt(_t('选择显示语言 / Choose language'), 'subtitle'),
        opt('zh-CN', '简体中文 / 简体中文'),
        opt('en', 'English / English'),
        opt('zh-TW', '繁體中文 / 繁體中文'),
      ] },
      txt(_t('切换后立即生效，所有管理页文案同步更新。'), 'caption', 'onSurfaceVariant'),
    ],
  };
}

module.exports = {
  manifest, render, buildUsage, pageIds: () => Object.keys(PAGES), UI_VERSION,
  /* 能力协商(供 core.js 从请求头解析后传入 render 的 ctx.caps) */
  parseCaps, negotiate, downgradePage,
  /* 插件自检视图(ctx.clientCaps() 返回它) */
  capsView,
  /* 公告解析/编码（core.js 的 /admin/api/notice 复用它，保持与 App 的 Notices.kt 一致） */
  noticeParse, noticeEncode, nowStamp,
};
