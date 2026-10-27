'use strict';
/** admin-ui.js -- admin-side SDUI pages (gcui v1, 2026-09-15)
 *
   * why this file exists:
*   The admin side used to be native pages hard-coded in the App (AdminPages.kt, 2694 lines); every UI change required rebuilding the APK.
*   Now pages are served from the server as gcui JSON; the App only "renders + executes actions".
 *
   * security boundary (paired with the App-side SduiController.adminApiScope):
*   - Pages rendered here are loaded only by the App's **admin core pages** (GET /admin/ui/<id>, requires x-admin-key)
*   - The App lets only this class of pages call adminApi (core-page whitelist /admin/); plugin pages cannot get it
*   - **Never put** sensitive fields like adminKey / upstream apiKey into pages: the page JSON ends up in App memory
 *
   * fallback: on render/load failure the App automatically switches back to the native page (triple fallback; see gay-core docs/ADMIN-SDUI-PLAN.md)
 */

/** gcui spec version (the App's SduiCapabilities.GCUI_VERSION refuses to render below this and falls back to native) */
const UI_VERSION = 1;

/** ==================== App capability negotiation (2026-10-07 deep refactor §C) ====================
   * background: the App's SduiCapabilities.headers() has always reported X-GCUI-Components / X-GCUI-Icons /
*   X-GCUI-Version, but **server code has never read them** (exactly one place in the repo uses x-gcui-version to tell "is it the App").
*   So the contract breaks here: the App reports capabilities, yet plugins do not know what to downgrade -> real devices render a red error block.
   * now: the server **proactively trims/degrades** pages per reported capabilities, so plugins need not adapt to every App version themselves.
*   Headers unavailable (web / old App) -> caps is null, everything stays as-is (backward compatible).
 */
function parseCaps(headers) {
  if (!headers) return null;
  const ver = Number(headers['x-gcui-version']);
if (!ver) return null;                     // not reported -> no trimming at all (old behavior)
  const split = k => String(headers[k] || '').split(',').map(x => x.trim()).filter(Boolean);
  const comps = split('x-gcui-components');
  const icons = split('x-gcui-icons');
  const navs = split('x-gcui-nav');
  return {
    version: ver,
    components: comps.length ? new Set(comps) : null,   // null = no specific list reported -> no trimming
    icons: icons.length ? new Set(icons) : null,
    nav: navs.length ? new Set(navs) : null,
  };
}
/** icon degradation: outside the whitelist -> swap in a generic icon (rather than a silent blank on the App) */
const ICON_FALLBACK = 'apps';
function downgradeIcon(name, caps) {
  if (!caps || !caps.icons) return name;
  const n = String(name || '').replace(/^msym:/, '');
  return caps.icons.has(n) ? name : ICON_FALLBACK;
}
/** Page trimming: walk the gcui tree recursively -- unknown components degrade to text (readable downgrade notice), unknown icons swap to a generic icon.
   *  returns {page, dropped:[]} for logging/self-inspection. */
function downgradePage(node, caps, dropped) {
  if (!caps) return node;
  if (Array.isArray(node)) return node.map(n => downgradePage(n, caps, dropped)).filter(Boolean);
  if (!node || typeof node !== 'object') return node;
  let out = node;
/* Component whitelist: unknown -> degrade to one readable text line (the App would render a red error block; an explicit notice is better) */
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
    /* nav degradation: unsupported nav -> drop it (older Apps apply default rules; nothing breaks) */
    if (out.action && out.action.nav && caps.nav && !caps.nav.has(out.action.nav)) {
      out.action = Object.assign({}, out.action); delete out.action.nav;
    }
  }
  if (out.children) out.children = downgradePage(out.children, caps, dropped);
  if (out.template) out.template = downgradePage(out.template, caps, dropped);
  return out;
}
/** the capability view for plugin self-checks (2026-10-07): exposes only "what can be used", never the internal sets.
*  ctx.clientCaps() returns it -- plugins can ask before rendering "does this App support the components I want to use".
   *  no header (web / old App) -> null (plugins should fall back to the most conservative rendering). */
