'use strict';




const crypto = require('crypto');
const { base32Encode, totpVerify } = require('../../src/auth');

function jsonRes(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); }

module.exports.activate = (ctx) => {
  const cfg = ctx.config;
  const save = () => ctx.setPluginConfig(cfg);

  ctx.registerAuth({
    name: 'second-auth',
    check: ({ req, query }) => {
      const aa = { secondKey: cfg.secondKey || '', totpSecret: cfg.totpSecret || '' };
      if (!aa.secondKey && !aa.totpSecret) return null; 
      const h = req.headers;
      if (aa.secondKey && (h['x-admin-key2'] === aa.secondKey || (query && query.get('adminKey2') === aa.secondKey))) return null; 
      if (aa.totpSecret && totpVerify(aa.totpSecret, h['x-totp'] || (query && query.get('totp')))) return null;
      return { ok: false, status: 401, error: aa.totpSecret ? '需要第二验证 (TOTP 动态码, x-totp 头)' : '需要第二验证 (第二密码, x-admin-key2 头)' };
    },
  }, { admin: true });

  
  ctx.registerRoute('GET', '/admin/config', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    jsonRes(res, 200, { secondKeySet: !!cfg.secondKey, totpEnabled: !!cfg.totpSecret, totpSecret: cfg.totpSecret || null });
  });
  ctx.registerRoute('POST', '/admin/config', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const j = p.body || {};
    let newTotp = null;
    if (j.secondKey !== undefined) cfg.secondKey = String(j.secondKey);
    if (j.totpAction === 'enable') { newTotp = base32Encode(crypto.randomBytes(20)); cfg.totpSecret = newTotp; }
    else if (j.totpAction === 'disable') delete cfg.totpSecret;
    save();
    const out = { ok: true, secondKeySet: !!cfg.secondKey, totpEnabled: !!cfg.totpSecret };
    if (newTotp) { out.totpSecret = newTotp; out.otpauthUrl = 'otpauth://totp/agw-core-' + ctx.instanceName + '?secret=' + newTotp + '&issuer=ai-gateway-core'; }
    jsonRes(res, 200, out);
  });

  ctx.log('第二验证已激活:', cfg.totpSecret ? 'TOTP' : (cfg.secondKey ? '第二密码' : '未配置(放行)'));
};
