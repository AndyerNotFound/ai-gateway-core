'use strict';
/* pricing-model plugin -- pricing model (fill-in-the-blank machine)
 *
   * positioning: **meter only; never touch the books**.
 *   v0.1 only listens in via the core's `onUsage` hook on every request's real usage and deducted quota, aggregating
 *   measured N (active users), per-user usage, and idle-share, then feeding them into a closed-form pricing formula.
 *   ★Deliberately does NOT register the `billing` hook: the core's billing hook is "the last non-empty result wins",
 *     and the billing plugin also appends a line to its own ledger -- adding a competing hook would yield
 *     "deductions follow ours, the ledger follows theirs" -- two books. To truly change billing, the right channel
 *     is writing rules for billing (hour/ctxLen/cache triggers), not stacking another hook.
 *
   * formula:
 *   X = (a·s/T + c + N_C·t_C·b) / (N_A·α_A + λ·N_S·α_S)
 *   Z = λ·X            α = 1 − r·u       criterion: u < 1/r
 *
   * endpoints:
 *   GET  /data/summary            measurements + solved results (user-readable, zero-quota cards allowed)
 *   GET  /ui/model                gcui page (App side)
 *   POST /intent/model/adjust     App-side parameter tuning (signed intent)
 *   GET  /admin/summary           admin overview
 *   POST /admin/params            admin writes parameters (merged as a whole)
 *   POST /admin/meter-reset       admin clears the metering data
 */
const DEF_PARAMS = {
  a: 3,               // training cost CNY/1M tokens (training data)
  s: 15000000,        // training-data size (M tokens)
  T: 24,              // amortization months
  c: 3000000,         // facility cost CNY/month
  b: 4,               // inference cost CNY/1M
  rA: 4, rS: 5,       // quota multipliers
  lam: 4,             // Z/X ratio
  NA: 300000, NS: 50000, uA: 0.15, uS: 0.12,
  NC: 1000000, tC: 1.03,
  idleWindows: [[23, 7], [12, 14]],   // idle windows (crossing midnight is written [23,7])
};
const ADJ_KEYS = ['a', 's', 'T', 'c', 'b', 'rA', 'rS', 'lam', 'NA', 'NS', 'uA', 'uS', 'NC', 'tC'];
const KEEP_DAYS = 45;

function inWindow(h, w) {
  const s = Number(w[0]) || 0, e = Number(w[1]) || 0;
  return (s <= e) ? (h >= s && h < e) : (h >= s || h < e);
}
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const dayKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

