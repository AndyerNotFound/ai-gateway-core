'use strict';
/** auth.js - the auth hook chain + default gatewayKey + TOTP + setup mode (doc §3)
 *
   * architecture (cf. Linux PAM / Spring Security AuthenticationProvider):
 *   Request -> the core's checkAuth(req, query, cfg) walks the registered auth policy chain
 *     ├─ gatewayKey default implementation (built into the core, lowest priority)
 *     ├─ card-key auth plugin (if installed) -> looks up apiKeys
 *     ├─ TOTP second-factor plugin (if installed) -> verifies adminAuth
 *     └─ ...other auth policies
 *   The first policy returning non-null wins; all null -> 401
 *
   * load order: auth plugins (type:'auth') load before business plugins; failure is fail-closed (guaranteed by the PluginManager).
 * Setup mode: first-install whitelist -- only POST /setup/admin is open, localhost only, 10-minute timeout.
 */
const crypto = require('crypto');
const { logErr } = require('./util');

/** *security warning: shown once when the admin key travels in a URL query parameter (?adminKey=).
 * This channel exists for backward compatibility only -- the URL leaks into browser history / Referer / access logs / screenshots.
   * 60-second dedup, avoiding notification spam. */
let _lastQueryKeyWarn = 0;
function warnQueryAdminKey(req) {
  const now = Date.now();
  if (now - _lastQueryKeyWarn < 60000) return;
  _lastQueryKeyWarn = now;
  const ip = (req && req.socket && req.socket.remoteAddress) || '?';
  logErr('[安全警告] 管理密钥通过 URL 查询参数传递 (?adminKey=...) 来自 ' + ip +
    ' — 密钥会进入浏览器历史 / Referer 头 / 服务器访问日志 / 截图。建议改用 x-admin-key 头或 adminKey cookie。');
}

/** the cookie value may have been encodeURIComponent-ed by the client; return it as-is when undecodable (never throws). */
function decodeURIComponentSafe(v) {
  if (!v) return '';
  try { return decodeURIComponent(v); } catch (_) { return String(v); }
}

/** ---- TOTP (RFC 6238, SHA1, 30s window, 6 digits) ---- */
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

/** ---- password hashing (scrypt; used by the user-system plugin) ---- */
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

/** extract the credentials the request presented: Bearer / x-api-key / x-goog-api-key / ?key= */
function presentedToken(req, query) {
  const h = req.headers;
  const auth = h.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return bearer || h['x-api-key'] || h['x-goog-api-key'] || (query && query.get('key')) || '';
}

/** ---- checkAuth strategy chain ----
 * strategy = {
 *   name: 'cardkey',                  // policy name (for logs)
 *   admin: false,                     // whether to join the admin auth chain (admin and user chains are separate)
 *   check({token, req, query, cfg}) → null | {ok:true, admin?, userKey?} | {ok:false, status, error}
 * }
   * returning null = this strategy does not recognize the credential, move on; non-null = final (allow or deny).
 */
class AuthChain {
  constructor() {
    this.strategies = [];      // the user request chain
    this.adminStrategies = []; // the admin chain (second factor included)
  }

  /* Register a policy. opts.admin=true also joins the admin chain. Auth plugins attach through this. */
  registerAuth(strategy, opts = {}) {
    if (!strategy || typeof strategy.check !== 'function') throw new Error('认证策略必须提供 check()');
    if (!strategy.name) strategy.name = 'strategy-' + this.strategies.length;
    if (opts.admin) this.adminStrategies.push(strategy); // admin strategies join the admin chain only; user requests are untouched
    else this.strategies.push(strategy);
    return strategy.name;
  }
  unregisterAuth(name) {
    this.strategies = this.strategies.filter(s => s.name !== name);
    this.adminStrategies = this.adminStrategies.filter(s => s.name !== name);
  }
  /**
   * Unregister by object (★multi-instance setups must use this).
   * Why: every instance activates the same auth plugin, so policy names collide (e.g. 'cardkey').
   * The old implementation unregistered by name -> reloading one instance also tore the same-named policy off **other instances**,
   * so that card failed auth on the other instances (401 invalid key).
   */
  unregisterAuthObj(strategy) {
    if (!strategy) return;
    this.strategies = this.strategies.filter(s => s !== strategy);
    this.adminStrategies = this.adminStrategies.filter(s => s !== strategy);
  }

  /* User request auth: built-in gatewayKey (highest priority) -> registered policy chain -> keyless fallback -> 401 */
  check(cfg, req, query) {
    const token = presentedToken(req, query);
    // kernel default impl: gatewayKey
    if (cfg.gatewayKey && token && token === cfg.gatewayKey) return { ok: true, admin: true, strategy: 'gatewayKey' };
    // register the strategy chain
    const ctx = { token, req, query, cfg };
    for (const s of this.strategies) {
      let r;
      try { r = s.check(ctx); } catch (e) { r = { ok: false, status: 500, error: '认证策略 ' + s.name + ' 异常: ' + e.message }; }
      if (r) { r.strategy = s.name; return r; }
    }
    // keyless compat: no gatewayKey and no strategy "claims" the request -> allow
    if (!cfg.gatewayKey && !this.strategies.length) return { ok: true, admin: true, strategy: 'none' };
    return { ok: false, status: 401, error: 'invalid key' };
  }

  /* Admin auth: adminKey primary check (Bearer / x-admin-key / ?adminKey= / cookie) -> admin policy chain (second factor etc.)
   * No adminKey = keyless admin (LAN personal use, legacy-compatible; instances created in setup mode always have an adminKey) */
  checkAdmin(cfg, req, query) {
    const h = req.headers;
    const auth = h.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const cookie = h.cookie || '';
    const cookieRaw = (cookie.match(/(?:^|;\s*)adminKey=([^;]+)/) || [])[1] || '';
    const queryKey = (query && query.get('adminKey')) || '';
    if (queryKey) warnQueryAdminKey(req);
    /* candidate credentials: header/query params first; both cookie forms (decoded + raw) as fallback.
     * *why both: web/admin.html writes the cookie with encodeURIComponent; when a key contains } > ^ + : ? characters
     *   it is written as %7D%3E... -- comparing the raw value would 401 for sure; plugin admin pages (iframe) carry only the cookie,
     *   the x-admin-key header was missing, so the main panel worked while every plugin admin page demanded an adminkey.
     *   while keeping compatibility with unencoded raw cookies (old clients / other tools).
     * matching strategy: when an adminKey is set, prefer a candidate that matches; otherwise fall back to the first (the code below 401s uniformly). */
    const cands = [bearer, h['x-admin-key'], queryKey, decodeURIComponentSafe(cookieRaw), cookieRaw].filter(Boolean);
    const adminToken = (cfg.adminKey && cands.find(t => t === cfg.adminKey)) || cands[0] || '';
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

/** ---- setup mode (doc §3.3, whitelist) ----
   * no admin at startup -> setup mode: only POST /setup/admin exposed, localhost only, time-boxed. */
function isLocalhost(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

module.exports = {
  base32Decode, base32Encode, totpCode, totpVerify,
  hashPassword, verifyPassword, genApiKey, presentedToken,
  AuthChain, isLocalhost,
};
