'use strict';
                                                                
  
                                                              
                                                  
                                      
                                 
                                         
                   
                                      
  
                                                                         
                                                                     
   
const crypto = require('crypto');
const { logErr } = require('./util');

                                              
                                                     
                   
let _lastQueryKeyWarn = 0;
function warnQueryAdminKey(req) {
  const now = Date.now();
  if (now - _lastQueryKeyWarn < 60000) return;
  _lastQueryKeyWarn = now;
  const ip = (req && req.socket && req.socket.remoteAddress) || '?';
  logErr('[安全警告] 管理密钥通过 URL 查询参数传递 (?adminKey=...) 来自 ' + ip +
    ' — 密钥会进入浏览器历史 / Referer 头 / 服务器访问日志 / 截图。建议改用 x-admin-key 头或 adminKey cookie。');
}

                                                
function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = String(s || '').toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of s) {
    val = (val << 5) | A.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function base32Encode(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += A[(val >> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}
function totpCode(secretB32, offsetStep = 0) {
  try {
    const key = base32Decode(secretB32);
    if (!key.length) return null;
    const counter = Math.floor(Date.now() / 1000 / 30) + offsetStep;
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const h = crypto.createHmac('sha1', key).update(buf).digest();
    const o = h[h.length - 1] & 0xf;
    const code = ((h[o] & 0x7f) << 24 | (h[o + 1] & 0xff) << 16 | (h[o + 2] & 0xff) << 8 | (h[o + 3] & 0xff)) % 1000000;
    return String(code).padStart(6, '0');
  } catch (_) { return null; }
}
function totpVerify(secretB32, code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return false;
  for (const off of [-1, 0, 1]) if (totpCode(secretB32, off) === c) return true;
  return false;
}

                                      
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const h = crypto.scryptSync(String(pw), salt, 32);
  return 'scrypt:' + salt + ':' + h.toString('base64url');
}
function verifyPassword(pw, stored) {
  try {
    if (!stored || !stored.startsWith('scrypt:')) return false;
    const [, salt, h] = stored.split(':');
    const calc = crypto.scryptSync(String(pw), salt, 32);
    return crypto.timingSafeEqual(calc, Buffer.from(h, 'base64url'));
  } catch (_) { return false; }
}

function genApiKey(len) {
  const n = Math.min(128, Math.max(8, Number(len) || 24));
  const bytes = Math.ceil(n * 3 / 4) + 2;
  return 'sk-' + crypto.randomBytes(bytes).toString('base64url').slice(0, n);
}

                                                            
function presentedToken(req, query) {
  const h = req.headers;
  const auth = h.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return bearer || h['x-api-key'] || h['x-goog-api-key'] || (query && query.get('key')) || '';
}

                          
               
                                                  
                                                                      
                                                                                                     
    
                                                   
   
class AuthChain {
  constructor() {
    this.strategies = [];              
    this.adminStrategies = [];                
  }

                                                    
  registerAuth(strategy, opts = {}) {
    if (!strategy || typeof strategy.check !== 'function') throw new Error('认证策略必须提供 check()');
    if (!strategy.name) strategy.name = 'strategy-' + this.strategies.length;
    if (opts.admin) this.adminStrategies.push(strategy);                         
    else this.strategies.push(strategy);
    return strategy.name;
  }
  unregisterAuth(name) {
    this.strategies = this.strategies.filter(s => s.name !== name);
    this.adminStrategies = this.adminStrategies.filter(s => s.name !== name);
  }

                                                        
  check(cfg, req, query) {
    const token = presentedToken(req, query);
                         
    if (cfg.gatewayKey && token && token === cfg.gatewayKey) return { ok: true, admin: true, strategy: 'gatewayKey' };
            
    const ctx = { token, req, query, cfg };
    for (const s of this.strategies) {
      let r;
      try { r = s.check(ctx); } catch (e) { r = { ok: false, status: 500, error: '认证策略 ' + s.name + ' 异常: ' + e.message }; }
      if (r) { r.strategy = s.name; return r; }
    }
                                          
    if (!cfg.gatewayKey && !this.strategies.length) return { ok: true, admin: true, strategy: 'none' };
    return { ok: false, status: 401, error: 'invalid key' };
  }

                                                                                        
                                                                
  checkAdmin(cfg, req, query) {
    const h = req.headers;
    const auth = h.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const cookie = h.cookie || '';
    const cookieKey = (cookie.match(/(?:^|;\s*)adminKey=([^;]+)/) || [])[1] || '';
    const queryKey = (query && query.get('adminKey')) || '';
    if (queryKey) warnQueryAdminKey(req);
    const adminToken = bearer || h['x-admin-key'] || queryKey || cookieKey || '';
    if (cfg.adminKey && adminToken !== cfg.adminKey) return { ok: false, status: 401, error: '需要管理密码(adminKey)' };
    const ctx = { token: adminToken, req, query, cfg, admin: true };
    for (const s of this.adminStrategies) {
      let r;
      try { r = s.check(ctx); } catch (e) { r = { ok: false, status: 500, error: '管理端策略 ' + s.name + ' 异常: ' + e.message }; }
      if (r) { r.strategy = s.name; return r; }
    }
    return { ok: true, admin: true, strategy: cfg.adminKey ? 'adminKey' : 'none' };
  }
}

                                    
                                                                      
function isLocalhost(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

module.exports = {
  base32Decode, base32Encode, totpCode, totpVerify,
  hashPassword, verifyPassword, genApiKey, presentedToken,
  AuthChain, isLocalhost,
};