module.exports = {
  activate(ctx) {
    const send = (res, code, obj) => {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(obj));
    };
    const D = () => (ctx.data.all() || {});
    const setD = (k, v) => { ctx.data.set(k, v); if (ctx.data.flush) ctx.data.flush(); };
    const P = () => Object.assign({}, DEF_PARAMS, D().params || {});
    const METER = () => { const m = D().meter; return (m && typeof m === 'object') ? m : { days: {}, users: {} }; };

    /* ==================== Metering (observe only; never changes billing) ==================== */
    /* after every request the kernel calls onUsage; usage already carries charged (the final value from billing or the legacy convention). */
    ctx.hook('onUsage', (usage, c) => {
      try {
        const p = P();
        const now = new Date();
        const dk = dayKey(now);
        const m = METER();
        const day = m.days[dk] || (m.days[dk] = { req: 0, in: 0, out: 0, cache: 0, charged: 0, idle: 0, hours: new Array(24).fill(0) });
        const tok = (Number(usage.input) || 0) + (Number(usage.output) || 0);
        const ch = (usage.charged != null) ? Number(usage.charged)
          : ((Number(usage.input) || 0) + (Number(usage.output) || 0));   // legacy-convention fallback
        const idle = (Array.isArray(p.idleWindows) ? p.idleWindows : DEF_PARAMS.idleWindows)
          .some((w) => inWindow(now.getHours(), w));

        day.req += 1;
        day.in += Number(usage.input) || 0;
        day.out += Number(usage.output) || 0;
        day.cache += Number(usage.cacheRead) || 0;
        day.charged = Math.round((day.charged + ch) * 100) / 100;
        if (idle) day.idle += 1;
        day.hours[now.getHours()] += 1;

        const uk = (c && c.urlInfo && c.urlInfo.userKey) || null;
        if (uk && uk.uid) {
          const u = m.users[String(uk.uid)] || (m.users[String(uk.uid)] = { last: 0, req: 0, tok: 0, charged: 0, first: now.getTime() });
          u.last = now.getTime();
          u.req += 1;
          u.tok += tok;
          u.charged = Math.round((u.charged + ch) * 100) / 100;
        }
        setD('meter', m);
      } catch (e) { ctx.log('计量异常(已忽略):', e.message); }
    });

    /* metering cleanup: keep only KEEP_DAYS days */
    ctx.cron(6 * 3600 * 1000, () => {
      try {
        const m = METER();
        const cut = Date.now() - KEEP_DAYS * 86400000;
        let n = 0;
        for (const k of Object.keys(m.days || {})) {
          if (new Date(k + 'T23:59:59').getTime() < cut) { delete m.days[k]; n++; }
        }
        for (const k of Object.keys(m.users || {})) {
          if ((m.users[k].last || 0) < cut) { delete m.users[k]; n++; }
        }
        if (n) setD('meter', m);
      } catch (e) { ctx.log('计量清理异常:', e.message); }
    });

    /* ==================== Aggregated reads ==================== */
    function measured() {
      const m = METER();
      const days = m.days || {};
      const keys = Object.keys(days).sort().slice(-30);
      let req = 0, tin = 0, tout = 0, cache = 0, charged = 0, idle = 0, hours = new Array(24).fill(0);
      let first = null;
      for (const k of keys) {
        const d = days[k];
        req += d.req || 0; tin += d.in || 0; tout += d.out || 0;
        cache += d.cache || 0; charged += d.charged || 0; idle += d.idle || 0;
        for (let i = 0; i < 24; i++) hours[i] += (d.hours && d.hours[i]) || 0;
        if (!first) first = k;
      }
      const cut = Date.now() - 30 * 86400000;
      let active = 0, activeReq = 0, activeTok = 0;
      for (const k of Object.keys(m.users || {})) {
        if ((m.users[k].last || 0) >= cut) { active++; activeReq += m.users[k].req || 0; activeTok += m.users[k].tok || 0; }
      }
      const daysCovered = keys.length || 1;
      return {
        days: keys.length, from: first || null,
        req, tokensIn: tin, tokensOut: tout, tokens: tin + tout, cacheRead: cache,
        charged: Math.round(charged),
        activeUsers: active,
        perUserTokens30d: active ? Math.round((tin + tout) / active) : 0,
        perUserTokensPerMonth: active ? Math.round(((tin + tout) / active) * (30 / daysCovered)) : 0,
        idleReq: idle,
        idleShare: req ? Number((idle / req).toFixed(4)) : null,
        cacheShare: (tin > 0) ? Number((cache / tin).toFixed(4)) : null,
        avgReqPerActive: active ? Number((activeReq / active).toFixed(1)) : 0,
        hours,
      };
    }

    /* ==================== Closed-form solving ==================== */
    function solve(p) {
      const alphaA = 1 - p.rA * p.uA, alphaS = 1 - p.rS * p.uS;
      const train = (p.a * p.s) / (p.T || 1);
      const freeCost = p.NC * p.tC * p.b;
      const fixedNoFree = train + p.c;
      const Dd = p.NA * alphaA + p.lam * p.NS * alphaS;
      const X = (Dd > 0.0001) ? (fixedNoFree + freeCost) / Dd : null;
      const Z = (X == null) ? null : p.lam * X;
      const contrib = (X == null) ? 0 : (p.NA * alphaA * X + p.NS * alphaS * Z);
      const budget = contrib - fixedNoFree;         // headroom allocatable to the free tier
      const net = budget - freeCost;                // net profit
      const NCmax = (p.b * p.tC > 0) ? budget / (p.b * p.tC) : 0;
      const payback = (net > 0) ? (p.a * p.s) / net : null;
      return {
        alphaA, alphaS, train, freeCost, fixedNoFree, divisor: Dd,
        X, Z, contrib, budget, net, NCmax, payback,
        okA: p.uA < 1 / (p.rA || 1), okS: p.uS < 1 / (p.rS || 1),
        needUA: 1 / (p.rA || 1), needUS: 1 / (p.rS || 1),
      };
    }

    const money = (v) => {
      if (v == null || !isFinite(v)) return '—';
      const a = Math.abs(v);
      if (a >= 1e8) return '¥' + (v / 1e8).toFixed(2) + '亿';
      if (a >= 1e4) return '¥' + (v / 1e4).toFixed(1) + '万';
      return '¥' + v.toFixed(1);
    };
    const cnt = (v) => (v == null || !isFinite(v)) ? '—' : ((Math.abs(v) >= 1e4) ? (v / 1e4).toFixed(1) + '万' : String(Math.round(v)));

    function snapshot() {
      const p = P(), r = solve(p), m = measured();
      return { params: p, solved: r, measured: m };
    }

    /* ==================== App-side gcui pages ==================== */
    function buildUi() {
      const p = P(), r = solve(p), m = measured();
      const kvs = (arr) => arr.map(([label, value]) => ({ type: 'kv', label, value: String(value) }));
      const intent = (key, value) => ({ type: 'intent', endpoint: 'intent/model/adjust', body: { key, value } });
      return {
        gcui: 1,
        title: '计费模型',
        layout: {
          type: 'column', gap: 12, children: [
            {
              type: 'card', gap: 10, children: [
                { type: 'text', text: '实测（近 30 天 · 只读）', style: 'title3' },
                { type: 'row', gap: 8, children: [
                  { type: 'metricTile', value: cnt(m.activeUsers), label: '活跃用户', glyph: 'person', weight: 1 },
                  { type: 'metricTile', value: cnt(m.req), label: '请求数', glyph: 'chat', weight: 1 },
                ] },
                { type: 'row', gap: 8, children: [
                  { type: 'metricTile', value: cnt(m.tokens), label: 'Tokens', glyph: 'bolt', weight: 1 },
                  { type: 'metricTile', value: (m.idleShare == null ? '—' : (m.idleShare * 100).toFixed(0) + '%'), label: '闲时占比', glyph: 'schedule', weight: 1 },
                ] },
                { type: 'column', gap: 6, children: kvs([
                  ['人均 tokens / 30天', cnt(m.perUserTokens30d)],
                  ['人均 tokens / 月(折算)', cnt(m.perUserTokensPerMonth)],
                  ['缓存命中占比', m.cacheShare == null ? '—' : (m.cacheShare * 100).toFixed(1) + '%'],
                  ['已扣额度', cnt(m.charged)],
                ]) },
              ],
            },
            {
              type: 'card', gap: 10, children: [
                { type: 'text', text: '解出定价', style: 'title3' },
                { type: 'row', gap: 8, children: [
                  { type: 'metricTile', value: r.X == null ? '无解' : '¥' + r.X.toFixed(1), label: 'A 档月费', glyph: 'wallet', weight: 1 },
                  { type: 'metricTile', value: r.Z == null ? '无解' : '¥' + r.Z.toFixed(1), label: 'S 档月费', glyph: 'wallet', weight: 1 },
                ] },
                { type: 'column', gap: 6, children: kvs([
                  ['单位贡献 α_A', r.alphaA.toFixed(3) + (r.alphaA > 0 ? '' : '  ✗ 亏')],
                  ['单位贡献 α_S', r.alphaS.toFixed(3) + (r.alphaS > 0 ? '' : '  ✗ 亏')],
                  ['可分配免费层余量', money(r.budget)],
                  ['每月净利', money(r.net)],
                  ['免费用户上限', cnt(r.NCmax)],
                  ['训练回本', r.payback == null ? '—（净利≤0）' : r.payback.toFixed(0) + ' 个月'],
                ]) },
                { type: 'text', text: '判据 u_A < ' + (r.needUA * 100).toFixed(1) + '%（当前 ' + (p.uA * 100).toFixed(1) + '%）· u_S < ' + (r.needUS * 100).toFixed(1) + '%（当前 ' + (p.uS * 100).toFixed(1) + '%）', style: 'caption', maxLines: 2 },
              ],
            },
            {
              type: 'card', gap: 10, children: [
                { type: 'text', text: '调参（输入后回车即重算）', style: 'title3' },
                { type: 'input', key: 'b', label: '推理成本 b ¥/1M（当前 ' + p.b + '）', inputType: 'number', value: '', submit: intent('b', '{{input.b}}') },
                { type: 'input', key: 'NA', label: 'A 档人数 N_A（当前 ' + p.NA + '）', inputType: 'number', value: '', submit: intent('NA', '{{input.NA}}') },
                { type: 'input', key: 'uA', label: 'A 用满率 u_A 0~1（当前 ' + p.uA + '）', inputType: 'number', value: '', submit: intent('uA', '{{input.uA}}') },
                { type: 'input', key: 'NC', label: '免费用户数 N_C（当前 ' + p.NC + '）', inputType: 'number', value: '', submit: intent('NC', '{{input.NC}}') },
                { type: 'row', gap: 8, children: [
                  { type: 'button', text: '倍率 r=3', style: 'tonal', action: intent('rA', 3) },
                  { type: 'button', text: 'r=4', style: 'tonal', action: intent('rA', 4) },
                  { type: 'button', text: 'r=5', style: 'tonal', action: intent('rA', 5) },
                ] },
              ],
            },
            { type: 'row', gap: 8, children: [
              { type: 'button', text: '用实测值填充', style: 'filled', icon: 'check', action: { type: 'intent', endpoint: 'intent/model/adjust', body: { useMeasured: true } } },
              { type: 'button', text: '刷新', style: 'outlined', icon: 'refresh', action: { type: 'refresh' } },
            ] },
            { type: 'text', text: 'X = (a·s/T + c + N_C·t_C·b) / (N_A·α_A + λ·N_S·α_S)，α = 1 − r·u。本插件只计量不改扣费。', style: 'caption', maxLines: 3 },
          ],
        },
      };
    }

    ctx.registerRoute('GET', '/ui/model', (req, res, p) => { jsonUi(res, buildUi()); });
    function jsonUi(res, page) {
      send(res, 200, page);
    }

    /* ==================== User read-only data (the zero-quota card allow path) ==================== */
    ctx.registerRoute('GET', '/data/summary', (req, res, p) => {
      const s = snapshot();
      send(res, 200, { ok: true, plugin: ctx.id, instance: ctx.instanceName, params: s.params, solved: s.solved, measured: s.measured });
    });

    /* ==================== App-side intents ==================== */
    ctx.registerRoute('POST', '/intent/model/adjust', (req, res, p) =>
      ctx.security.guard(req, p, res, (uk) => {
        if (!uk) return { ok: false, error: '需要登录' };
        const body = p.body || {};
        const cur = P();
        if (body.useMeasured) {
          const m = measured();
          if (m.activeUsers > 0) cur.NA = m.activeUsers;
          if (m.perUserTokensPerMonth > 0) cur.tC = Number((m.perUserTokensPerMonth / 1e6).toFixed(3));
        } else {
          const key = String(body.key || '');
          if (ADJ_KEYS.indexOf(key) < 0) return { ok: false, error: '不支持的参数: ' + key, ui: buildUi() };
          const v = Number(body.value);
          if (!isFinite(v) || v < 0) return { ok: false, error: '参数必须是 ≥0 的数字', ui: buildUi() };
          cur[key] = v;
        }
        setD('params', cur);
        return { ok: true, toast: '已重算', ui: buildUi() };
      })
    );

    /* ==================== Admin side ==================== */
    ctx.registerRoute('GET', '/admin/summary', (req, res, p) => {
      const a = p.authAdmin ? p.authAdmin() : { ok: false };
      if (!a.ok) return send(res, 401, { ok: false, error: '需要管理员密钥' });
      const s = snapshot();
      send(res, 200, { ok: true, params: s.params, solved: s.solved, measured: s.measured, defaults: DEF_PARAMS });
    });

    ctx.registerRoute('POST', '/admin/params', (req, res, p) => {
      const a = p.authAdmin ? p.authAdmin() : { ok: false };
      if (!a.ok) return send(res, 401, { ok: false, error: '需要管理员密钥' });
      const body = p.body || {};
      const cur = P();
      const applied = [];
      for (const k of ADJ_KEYS) {
        if (body[k] == null || body[k] === '') continue;
        const v = Number(body[k]);
        if (!isFinite(v) || v < 0) return send(res, 400, { ok: false, error: '参数 ' + k + ' 非法' });
        cur[k] = v; applied.push(k);
      }
      setD('params', cur);
      const back = P();   // read-back verification
      const s = snapshot();
      send(res, 200, { ok: true, applied, params: back, solved: s.solved });
    });

    ctx.registerRoute('POST', '/admin/meter-reset', (req, res, p) => {
      const a = p.authAdmin ? p.authAdmin() : { ok: false };
      if (!a.ok) return send(res, 401, { ok: false, error: '需要管理员密钥' });
      setD('meter', { days: {}, users: {} });
      const back = METER();
      send(res, 200, { ok: true, days: Object.keys(back.days || {}).length, users: Object.keys(back.users || {}).length });
    });

    /* pre-auth estimate hook: lets "quota freezing" use the same ruler (optional; v0.1 does not intervene -- returning null opts out) */

    ctx.log('计费模型插件已激活 · 只计量不改扣费 · 闲时窗 ' + JSON.stringify(P().idleWindows));
  },
};