function capsView(caps) {
  if (!caps) return null;
  return {
    version: caps.version,
    /** component whitelist (array); no list reported -> null (= unrestricted) */
    components: caps.components ? [...caps.components] : null,
    icons: caps.icons ? [...caps.icons] : null,
    nav: caps.nav ? [...caps.nav] : null,
    /** supports a component? no list reported -> always true (no restriction) */
    hasComponent: (t) => !caps.components || caps.components.has(String(t || '')),
    /** supports an icon? (the msym: prefix is stripped automatically); unreported -> true */
    hasIcon: (i) => !caps.icons || caps.icons.has(String(i || '').replace(/^msym:/, '')),
    /** supports a navigation mode? unreported -> true */
    hasNav: (n) => !caps.nav || caps.nav.has(String(n || '')),
    /** pick the components this App knows from the list (plugins decide which to render from it) */
    pick: (list) => (Array.isArray(list) ? list : []).filter(t => !caps.components || caps.components.has(String(t || ''))),
  };
}

/** capability-negotiate a whole page; caps null -> return as-is (zero overhead, zero behavior change) */
function negotiate(page, caps) {
  if (!caps || !page || !page.root) return page;
  const dropped = [];
  const root = downgradePage(page.root, caps, dropped);
  if (dropped.length) {
    /* say it out loud (rather than silently degrading): admins should know "what this page loses on older Apps" */
    const uniq = [...new Set(dropped)];
    root.children = (root.children || []).concat([{
      type: 'text', style: 'caption', color: '$onSurfaceVariant',
      text: '（已按当前 App 版本降级，暂不支持：' + uniq.join('、') + '）',
    }]);
  }
  return Object.assign({}, page, { root });
}

/** ==================== Component helpers ==================== */
/** *2026-10-08 i18n done properly (user report: "in English mode almost everything is still Chinese"):
   *  kernel pages had 107 hardcoded Chinese strings + dict-seed's en covering only 3 of 24 kernel-page keys.
   *  the real fix = module-level _t (read from the i18n bundle at render, identity fallback on failure) + txt/chip helpers routed through _t(). */
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

/** pill buttons (the native instance card's buttons are chips -- far more compact than large buttons) */
const chip = (text, icon, action, extra) => {
  text = _t(text);
  const o = { type: 'chip', text: text };
  if (icon) o.icon = 'msym:' + icon;
  if (action) o.action = action;
  return Object.assign(o, extra || {});
};

/** confirm dialogs uniformly name the target, preventing mis-taps */
const confirmText = s => s + '\n\n（该操作立即生效）';

/** ==================== Instances page ==================== */
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
      /* compact version: port/UID/requests merged into one line; sub-page URLs pre-generated server-side */
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

  /* *instance card template: a list template where {{item.xxx}} points at the current instance */
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
      /* multi-select (checked uids land in {{selected}}; without an action the App refreshes the count itself) */
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

/** ==================== Usage stats page (redone 2026-09-18: spans / break granularity / persistent history) ==================== */
/** data has two layers (explained to users at the page bottom, so nobody assumes every block follows the span):
*   (1) Curve + metric cards = **persistent history** (usage-history.js: hourly buckets forever, 10-minute buckets 30 days)
*      -> query any time range, survives gateway restarts;
*   (2) Channel ranking / recent requests = in-memory `_stats` (latest 200 detail records per instance, cleared on restart)
*      -> no channel-by-time history dimension, only "accumulated since startup".
   * interaction: span/granularity changes use `open` + **same-page query swap** -> the App reads it as "same-page in-place refresh", never pushing
*   (see SduiController inline navigation semantics). The two sides use different page paths (admin /admin/ui/usage,
*   user side /ui/usage), so base is passed in by core.js through the render ctx.
   * *gcui templates accept **pure paths** only (`{{state.x}}`), not expressions like `{{a=='b'}}`
*   -> selection state is always computed server-side into plain values in state (empty spanA/spanB means "no selection in this row").
 */
const usageHist = require('./usage-history');

const U_HOUR = 3600000;
/** local timezone offset (ms): **display/input in local time**, buckets always UTC */
function uTzMin() { return -new Date().getTimezoneOffset(); }
/** ms -> local 'YYYY-MM-DD HH:MM' */
function uLocal(ms) {
  const s = new Date(ms + uTzMin() * 60000).toISOString();
  return s.slice(0, 10) + ' ' + s.slice(11, 16);
}
/** ms -> local 'HH:MM:SS' (recent request list) */
function uLocalTime(ms) {
  return new Date(ms + uTzMin() * 60000).toISOString().slice(11, 19);
}
/** user input (local time) -> ms; accepts '2026-09-18 08' / '2026-09-18T08:30' / '2026-09-18' */
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

