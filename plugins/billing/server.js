'use strict';
/* billing 插件 — 动态计费 (2026-09-17)
 *
 * 定位：**只算账，不扣账**。额度仍在 auth-cardkey 手里（它是唯一的扣款出口）。
 *  本插件通过内核的 `billing` hook 算出「这次该扣多少加权额度」（charged），
 *  内核把它交给 auth-cardkey 的 onUsage；没装本插件时 charged=null → 内核按老口径
 *  (input+output) 扣 —— 所以装上/卸下本插件都不会让已发卡密的扣费算法突变。
 *
 * 数据来源（★只有一份真相，不另存副本）：
 *   · 模型价格 / 模型级规则 → model-square 的 modelMeta（键 "实例|渠道|模型"）
 *   · 用户分组 → auth-user 的 users[].group
 *   · 全局规则 / 用户组折扣 / 上游成本表 → 本插件自己的数据文件
 *
 * 端点：
 *   GET  /admin/status                总览（规则数/最近结算/利润）
 *   GET  /admin/rules                 全局规则读写
 *   POST /admin/rules                 规则增删改（action: add/update/delete/move/toggle）
 *   GET  /admin/cost                  上游成本表
 *   POST /admin/cost                  成本表读写
 *   GET  /admin/profit?days=7         利润报表（按模型/渠道聚合）
 *   POST /admin/simulate              试算（不扣费，管理端预览"这次会扣多少"）
 *   GET  /admin/model-price?model=&channel=  查某模型当前生效的价格与命中规则
 *
 * 为什么规则要"标签式"：管理员配的是「什么时候触发 → 触发什么」，不是写代码。
 * 想让规则更灵活时可用 when.k='expr' 写受限表达式（自研解析器，**绝不用 eval**）。
 */
const path = require('path');
const fs = require('fs');
const engine = require('./engine.js');

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

/* ==================== 内置规则模板（"触发 → 效果"标签的取值表） ====================
 * 前端(网页/App)用它渲染下拉，不必硬编码第二份。 */
const TRIGGERS = [
  { k: 'model', label: '按模型名', ops: ['eq', 'ne', 'in', 'nin'], vType: 'text', hint: '如 deepseek-chat，多个用逗号' },
  { k: 'group', label: '按模型分组', ops: ['eq', 'ne', 'in', 'nin'], vType: 'text', hint: '模型广场里的分组名' },
  { k: 'ugroup', label: '按用户分组', ops: ['eq', 'ne', 'in', 'nin'], vType: 'text', hint: '用户体系里的分组名' },
  { k: 'channel', label: '按渠道', ops: ['eq', 'ne', 'in', 'nin'], vType: 'text', hint: '渠道名' },
  { k: 'ctxLen', label: '按上下文长度', ops: ['gte', 'gt', 'lte', 'lt', 'between'], vType: 'number', hint: '输入 token 数，如 32000' },
  { k: 'hour', label: '按小时(0-23)', ops: ['gte', 'gt', 'lte', 'lt', 'between', 'in'], vType: 'number', hint: '如 0 或 22' },
  { k: 'weekday', label: '按星期(0=周日)', ops: ['eq', 'ne', 'in'], vType: 'number' },
  { k: 'day', label: '按日(1-31)', ops: ['eq', 'gte', 'lte', 'in'], vType: 'number' },
  { k: 'cache', label: '按缓存状态', ops: ['eq', 'ne'], vType: 'select', options: ['hit', 'write', 'none'], hint: 'hit=命中，write=写入，none=无缓存' },
  { k: 'perCall', label: '按次计费模型', ops: ['eq'], vType: 'bool' },
  { k: 'expr', label: '自定义表达式', ops: ['expr'], vType: 'expr', hint: '如 ctxLen >= 64000 && hour < 8；可用变量见文档' },
];

const EFFECTS = [
  { k: 'price', label: '设定单价', fields: ['field', 'mode', 'v'], modes: ['set', 'mult', 'add'], targets: ['all', 'input', 'output', 'cacheRead', 'cacheWrite'], hint: '直接给出该字段的单价（权重），不必是整数倍' },
  { k: 'mult', label: '整体倍率', fields: ['v'], hint: '在最终结果上乘一个系数，如 0.5 表示错峰半价' },
  { k: 'perCall', label: '改按次计费', fields: ['v'], hint: '本次按固定额度收（与 token 计费二选一）' },
  { k: 'free', label: '本次免费', fields: [], hint: '直接计 0' },
];

