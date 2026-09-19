'use strict';

























const path = require('path');
const fs = require('fs');
const engine = require('./engine.js');

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}



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
    





    const D = () => { const d = ctx.data.all() || {}; return d; };
    const rulesOf = () => { const r = D().rules; return Array.isArray(r) ? r : []; };
    const costOf = () => { const c = D().cost; return (c && typeof c === 'object') ? c : {}; };
    

    const setData = (k, v) => { ctx.data.set(k, v); if (ctx.data.flush) ctx.data.flush(); };
    const ledgerDir = path.join(ctx.dataDir, 'ledger');
    try { fs.mkdirSync(ledgerDir, { recursive: true }); } catch (_) {}

    const money = () => Number(D().moneyPerToken) || 0;
    const weightMode = () => D().weightMode !== false;   
    


    const miBase = () => D().miBase === true;
    const ugroupDiscount = () => D().ugroupDiscount || {};

    
    let _msCache = null, _msAt = 0;
    const msConfig = () => {
      const now = Date.now();
      if (_msCache && now - _msAt < 15000) return _msCache;   
      try {
        const c = ctx.getPluginConfig('model-square', 0);
        _msCache = (c && typeof c === 'object') ? c : null;
      } catch (_) { _msCache = null; }
      _msAt = now;
      return _msCache;
    };

    
    const metaFor = (inst, ch, model) => {
      const ms = msConfig();
      if (!ms || !ms.modelMeta) return null;
      const mm = ms.modelMeta;
      
      const direct = mm[[String(inst || ''), String(ch), String(model)].join('|')];
      if (direct) return direct;
      const i = String(inst || ''), c = String(ch), m = String(model);
      
      if (c) {
        const pre = i + '|' + c + '|';
        for (const k of Object.keys(mm)) {
          if (k.indexOf(pre) !== 0) continue;
          const v = mm[k];
          if (v && v.alias && String(v.alias) === m) return v;
        }
      }
      



      let fallback = null;
      for (const k of Object.keys(mm)) {
        const parts = k.split('|');
        const km = parts.slice(2).join('|');           
        const v = mm[k];
        if (km === m || (v && v.alias && String(v.alias) === m)) {
          if (v && v.price) return v;                 
          if (!fallback) fallback = v;
        }
      }
      return fallback;
    };

    
    let _auCache = null, _auAt = 0;
    const auConfig = () => {
      const now = Date.now();
      if (_auCache && now - _auAt < 15000) return _auCache;
      try {
        const c = ctx.getPluginConfig('auth-user', 0);
        _auCache = (c && typeof c === 'object') ? c : null;
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

    
    
    





    ctx.hook('onChatAuth', ({ model, cfg }) => {
      if (D().blockUnpriced === false) return null;
      if (!model) return null;
      const inst = (cfg && cfg._name) || ctx.instanceName || '';
      const meta = metaFor(inst, '', model);
      const priced = !!(meta && (meta.price || (meta.perCall != null && meta.perCall !== '')));
      if (priced) return null;
      return { status: 403, message: '模型「' + model + '」未定价，已禁止调用（请先在模型广场给该模型配置价格）' };
    });
    






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
        if (!res) return null;   

        
        recordLedger(usage, res, { inst, ch, uk, ug });
        return { charged: res.charged, detail: res.detail };
      } catch (e) {
        ctx.log('billing 结算异常（按老口径继续）:', e.message);
        return null;
      }
    });

    


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
      } catch (_) {  }
    }
    


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
        ledgerKeepDays: Number(D().ledgerKeepDays) || 0,   
        triggers: TRIGGERS, effects: EFFECTS,
      });
    });

    
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
        if (j.miBase !== undefined) setData('miBase', !!j.miBase);   
        
        if (j.ledgerKeepDays !== undefined) setData('ledgerKeepDays', Math.max(0, Math.min(3650, Number(j.ledgerKeepDays) || 0)));
        if (j.chargePrecision !== undefined) setData('chargePrecision', Math.max(0, Math.min(6, Number(j.chargePrecision) || 0)));
        if (j.blockUnpriced !== undefined) setData('blockUnpriced', !!j.blockUnpriced);   
        return jsonRes(res, 200, { ok: true, weightMode: weightMode(), moneyPerToken: money(), miBase: miBase(), ugroupDiscount: ugroupDiscount() });
      } else {
        return jsonRes(res, 400, { error: '未知操作: ' + act });
      }
      setData('rules', list);
      
      const back = rulesOf();
      jsonRes(res, 200, { ok: true, count: back.length, rules: back });
    });

    
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
