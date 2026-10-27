'use strict';
/* auth.js - 认证 hook 链 + 默认 gatewayKey + TOTP + setup 模式 (文档 §3)
 *
 * 架构 (类比 Linux PAM / Spring Security AuthenticationProvider):
 *   请求 → 内核 checkAuth(req, query, cfg) 调用注册的认证策略链
 *     ├─ gatewayKey 默认实现(内核内置, 最低优先级)
 *     ├─ 卡密认证插件(若装了) → 查 apiKeys
 *     ├─ TOTP 第二验证插件(若装了) → 验证 adminAuth
 *     └─ ...其他认证策略
 *   链上第一个返回非 null 的策略生效; 全 null → 401
 *
 * 加载顺序: 认证插件(type:'auth') 先于业务插件加载, 失败 fail-closed (由 PluginManager 保证)。
 * setup 模式: 首次安装白名单——只开放 POST /setup/admin, localhost only, 10 分钟超时。
 */
const crypto = require('crypto');
const { logErr } = require('./util');

/* ⚠️ 安全警告: 管理密钥经 URL 查询参数(?adminKey=)传递时提示一次。
 * 该通道仅为向后兼容保留 —— URL 会进入浏览器历史 / Referer / 访问日志 / 截图。
 * 60 秒去重, 避免刷屏。 */
let _lastQueryKeyWarn = 0;
function warnQueryAdminKey(req) {
  const now = Date.now();
  if (now - _lastQueryKeyWarn < 60000) return;
  _lastQueryKeyWarn = now;
  const ip = (req && req.socket && req.socket.remoteAddress) || '?';
  logErr('[安全警告] 管理密钥通过 URL 查询参数传递 (?adminKey=...) 来自 ' + ip +
    ' — 密钥会进入浏览器历史 / Referer 头 / 服务器访问日志 / 截图。建议改用 x-admin-key 头或 adminKey cookie。');
}

/* cookie 值可能被客户端 encodeURIComponent 过；解不开就原样返回（绝不抛错）。 */
function decodeURIComponentSafe(v) {
  if (!v) return '';
  try { return decodeURIComponent(v); } catch (_) { return String(v); }
}

/* ---- TOTP (RFC 6238, SHA1, 30s窗口, 6位) ---- */
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

/* ---- 密码哈希 (scrypt; 用户体系插件用) ---- */
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

/* 提取请求出示的凭证: Bearer / x-api-key / x-goog-api-key / ?key= */
function presentedToken(req, query) {
  const h = req.headers;
  const auth = h.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return bearer || h['x-api-key'] || h['x-goog-api-key'] || (query && query.get('key')) || '';
}

/* ---- checkAuth 策略链 ----
 * strategy = {
 *   name: 'cardkey',                  // 策略名(日志用)
 *   admin: false,                     // 是否参与管理端鉴权链 (admin 链 / 用户链分开)
 *   check({token, req, query, cfg}) → null | {ok:true, admin?, userKey?} | {ok:false, status, error}
 * }
 * 返回 null = 本策略不认识这个凭证, 继续下一个; 非 null = 定论(通过或拒绝)。
 */
class AuthChain {
  constructor() {
    this.strategies = [];      // 用户请求链
    this.adminStrategies = []; // 管理端链 (含第二验证)
  }

  /* 注册策略。opts.admin=true 表示同时参与管理端链。auth 插件经此挂入。 */
  registerAuth(strategy, opts = {}) {
    if (!strategy || typeof strategy.check !== 'function') throw new Error('认证策略必须提供 check()');
    if (!strategy.name) strategy.name = 'strategy-' + this.strategies.length;
    if (opts.admin) this.adminStrategies.push(strategy); // admin 策略只在管理链, 不拦用户请求
    else this.strategies.push(strategy);
    return strategy.name;
  }
  unregisterAuth(name) {
    this.strategies = this.strategies.filter(s => s.name !== name);
    this.adminStrategies = this.adminStrategies.filter(s => s.name !== name);
  }
  /**
   * 按对象注销 (★多实例必须走这个)。
   * 为什么: 每个实例都会激活同一份认证插件, 策略名相同(如 'cardkey')。
   * 旧实现按 name 注销 → 重载某个实例时会把**其它实例**的同名策略一起摘掉,
   * 结果那张卡在其它实例上认证失败(401 invalid key)。
   */
  unregisterAuthObj(strategy) {
    if (!strategy) return;
    this.strategies = this.strategies.filter(s => s !== strategy);
    this.adminStrategies = this.adminStrategies.filter(s => s !== strategy);
  }

  /* 用户请求鉴权: gatewayKey 内置(最高优先) → 注册策略链 → 免密兜底 → 401 */
  check(cfg, req, query) {
    const token = presentedToken(req, query);
    // 内核默认实现: gatewayKey
    if (cfg.gatewayKey && token && token === cfg.gatewayKey) return { ok: true, admin: true, strategy: 'gatewayKey' };
    // 注册策略链
    const ctx = { token, req, query, cfg };
    for (const s of this.strategies) {
      let r;
      try { r = s.check(ctx); } catch (e) { r = { ok: false, status: 500, error: '认证策略 ' + s.name + ' 异常: ' + e.message }; }
      if (r) { r.strategy = s.name; return r; }
    }
    // 免密兼容: 无 gatewayKey 且没有任何策略"认领" → 放行
    if (!cfg.gatewayKey && !this.strategies.length) return { ok: true, admin: true, strategy: 'none' };
    return { ok: false, status: 401, error: 'invalid key' };
  }

  /* 管理端鉴权: adminKey 主验证 (Bearer / x-admin-key / ?adminKey= / cookie) → admin 策略链(第二验证等)
   * 无 adminKey = 免密管理(局域网自用, 兼容旧版; setup 模式创建的实例必有 adminKey) */
  checkAdmin(cfg, req, query) {
    const h = req.headers;
    const auth = h.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const cookie = h.cookie || '';
    const cookieRaw = (cookie.match(/(?:^|;\s*)adminKey=([^;]+)/) || [])[1] || '';
    const queryKey = (query && query.get('adminKey')) || '';
    if (queryKey) warnQueryAdminKey(req);
    /* 候选凭证: 头/查询参数优先, cookie 两种形式(解码后 + 原始)兜底。
     * ★为什么两种: web/admin.html 用 encodeURIComponent 写 cookie, 密钥含 } > ^ + : ? 等符号时
     *   会写成 %7D%3E… 形式 —— 若只取原始值去比对必然 401; 而插件管理页(iframe)只带 cookie、
     *   不带 x-admin-key 头, 于是表现为「主面板正常、插件管理页全部提示需要 adminkey」。
     *   同时保留未编码裸 cookie 的兼容(旧客户端/其它工具)。
     * 匹配策略: 设了 adminKey 时优先取能匹配上的候选, 否则退回第一个候选(交给下面统一判 401)。 */
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

/* ---- setup 模式 (文档 §3.3, 白名单) ----
 * 启动时无管理员 → setup 模式: 只开放 POST /setup/admin, localhost only, 限时窗口。 */
function isLocalhost(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

module.exports = {
  base32Decode, base32Encode, totpCode, totpVerify,
  hashPassword, verifyPassword, genApiKey, presentedToken,
  AuthChain, isLocalhost,
};
