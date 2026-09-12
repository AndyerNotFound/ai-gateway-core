'use strict';
                                       
                                                                                
                                                                              
                                                               
   
const crypto = require('crypto');

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

module.exports.activate = (ctx) => {
  const keys = () => Array.isArray(ctx.config.apiKeys) ? ctx.config.apiKeys : (ctx.config.apiKeys = []);
  const keyLength = () => Math.min(128, Math.max(8, Number(ctx.config.keyLength) || 24));
  const usage = () => ctx.data.get('usage') || {};
  const usedOf = k => (usage()[k.key] || 0);
  const setUsed = (k, v) => { const u = usage(); u[k.key] = Math.max(0, Math.round(v)); ctx.data.set('usage', u); };
  const save = () => ctx.setPluginConfig(ctx.config);
  const genKey = () => 'sk-' + crypto.randomBytes(Math.ceil(keyLength() * 3 / 4) + 2).toString('base64url').slice(0, keyLength());

  const creditsJSON = (uk) => {
    const qt = Number(uk.quotaTokens);
    const zeroLimited = qt === 0;                   
    const unlimited = qt === -1;                  
    const quota = (zeroLimited || unlimited) ? 0 : Math.max(0, qt);
    const used = usedOf(uk);
    return {
      name: uk.name || '', uid: uk.uid || '', quotaTokens: quota, usedTokens: used,
      remainingTokens: zeroLimited ? 0 : (unlimited ? null : Math.max(0, quota - used)),
      unlimited, zeroLimited,
      expiresAt: uk.expiresAt || '', models: uk.models || [], branches: uk.branches || [],
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
          || /\/v1\/models(\/[^\/]+)?$/.test(p);
        if (!selfServe) return { ok: false, status: 429, error: '额度为 0, 请联系管理员充值' };
      }
      if (uk.quotaTokens > 0 && used >= uk.quotaTokens)
        return { ok: false, status: 429, error: '额度已用尽 (' + used + '/' + uk.quotaTokens + ' tokens)' };
      return { ok: true, userKey: Object.assign({}, uk, { usedTokens: used }) };
    },
  });

                             
  const syncGlobal = () => { for (const k of keys()) if (k && k.key) ctx.gateway.registerGlobalKey(k.key, k.branches || []); };
  syncGlobal();

                                
  ctx.hook('onChatAuth', ({ userKey, model }) => {
    if (!userKey) return null;
    if (Array.isArray(userKey.models) && userKey.models.length && !userKey.models.includes(model))
      return { status: 403, message: '此卡密不允许使用模型: ' + model + ' (可用: ' + userKey.models.join(', ') + ')' };
    return null;
  });

               
  ctx.hook('onUsage', ({ input, output }, c) => {
    const uk = c.urlInfo && c.urlInfo.userKey;
    if (!uk || !uk.key) return;
    setUsed(uk, usedOf(uk) + (input || 0) + (output || 0));
  });

                                   
  ctx.bindAuthApis({
    findKey: (cfg2, token) => { const k = keys().find(x => x && x.key === token); return k ? Object.assign({}, k, { usedTokens: usedOf(k) }) : null; },
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
      quotaTokens: Math.max(0, Number(j.quotaTokens) || 0), uid: String(j.uid || ''),
      models: Array.isArray(j.models) ? j.models.map(String) : [],
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
    if (j.branches !== undefined) k.branches = Array.isArray(j.branches) ? j.branches.map(String) : [];
    if (j.expiresAt !== undefined) k.expiresAt = String(j.expiresAt);
    if (j.note !== undefined) k.note = String(j.note).slice(0, 200);
    if (j.quotaTokens !== undefined) k.quotaTokens = Math.max(-1, Number(j.quotaTokens) || 0);             
                                                       
    if (j.addQuota !== undefined && j.addQuota > 0) {
      if (k.quotaTokens !== -1) k.quotaTokens = (Number(k.quotaTokens) || 0) + Number(j.addQuota);
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

  ctx.log('卡密认证已激活, 卡数:', keys().length);
};
