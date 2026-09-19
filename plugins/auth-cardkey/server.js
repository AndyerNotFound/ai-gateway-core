'use strict';





const crypto = require('crypto');





const quotaFrozen = new Map(); 

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

module.exports.activate = (ctx) => {
  


  let _cfgCache = null, _cfgRev = -1;
  const cfgLive = () => {
    const r = ctx.configRev ? ctx.configRev() : 0;
    if (!_cfgCache || r !== _cfgRev) {
      const fresh = ctx.getPluginConfig('auth-cardkey');
      _cfgCache = (fresh && typeof fresh === 'object') ? fresh : Object.assign({}, ctx.config);
      _cfgRev = r;
    }
    return _cfgCache;
  };
  const keys = () => { const c = cfgLive(); if (!Array.isArray(c.apiKeys)) c.apiKeys = []; return c.apiKeys; };
  const keyLength = () => Math.min(128, Math.max(8, Number(cfgLive().keyLength) || 24));
  const usage = () => ctx.data.get('usage') || {};
  const usedOf = k => (usage()[k.key] || 0);
  const frozenOf = k => quotaFrozen.get(k.key) || 0;
  
  const fmtAmt = (v) => {
    const x = Number(v);
    if (!isFinite(x)) return '0';
    return String(Math.round(x * 1e6) / 1e6);
  };
  const setUsed = (k, v) => {
    



    const u = usage();
    const x = Number(v);
    u[k.key] = isFinite(x) ? Math.max(0, Math.round(x * 1e6) / 1e6) : (u[k.key] || 0);
    ctx.data.set('usage', u);
  };
  const save = () => ctx.setPluginConfig(cfgLive());
  


  const genKey = () => {
    const live = keys();
    let k;
    do { k = 'sk-' + crypto.randomBytes(Math.ceil(keyLength() * 3 / 4) + 2).toString('base64url').slice(0, keyLength()); }
    while (live.some(x => x && x.key === k));
    return k;
  };

  const creditsJSON = (uk) => {
    const qt = Number(uk.quotaTokens);
    const zeroLimited = qt === 0; 
    const unlimited = qt === -1; 
    const quota = (zeroLimited || unlimited) ? 0 : Math.max(0, qt);
    const used = usedOf(uk);
    return {
      name: uk.name || '', uid: uk.uid || '', quotaTokens: quota, usedTokens: used,
      

      usedTokensDisplay: Math.round(used * 1e6) / 1e6,
      remainingTokens: zeroLimited ? 0 : (unlimited ? null : Math.max(0, quota - used - frozenOf(uk))),
      reservedTokens: unlimited ? 0 : Math.round(frozenOf(uk) * 1e6) / 1e6,
      unlimited, zeroLimited,
      expiresAt: uk.expiresAt || '', models: uk.models || [], groups: uk.groups || [], branches: uk.branches || [],
    };
  };

  
  ctx.registerAuth({
    name: 'cardkey',
    check: ({ token, req }) => {
      if (!token) return null;
      const uk = keys().find(k => k && k.key === token);
      if (!uk) return null;
      if (uk.enable === false) return { ok: false, status: 401, error: 'key 已禁用' };
      if (uk.expiresAt) {
        const t = new Date(uk.expiresAt).getTime();
        if (!isNaN(t) && t < Date.now()) return { ok: false, status: 401, error: 'key 已过期 (' + uk.expiresAt + ')' };
      }
      const used = usedOf(uk);
      if (uk.quotaTokens === 0) {
        

        const p = (req && req.url || '').split('?')[0];
        



        const selfServe = /(^|\/)auth\//.test(p)
          || /\/credits$/.test(p)
          || /\/v1\/models(\/[^\/]+)?$/.test(p)
          || /\/v1\/branches$/.test(p)
          || /\/plugins\/[^\/]+\/(ui|intent|data)(\/|$)/.test(p);
        
        if (!selfServe) return { ok: false, status: 429, error: '余额不足：当前额度为 0，无法调用模型（请联系管理员充值）' };
      }
      if (uk.quotaTokens > 0 && used >= uk.quotaTokens)
        return { ok: false, status: 429, error: '余额不足：额度已用尽 (' + fmtAmt(used) + '/' + fmtAmt(uk.quotaTokens) + ')，无法调用模型（请联系管理员充值）' };
      return { ok: true, userKey: Object.assign({}, uk, { usedTokens: used }) };
    },
  });

  
  const syncGlobal = () => { for (const k of keys()) if (k && k.key) ctx.gateway.registerGlobalKey(k.key, k.branches || []); };
  syncGlobal();

  




  ctx.hook('onChatAuth', ({ userKey, model, body }) => {
    if (!userKey) return null;
    if (Array.isArray(userKey.models) && userKey.models.length && !userKey.models.includes(model))
      return { status: 403, message: '此卡密不允许使用模型: ' + model + ' (可用: ' + userKey.models.join(', ') + ')' };
    const gs = Array.isArray(userKey.groups) ? userKey.groups : [];
    if (gs.length) {
      let ok = true;
      try { ok = ctx.gateway.modelGroups().matches(model, gs); }
      catch (e) { ok = true; ctx.log('分组校验不可用(放行):', e.message); }
      if (!ok) return { status: 403, message: '此卡密只能使用分组内的模型: ' + model + ' (允许分组: ' + gs.join(', ') + ')' };
    }
    
    return { quota: {
      reserve: ({ canonical, cfg, estimateCharge, ch }) => {
        const qt = Number(userKey.quotaTokens);
        if (qt === -1) return { release: () => {} };
        const promptEstimate = Math.ceil(JSON.stringify(body || {}).length / 2);
        let maxOut = Math.max(1, Math.min(1000000, Number(
          body && (body.max_tokens ?? body.max_completion_tokens ?? (body.generationConfig && body.generationConfig.maxOutputTokens))
        ) || 4096));
        



        maxOut = Math.min(maxOut, 4096);
        const tokens = promptEstimate + maxOut;
        






        let estimate = tokens, inChargeUnit = false;
        if (typeof estimateCharge === 'function') {
          const v = estimateCharge({
            model: (canonical && canonical.model) || '',
            inst: (cfg && cfg._name) || ctx.instanceName || '',
            ch: ch || '', input: promptEstimate, output: maxOut, uid: userKey.uid || '', cfg,
          });
          if (v !== null && v !== undefined && isFinite(Number(v)) && Number(v) >= 0) {
            estimate = Number(v); inChargeUnit = true;
          }
        }
        const used = usedOf(userKey);
        const frozen = frozenOf(userKey);
        const available = Math.max(0, qt - used - frozen);
        if (estimate > available) return {
          error: '余额不足：当前可用额度约 ' + fmtAmt(available) + (inChargeUnit
            ? '，本次请求预计消耗约 ' + fmtAmt(estimate) + ' 额度（max_tokens=' + maxOut + '）'
            : '，本次请求预授权需要约 ' + estimate + '（max_tokens=' + maxOut + '）'),
          status: 429,
        };
        quotaFrozen.set(userKey.key, frozen + estimate);
        let released = false;
        return { estimate, inChargeUnit, release: () => {
          if (released) return;
          released = true;
          const next = (quotaFrozen.get(userKey.key) || 0) - estimate;
          if (next > 0) quotaFrozen.set(userKey.key, next); else quotaFrozen.delete(userKey.key);
        }};
      },
    }};
  });

  





  ctx.hook('onUsage', (usage, c) => {
    const uk = c.urlInfo && c.urlInfo.userKey;
    if (!uk || !uk.key || !usage) return;
    const legacy = (Number(usage.input) || 0) + (Number(usage.output) || 0);
    const charged = (usage.charged != null) ? Number(usage.charged) : legacy;
    if (!isFinite(charged)) return;
    setUsed(uk, usedOf(uk) + charged);
  });

  
  ctx.bindAuthApis({
    findKey: (cfg2, token) => { const k = keys().find(x => x && x.key === token); return k ? Object.assign({}, k, { usedTokens: usedOf(k) }) : null; },
    
    accessOptions: (scope) => optionsJSON(scope || null),
    grantQuota: (cfg2, keyId, tokens) => { const k = keys().find(x => x && x.key === keyId); if (!k || !(tokens > 0)) return false; setUsed(k, usedOf(k) - tokens); return true; },
    listKeys: () => keys().map(k => Object.assign({}, k, { usedTokens: usedOf(k) })),
    addKey: (k) => { keys().push(k); save(); syncGlobal(); return k; },
    updateKey: (key, patch) => { const k = keys().find(x => x && x.key === key); if (!k) return false; Object.assign(k, patch); save(); syncGlobal(); return true; },
    deleteKey: (key) => { const i = keys().findIndex(x => x && x.key === key); if (i < 0) return false; const k = keys()[i]; keys().splice(i, 1); save(); ctx.gateway.unregisterGlobalKey(k.key); return true; },
    deleteKeysOf: (uid) => { const list = keys().filter(x => x && x.uid === uid); for (const k of list) { const i = keys().indexOf(k); if (i >= 0) keys().splice(i, 1); ctx.gateway.unregisterGlobalKey(k.key); } if (list.length) save(); return list.length; },
    creditsJSON, genKey,
  });

  
  ctx.registerTopRoute('GET', '/credits', ({ res, auth }) => {
    const r = auth();
    if (!r.ok) return jsonRes(res, r.status || 401, { error: r.error || 'invalid key' });
    if (r.userKey) return jsonRes(res, 200, creditsJSON(r.userKey));
    return jsonRes(res, 200, { admin: true, unlimited: true });
  });

  
  const adminOnly = (p, res) => { const a = p.authAdmin(); if (!a.ok) { jsonRes(res, a.status || 401, { error: a.error || 'unauthorized' }); return false; } return true; };

  ctx.registerRoute('GET', '/admin/keys', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    jsonRes(res, 200, { keys: keys().map(k => Object.assign({}, k, { usedTokens: usedOf(k) })) });
  });

  ctx.registerRoute('POST', '/admin/keys', (req, res, p) => { 
    if (!adminOnly(p, res)) return;
    const j = p.body || {};
    const nk = {
      key: genKey(), name: String(j.name || '卡密').slice(0, 64), enable: true,
      
      quotaTokens: Number(j.quotaTokens) === -1 ? -1 : Math.max(0, Number(j.quotaTokens) || 0), uid: String(j.uid || ''),
      models: Array.isArray(j.models) ? j.models.map(String) : [],
      groups: Array.isArray(j.groups) ? j.groups.map(String) : [],
      branches: Array.isArray(j.branches) ? j.branches.map(String) : [],
      channels: Array.isArray(j.channels) ? j.channels.map(String) : [],
      redact: j.redact == null ? null : !!j.redact,
      expiresAt: String(j.expiresAt || ''), note: String(j.note || '').slice(0, 200),
      by: 'admin',   
      createdAt: new Date().toISOString(),
    };
    keys().push(nk); save(); syncGlobal();
    jsonRes(res, 200, { ok: true, key: Object.assign({}, nk, { usedTokens: 0 }) });
  });

  ctx.registerRoute('POST', '/admin/keys-update', (req, res, p) => { 
    if (!adminOnly(p, res)) return;
    const j = p.body || {};
    const k = keys().find(x => x && x.key === j.key);
    if (!k) return jsonRes(res, 404, { error: '卡密不存在' });
    if (j.name !== undefined) k.name = String(j.name).slice(0, 64);
    if (j.enable !== undefined) k.enable = !!j.enable;
    if (j.models !== undefined) k.models = Array.isArray(j.models) ? j.models.map(String) : [];
    if (j.groups !== undefined) k.groups = Array.isArray(j.groups) ? j.groups.map(String) : [];
    if (j.branches !== undefined) k.branches = Array.isArray(j.branches) ? j.branches.map(String) : [];
    if (j.expiresAt !== undefined) k.expiresAt = String(j.expiresAt);
    if (j.note !== undefined) k.note = String(j.note).slice(0, 200);
    if (j.quotaTokens !== undefined) k.quotaTokens = Math.max(-1, Number(j.quotaTokens) || 0); 
    


    if (j.addQuota !== undefined && j.addQuota !== '' && j.addQuota !== null) {
      const delta = Number(j.addQuota);
      if (isFinite(delta) && delta !== 0) {
        if (k.quotaTokens !== -1) {
          k.quotaTokens = Math.max(0, (Number(k.quotaTokens) || 0) + delta);
        }
      }
    }
    if (j.resetUsage) setUsed(k, 0);
    save(); syncGlobal();
    jsonRes(res, 200, { ok: true, key: Object.assign({}, k, { usedTokens: usedOf(k) }) });
  });

  ctx.registerRoute('DELETE', '/admin/keys', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    const j = p.body || {};
    const i = keys().findIndex(x => x && x.key === j.key);
    if (i < 0) return jsonRes(res, 404, { error: '卡密不存在' });
    const k = keys()[i];
    keys().splice(i, 1); save(); ctx.gateway.unregisterGlobalKey(k.key);
    jsonRes(res, 200, { ok: true });
  });

  



  const optionsJSON = (scope) => {
    const gi = ctx.gateway.modelGroups ? ctx.gateway.modelGroups() : { declared: [], groupsOf: m => [], matches: () => true };
    const models = [];
    const instances = [];
    for (const inst of ctx.gateway.listInstances()) {
      if (inst.enabled === false) continue;
      instances.push(inst.name);
      let ic = null;
      try { ic = ctx.getInstanceConfig(inst.uid); } catch (_) { }
      if (!ic || !Array.isArray(ic.channels)) continue;
      for (const ch of ic.channels) {
        if (!ch || !ch.name) continue;
        const mm = (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {};
        const names = [];
        for (const m of (Array.isArray(ch.models) ? ch.models : [])) if (m) names.push(String(m));
        for (const k of Object.keys(mm)) if (k) names.push(String(k));
        for (const n of names) {
          if (models.some(x => x.name === n)) continue;
          const gs = gi.groupsOf(n);
          models.push({ name: n, group: gs[0] || 'Default', groups: gs, instance: inst.name, channel: ch.name });
        }
      }
    }
    let groups = gi.declared.slice();
    for (const m of models) for (const g of m.groups) if (!groups.includes(g)) groups.push(g);
    let outModels = models;
    if (scope) {
      const sm = Array.isArray(scope.models) ? scope.models : [];
      const sg = Array.isArray(scope.groups) ? scope.groups : [];
      if (sm.length) outModels = outModels.filter(m => sm.includes(m.name));
      if (sg.length) outModels = outModels.filter(m => m.groups.some(g => sg.includes(g)));
      if (sg.length) groups = groups.filter(g => sg.includes(g));
    }
    return { ok: true, groups, models: outModels, instances,
      defaultGroup: groups.includes('Default') ? 'Default' : (groups[0] || '') };
  };

  ctx.registerRoute('GET', '/admin/options', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    jsonRes(res, 200, optionsJSON(null));
  });

  
  ctx.registerTopRoute('GET', '/auth/access-options', ({ res, auth }) => {
    const r = auth();
    if (!r.ok) return jsonRes(res, r.status || 401, { error: r.error || 'invalid key' });
    jsonRes(res, 200, optionsJSON(r.userKey || null));
  });

  















  ctx.registerAdminUi({
    id: 'key-edit',
    title: '编辑卡密',
    icon: 'edit',
    menu: false,
    render: (gw, c, q) => {
      const qs = (n) => String((q && q.get) ? (q.get(n) || '') : '');
      const key = qs('key');
      const txt = (text, style, color) => { const o = { type: 'text', text: text }; if (style) o.style = style; if (color) o.color = color; return o; };
      const gap = (h) => ({ type: 'spacer', height: h || 8 });
      const btn = (text, style, action) => ({ type: 'button', text: text, style: style, action: action });
      const kids = [];
      const k = keys().find(x => x && x.key === key);
      if (!k) {
        kids.push(txt('卡密不存在或已被删除。', 'body'));
        kids.push(btn('关闭', 'text', { type: 'close' }));
        return { gcui: 1, title: '编辑卡密', state: {}, root: { type: 'column', gap: 10, children: kids } };
      }
      const groups = Array.isArray(k.groups) ? k.groups.map(String) : [];
      const models = Array.isArray(k.models) ? k.models.map(String) : [];
      const branches = Array.isArray(k.branches) ? k.branches.map(String) : [];
      const quota = Number(k.quotaTokens) || 0;
      const used = Math.round(usedOf(k) * 100) / 100;
      const mode = groups.length ? 'group' : (models.length ? 'model' : 'all');
      const opts = optionsJSON(null);
      const allGroups = (opts.groups || []).map(String);
      const allModels = [];
      for (const m of (opts.models || [])) { const n = String((m && m.name) || ''); if (n && allModels.indexOf(n) < 0) allModels.push(n); }
      const upd = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
        body: { plugin: 'auth-cardkey', path: '/admin/keys-update', method: 'POST', body: Object.assign({ key: key }, body) } });
      const permText = groups.length ? ('分组 ' + groups.join('/'))
        : (models.length ? (models.length + ' 个模型') : '全部模型');
      
      const gc = allGroups.map(g => {
        const on = groups.indexOf(g) >= 0;
        return { name: g, on: on, g: (on ? groups.filter(x => x !== g) : groups.concat([g])), m: [] };
      });
      const mc = allModels.map(m => {
        const on = models.indexOf(m) >= 0;
        return { name: m, on: on, g: [], m: (on ? models.filter(x => x !== m) : models.concat([m])) };
      });

      
      kids.push(txt(k.name || '(未命名)', 'title3'));
      kids.push(txt('卡号 ' + key.slice(0, 8) + '\u2026' + key.slice(-4) + (k.enable === false ? ' \u00b7 已禁用' : ''), 'caption', '$onSurfaceVariant'));
      kids.push(txt('额度 ' + (quota === -1 ? '不限' : String(quota)) + ' \u00b7 已用 ' + used, 'caption', '$onSurfaceVariant'));
      kids.push(gap(10));

      
      kids.push(txt('基本信息', 'title3'));
      kids.push({
        type: 'form', submitText: '保存基本信息', submitShape: 'large',
        fields: [
          { type: 'input', key: 'name', label: '卡名', value: String(k.name || '') },
          { type: 'input', key: 'quotaTokens', label: '额度（0 = 零额度；-1 = 不限）', inputType: 'number', value: String(quota) },
          { type: 'input', key: 'expiresAt', label: '到期日（YYYY-MM-DD，可空）', value: String(k.expiresAt || '') },
          { type: 'input', key: 'note', label: '备注', value: String(k.note || '') },
        ],
        submit: upd({
          name: '{{form.name}}', quotaTokens: '{{form.quotaTokens}}',
          expiresAt: '{{form.expiresAt}}', note: '{{form.note}}',
        }),
      });
      kids.push(gap(12));

      
      kids.push(txt('访问权限', 'title3'));
      kids.push(txt('当前：' + permText + (branches.length ? ' \u00b7 实例 ' + branches.join('/') : ''), 'caption', '$onSurfaceVariant'));
      kids.push({
        type: 'hscroll', gap: 8, children: [
          { type: 'chip', text: '不限', icon: 'msym:check', selected: '{{state.showNone}}', action: upd({ groups: [], models: [] }) },
          { type: 'chip', text: '按分组', icon: 'msym:group', selected: '{{state.showGroup}}',
            action: { type: 'setState', patch: { showGroup: true, showModel: false, showNone: false } } },
          { type: 'chip', text: '按模型', icon: 'msym:apps', selected: '{{state.showModel}}',
            action: { type: 'setState', patch: { showGroup: false, showModel: true, showNone: false } } },
        ],
      });
      kids.push(txt('「不限」立即生效；「按分组/按模型」只是切换下面的列表，点选具体项才保存。', 'caption', '$onSurfaceVariant'));

      
      kids.push({ type: 'text', text: '点分组即勾选/取消并立即保存（已选 ' + groups.length + ' / 共 ' + allGroups.length + '）',
        style: 'caption', color: '$onSurfaceVariant', visible: '{{state.showGroup}}' });
      if (allGroups.length) {
        kids.push({
          type: 'list', items: '{{state.gc}}', columns: 2, visible: '{{state.showGroup}}',
          template: {
            type: 'chip', text: '{{item.name}}', selected: '{{item.on}}',
            action: upd({ groups: '{{item.g}}', models: '{{item.m}}' }),
          },
        });
      } else {
        kids.push({ type: 'text', text: '没有可选分组（先在「模型分组 / 快速分组」里定义）。', style: 'caption', color: '$error', visible: '{{state.showGroup}}' });
      }

      
      kids.push({ type: 'text', text: '点模型即勾选/取消并立即保存（已选 ' + models.length + ' / 共 ' + allModels.length + '）',
        style: 'caption', color: '$onSurfaceVariant', visible: '{{state.showModel}}' });
      if (allModels.length) {
        kids.push({
          type: 'list', items: '{{state.mc}}', columns: 2, visible: '{{state.showModel}}',
          template: {
            type: 'chip', text: '{{item.name}}', selected: '{{item.on}}',
            action: upd({ groups: '{{item.g}}', models: '{{item.m}}' }),
          },
        });
      } else {
        kids.push({ type: 'text', text: '没有检测到可选模型。', style: 'caption', color: '$error', visible: '{{state.showModel}}' });
      }
      kids.push(gap(12));
      kids.push(btn('关闭', 'text', { type: 'close' }));

      return {
        gcui: 1, title: '编辑卡密',
        state: { showGroup: mode === 'group', showModel: mode === 'model', showNone: mode === 'all', gc: gc, mc: mc },
        root: { type: 'column', gap: 10, children: kids },
      };
    },
  });

  ctx.log('卡密认证已激活, 卡数:', keys().length);
};