/** segmented picker: a tap writes value into inputs[key] (Renderer.segmented behavior); actions read it via {{input.<key>}} */
const seg = (key, options, selected, action) => ({ type: 'segmented', key: key, options: options, selected: selected, action: action });

/** span -> [fromMs, toMs] (local-time semantics); illegal input falls back to the default window; never throws */
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
      /* hour-precision input -> the whole hour counts (+59:59.999) */
      if (f && t && t >= f) return { from: f, to: t + U_HOUR - 1 };
      const r = usageHist.range(keyId); return { from: r.minMs || (now - 24 * U_HOUR), to: now };
    }
    default: return { from: now - 24 * U_HOUR, to: now };
  }
}

function buildUsage(gw, cfg, q, ctx) {
  const ic = gw.pool.instances.get(cfg._uid);
  const base = (ctx && ctx.base) || '/admin/ui/usage';
  /* *per-user isolation (2026-09-18): ctx.scope = { keyId, name }, resolved by core.js from **the request's own key card**
   *   (only the user-side /ui/usage carries it; the admin /admin/ui/usage does not = site-wide view, behavior unchanged).
   *   why: user-side pages used to ignore the request's key card, so any card holder saw **site-wide** requests
*   -- visible as "a user who never called also sees the request". */
  const scope = (ctx && ctx.scope) || null;
  const meKey = (scope && scope.keyId) ? String(scope.keyId) : '';
  const meMode = !!meKey;
  const meName = (scope && scope.name) || '';
  /* *unknown identity (invalid/expired card, or no credentials at all) -> **hide the stats**; never fall back to the site-wide view:
   *   otherwise "users with expired cards" could see other people's requests (secure default = give nothing). */
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

  /* *default aggregates all instances (§45): cross-instance requests count into the **target instance's** _stats,
   *   looking only at cfg._uid would miss them. History buckets must merge across uids too.
   *   in meMode (user side), history buckets switch to **per-key buckets** (queryMany's 5th arg keyId). */
  const isDef = cfg._name === 'default';
  const targets = isDef ? [...gw.pool.instances.values()].filter(x => x) : [ic];
  const uids = targets.map(x => x._uid);
  const hist = usageHist.queryMany(uids, rg.from, rg.to, gran, meMode ? meKey : undefined);
  const series = hist.series.map(x => ({ label: x.label, count: x.count, errors: x.errors }));
  const peak = series.reduce((m, x) => (x.count > m ? x.count : m), 0);
  const sum = series.reduce((a, x) => a + x.count, 0);
  const avg = series.length ? Math.round((sum / series.length) * 10) / 10 : 0;

  /* ---- In-memory side (channel ranking / recent requests / uptime) ---- */
  let startMs = 0; const allRecent = []; const byChMap = {};
  let myCharged = 0;
  for (const tt of targets) {
    const s = (tt && tt._stats) || {};
    if (meMode) {
      /* *own data only: totals from stats.byKey[<keyId>], details from recent entries sharing that keyId */
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
  /* recent requests: details live only in memory -> **filter by the selected span** (empty when the span exceeds memory; the page explains this) */
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
    /* each segmented row's highlighted value: not in this row -> empty string (that row shows no highlight) */
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
    /* third stat card: admins see "uptime"; meaningless for users -> replaced with their own cumulative billing */
    tile3: meMode ? (Math.round(myCharged * 1e6) / 1e6) : upMin,
    tile3Label: meMode ? '计费(自启动)' : '运行(分)',
    memNote: meMode
      ? '明细来自内存（最近 200 条，重启网关后清空）'
      : '渠道排行 / 最近请求来自内存（各实例最近 200 条，重启网关后清空）',
    histNote: meMode
      ? '曲线与指标只统计你发起的请求：小时桶永久保存 · 10 分钟桶保留 30 天'
      : '曲线与指标来自持久历史：小时桶永久保存 · 10 分钟桶保留 30 天',
  };

/* ★2026-09-18: target must carry the `page:` protocol prefix -- the App-side open action only accepts
   *   `page:` / `http(s)://`; a bare path is judged "unknown page: /ui/usage?span=..." and dropped outright.
   *   (GCUI's navigation protocol: page/query changes always use page:<path>[?query]; see SduiController.dispatch) */
  const openTo = (qs) => ({ type: 'open', nav: 'replace', target: 'page:' + base + '?' + qs });

  return {
    title: meMode ? '我的使用统计' : '使用统计',
    state: state,
    root: {
      type: 'column', gap: 10, children: [
        txt(meMode ? '我的使用统计' : '使用统计', 'title3'),
        ...(meMode ? [txt('只统计「' + (meName || '当前卡密') + '」发起的请求。管理端「使用」页可查看全站统计。', 'caption', '$onSurfaceVariant')] : []),
        txt('{{state.rangeText}}', 'caption', '$onSurfaceVariant'),
        /* ---- Span: two segmented rows (4 per row; 7 options would cram on phones) ---- */
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
        /* ---- Break granularity (dynamic: few buckets = dense points; many = automatically sparser) ---- */
        txt('折点粒度', 'caption', '$onSurfaceVariant'),
        seg('granSel', U_GRAN_OPTS, '{{state.gran}}', openTo('span={{state.span}}&g={{input.granSel}}')),
        gap(4),
        /* ---- Stat cards (follow the selected span) ---- */
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

/** ==================== Channels page ==================== */

/** the current instance config (an empty object when loadInstance is absent, easing test stubs) */
function instCfg(gw, uid) {
  return (typeof gw.store.loadInstance === 'function') ? (gw.store.loadInstance(uid) || {}) : {};
}

/** instance path prefix (plugin routes of non-default instances must carry the /<name> prefix) */
function instPrefix(cfg) {
  return (cfg && cfg._name && cfg._name !== 'default') ? '/' + cfg._name : '';
}

/** Probe success-rate cache -- the probe plugin is async while page rendering must be **synchronous** (gcui contract).
   * strategy: read the last result + background refresh. The first open may lack success rates; refresh once and they appear;
   * benefit: the page never waits on HTTP for one badge (and an absent probe never slows the page). */
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
if (Date.now() - rateCache.at > 15000) refreshRates(gw, cfg);   /* refreshed in background, not awaited */

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
      /* *URLs are encoded server-side: channel names may contain CJK, and the App would reject a naively built URL as invalid */
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

/** form fields for editing/adding a channel (shared by both sides) */
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

/** submission body: origName is filled by the server (the App's form only carries field values) */
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

/** ==================== Plugins page ==================== */

/** the current instance's plugin list (from the plugin system; failures must not take the page down) */
function pluginList(gw, cfg) {
  try {
    if (gw.plugins && typeof gw.plugins.listForInstance === 'function') {
      return gw.plugins.listForInstance(cfg._uid, cfg) || [];
    }
} catch (_) { /* ignored */ }
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
    /* search: input + submit (the input's value resolves through the full scope at tap time) */
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

/** plugin schema -> form fields (type: string/number/boolean) */
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
  /* *fallback entries (2026-09-19 incident fix): two buttons with **hardcoded booleans**, depending on no template variables.
*  Background: the App attaches _checked to the action while the body resolves in render scope -> {{_checked}} resolves to an empty string,
   *  the old server turned !!"": false, so plugins could "switch off but never on". This guarantees the state can always change. */
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

/** ==================== Notices page ==================== */
/** notices are **one string** inside serverInfo.announcement (one per line), formatted exactly like the App's Notices.kt:
 *   plain notice / [2026/09/12 13:20] content / @u1234 content / [time] @u1 content
   * targeting is display-layer filtering only; the raw text stays in the public string (anyone reading bootstrap can see it) -- never post sensitive content. */
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
  /* two entries (matching native: add a notice / add a timeline entry) */
  kids.push({
    type: 'row', gap: 10, children: [
      btn('新增公告', 'filled', { type: 'open', target: 'page:/admin/ui/notice-new?timed=0' }, { weight: 1 }),
      btn('添加时间线', 'tonal', { type: 'open', target: 'page:/admin/ui/notice-new?timed=1' }, { weight: 1 }),
    ],
  });

  return { title: '公告', state: { notices: list }, root: { type: 'column', gap: 10, children: kids } };
}

/** add a notice / add a timeline entry (timestamps pre-filled when timed=1) */
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

/** edit a notice (content only; time/targeting untouched) */
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

/** ==================== Users / key cards page ==================== */

/** proxy-call plugin admin endpoints (data is read directly during page rendering, not via the App's adminApi) */
async function pluginGet(gw, cfg, plugin, sub) {
  if (typeof gw.selfReq !== 'function') return null;
  return gw.selfReq(cfg, 'GET', instPrefix(cfg) + '/plugins/' + plugin + sub, null, 9000);
}

/** *capability queries (2026-10-07 deep refactor): kernel pages no longer hardcode plugin names.
* previously buildUsers() did pluginGet(gw, cfg, 'auth-user', '/admin/users') -- the core had to know
   * the auth plugin was auth-user. Now it asks "who provides the user-admin capability"; the kernel cares nothing for who that is.
* returns {cap, adm} -- adm is the provider-reported action paths (pluginId + endpoints), used to assemble adminApi actions. */
function capOf(gw, cfg, name) {
  try {
    const pm = gw && gw.plugins;
    if (!pm || typeof pm.requireCapability !== 'function') return null;
    return pm.requireCapability(cfg._uid, name) || null;
  } catch (_) { return null; }
}
/** fetch the capability provider's declared action surface (pluginId included); missing -> null (the page shows an empty state from it, never crashes) */
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
    /* *capability first: whoever provides cardkey-admin is used; unavailable -> an empty state (not 404/crash) */
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
    /* *capability first: whoever provides user-admin is used */
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
  /* action paths are **provider-declared** (never hardcoded to 'auth-user'); capability missing -> the action is empty and the button invisible */
  const userAdm = capAdmin(gw, cfg, 'user-admin') || { pluginId: '', list: '' };
  const keyAdm = capAdmin(gw, cfg, 'cardkey-admin') || { pluginId: '', list: '', update: '' };
  const canAct = !!(userAdm.pluginId), canActKey = !!(keyAdm.pluginId);
  /* *2026-10-08 native-page feature parity: (1) avatar (first char of the UID) (2) tap card -> edit (3) action row as chips (pills, no wrap on narrow screens)
   *  (4) adds "copy UID". All SDUI components support it (avatar/chip/card); zero App involvement, no rebuild. */
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
  /* *2026-10-08 keyCard aligns with userCard: (1) avatar (first char of the card name) (2) tap card -> edit (key-edit) (3) chip action row */
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
  /* *add entry (2026-10-08): moved below the search box (a frequent action, visible at a glance); same capability as the native page's bottom button */
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

/** ==================== User add / edit (kernel sub-page, menu:false) ====================
* ★2026-10-08: the App's native "add user / edit profile" pages are retired to fallback -- the real fix is core-page driven.
   * endpoints go through the capability (capOf 'user-admin'), never hardcoded to auth-user. Form submits = adminApi + {{input.*}}
   * (the App resolves it through the full scope at tap time). */

/** user add form: username/password/nickname/group/quota; a primary card is issued automatically on creation */
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

/** user edit form: profile (name/nickname/email/note/group) + password reset + ban/unban + delete */
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

/** ==================== Instance details / rename / create ==================== */

/** uniformly fetch uid + instance meta from the query (returns null when missing -> the page shows a hint) */
function instMeta(gw, q) {
  const uid = Number(q && q.get ? (q.get('uid') || 0) : 0);
  const list = gw.store.index.instances || [];
  return { uid: uid, meta: list.find(m => m.uid === uid) || null };
}

/** the fallback page when the target is missing (never let the App see a 404 and bounce to the native page) */
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

/** "edit instance" = the onboarding params form (mirroring the old App: name / port / listen address / adminKey) */
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
  /* fallback entries: instance start/stop also gets hardcoded-boolean buttons (mistakenly stopping an instance costs far more than a plugin) */
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

/** ==================== Page registry ==================== */
/** *new pages: add an entry here and match it to the App's built-in page ids (or let the App append a menu item).
   *  the id must match the App-side menu id to "replace" that page; otherwise it appends as a new menu item. */
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
  /* sub-pages: menu:false keeps them out of the sidebar (menu filtering only); still openable */
  plugin: { title: '插件设置', icon: 'settings', menu: false, build: buildPlugin },
  'notice-new': { title: '新增公告', icon: 'add', menu: false, build: buildNoticeNew },
  'notice-edit': { title: '编辑公告', icon: 'edit', menu: false, build: buildNoticeEdit },
  /* sub-pages: menu:false keeps them out of the sidebar (menu filtering only); still openable */
  'channel-edit': { title: '编辑渠道', icon: 'edit', menu: false, build: buildChannelEdit },
  'channel-new': { title: '新增渠道', icon: 'add', menu: false, build: buildChannelNew },
/* The three pages below are only sub-pages of the "instances page", **not in the sidebar** (menu:false) -- only filtered from menu items, still openable via open */
  'instance-detail': { title: '实例详情', icon: 'info', menu: false, build: buildInstanceDetail },
  'instance-edit': { title: '编辑实例', icon: 'edit', menu: false, build: buildInstanceEdit },
  'instance-new': { title: '新建实例', icon: 'add', menu: false, build: buildInstanceNew },
};

/** for the App's bootstrap.adminUi (the server declaring which admin pages have server-side UIs)
*  Pages with menu:false are not sent down -- otherwise the App would append "instance details / rename / create" as sidebar menu items. */
function manifest(extraPages) {
  const list = Object.keys(PAGES).filter(id => PAGES[id].menu !== false).map(id => ({
    id: id,
    title: PAGES[id].title,
    subtitle: PAGES[id].subtitle,
    icon: PAGES[id].icon,
    ui: '/admin/ui/' + id,
  }));
  /* plugin-contributed pages (registerAdminUi): the same id **overrides** the kernel page (how a plugin takes over a page);
* new ids are appended as new menu items. Plugin pages with menu:false are not sent down (sub-pages only). */
  for (const p of (extraPages || [])) {
    if (p.menu === false) continue;
    const i = list.findIndex(x => x.id === p.id);
    const item = { id: p.id, title: p.title, subtitle: p.subtitle || '插件页面', icon: p.icon || 'apps', ui: '/admin/ui/' + p.id };
    if (i >= 0) list[i] = item; else list.push(item);
  }
  return { version: 1, pages: list };
}

/** render one page (q = URLSearchParams; sub-pages read uid etc. from it); unknown name -> null
*  ctx (added 2026-09-18): { base, admin } -- `open` targets inside pages must distinguish the two sides' paths
   *  (admin /admin/ui/<id>, user /ui/xxx), passed in by core.js's two call sites. */
function render(gw, cfg, name, q, extraPages, ctx) {
  /* *i18n (2026-10-08): fetch the i18n bundle once per render -> module-level _t; txt/chip/titles all pass through _t */
  try {
    const ib = require('../i18n/lib').bundle;
    if (ib && gw) _t = ib(gw, { uid: cfg && cfg._uid }).t || _t;
} catch (_) { /* fall back to identity, never let i18n break the page */ }
  /* *capability negotiation (2026-10-07): ctx.caps is parsed from request headers by the caller and passed in; absent -> no trimming (legacy behavior) */
  const caps = (ctx && ctx.caps) || null;
/* ★Plugin pages first (2026-10-08): semantically unified with the App-side buildPage SDUI-first dispatch --
   *  the old "kernel pages first" order meant plugin pages with the same id never got their turn: on the App, sduiUsable('users')=true
   *  believing it took over, while the server returned the kernel built-in page (which looks like the native one) -> the user sees "no change".
   *  with plugin pages first, kernel pages retire to fallback (used only when no plugin registered the same id). */
  const pp = (extraPages || []).find(x => x.id === name);
  if (pp && typeof pp.render === 'function') {
    try {
      const page = pp.render(gw, cfg, q) || {};
      page.gcui = UI_VERSION;
      if (!page.title) page.title = pp.title || name;
      /* *plugin pages go through the same negotiation: plugin authors need not adapt to every App version themselves */
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
/* Core built-in pages (fallback): used only when no plugin registered a page with the same id -- negotiated after async pages resolve */
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

          /* *2026-10-08 admin language setting (user report: no way to change language on either end):
   *  radio -> intent /admin/api/set-lang (core.js persists i18n prefs[admin uid]) -> then:'reload'
   *  -> the current page refreshes, the bundle reads the new language -> every kernel page's copy follows. Pure server-side; the App does nothing. */
function buildLangSet(gw, cfg, q, ctx) {
  let lang = 'zh-CN';
  try {
    /* *the kernel convention is gw.store.getPluginConfig (every other build* in this file uses it; gw.getPluginConfig does not exist) */
    const pc = (gw.store && gw.store.getPluginConfig('i18n', cfg._uid, 'user')) || {};
    lang = (pc.prefs && pc.prefs[String(cfg._uid)]) || pc.defaultLang || 'zh-CN';
  } catch (_) {}
  const opt = (id, label) => ({
/* ★checked and selected written in parallel: App-side radio reads checked (current), plugin/core pages conventionally write selected -- dual-write keeps both recognized */
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
/* Capability negotiation (parsed from request headers by core.js, passed into render's ctx.caps) */
  parseCaps, negotiate, downgradePage,
  /* the plugin self-check view (returned by ctx.clientCaps()) */
  capsView,
  /* notice parsing/encoding (core.js's /admin/api/notice reuses this, staying consistent with the App's Notices.kt) */
  noticeParse, noticeEncode, nowStamp,
};