module.exports = {
  activate(ctx) {
    const cfg = ctx.config;
    /* 数据（dataScope=global → plugins-data/_global/billing.json）：
     *   rules        全局规则（对所有模型生效，模型级规则在其后叠加）
     *   cost         上游成本表：{ "模型名": { in, out, cacheRead, cacheWrite } }（元/1M）
     *   ugroupDiscount { "分组名": 0.8 }
     *   weightMode   true=价格按"权重"；false=按"元/1M tokens"并用 moneyPerToken 换算
     */
    const D = () => { const d = ctx.data.all() || {}; return d; };
    const rulesOf = () => { const r = D().rules; return Array.isArray(r) ? r : []; };
    const costOf = () => { const c = D().cost; return (c && typeof c === 'object') ? c : {}; };
    /* ★管理端写入（规则/设置/成本表）低频且重要 —— 写完立即落盘，不等 30s 定时器：
     * 2026-09-17 之前只标 dirty，落盘要等周期 flush 或优雅退出，中途 kill -9 会丢刚存的规则。 */
    const setData = (k, v) => { ctx.data.set(k, v); if (ctx.data.flush) ctx.data.flush(); };
    const ledgerDir = path.join(ctx.dataDir, 'ledger');
    try { fs.mkdirSync(ledgerDir, { recursive: true }); } catch (_) {}

    const money = () => Number(D().moneyPerToken) || 0;
    const weightMode = () => D().weightMode !== false;   // 默认 true（权重模式，老卡零迁移）
    /* ★计费基数开关 (2026-09-19)：true = 权重模式按 1Mi tokens(2²⁰=1048576) 扣费，
     * false(默认) = 按 1M tokens(10⁶)。只影响权重模式的扣费分母；
     * 金额模式保持「元/1M tokens」行业口径不变（见 engine.compute）。 */
    const miBase = () => D().miBase === true;
    const ugroupDiscount = () => D().ugroupDiscount || {};

    /* ==================== 数据源：模型价格/规则 ====================
     * ★2026-10-07 深度改造: 这里原来写死 ctx.getPluginConfig('model-square', 0) ——
     *   把"谁是价格提供方"当成了内核事实。现在改成**能力查询**:
     *   任何插件 provideCapability('model-pricing', {...}) 都能成为价格源, 本插件不需要知道它叫什么。
     *   能力缺席(没装提供方) → msConfig() 返回 null → 走原降级路径(按老口径扣费), 不抛错。 */
    let _msCache = null, _msAt = 0, _msRev = -1;
    /** 能力对象(每次取, 因为插件可能热重载/后注册); 没提供方 → null */
    const msCap = () => {
      try { return (typeof ctx.requireCapability === 'function') ? ctx.requireCapability('model-pricing') : null; }
      catch (_) { return null; }
    };
    const msConfig = () => {
      const now = Date.now();
      const cap = msCap();
      if (!cap) { _msCache = null; return null; }
      /* 能力自带版本号 → 配置变了立刻失效(比 15s TTL 更准); 拿不到版本号就退回 TTL */
      let rev = -1;
      try { rev = (typeof cap.rev === 'function') ? cap.rev() : -1; } catch (_) { rev = -1; }
      if (_msCache && now - _msAt < 15000 && (rev === -1 || rev === _msRev)) return _msCache;
      try {
        const mm = (typeof cap.allMeta === 'function') ? cap.allMeta() : null;
        const gs = (typeof cap.groups === 'function') ? cap.groups() : [];
        _msCache = (mm && typeof mm === 'object') ? { modelMeta: mm, groups: Array.isArray(gs) ? gs : [] } : null;
      } catch (_) { _msCache = null; }
      _msAt = now; _msRev = rev;
      return _msCache;
    };

    /** 取某 实例/渠道/模型 的 meta（找不到别名也认：客户端可能用 alias 当模型名） */
    const metaFor = (inst, ch, model) => {
      const ms = msConfig();
      if (!ms || !ms.modelMeta) return null;
      const mm = ms.modelMeta;
      /* 1) 精确命中：实例|渠道|模型 */
      const direct = mm[[String(inst || ''), String(ch), String(model)].join('|')];
      if (direct) return direct;
      const i = String(inst || ''), c = String(ch), m = String(model);
      /* 2) 别名回查：同实例同渠道里 alias === 模型名 */
      if (c) {
        const pre = i + '|' + c + '|';
        for (const k of Object.keys(mm)) {
          if (k.indexOf(pre) !== 0) continue;
          const v = mm[k];
          if (v && v.alias && String(v.alias) === m) return v;
        }
      }
      /* 3) ★渠道为空（管理端试算/查价预览）或精确渠道没命中时：
       *    按「模型名/别名」全局搜索第一条匹配 —— 售价通常按模型统一定，
       *    管理员预览"这个模型会扣多少"不该被渠道名卡住。
       *    优先选有 price 的；都没有就返回第一个匹配（拿 group/rules 也用得上）。 */
      let fallback = null;
      for (const k of Object.keys(mm)) {
        const parts = k.split('|');
        const km = parts.slice(2).join('|');           // 模型名本身可能含 |
        const v = mm[k];
        if (km === m || (v && v.alias && String(v.alias) === m)) {
          if (v && v.price) return v;                 // 有价格的最优先
          if (!fallback) fallback = v;
        }
      }
      return fallback;
    };

    /** 用户分组 —— ★2026-10-07 同样改为能力查询: 任何插件提供 'user-groups' 即可 */
    let _auCache = null, _auAt = 0;
    const auConfig = () => {
      const now = Date.now();
      if (_auCache && now - _auAt < 15000) return _auCache;
      try {
        const cap = (typeof ctx.requireCapability === 'function') ? ctx.requireCapability('user-groups') : null;
        if (!cap) { _auCache = null; }
        else if (typeof cap.listUsers === 'function') {
          const us = cap.listUsers() || [];
          _auCache = { users: us, defaultGroup: (typeof cap.defaultGroup === 'function' ? cap.defaultGroup() : '') || '' };
        } else if (typeof cap.users === 'function') {
          _auCache = { users: cap.users() || [], defaultGroup: (typeof cap.defaultGroup === 'function' ? cap.defaultGroup() : '') || '' };
        } else { _auCache = null; }
      } catch (_) { _auCache = null; }
      _auAt = now;
      return _auCache;
    };
    const ugroupOf = (uid) => {
      if (!uid) return '';
      const au = auConfig();
      if (!au || !Array.isArray(au.users)) return '';
      const u = au.users.find(x => x && String(x.uid) === String(uid));
      return (u && (u.group || u.groups && u.groups[0])) || au.defaultGroup || '';
    };

    /* ==================== 结算 ==================== */
    /* 内核在 logDone 时调它；返回 { charged, detail } 或 null（null = 按老口径） */
    /* ★未定价的模型禁止调用（2026-09-18 用户要求「没定价不给调用」）。
     *  用内核已有的 onChatAuth 预检钩子（在「选渠道 / 转发上游」之前触发，返回 {status,message} 即拒绝），
     *  所以**不需要改内核、也不用重启网关**（插件热重载即可生效）。
     *  判定：按模型名全局查价（metaFor 会优先返回"有 price"的那条）；查不到 price 且没有 perCall → 403。
     *  ⚠price 字段全 0 也算「已定价」= 明确免费，照常放行。
     *  开关：插件设置 blockUnpriced=false 可关（默认开）。 */
    ctx.hook('onChatAuth', ({ model, cfg }) => {
      if (D().blockUnpriced === false) return null;
      if (!model) return null;
      const inst = (cfg && cfg._name) || ctx.instanceName || '';
      const meta = metaFor(inst, '', model);
      const priced = !!(meta && (meta.price || (meta.perCall != null && meta.perCall !== '')));
      if (priced) return null;
      return { status: 403, message: '模型「' + model + '」未定价，已禁止调用（请先在模型广场给该模型配置价格）' };
    });
    /* ★预授权估算 (2026-09-18)：内核在「冻结额度」前问一句「这次大约要多少额度」。
     *  返回**额度单位**的预估 —— 与结算刻意用同一把尺子（同一个 engine.compute、
     *  同一份价格/规则/折扣/按次配置），否则就又变成「同一份数据两套单位」。
     *  用法：认证插件（auth-cardkey）估好 token 数后交给内核的 estimateCharge 回调，
     *  这里只负责「token → 额度」的换算；**不写账本**（估算不是真实用量）。
     *  返回 null = 这次估不出来（模型没配价/没规则命中）→ 调用方回退老口径（token 数），
     *  与「没配过价的模型按 1 token = 1 额度结算」严格对齐。 */
    ctx.hook('onQuotaEstimate', ({ model, inst, ch, input, output, uid, cfg }) => {
      try {
        if (!model) return null;
        const i = Math.max(0, Number(input) || 0);
        const o = Math.max(0, Number(output) || 0);
        const instName = inst || (cfg && cfg._name) || ctx.instanceName || '';
        const meta = metaFor(instName, ch || '', model);
        const res = engine.compute(
          { model, channel: ch || '', input: i, output: o, cacheRead: 0, cacheWrite: 0 },
          {
            price: meta && meta.price ? meta.price : null,
            perCall: meta ? meta.perCall : null,
            rules: (meta && Array.isArray(meta.rules)) ? meta.rules : [],
            globalRules: rulesOf(),
            group: (meta && meta.group) || '',
            ugroup: uid ? ugroupOf(uid) : '',
            cfg: {
              weightMode: weightMode(),
              moneyPerToken: money(),
              miBase: miBase(),
              ugroupDiscount: ugroupDiscount(),
              chargePrecision: D().chargePrecision,
            },
          });
        return res ? res.charged : null;
      } catch (e) { ctx.log('预授权估算异常（回退老口径）:', e.message); return null; }
    });
    ctx.hook('billing', (usage, c) => {
      try {
        const inst = (c && c.cfg && c.cfg._name) || '';
        const ch = (c && c.ch && c.ch.name) || usage.channel || '';
        const meta = metaFor(inst, ch, usage.model);
        const uk = (c && c.urlInfo && c.urlInfo.userKey) || null;
        const ug = uk ? ugroupOf(uk.uid) : '';

        const res = engine.compute(usage, {
          price: meta && meta.price ? meta.price : null,
          perCall: meta ? meta.perCall : null,
          rules: (meta && Array.isArray(meta.rules)) ? meta.rules : [],
          globalRules: rulesOf(),
          group: (meta && meta.group) || '',
          ugroup: ug,
          cfg: {
            weightMode: weightMode(),
            moneyPerToken: money(),
            miBase: miBase(),
            ugroupDiscount: ugroupDiscount(),
            chargePrecision: D().chargePrecision,
          },
        });
        if (!res) return null;   // 没配价、没规则 → 交回内核（老口径，零迁移）

        /* 成本核算：写入明细（异步、失败不影响转发） */
        recordLedger(usage, res, { inst, ch, uk, ug });
        return { charged: res.charged, detail: res.detail };
      } catch (e) {
        ctx.log('billing 结算异常（按老口径继续）:', e.message);
        return null;
      }
    });

    /* ---------- 明细账（JSONL，按天分文件）----------
     * ★保留期：**默认永久保留**（`ledgerKeepDays` = 0）；设 >0 才按天滚动删除。
     *   2026-09-18 用户定：「账单不能丢」→ 默认 0（实测每天仅 5~10KB，永久也就几 MB）。 */
    const ledgerFile = () => path.join(ledgerDir, new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.jsonl');
    function recordLedger(usage, res, info) {
      try {
        if (D().ledger === false) return;
        const ct = costOf();
        const cost = ct[String(usage.model || '')] || null;
        const d = res.detail || {};
        let costMoney = null;
        if (cost) {
          const cr = Math.max(0, Number(usage.cacheRead) || 0);
          const fresh = Math.max(0, (Number(usage.input) || 0) - cr);
          costMoney = (fresh * (Number(cost['in']) || 0) + cr * (Number(cost.cacheRead) || Number(cost['in']) || 0)
            + (Number(usage.cacheWrite) || 0) * (Number(cost.cacheWrite) || Number(cost['in']) || 0)
            + (Number(usage.output) || 0) * (Number(cost.out) || 0)) / 1e6;
        }
        const row = {
          t: new Date().toISOString(), model: String(usage.model || ''), ch: info.ch, inst: info.inst,
          in: Number(usage.input) || 0, out: Number(usage.output) || 0,
          cr: Number(usage.cacheRead) || 0, cw: Number(usage.cacheWrite) || 0,
          charged: res.charged, mode: d.mode || '', hits: d.hits || [],
          cost: costMoney, uid: (info.uk && info.uk.uid) || '', ug: info.ug || '',
          keyName: info.uk ? (info.uk.name || String(info.uk.key || '').slice(0, 12)) : '',
        };
        fs.appendFile(ledgerFile(), JSON.stringify(row) + '\n', () => {});
      } catch (_) { /* 账本写失败不影响转发 */ }
    }
    /* 明细账清理：keepDays=0（默认）→ **不删**（永久保留）；>0 才滚动删除。
     * ★必须走 ctx.cron 定时执行：以前只在 activate 里清一次，那样网关长期不重启就永不清理
     *  （与 usage-history 2026-09-18 修的"只启动时压实"是同族缺陷）。 */
    ctx.cron(6 * 3600 * 1000, () => {
      try {
        const keep = Number(D().ledgerKeepDays) || 0;
        if (!(keep > 0)) return;
        const cutoff = Date.now() - keep * 86400000;
        for (const f of fs.readdirSync(ledgerDir)) {
          const m = f.match(/^(\d{4})(\d{2})(\d{2})\.jsonl$/);
          if (!m) continue;
          if (new Date(m[1] + '-' + m[2] + '-' + m[3]).getTime() < cutoff) { try { fs.unlinkSync(path.join(ledgerDir, f)); } catch (_) {} }
        }
      } catch (_) {}
    });

    const readLedger = (days) => {
      const out = [];
      const n = Math.max(1, Math.min(31, Number(days) || 1));
      for (let i = 0; i < n; i++) {
        const d = new Date(Date.now() - i * 86400000);
        const f = path.join(ledgerDir, d.toISOString().slice(0, 10).replace(/-/g, '') + '.jsonl');
        try {
          if (!fs.existsSync(f)) continue;
          for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { out.push(JSON.parse(line)); } catch (_) {}
          }
        } catch (_) {}
      }
      return out;
    };

    /* ==================== 管理端点 ==================== */
    const adminOnly = (p, res) => {
      const a = p.authAdmin();
      if (!a.ok) { jsonRes(res, a.status || 401, { error: a.error || 'unauthorized' }); return false; }
      return true;
    };

    ctx.registerRoute('GET', '/admin/status', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      const rows = readLedger(1);
      const sum = rows.reduce((a, r) => {
        a.charged += Number(r.charged) || 0;
        a.cost += Number(r.cost) || 0;
        a.n++;
        return a;
      }, { charged: 0, cost: 0, n: 0 });
      const ms = msConfig();
      const priced = ms && ms.modelMeta ? Object.values(ms.modelMeta).filter(m => m && m.price).length : 0;
      const withRules = ms && ms.modelMeta ? Object.values(ms.modelMeta).filter(m => m && Array.isArray(m.rules) && m.rules.length).length : 0;
      jsonRes(res, 200, {
        ok: true,
        weightMode: weightMode(), moneyPerToken: money(),
        globalRules: rulesOf().length, modelsPriced: priced, modelsWithRules: withRules,
        ugroupDiscount: Object.keys(ugroupDiscount()).length, costModels: Object.keys(costOf()).length,
        today: { requests: sum.n, chargedTokens: Math.round(sum.charged), costMoney: Number(sum.cost.toFixed(6)) },
        ledger: D().ledger !== false,
        ledgerKeepDays: Number(D().ledgerKeepDays) || 0,   /* 0 = 永久保留 */
        triggers: TRIGGERS, effects: EFFECTS,
      });
    });

    /* ---- 全局规则 ---- */
    ctx.registerRoute('GET', '/admin/rules', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      jsonRes(res, 200, { ok: true, rules: rulesOf(), triggers: TRIGGERS, effects: EFFECTS, weightMode: weightMode(), moneyPerToken: money(), miBase: miBase(), ugroupDiscount: ugroupDiscount() });
    });

    ctx.registerRoute('POST', '/admin/rules', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      const j = p.body || {};
      const act = String(j.action || '');
      const list = rulesOf().slice();

      const norm = (r) => {
        if (!r || typeof r !== 'object') return null;
        const o = {
          id: String(r.id || ('r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5))).slice(0, 40),
          note: String(r.note || '').slice(0, 80),
          on: r.on !== false,
          when: Array.isArray(r.when) ? r.when.slice(0, 8).map(c => ({
            k: String((c && c.k) || 'expr').slice(0, 20),
            op: String((c && c.op) || 'eq').slice(0, 12),
            v: (c && (typeof c.v === 'object' ? c.v : String(c.v == null ? '' : c.v).slice(0, 200))) || '',
          })) : [],
          then: Array.isArray(r.then) ? r.then.slice(0, 8).map(e => ({
            k: String((e && e.k) || 'mult').slice(0, 16),
            field: String((e && e.field) || 'all').slice(0, 16),
            mode: String((e && e.mode) || 'set').slice(0, 8),
            v: Number((e && e.v)) || 0,
          })) : [],
        };
        /* ★校验：表达式类条件先试算一次，写错了当场拒绝（不能让坏规则进库，否则每请求都算错） */
        for (const c of o.when) {
          if (c.k === 'expr') {
            try { engine.evalExpr(c.v, { ctxLen: 1, hour: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, minute: 0, day: 1, weekday: 1, perCall: 0, priceIn: 1, priceOut: 1 }); }
            catch (e) { return { error: '自定义表达式有误: ' + e.message }; }
          }
        }
        if (!o.then.length) return { error: '规则至少要有一条"触发效果"' };
        return o;
      };

      if (act === 'add') {
        const r = norm(j.rule);
        if (r && r.error) return jsonRes(res, 400, { error: r.error });
        list.push(r);
      } else if (act === 'update') {
        const i = Number(j.index);
        if (!(i >= 0 && i < list.length)) return jsonRes(res, 404, { error: '规则不存在' });
        const r = norm(Object.assign({ id: list[i].id }, j.rule));
        if (r && r.error) return jsonRes(res, 400, { error: r.error });
        list[i] = r;
      } else if (act === 'delete') {
        const i = Number(j.index);
        if (!(i >= 0 && i < list.length)) return jsonRes(res, 404, { error: '规则不存在' });
        list.splice(i, 1);
      } else if (act === 'toggle') {
        const i = Number(j.index);
        if (!(i >= 0 && i < list.length)) return jsonRes(res, 404, { error: '规则不存在' });
        list[i].on = list[i].on === false;
      } else if (act === 'move') {
        const i = Number(j.index), to = Number(j.to);
        if (!(i >= 0 && i < list.length) || !(to >= 0 && to < list.length)) return jsonRes(res, 400, { error: '位置无效' });
        const [x] = list.splice(i, 1); list.splice(to, 0, x);
      } else if (act === 'clear') {
        list.length = 0;
      } else if (act === 'settings') {
        /* 全局设置（权重模式/汇率/折扣表/记账开关） */
        if (j.weightMode !== undefined) setData('weightMode', !!j.weightMode);
        if (j.moneyPerToken !== undefined) setData('moneyPerToken', Math.max(0, Number(j.moneyPerToken) || 0));
        if (j.ugroupDiscount && typeof j.ugroupDiscount === 'object') {
          const m = {};
          for (const k of Object.keys(j.ugroupDiscount).slice(0, 50)) {
            const v = Number(j.ugroupDiscount[k]);
            if (v > 0 && v <= 10) m[String(k).slice(0, 40)] = v;
          }
          setData('ugroupDiscount', m);
        }
        if (j.ledger !== undefined) setData('ledger', !!j.ledger);
        if (j.miBase !== undefined) setData('miBase', !!j.miBase);   /* ★计费基数：true=1Mi(2²⁰) / false=1M(10⁶) */
        /* 明细账保留天数：0 = 永久（默认）；上限 10 年防手滑 */
        if (j.ledgerKeepDays !== undefined) setData('ledgerKeepDays', Math.max(0, Math.min(3650, Number(j.ledgerKeepDays) || 0)));
        if (j.chargePrecision !== undefined) setData('chargePrecision', Math.max(0, Math.min(6, Number(j.chargePrecision) || 0)));
        if (j.blockUnpriced !== undefined) setData('blockUnpriced', !!j.blockUnpriced);   /* ★未定价模型是否禁调用（默认开） */
        return jsonRes(res, 200, { ok: true, weightMode: weightMode(), moneyPerToken: money(), miBase: miBase(), ugroupDiscount: ugroupDiscount() });
      } else {
        return jsonRes(res, 400, { error: '未知操作: ' + act });
      }
      setData('rules', list);
      /* 回读校验（写完必须能读回，否则静默失败会很难查） */
      const back = rulesOf();
      jsonRes(res, 200, { ok: true, count: back.length, rules: back });
    });

    /* ---- 上游成本表（元/1M tokens） ---- */
    ctx.registerRoute('GET', '/admin/cost', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      jsonRes(res, 200, { ok: true, cost: costOf() });
    });
    ctx.registerRoute('POST', '/admin/cost', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      const j = p.body || {};
      const act = String(j.action || 'set');
      const c = Object.assign({}, costOf());
      if (act === 'delete') {
        const m = String(j.model || '');
        if (!c[m]) return jsonRes(res, 404, { error: '该模型没有成本记录: ' + m });
        delete c[m]; setData('cost', c);
        return jsonRes(res, 200, { ok: true, cost: costOf() });
      }
      if (act === 'import') {
        /* 批量导入：{ items: { "模型": {in,out,...} } } 或 [{model,in,out}] */
        const src = j.items || {};
        let n = 0;
        const arr = Array.isArray(src) ? src : Object.keys(src).map(k => Object.assign({ model: k }, src[k]));
        for (const it of arr.slice(0, 500)) {
          const m = String((it && it.model) || '').trim();
          if (!m) continue;
          c[m] = {
            'in': Math.max(0, Number(it['in']) || 0), out: Math.max(0, Number(it.out) || 0),
            cacheRead: Math.max(0, Number(it.cacheRead) || 0), cacheWrite: Math.max(0, Number(it.cacheWrite) || 0),
          };
          n++;
        }
        setData('cost', c);
        return jsonRes(res, 200, { ok: true, imported: n, cost: costOf() });
      }
      const m = String(j.model || '').trim();
      if (!m) return jsonRes(res, 400, { error: '缺少模型名' });
      c[m] = {
        'in': Math.max(0, Number(j['in']) || 0), out: Math.max(0, Number(j.out) || 0),
        cacheRead: Math.max(0, Number(j.cacheRead) || 0), cacheWrite: Math.max(0, Number(j.cacheWrite) || 0),
      };
      setData('cost', c);
      jsonRes(res, 200, { ok: true, cost: costOf() });
    });

    /* ---- 利润报表 ---- */
    ctx.registerRoute('GET', '/admin/profit', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      const days = Number(p.query.days) || 1;
      const rows = readLedger(days);
      const byModel = {}, byDay = {};
      let tot = { n: 0, charged: 0, cost: 0, in: 0, out: 0, cr: 0, cw: 0, noCost: 0 };
      for (const r of rows) {
        const k = String(r.model || '?');
        const b = byModel[k] || (byModel[k] = { model: k, n: 0, charged: 0, cost: 0, hasCost: true, cr: 0, cw: 0 });
        b.n++; b.charged += Number(r.charged) || 0; b.cr += Number(r.cr) || 0; b.cw += Number(r.cw) || 0;
        if (r.cost == null) { b.hasCost = false; tot.noCost++; } else b.cost += Number(r.cost) || 0;
        const day = String(r.t || '').slice(0, 10);
        const d = byDay[day] || (byDay[day] = { day, n: 0, charged: 0, cost: 0 });
        d.n++; d.charged += Number(r.charged) || 0; if (r.cost != null) d.cost += Number(r.cost) || 0;
        tot.n++; tot.charged += Number(r.charged) || 0; if (r.cost != null) tot.cost += Number(r.cost) || 0;
        tot['in'] += Number(r['in']) || 0; tot.out += Number(r.out) || 0; tot.cr += Number(r.cr) || 0; tot.cw += Number(r.cw) || 0;
      }
      const mpt = money();
      const list = Object.values(byModel).map(b => {
        const chargedMoney = (mpt > 0) ? b.charged * mpt : null;
        return Object.assign(b, {
          charged: Math.round(b.charged),
          cost: Number(b.cost.toFixed(6)),
          chargedMoney: chargedMoney == null ? null : Number(chargedMoney.toFixed(6)),
          profit: (chargedMoney == null || !b.hasCost) ? null : Number((chargedMoney - b.cost).toFixed(6)),
          profitRate: (chargedMoney && b.hasCost && chargedMoney > 0) ? Number(((chargedMoney - b.cost) / chargedMoney * 100).toFixed(2)) : null,
        });
      }).sort((a, b) => b.n - a.n);
      jsonRes(res, 200, {
        ok: true, days, moneyPerToken: mpt,
        totals: {
          requests: tot.n, chargedTokens: Math.round(tot.charged),
          costMoney: Number(tot.cost.toFixed(6)),
          chargedMoney: mpt > 0 ? Number((tot.charged * mpt).toFixed(6)) : null,
          profit: mpt > 0 ? Number((tot.charged * mpt - tot.cost).toFixed(6)) : null,
          inputTokens: tot['in'], outputTokens: tot.out, cacheReadTokens: tot.cr, cacheWriteTokens: tot.cw,
          noCostRequests: tot.noCost,
        },
        byModel: list, byDay: Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1)),
      });
    });

    /* ---- 试算（管理端预览"这条请求会扣多少"，不扣费） ---- */
    ctx.registerRoute('POST', '/admin/simulate', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      const j = p.body || {};
      const usage = {
        input: Math.max(0, Number(j.input) || 0), output: Math.max(0, Number(j.output) || 0),
        cacheRead: Math.max(0, Number(j.cacheRead) || 0), cacheWrite: Math.max(0, Number(j.cacheWrite) || 0),
        model: String(j.model || ''), channel: String(j.channel || ''),
      };
      const inst = String(j.instance || (ctx.instanceName || ''));
      const t = j.at ? new Date(j.at) : new Date();
      const meta = metaFor(inst, usage.channel, usage.model);
      const res2 = engine.compute(usage, {
        price: meta && meta.price ? meta.price : null,
        perCall: meta ? meta.perCall : null,
        rules: (meta && Array.isArray(meta.rules)) ? meta.rules : [],
        globalRules: rulesOf(),
        group: (meta && meta.group) || '',
        ugroup: String(j.ugroup || ''),
        at: isNaN(t.getTime()) ? new Date() : t,
        cfg: { weightMode: weightMode(), moneyPerToken: money(), miBase: miBase(), ugroupDiscount: ugroupDiscount(), chargePrecision: D().chargePrecision },
      });
      jsonRes(res, 200, {
        ok: true, charged: res2 ? res2.charged : (usage.input + usage.output),
        detail: res2 ? res2.detail : { mode: 'legacy(未配价按 input+output)' },
        priced: !!(meta && meta.price), modelRules: (meta && meta.rules) ? meta.rules.length : 0,
        globalRules: rulesOf().length,
      });
    });

    /* ---- 查某模型当前生效的价格与命中规则 ---- */
    ctx.registerRoute('GET', '/admin/model-price', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      const model = String(p.query.model || ''), ch = String(p.query.channel || ''), inst = String(p.query.instance || ctx.instanceName || '');
      const meta = metaFor(inst, ch, model);
      jsonRes(res, 200, {
        ok: true, found: !!meta,
        model, channel: ch, instance: inst,
        group: (meta && meta.group) || '', price: (meta && meta.price) || null, perCall: meta ? meta.perCall : null,
        rules: (meta && Array.isArray(meta.rules)) ? meta.rules : [],
        globalRules: rulesOf(),
      });
    });

    /* ==================== 管理端 SDUI 页面（插件贡献，App 原生渲染，零 WebView） ==================== */
    const G = {
      txt: (text, style, color) => { const o = { type: 'text', text }; if (style) o.style = style; if (color) o.color = color; return o; },
      kv: (label, value) => ({ type: 'kv', label, value }),
      badge: (text, tone) => ({ type: 'badge', text, tone }),
      btn: (text, style, action, extra) => Object.assign({ type: 'button', text, style, action }, extra || {}),
      gap: (height) => ({ type: 'spacer', height: height || 8 }),
      card: (children, extra) => Object.assign({ type: 'card', variant: 'outlined', gap: 10, children }, extra || {}),
      row: (children, gap) => ({ type: 'row', gap: gap == null ? 8 : gap, children }),
    };
    const fmt = (v, d) => (v == null || v === '' || isNaN(Number(v))) ? '—' : (Math.round(Number(v) * Math.pow(10, d == null ? 2 : d)) / Math.pow(10, d == null ? 2 : d)).toString();
    const call = (sub, body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call', body: { plugin: 'billing', path: sub, method: 'POST', body: body } });

    /* 规则一行 → gcui */
    const ruleRow = (r, i) => {
      const whenTxt = (r.when || []).map(c => c.k === 'expr' ? ('(' + c.v + ')') : (c.k + ' ' + c.op + ' ' + (Array.isArray(c.v) ? c.v.join('~') : c.v))).join(' 且 ') || '无条件';
      const thenTxt = (r.then || []).map(e => e.k === 'price' ? ('单价 ' + e.field + '=' + e.v) : e.k === 'mult' ? ('×' + e.v) : e.k === 'free' ? '免费' : e.k === 'perCall' ? ('按次 ' + e.v) : e.k).join('，');
      return G.card([
        G.row([
          Object.assign(G.txt(r.note || ('规则 ' + (i + 1)), 'title3'), { weight: 1 }),
          G.badge(r.on === false ? '已停用' : '生效中', r.on === false ? 'neutral' : 'success'),
        ]),
        G.txt('触发：' + whenTxt, 'caption', '$onSurfaceVariant'),
        G.txt('效果：' + thenTxt, 'caption', '$onSurfaceVariant'),
        G.row([
          G.btn(r.on === false ? '启用' : '停用', 'tonal', call('/admin/rules', { action: 'toggle', index: i }), { weight: 1 }),
          G.btn('上移', 'text', call('/admin/rules', { action: 'move', index: i, to: i - 1 }), { weight: 1, visible: i > 0 }),
          G.btn('下移', 'text', call('/admin/rules', { action: 'move', index: i, to: i + 1 }), { weight: 1 }),
          G.btn('删除', 'text', Object.assign(call('/admin/rules', { action: 'delete', index: i }), { confirm: '删除规则「' + (r.note || i + 1) + '」？' }), { weight: 1 }),
        ], 6),
      ]);
    };

    ctx.registerAdminUi({
      id: 'billing',
      title: '动态计费',
      subtitle: '规则 · 成本 · 利润',
      icon: 'wallet',
      menu: true,
      render: (gw, c, q) => {
        const rows = readLedger(1);
        const sum = rows.reduce((a, r) => { a.ch += Number(r.charged) || 0; a.cost += Number(r.cost) || 0; a.n++; return a; }, { ch: 0, cost: 0, n: 0 });
        const ms = msConfig();
        const mm = (ms && ms.modelMeta) || {};
        const priced = Object.values(mm).filter(m => m && m.price).length;
        const withRules = Object.values(mm).filter(m => m && Array.isArray(m.rules) && m.rules.length).length;
        const rules = rulesOf();
        const kids = [
          G.txt('动态计费', 'title3'),
          G.txt('额度仍由卡密插件扣除；本页负责"该扣多少"。未配价格的模型按原口径 1:1 扣费。', 'caption', '$onSurfaceVariant'),
          G.card([
            G.row([
              { type: 'metricTile', value: String(rules.length), label: '全局规则', weight: 1 },
              { type: 'metricTile', value: String(priced), label: '已定价模型', weight: 1 },
              { type: 'metricTile', value: String(withRules), label: '带规则模型', weight: 1 },
            ]),
            G.kv('计费口径', weightMode() ? ('权重模式（价格 = 额度 / ' + (miBase() ? '1Mi' : '1M') + ' tokens）') : '金额模式（元/1M ÷ 汇率）'),
            G.kv('计费基数', miBase() ? '1Mi = 2²⁰ = 1,048,576 tokens' : '1M = 10⁶ = 1,000,000 tokens'),
            G.kv('每 token 汇率', money() > 0 ? String(money()) : '未设置（无法把金额换算成额度）'),
            G.kv('用户组折扣', Object.keys(ugroupDiscount()).length ? Object.entries(ugroupDiscount()).map(([k, v]) => k + '×' + v).join('、') : '无'),
            G.kv('今日结算', sum.n + ' 次 · 扣 ' + Math.round(sum.ch) + ' 额度 · 成本 ' + fmt(sum.cost, 4) + ' 元'),
          ]),
          G.gap(4),
          G.txt('计费基数开关（价格表填的数含义不变，只换分母；金额模式始终按 元/1M tokens）', 'caption', '$onSurfaceVariant'),
          G.row([
            { type: 'chip', text: '按 1M 计费（10⁶）', icon: 'msym:check', selected: !miBase(), action: call('/admin/rules', { action: 'settings', miBase: false }) },
            { type: 'chip', text: '按 1Mi 计费（2²⁰）', icon: 'msym:check', selected: miBase(), action: call('/admin/rules', { action: 'settings', miBase: true }) },
          ]),
          G.gap(4),
          G.txt('全局规则（对所有模型生效，可被模型级规则覆盖）', 'title3'),
        ];
        if (!rules.length) kids.push(G.txt('还没有全局规则。想在"模型编辑"弹窗里给单个模型配规则也可以。', 'caption', '$onSurfaceVariant'));
        rules.forEach((r, i) => kids.push(ruleRow(r, i)));
        kids.push(G.gap(4));
        kids.push(G.btn('刷新', 'tonal', { type: 'refresh' }));
        kids.push(G.txt('规则语法：触发条件全部满足才生效；效果按顺序叠加。价格填 0 = 免费，填 0.5 = 半价权重（也可用「整体倍率」表达）。', 'caption', '$onSurfaceVariant'));
        return { title: '动态计费', state: {}, root: { type: 'column', gap: 10, children: kids } };
      },
    });

    ctx.log('动态计费已激活：全局规则 ' + rulesOf().length + ' 条，成本表 ' + Object.keys(costOf()).length + ' 个模型');
  },
};
