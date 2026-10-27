'use strict';
/* auth-user 插件 (type:auth) - 用户体系: 注册/账密登录/自助发卡/资料编辑
 * 配置: { users: [{uid,name,passwordHash,nickname,avatar,note,createdAt}], registration: {...} }
 * 依赖: auth-cardkey 插件 (经 gateway.authApis() 操作卡密)
 * 顶层端点: POST /auth/login /auth/register, GET /auth/register /auth/me /v1/branches,
 *           POST /auth/profile, GET|POST /auth/mykeys, POST /auth/mykeys-update /auth/mykeys-delete
 */
const crypto = require('crypto');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { hashPassword, verifyPassword } = require('../../src/auth');

/* ---- 多语言(i18n 插件公共库): require 失败/读配置失败 → 一律回退中文原文。
 *   auth 插件激活失败会 fail-closed 阻断全部插件, 这里必须万无一失。 ---- */
let i18nBundle = null;
try { i18nBundle = require('../i18n/lib').bundle; } catch (_) { i18nBundle = null; }

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

/* ---------- 极简 SMTP 客户端 (AUTH LOGIN, 支持 smtps://465 与 smtp://587 STARTTLS) ---------- */
function smtpSend(smtpUrl, from, to, subject, text) {
  return new Promise((resolve, reject) => {
    let mu;
    try { mu = new URL(smtpUrl); } catch (e) { return reject(new Error('SMTP 地址格式错误: 需 smtps://user:pass@host:465 或 smtp://user:pass@host:587')); }
    const isSsl = mu.protocol === 'smtps:';
    if (!isSsl && mu.protocol !== 'smtp:') return reject(new Error('SMTP 协议只支持 smtp:// 或 smtps://'));
    const port = Number(mu.port) || (isSsl ? 465 : 587);
    const user = decodeURIComponent(mu.username || ''), pass = decodeURIComponent(mu.password || '');
    const host = mu.hostname;
    let sock, buf = '', step = 0, done = false;
    const caps = {};
    const fail = (m) => { if (!done) { done = true; try { sock && sock.destroy(); } catch (_) {} reject(new Error(m)); } };
    const timer = setTimeout(() => fail('SMTP 超时'), 20000);
    const finish = () => { if (!done) { done = true; clearTimeout(timer); try { sock && sock.end(); } catch (_) {} resolve(true); } };
    const send = (line) => { try { sock.write(line + '\r\n'); } catch (e) { fail(e.message); } };
    const expect = (codes, next) => ({ codes, next });
    /* 状态机: 序列推进 */
    let steps;
    const buildSteps = () => {
      steps = [
        expect([220], () => send('EHLO gateway.local')),
        expect([250], () => {
          if (isSsl || sock.encrypted) { steps.splice(step, 1); return send('AUTH LOGIN'); } // SSL 直连: 移除多余的EHLO重复步
          if (!caps.starttls) { steps.splice(step, 2); return send('AUTH LOGIN'); } // 无 STARTTLS: 移除 STARTTLS步+TLS后EHLO步
          send('STARTTLS');
        }),
      ];
      if (!isSsl) steps.push(expect([220], () => {
        /* STARTTLS 升级 */
        const tlsSock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => {
          sock = tlsSock; send('EHLO gateway.local');
        });
        tlsSock.on('error', (e) => fail('STARTTLS 失败: ' + e.message));
        tlsSock.on('data', onData);
        buf = '';
      }));
      steps.push(
        expect([250], () => send('AUTH LOGIN')),
        expect([334], () => send(Buffer.from(user).toString('base64'))),
        expect([334], () => send(Buffer.from(pass).toString('base64'))),
        expect([235], () => send('MAIL FROM:<' + (from || user) + '>')),
        expect([250], () => send('RCPT TO:<' + to + '>')),
        expect([250, 251], () => send('DATA')),
        expect([354], () => {
          const hdr = 'From: <' + (from || user) + '>\r\nTo: <' + to + '>\r\nSubject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n';
          send(hdr + text + '\r\n.');
        }),
        expect([250], () => { send('QUIT'); finish(); }),
      );
    };
    const onLine = (line) => {
      if (/^250[ -]STARTTLS$/i.test(line.trim())) caps.starttls = true;
      const m = /^(\d{3})([ -])/.exec(line);
      if (!m) return;
      if (m[2] === '-') return; // 多行响应中间行
      const code = Number(m[1]);
      const st = steps[step];
      if (!st) return;
      if (!st.codes.includes(code)) return fail('SMTP 响应 ' + code + ': ' + line.slice(4).trim().slice(0, 120));
      step++;
      try { st.next && st.next(); } catch (e) { fail(e.message); }
    };
    const _u8 = new (require('string_decoder').StringDecoder)('utf8');   /* ★跨分块安全解码(2026-09-18) */
    const onData = (chunk) => {
      buf += _u8.write(chunk);
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); onLine(line); }
    };
    const onConnect = () => { /* 等 220 横幅 */ };
    const s0 = isSsl
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }, onConnect)
      : net.connect({ host, port }, onConnect);
    sock = s0;
    buildSteps();
    s0.on('data', onData);
    s0.on('error', (e) => fail('SMTP 连接失败: ' + e.message));
  });
}

/* 邮箱验证码 (内存态, 10 分钟过期, 每邮箱 60s 冷却) */
const emailCodes = new Map(); // email -> {code, exp, lastSent}
function newEmailCode(email) {
  const code = String(crypto.randomInt(100000, 999999));
  emailCodes.set(email, { code, exp: Date.now() + 600000, lastSent: Date.now() });
  return code;
}
function checkEmailCode(email, code) {
  const r = emailCodes.get(email);
  if (!r) return '请先获取验证码';
  if (Date.now() > r.exp) { emailCodes.delete(email); return '验证码已过期, 请重新获取'; }
  if (r.code !== String(code || '').trim()) return '验证码错误';
  emailCodes.delete(email);
  return null;
}

module.exports.activate = (ctx) => {
  /* ★多语言: 每次页面渲染取一次 bundle(内部只读一次 i18n 配置), t() 复用;
   *   任何异常回退中文原文, 绝不因 i18n 影响认证。 */
  const mkT = (uk) => {
    try { if (i18nBundle) return i18nBundle(ctx, uk); } catch (_) {}
    const t = function (s) { return (typeof s === 'string') ? s : s; };
    t.lang = 'zh-CN';
    return { lang: 'zh-CN', t: t };
  };
  /* ★多实例一致性: 用户表/分组是全局配置, 但每个实例各有一份内存副本。
   * cfg 用 Proxy 包一层, 每次访问都先按内核配置版本号判断是否需要重新读盘,
   * 这样任一实例改了用户/分组, 其它实例立刻看到最新值。 */
  let _cfgCache = null, _cfgRev = -1;
  const cfgFresh = () => {
    const r = ctx.configRev ? ctx.configRev() : 0;
    if (!_cfgCache || r !== _cfgRev) {
      const fresh = ctx.getPluginConfig('auth-user');
      _cfgCache = (fresh && typeof fresh === 'object') ? fresh : Object.assign({}, ctx.config);
      _cfgRev = r;
    }
    return _cfgCache;
  };
  const cfg = new Proxy({}, {
    get: (_, k) => cfgFresh()[k],
    set: (_, k, v) => { cfgFresh()[k] = v; return true; },
    has: (_, k) => k in cfgFresh(),
    deleteProperty: (_, k) => { delete cfgFresh()[k]; return true; },
    ownKeys: () => Reflect.ownKeys(cfgFresh()),
    getOwnPropertyDescriptor: (_, k) => Object.getOwnPropertyDescriptor(cfgFresh(), k),
  });
  cfg.users = Array.isArray(cfg.users) ? cfg.users : [];
  cfg.registration = cfg.registration && typeof cfg.registration === 'object' ? cfg.registration : {};
  /* 用户分组: 给用户打标签(默认/VIP/内部…), 模型广场按分组筛选可用模型 */
  cfg.groups = (Array.isArray(cfg.groups) && cfg.groups.length) ? cfg.groups.map(String) : ['默认'];
  if (cfg.defaultGroup === undefined) cfg.defaultGroup = '默认';
  if (!Array.isArray(cfg._groupsSaved)) { cfg.groups = cfg.groups.slice(); }
  const groupOf = (u) => (u && u.group) || cfg.defaultGroup || '默认';
  const reg = cfg.registration || {};   /* 兼容未配置注册的情况(默认: 注册关闭 + 零额度) */
  /* ★写盘用「内存快照」, 不要直接把 Proxy 交给内核。
   *  cfg 是 Proxy, 序列化时的 ownKeys 会回调 cfgFresh(); 而 ctx.setPluginConfig() 内部会把配置版本号 +1,
   *  于是同一次请求里的第二次 save() 会因为"版本号变了"从磁盘重读, 把**尚未落盘的改动**覆盖掉
   *  (最典型: 自动建档时刚填的昵称/头像) → 表现为"点保存提示成功, 刷新却变回空"。
   *  快照成普通对象后不再触发重读; 写盘后再把本地版本号同步到最新, 免得下次 cfgFresh 白重读一次。 */
  const save = () => {
    const snap = {};
    for (const k of Object.keys(cfg)) snap[k] = cfg[k];
    ctx.setPluginConfig(snap);
    if (ctx.configRev) _cfgRev = ctx.configRev();
  };
  const apis = () => ctx.gateway.authApis(); // auth-cardkey 提供

  /* ---- 额度语义(与 auth-cardkey 一致): 0 = 零额度(不可用) / -1 = 不限 / >0 = 具体额度 ----
   * ★零额度只是「余额不足, 调不了模型」, **不是「什么都干不了」** ——
   *   发子卡 / 改权限 / 看模型 / 保存资料 等自助操作一律照常。
   *   但要防止越权: 子卡额度绝不能超过父卡能给的量(父卡 0 → 子卡只能是 0)。 */
  const parentRemaining = (uk) => (Number(uk.quotaTokens) === -1
    ? -1
    : Math.max(0, (Number(uk.quotaTokens) || 0) - (uk.usedTokens || 0)));

  /** 申请额度 → 实际批给子卡的额度(已按父卡剩余裁剪)。
   *  未指定: 父卡不限则子卡不限, 否则给到父卡剩余。
   *  -1 = 想要不限: 父卡不限才给不限, 否则给到父卡剩余。
   *  0  = 显式零额度(保留, 别自作主张改成不限)。 */
  const clampQuota = (uk, requested) => {
    const rem = parentRemaining(uk);                 /* -1 = 父卡不限 */
    const none = (requested === undefined || requested === null || requested === '');
    let raw = none ? null : Number(requested);
    if (raw !== null && !isFinite(raw)) raw = null;
    if (rem === -1) {
      if (raw === null) return -1;
      if (raw === 0) return 0;
      return raw > 0 ? Math.floor(raw) : -1;
    }
    if (raw === null || raw === -1) return rem > 0 ? rem : 0;
    return Math.min(Math.max(0, Math.floor(raw)), rem);
  };

  const myKeysOf = (uid, mainKey) => {
    const all = apis().listKeys ? apis().listKeys() : [];
    return uid ? all.filter(k => k.uid === uid) : (mainKey ? all.filter(k => k.key === mainKey) : []);
  };
  const branchesOf = (uk) => {
    const all = ctx.gateway.listInstances().filter(i => i.enabled).map(i => i.name);
    if (!uk) return all;
    const b = uk.branches || [];
    return b.length ? all.filter(n => b.includes(n)) : all;
  };
  const requireUser = (auth, res) => {
    const r = auth();
    if (!r.ok) { jsonRes(res, r.status || 401, { error: r.error || 'invalid key' }); return null; }
    if (!r.userKey) { jsonRes(res, 403, { error: '需要用户卡密(非管理员key)' }); return null; }
    return r.userKey;
  };

  /* ---- POST /auth/login {username|uid,password} → 该用户卡密 ----
   * 兼容: 先按 username 查, 再按 uid 查 (旧账号) */
  ctx.registerTopRoute('POST', '/auth/login', ({ res, body }) => {
    const loginId = String((body && (body.username || body.uid)) || '').trim();
    const user = cfg.users.find(x => x.username === loginId || x.uid === loginId || x.name === loginId);
    if (!user || !verifyPassword((body && body.password) || '', user.passwordHash))
      return jsonRes(res, 401, { error: '用户名或密码错误' });
    if (user.banned) return jsonRes(res, 403, { error: '该账号已被封禁' + (user.banReason ? ': ' + user.banReason : ''), banned: true });
    const keys = myKeysOf(user.uid);
    jsonRes(res, 200, { ok: true, uid: user.uid, username: user.username || user.name || '', name: user.name || '', nickname: user.nickname || '', avatar: user.avatar || '', keys: keys.map(k => Object.assign({ key: k.key, isMain: !!k.isMain }, apis().creditsJSON(k))) });
  });

  /* POST /auth/password 改密码 (需登录态) */
  ctx.registerTopRoute('POST', '/auth/password', ({ res, auth, body }) => {
    const uk = requireUser(auth, res); if (!uk) return;
    if (!uk.uid) return jsonRes(res, 400, { error: mkT(uk).t('卡密未绑定账号, 无法改密码') });
    const user = cfg.users.find(x => x.uid === uk.uid);
    if (!user) return jsonRes(res, 404, { error: mkT(uk).t('账号不存在') });
    const oldPw = String((body && body.oldPassword) || '');
    const newPw = String((body && body.newPassword) || '');
    if (!verifyPassword(oldPw, user.passwordHash)) return jsonRes(res, 403, { error: mkT(uk).t('原密码错误') });
    if (newPw.length < (reg.minPasswordLen || 8)) return jsonRes(res, 400, { error: mkT(uk).t('新密码至少 {0} 位', reg.minPasswordLen || 8) });
    user.passwordHash = hashPassword(newPw);
    save();
    jsonRes(res, 200, { ok: true });
  });

  /* POST /auth/rotate-main {username|uid, password} → 凭密码(带外凭据)轮换主卡
   *  用于: 主卡泄漏时, 用户不需管理员介入即可让旧卡失效并拿到新卡。
   *  ★关键: 用密码验证(不是泄漏的主卡) —— 拿到泄漏主卡的攻击者无法轮换。 */
  ctx.registerTopRoute('POST', '/auth/rotate-main', ({ res, body }) => {
    const loginId = String((body && (body.username || body.uid)) || '').trim();
    const user = cfg.users.find(x => x.username === loginId || x.uid === loginId || x.name === loginId);
    if (!user || !verifyPassword(String((body && body.password) || ''), user.passwordHash))
      return jsonRes(res, 401, { error: '用户名或密码错误' });
    if (user.banned) return jsonRes(res, 403, { error: '该账号已被封禁' + (user.banReason ? ': ' + user.banReason : ''), banned: true });
    const all = apis().listKeys ? apis().listKeys() : [];
    const old = all.find(k => k && k.uid === user.uid && k.isMain);
    if (!old) return jsonRes(res, 404, { error: '未找到主卡, 请联系管理员' });
    const newKey = apis().genKey();
    /* 保留原主卡的额度/权限, 只换 key 值; 旧用量统计随旧 key 注销(额度本身不变) */
    const f = {};
    ['name','enable','quotaTokens','uid','models','branches','isMain','by','redact','note','groups','expiresAt'].forEach(kk => { if (old[kk] !== undefined) f[kk] = old[kk]; });
    f.key = newKey;
    f.createdAt = new Date().toISOString();
    apis().addKey(f);
    apis().deleteKey(old.key);
    save();
    jsonRes(res, 200, { ok: true, key: newKey, uid: user.uid, message: '主卡已轮换, 旧卡立即失效' });
  });

  /* ---- 注册 ---- */
  ctx.registerTopRoute('GET', '/auth/register', ({ res }) => {
    jsonRes(res, 200, { enable: !!reg.enable, captchaProvider: reg.captchaProvider || 'none', captchaSiteKey: reg.captchaSiteKey || '', minPasswordLen: reg.minPasswordLen || 8, emailVerify: !!(reg.emailVerify && reg.emailVerify.enable) });
  });
  /* POST /auth/email-code {email} 发送验证码 (需开启 emailVerify) */
  ctx.registerTopRoute('POST', '/auth/email-code', async ({ res, body }) => {
    if (!reg.enable) return jsonRes(res, 403, { error: '该服务器未开放注册' });
    const ev = reg.emailVerify || {};
    if (!ev.enable) return jsonRes(res, 400, { error: '未开启邮箱验证' });
    if (!ev.smtpUrl) return jsonRes(res, 500, { error: '管理端未配置 SMTP (emailVerify.smtpUrl)' });
    const email = String((body && body.email) || '').trim().toLowerCase();
    if (!/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(email)) return jsonRes(res, 400, { error: '邮箱格式不正确' });
    if (cfg.users.some(x => (x.email || '') === email)) return jsonRes(res, 409, { error: '该邮箱已注册' });
    const prev = emailCodes.get(email);
    if (prev && Date.now() - prev.lastSent < 60000) return jsonRes(res, 429, { error: '发送太频繁, 请 60 秒后再试' });
    const code = newEmailCode(email);
    try {
      await smtpSend(ev.smtpUrl, ev.from || '', email, '注册验证码', '你的验证码是: ' + code + '\n10 分钟内有效。\n\n(若非本人操作请忽略)');
      jsonRes(res, 200, { ok: true, msg: '验证码已发送, 10 分钟内有效' });
    } catch (e) {
      emailCodes.delete(email);
      jsonRes(res, 502, { error: '邮件发送失败: ' + e.message });
    }
  });
  ctx.registerTopRoute('POST', '/auth/register', async ({ res, body }) => {
    if (!reg.enable) return jsonRes(res, 403, { error: '该服务器未开放注册' });
    const username = String((body && (body.username || body.uid)) || '').trim();
    const pw = String((body && body.password) || '');
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) return jsonRes(res, 400, { error: '用户名需 3-32 位字母/数字/下划线' });
    if (pw.length < (reg.minPasswordLen || 8)) return jsonRes(res, 400, { error: '密码至少 ' + (reg.minPasswordLen || 8) + ' 位' });
    if (cfg.users.some(x => x.username === username || x.name === username)) return jsonRes(res, 409, { error: '该用户名已被注册' });
    /* 邮箱验证 */
    const ev = reg.emailVerify || {};
    let email = '';
    if (ev.enable) {
      email = String((body && body.email) || '').trim().toLowerCase();
      if (!/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(email)) return jsonRes(res, 400, { error: '邮箱格式不正确' });
      if (cfg.users.some(x => (x.email || '') === email)) return jsonRes(res, 409, { error: '该邮箱已注册' });
      const codeErr = checkEmailCode(email, (body && body.emailCode));
      if (codeErr) return jsonRes(res, 400, { error: codeErr });
    }
    if (reg.captchaProvider === 'turnstile') {
      if (!reg.captchaSecret) return jsonRes(res, 500, { error: '管理端未配置 captchaSecret' });
      const token = String((body && body.captchaToken) || '');
      if (!token) return jsonRes(res, 400, { error: '缺少人机验证' });
      const okT = await new Promise(resolve => {
        const postData = 'secret=' + encodeURIComponent(reg.captchaSecret) + '&response=' + encodeURIComponent(token);
        const rq = https.request({ hostname: 'challenges.cloudflare.com', path: '/turnstile/v0/siteverify', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }, timeout: 10000 }, (r2) => {
          let d = ''; r2.on('data', c => d += c); r2.on('end', () => { try { resolve(!!JSON.parse(d).success); } catch (_) { resolve(false); } });
        });
        rq.on('error', () => resolve(false)); rq.on('timeout', () => { rq.destroy(); resolve(false); });
        rq.write(postData); rq.end();
      });
      if (!okT) return jsonRes(res, 403, { error: '人机验证失败' });
    }
    /* UID 随机生成 (不暴露给用户, 防止删号后同 UID 继承资产) */
    const uid = 'u' + crypto.randomBytes(4).toString('hex');
    const user = { uid, username, name: username, group: cfg.defaultGroup, passwordHash: hashPassword(pw), nickname: '', avatar: '', email, banned: false, note: '注册', createdAt: new Date().toISOString() };
    cfg.users.push(user);
    save();
    // 发默认卡
    let mainKey = null;
    if (apis().addKey) {
      const dq = Math.floor(Number(reg.defaultQuota) || 0);
      /* defaultQuota>0 = 新用户自动获得该额度; 默认 0/未设 = 零额度卡(-1), 需管理员充值后才可用 */
      /* 约定: quotaTokens 0 = 零额度(不可用) / -1 = 不限 / >0 = 具体额度。
       * 新用户默认给「零额度」, 管理员充值后才可用 —— 之前写成 -1 等于白送不限额度。 */
      mainKey = { key: apis().genKey(), name: username + ' 的主卡', enable: true, quotaTokens: dq > 0 ? dq : 0, uid, models: [], branches: [], isMain: true, by: 'auto', createdAt: new Date().toISOString() };
      apis().addKey(mainKey);
    }
    jsonRes(res, 200, { ok: true, uid, username, key: mainKey ? mainKey.key : null });
  });

  /* ---- GET /auth/me ---- */
  ctx.registerTopRoute('GET', '/auth/me', ({ res, auth }) => {
    const uk = requireUser(auth, res); if (!uk) return;
    const user = uk.uid ? cfg.users.find(x => x.uid === uk.uid) : null;
    const keys = myKeysOf(uk.uid, uk.key);
    jsonRes(res, 200, {
      ok: true, uid: uk.uid || '', username: (user && (user.username || user.name)) || uk.name || '',
      name: (user && user.name) || uk.name || '',
      nickname: (user && user.nickname) || '', avatar: (user && user.avatar) || '',
      group: groupOf(user), groups: cfg.groups.slice(),
      mainKey: uk.key,
      keys: keys.map(k => Object.assign({ key: k.key, isMain: k.key === uk.key }, apis().creditsJSON(k))),
      branches: branchesOf(uk),
    });
  });

  /* ---- POST /auth/profile ---- */
  ctx.registerTopRoute('POST', '/auth/profile', ({ res, auth, body }) => {
    const uk = requireUser(auth, res); if (!uk) return;
    const j = body || {};
    if (uk.uid) {
      let user = cfg.users.find(x => x.uid === uk.uid);
      if (!user) {
        /* ★首次: 该身份还没有用户记录(如管理员密钥) —— 自动建立一条,
         *  否则下面的写入全被跳过, 接口却返回 ok:true(静默失败)。 */
        user = {
          uid: uk.uid,
          username: uk.name || uk.uid,
          name: uk.name || uk.uid,
          nickname: '',
          avatar: '',
          group: cfg.defaultGroup || '默认',
          note: '自动创建(管理员身份)',
          createdAt: new Date().toISOString(),
        };
        cfg.users.push(user);
        save();
      }
      if (j.nickname !== undefined) user.nickname = String(j.nickname).slice(0, 64);
      if (j.name !== undefined) user.name = String(j.name).slice(0, 64);
      if (j.avatar !== undefined) user.avatar = String(j.avatar).slice(0, 300);
      save();
    } else {
      /* 没有 uid = 无法定位记录, 明确报错而不是假装成功 */
      return jsonRes(res, 400, { error: mkT(uk).t('该身份没有用户记录, 无法保存资料') });
    }
    if (j.cardName !== undefined && apis().updateKey) apis().updateKey(uk.key, { name: String(j.cardName).slice(0, 64) });
    jsonRes(res, 200, { ok: true });
  });

  /* ---- 我的卡密 ---- */
  ctx.registerTopRoute('GET', '/auth/mykeys', ({ res, auth }) => {
    const uk = requireUser(auth, res); if (!uk) return;
    const keys = myKeysOf(uk.uid, uk.key);
    jsonRes(res, 200, { keys: keys.map(k => Object.assign({ key: k.key, redact: k.redact == null ? null : !!k.redact, isMain: k.key === uk.key }, apis().creditsJSON(k))) });
  });
  ctx.registerTopRoute('POST', '/auth/mykeys', ({ res, auth, body }) => { // 自助发子卡(父卡子集)
    const uk = requireUser(auth, res); if (!uk) return;
    const j = body || {};
    const pm = uk.models || [], pb = uk.branches || [];
    const models = Array.isArray(j.models) ? j.models.map(String).filter(m => !pm.length || pm.includes(m)) : [];
    const groups = Array.isArray(j.groups) ? j.groups.map(String).filter(x => !(uk.groups || []).length || (uk.groups || []).includes(x)) : [];
    const branches = Array.isArray(j.branches) ? j.branches.map(String).filter(b => !pb.length || pb.includes(b)) : [];
    /* 额度为 0 的卡也能发子卡(子卡同样是 0 额度, 调模型时才提示余额不足) */
    const quota = clampQuota(uk, j.quotaTokens);
    if (Number(uk.quotaTokens) > 0 && quota > 0) {
      apis().updateKey(uk.key, { quotaTokens: Number(uk.quotaTokens) - quota }); /* 从主卡扣除 */
    }
    const nk = { key: apis().genKey(), name: String(j.name || uk.name || '子卡').slice(0, 64), enable: true, quotaTokens: quota, uid: uk.uid || '', models, groups, branches, note: String(j.note || '用户自助').slice(0, 200), by: 'user', createdAt: new Date().toISOString() };
    apis().addKey(nk);
    jsonRes(res, 200, { ok: true, key: nk });
  });
  ctx.registerTopRoute('POST', '/auth/mykeys-update', ({ res, auth, body }) => {
    const uk = requireUser(auth, res); if (!uk) return;
    const j = body || {};
    const target = myKeysOf(uk.uid, uk.key).find(k => k.key === j.key);
    if (!target) return jsonRes(res, 404, { error: '卡密不存在或不属于你' });
    const patch = {};
    if (j.name !== undefined) patch.name = String(j.name).slice(0, 64);
    if (j.models !== undefined) { const pm = uk.models || []; patch.models = Array.isArray(j.models) ? j.models.map(String).filter(m => !pm.length || pm.includes(m)) : []; }
    if (j.groups !== undefined) { const pg = uk.groups || []; patch.groups = Array.isArray(j.groups) ? j.groups.map(String).filter(x => !pg.length || pg.includes(x)) : []; }
    if (j.branches !== undefined) { const pb = uk.branches || []; patch.branches = Array.isArray(j.branches) ? j.branches.map(String).filter(b => !pb.length || pb.includes(b)) : []; }
    if (j.redact !== undefined) patch.redact = j.redact == null ? null : !!j.redact;
    let quotaSkipped = false;
    if (j.quotaTokens !== undefined) {
      if (j.key === uk.key) {
        /* 主卡额度不允许自助改(管理员的事); 之前静默跳过还返回 ok —— 用户以为改成功了 */
        quotaSkipped = true;
      } else {
        /* ★安全: 子卡额度永远不得超过父卡剩余 —— 否则零额度用户随手给自己发一张有额度的子卡 */
        patch.quotaTokens = clampQuota(uk, j.quotaTokens);
      }
    }
    apis().updateKey(j.key, patch);
    jsonRes(res, 200, { ok: true, quotaSkipped });
  });
  ctx.registerTopRoute('POST', '/auth/mykeys-delete', ({ res, auth, body }) => {
    const uk = requireUser(auth, res); if (!uk) return;
    if (body && body.key === uk.key) return jsonRes(res, 400, { error: mkT(uk).t('不能删除主卡') });
    const target = myKeysOf(uk.uid, uk.key).find(k => k.key === (body && body.key));
    if (!target) return jsonRes(res, 404, { error: '卡密不存在或不属于你' });
    apis().deleteKey(body.key);
    jsonRes(res, 200, { ok: true });
  });

  /* ---- GET /v1/branches ---- */
  ctx.registerTopRoute('GET', '/v1/branches', ({ res, auth }) => {
    const r = auth();
    if (!r.ok) return jsonRes(res, r.status || 401, { error: r.error || 'invalid key' });
    jsonRes(res, 200, { branches: branchesOf(r.userKey) });
  });

  /* ================= Gay Core SDUI: 个人中心 (provides: user-system) =================
   * UI = 服务端动态生成的 gcui JSON; 交互 = 签名意图 (ctx.security.guard)。客户端零业务状态。 */
  const ukOf = (p) => {
    const t = (p && p.token) || '';
    if (!t || !apis().findKey) return null;
    /* ★优先用认证链结果: 管理员密钥(auth-adminkey 认领)不在卡密列表里, findKey 找不到 */
    const uk = (p && p.userKey) ? p.userKey : apis().findKey(null, t);
    if (!uk || uk.enable === false) return null;
    return uk;
  };
  /* 额度数字本地化: en 用 K/M, 繁中 億/萬, 简中 亿/万; null = 不限 */
  const fmtTok = (t, n) => {
    if (n == null) return t('不限');
    if (t.lang === 'en') return n >= 1e8 ? (n / 1e6).toFixed(0) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(0) + 'K' : String(n);
    const big = t.lang === 'zh-TW' ? ' 億' : ' 亿';
    const mid = t.lang === 'zh-TW' ? ' 萬' : ' 万';
    return n >= 1e8 ? (n / 1e8).toFixed(2) + big : n >= 1e4 ? (n / 1e4).toFixed(1) + mid : String(n);
  };
  /* 零额度只是「调模型要充值」, 其它自助功能照常 —— 文案别写得像账号被停用 */
  const creditText = (t, cd) => cd.zeroLimited ? t('零额度 · 调用模型需充值') : cd.unlimited ? t('不限量') : null;
  const keyState = (t, k, mainKey) => {
    const cd = apis().creditsJSON(k);
    const isMain = k.key === mainKey;
    const badge = cd.zeroLimited ? { text: t('零额度'), tone: 'error' }
      : cd.unlimited ? { text: t('不限量'), tone: 'primary' }
      : { text: t('按量'), tone: 'neutral' };
    return {
      name: k.name || t('未命名卡'), key: k.key, keyShort: k.key.slice(0, 8) + '…' + k.key.slice(-4),
      isMain, quotaText: creditText(t, cd) || t('余 {0}', fmtTok(t, cd.remainingTokens)),
      canDelete: !isMain,
      badgeText: isMain ? t('主卡') : badge.text,
      badgeTone: isMain ? 'primary' : badge.tone,
      enabled: k.enable !== false,
    };
  };

  /* ===== 卡密「访问权限」编辑 (SDUI) =====
   * 为什么要服务端做: App 的 SDUI 渲染器只认 gcui JSON, 改这里不用重编 App。
   * 交互: 个人页「权限」chip → intent(key-edit-open) → 返回整个编辑页(App 压栈 = 真子页)。
   *       权限用 list+columns 网格多选 chip, 每次点选都是 intent → 服务端返回新页。
   *       ★每次点选都必须标 nav:'replace'(同页就地刷新) —— 否则 App 会当成"新子页"压栈,
   *         点 N 个 chip 就要按 N 次返回才出得去(2026-09-17 修: "嵌套打开 / 返回要按很多次")。 */

  /** 可勾选清单: 编辑子卡时用父卡范围裁剪; 编辑主卡(无父)时全量 */
  const accessOptions = (parent, targetKey) => {
    let o = { groups: [], models: [], instances: [] };
    const scope = (parent && targetKey && targetKey !== parent.key) ? parent : null;
    try { o = Object.assign(o, apis().accessOptions ? apis().accessOptions(scope) : {}); } catch (_) { }
    return o;
  };
  /** 子卡权限绝不能比父卡宽: 与父卡白名单取交集(父卡为空则该维度不限) */
  const clampPerm = (parent, mode, groups, models) => {
    const pg = Array.isArray(parent && parent.groups) ? parent.groups : [];
    const pm = Array.isArray(parent && parent.models) ? parent.models : [];
    const inter = (a, b) => a.filter(x => b.includes(x));
    const out = {};
    out.groups = pg.length ? (mode === 'group' ? inter(groups, pg) : pg.slice()) : (mode === 'group' ? groups.slice() : []);
    out.models = pm.length ? (mode === 'model' ? inter(models, pm) : pm.slice()) : (mode === 'model' ? models.slice() : []);
    return out;
  };
  const effMode = (k) => {
    const g = Array.isArray(k.groups) ? k.groups : [];
    const m = Array.isArray(k.models) ? k.models : [];
    if (g.length) return 'group';
    if (m.length) return 'model';
    return 'all';
  };
  const permText = (t, k) => {
    const g = Array.isArray(k.groups) ? k.groups : [];
    const m = Array.isArray(k.models) ? k.models : [];
    const b = Array.isArray(k.branches) ? k.branches : [];
    const parts = [];
    parts.push(g.length ? t('分组 {0}', g.join('/')) : (m.length ? t('{0} 个模型', m.length) : t('全部模型')));
    if (b.length) parts.push(t('实例 {0}', b.join('/')));
    return parts.join(' · ');
  };

  /** 编辑页 (整个页面服务端生成; 每次点 chip 都由 intent 返回新页 + nav:'replace' → App 原地换页) */
  const editKeyPage = (uk, targetKey, mode, groups, models, q) => {
    const { t } = mkT(uk);
    const opts = accessOptions(uk, targetKey);
    const allGroups = (opts.groups || []).map(String);
    const kw = String(q || '').toLowerCase();
    const allModels = (opts.models || []).filter(m => !kw || String(m.name).toLowerCase().includes(kw));
    const isMain = targetKey === uk.key;
    const pass = { key: targetKey, mode: mode, groups: groups, models: models, q: q };
    const modeChip = (val, label, icon) => ({
      type: 'chip', text: label, icon: icon, selected: mode === val,
      action: { type: 'intent', endpoint: './intent/key-edit-mode', body: Object.assign({}, pass, { mode: val }) },
    });
    const cell = (facet, label, value, on) => ({
      type: 'chip', text: label, selected: on,
      action: { type: 'intent', endpoint: './intent/key-edit-toggle', body: Object.assign({}, pass, { facet: facet, value: value }) },
    });
    let grid = [];
    if (mode === 'group') grid = allGroups.map(g => cell('group', g, g, groups.includes(g)));
    else if (mode === 'model') grid = allModels.map(m => cell('model', m.name, m.name, models.includes(m.name)));

    const body2 = [];
    if (mode === 'all') {
      body2.push({ type: 'text', text: t('当前不限模型 —— 这张卡密可以使用全部模型。'), style: 'caption' });
      body2.push({ type: 'text', text: t('想限制的话，点上面的「按分组」或「按模型」再勾选。'), style: 'caption' });
    } else {
      body2.push({ type: 'text', text: t(mode === 'group' ? '选择分组' : '选择模型') + t('（可多选，已选 {0} 个）', grid.filter(x => x.selected).length), style: 'title4' });
      if (mode === 'group') {
        body2.push({ type: 'text', text: t('分组由管理端「模型分组 / 快速分组」定义；未定义时按模型名前缀（如 gpt / claude）分组。'), style: 'caption' });
      } else {
        body2.push({ type: 'input', key: 'q', label: t('搜索模型名'), value: q || '', leadingIcon: 'msym:search', submit: { type: 'intent', endpoint: './intent/key-edit-search', body: Object.assign({}, pass, { q: '{{input.q}}' }) } });
        body2.push({ type: 'text', text: t('可选 {0} 个', allModels.length) + (kw ? t('（搜索：{0}）', q) : ''), style: 'caption' });
      }
      body2.push({ type: 'list', items: '{{state.grid}}', columns: 2, template: {
        type: 'chip', text: '{{item.label}}', selected: '{{item.on}}',
        action: { type: 'intent', endpoint: './intent/key-edit-toggle', body: Object.assign({}, pass, { facet: mode === 'group' ? 'group' : 'model', value: '{{item.value}}' }) },
      } });
    }
    const children = [
      { type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 8, children: [
        { type: 'text', text: t('访问权限'), style: 'title3' },
        { type: 'text', text: t('卡密：{0}', (isMain ? t('主卡') : (targetKey || '').slice(0, 8) + '…' + (targetKey || '').slice(-4)) + ' · ' + permText(t, { groups: groups, models: models })), style: 'caption' },
        { type: 'hscroll', gap: 8, children: [
          modeChip('all', t('不限'), 'msym:check'),
          modeChip('group', t('按分组'), 'msym:group'),
          modeChip('model', t('按模型'), 'msym:apps'),
        ] },
      ] },
      { type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: body2.concat([
        { type: 'row', gap: 10, children: [
          { type: 'button', text: t('保存权限'), style: 'filled', shape: 'pill', weight: 1, icon: 'msym:check',
            action: { type: 'intent', endpoint: './intent/key-edit-save', body: pass } },
          { type: 'button', text: t('返回'), style: 'outlined', shape: 'pill', weight: 1,
            action: { type: 'intent', endpoint: './intent/key-edit-back', body: {} } },
        ] },
      ]) },
    ];
    return {
      gcui: 1, title: t('访问权限'),
      state: { grid: grid.map(x => ({ label: x.text, value: x.action.body.value, on: !!x.selected })) },
      root: { type: 'column', gap: 14, children },
    };
  };

  /** 个人页 (个人页/权限编辑返回都复用它) */
  const buildPersonalPage = (uk) => {
    const { t, lang } = mkT(uk);
    const user = uk.uid ? cfg.users.find(x => x.uid === uk.uid) : null;
    const cd = apis().creditsJSON(uk);
    const display = (user && (user.nickname || user.username || user.name)) || uk.name || uk.uid || t('匿名用户');
    const uname = (user && (user.username || user.name)) || uk.name || uk.uid || '';
    const keys = myKeysOf(uk.uid, uk.key);
    const initial = String(display).trim().slice(0, 1).toUpperCase() || '?';
    const quotaBig = cd.zeroLimited ? '0' : cd.unlimited ? t('不限') : fmtTok(t, cd.remainingTokens);
    const quotaTone = cd.zeroLimited ? 'error' : cd.unlimited ? 'primary' : 'success';
    const quotaCap = cd.zeroLimited ? t('零额度 · 请联系管理员充值') : cd.unlimited ? t('不限量') : t('总额度 {0}', fmtTok(t, cd.quotaTokens));
    const children = [
      /* 资料头: 头像 + 昵称 + 状态徽章 + 键值 */
      { type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: [
        { type: 'row', gap: 14, children: [
          { type: 'avatar', text: initial, size: 56, url: (user && user.avatar) || '' },
          { type: 'column', weight: 1, gap: 6, children: [
            { type: 'text', text: display, style: 'title3' },
            { type: 'row', gap: 6, children: [
              { type: 'badge', text: uk.uid ? t('已绑定账号') : t('仅卡密'), tone: uk.uid ? 'success' : 'neutral' },
              { type: 'badge', text: t('主卡'), tone: 'primary' },
            ] },
          ] },
        ] },
        { type: 'kv', label: t('用户名'), value: uname || t('(未设置)') },
        { type: 'kv', label: t('卡密'), value: uk.key.slice(0, 8) + '…' + uk.key.slice(-4) },
        ...(cd.expiresAt ? [{ type: 'kv', label: t('到期'), value: cd.expiresAt }] : []),
      ] },
      /* 额度: 大数字 + 状态徽章 + 进度 */
      { type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: [
        { type: 'row', gap: 8, children: [
          { type: 'column', weight: 1, gap: 4, children: [
            { type: 'text', text: t('剩余额度'), style: 'caption', color: '$onSurfaceVariant' },
            { type: 'text', text: quotaBig, style: 'title', color: cd.zeroLimited ? '$error' : '$primary' },
          ] },
          { type: 'badge', text: cd.zeroLimited ? t('不可用') : cd.unlimited ? t('不限量') : t('可用'), tone: quotaTone },
        ] },
        ...((!cd.unlimited && !cd.zeroLimited) ? [{ type: 'progress', value: cd.remainingTokens, max: cd.quotaTokens }] : []),
        { type: 'kv', label: t('说明'), value: quotaCap },
        { type: 'kv', label: t('已使用'), value: fmtTok(t, cd.usedTokens) },
      ] },
      /* 卡密列表: chip 操作 + 状态徽章 */
      { type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, title: t('我的卡密 ({0})', keys.length), children: [
        { type: 'list', items: '{{state.keys}}', template: { type: 'column', gap: 10, children: [
          { type: 'row', gap: 6, children: [
            { type: 'text', text: '{{item.name}}', style: 'body', weight: 1 },
            { type: 'badge', text: '{{item.badgeText}}', tone: '{{item.badgeTone}}' },
          ] },
          { type: 'text', text: '{{item.keyShort}} · {{item.quotaText}}', style: 'caption' },
          { type: 'row', gap: 8, children: [
            { type: 'chip', text: t('复制'), icon: 'msym:copy', action: { type: 'copy', text: '{{item.key}}', toast: t('卡密已复制') } },
            { type: 'chip', text: t('改名'), icon: 'msym:edit', action: { type: 'intent', endpoint: './intent/key-rename-open', body: { key: '{{item.key}}' } } },
            { type: 'chip', text: t('权限'), icon: 'msym:key', action: { type: 'intent', endpoint: './intent/key-edit-open', body: { key: '{{item.key}}' } } },
            { type: 'chip', text: t('删除'), icon: 'msym:delete', visible: '{{item.canDelete}}', action: { type: 'intent', endpoint: './intent/delete-key', confirm: t('确定删除这张卡密吗?'), body: { key: '{{item.key}}' } } },
          ] },
        ] } },
        { type: 'button', text: t('发子卡'), style: 'filled', shape: 'pill', icon: 'msym:add', action: { type: 'open', target: 'page:create-key' } },
      ] },
      /* 账号 */
      { type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, title: t('账号'), children: [
        { type: 'row', gap: 8, children: [
          { type: 'button', text: t('编辑资料'), style: 'outlined', shape: 'pill', weight: 1, action: { type: 'open', target: 'page:edit-profile' } },
          ...(uk.uid ? [{ type: 'button', text: t('修改密码'), style: 'outlined', shape: 'pill', weight: 1, action: { type: 'open', target: 'page:change-password' } }] : []),
        ] },
        ...(uk.uid ? [{ type: 'button', text: t('注销账号'), style: 'outlined', shape: 'pill', icon: 'msym:delete', action: { type: 'open', target: 'page:delete-account' } }] : []),
      ] },
      /* 语言(i18n 插件): 选完记住, 所有插件页面跟随; 选项名固定不翻(各自代表自己) */
      { type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, title: t('语言 / Language'), children: [
        { type: 'radio', text: '简体中文', checked: lang === 'zh-CN', selected: lang === 'zh-CN', action: { type: 'intent', endpoint: './intent/set-lang', body: { lang: 'zh-CN' } } },
        { type: 'radio', text: 'English', checked: lang === 'en', selected: lang === 'en', action: { type: 'intent', endpoint: './intent/set-lang', body: { lang: 'en' } } },
        { type: 'radio', text: '繁體中文', checked: lang === 'zh-TW', selected: lang === 'zh-TW', action: { type: 'intent', endpoint: './intent/set-lang', body: { lang: 'zh-TW' } } },
      ] },
    ];
    return {
      gcui: 1, title: t('个人'),
      state: { keys: keys.map(k => keyState(t, k, uk.key)) },
      root: { type: 'column', gap: 14, children },
    };
  };

  ctx.registerRoute('GET', '/ui/personal', (req, res, p) => {
    const uk = ukOf(p);
    if (!uk) return jsonRes(res, 401, { error: mkT(null).t('需要卡密登录') });
    jsonRes(res, 200, buildPersonalPage(uk));
  });

  ctx.registerRoute('GET', '/ui/widget-credits', (req, res, p) => {
    const uk = ukOf(p);
    if (!uk) return jsonRes(res, 401, { error: mkT(null).t('需要卡密登录') });
    const { t } = mkT(uk);
    const cd = apis().creditsJSON(uk);
    const user = uk.uid ? cfg.users.find(x => x.uid === uk.uid) : null;
    const display = (user && (user.nickname || user.username || user.name)) || uk.name || uk.uid || t('用户');
    const children = [
      { type: 'row', gap: 6, children: [
        { type: 'text', text: t('额度'), style: 'caption', color: '$onSurfaceVariant', weight: 1 },
        { type: 'badge', text: cd.zeroLimited ? t('零额度') : cd.unlimited ? t('不限量') : t('按量'), tone: cd.zeroLimited ? 'error' : cd.unlimited ? 'primary' : 'neutral' },
      ] },
    ];
    if (cd.zeroLimited) {
      children.push({ type: 'text', text: '0', style: 'title', color: '$error' });
      children.push({ type: 'text', text: t('请联系管理员充值'), style: 'caption' });
    } else if (cd.unlimited) {
      children.push({ type: 'text', text: t('不限'), style: 'title', color: '$primary' });
      children.push({ type: 'text', text: display, style: 'caption' });
    } else {
      children.push({ type: 'text', text: fmtTok(t, cd.remainingTokens), style: 'title', color: '$primary' });
      children.push({ type: 'progress', value: cd.remainingTokens, max: cd.quotaTokens > 0 ? cd.quotaTokens : 100 });
      children.push({ type: 'text', text: t('总额度 {0}', fmtTok(t, cd.quotaTokens)), style: 'caption' });
    }
    jsonRes(res, 200, {
      gcui: 1, title: t('额度'),
      root: { type: 'column', gap: 6, children },
    });
  });

  ctx.registerRoute('GET', '/ui/edit-profile', (req, res, p) => {
    const uk = ukOf(p);
    if (!uk) return jsonRes(res, 401, { error: mkT(null).t('需要卡密登录') });
    const { t } = mkT(uk);
    const user = uk.uid ? cfg.users.find(x => x.uid === uk.uid) : null;
    jsonRes(res, 200, { gcui: 1, title: t('编辑资料'), root: { type: 'column', gap: 14, children: [
      { type: 'card', variant: 'outlined', shape: 'extraLarge', title: t('基本资料'), children: [
        ...(uk.uid ? [
          { type: 'input', key: 'nickname', label: t('昵称'), value: (user && user.nickname) || '' },
          { type: 'input', key: 'avatar', label: t('头像 URL'), value: (user && user.avatar) || '' },
        ] : []),
        { type: 'input', key: 'cardName', label: t('主卡名称'), value: uk.name || '' },
      ] },
      { type: 'button', text: t('保存'), style: 'filled', shape: 'pill', icon: 'msym:check', action: { type: 'intent', endpoint: './intent/profile', pop: true,
        body: { nickname: '{{input.nickname}}', avatar: '{{input.avatar}}', cardName: '{{input.cardName}}' } } },
    ] } });
  });

  ctx.registerRoute('GET', '/ui/change-password', (req, res, p) => {
    const uk = ukOf(p);
    if (!uk) return jsonRes(res, 401, { error: mkT(null).t('需要卡密登录') });
    const { t } = mkT(uk);
    if (!uk.uid) return jsonRes(res, 400, { error: t('卡密未绑定账号') });
    jsonRes(res, 200, { gcui: 1, title: t('修改密码'), root: { type: 'column', gap: 14, children: [
      { type: 'card', variant: 'outlined', shape: 'extraLarge', children: [
        { type: 'text', text: t('新密码至少 {0} 位', reg.minPasswordLen || 8), style: 'caption', color: '$onSurfaceVariant' },
        { type: 'input', key: 'oldPassword', label: t('原密码'), inputType: 'password' },
        { type: 'input', key: 'newPassword', label: t('新密码'), inputType: 'password' },
      ] },
      { type: 'button', text: t('修改密码'), style: 'filled', shape: 'pill', icon: 'msym:check', action: { type: 'intent', endpoint: './intent/password', pop: true,
        body: { oldPassword: '{{input.oldPassword}}', newPassword: '{{input.newPassword}}' } } },
    ] } });
  });

  ctx.registerRoute('GET', '/ui/create-key', (req, res, p) => {
    const uk = ukOf(p);
    if (!uk) return jsonRes(res, 401, { error: mkT(null).t('需要卡密登录') });
    const { t } = mkT(uk);
    const cd = apis().creditsJSON(uk);
    jsonRes(res, 200, { gcui: 1, title: t('发子卡'), root: { type: 'column', gap: 14, children: [
      { type: 'card', variant: 'outlined', shape: 'extraLarge', children: [
        { type: 'row', gap: 8, children: [
          { type: 'text', text: t('主卡额度'), style: 'caption', color: '$onSurfaceVariant', weight: 1 },
          { type: 'badge', text: cd.zeroLimited ? t('零额度') : cd.unlimited ? t('不限量') : fmtTok(t, cd.remainingTokens), tone: cd.zeroLimited ? 'error' : cd.unlimited ? 'primary' : 'success' },
        ] },
        { type: 'text', text: creditText(t, cd) || t('子卡额度将从主卡扣除，主卡剩余 {0}', fmtTok(t, cd.remainingTokens)), style: 'caption', color: '$onSurfaceVariant' },
      ] },
      { type: 'card', variant: 'outlined', shape: 'extraLarge', title: t('子卡信息'), children: [
        { type: 'input', key: 'name', label: t('卡密名称'), value: '' },
        { type: 'input', key: 'quotaTokens', label: t('额度 (0=跟随上限)'), inputType: 'number', value: '' },
      ] },
      { type: 'button', text: t('创建子卡'), style: 'filled', shape: 'pill', icon: 'msym:add', action: { type: 'intent', endpoint: './intent/create-key',
        body: { name: '{{input.name}}', quotaTokens: '{{input.quotaTokens}}' } } },
    ] } });
  });

  /* ---- 签名意图端点 (security.guard: 验签+防重放+防回滚+幂等) ---- */
  ctx.registerRoute('POST', '/intent/profile', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(uk).t('需要用户卡密') };
    const b = p.body || {};
    if (!uk.uid) return { ok: false, error: '该身份没有用户记录, 无法保存资料' };
    let user = cfg.users.find(x => x.uid === uk.uid);
    if (!user) {
      /* 与 /auth/profile 一致: 该身份还没有用户记录(如管理员密钥 uadmin)时自动建档,
       * 否则这里会静默跳过写入却回 ok:true (App 侧表现为"保存成功但昵称头像被重置")。 */
      user = {
        uid: uk.uid, username: uk.name || uk.uid, name: uk.name || uk.uid,
        nickname: '', avatar: '', group: cfg.defaultGroup || '默认',
        note: '自动创建(管理员身份)', createdAt: new Date().toISOString(),
      };
      cfg.users.push(user);
    }
    if (typeof b.nickname === 'string') user.nickname = b.nickname.slice(0, 64);
    if (typeof b.avatar === 'string') user.avatar = b.avatar.slice(0, 300);
    save();
    if (typeof b.cardName === 'string' && apis().updateKey) apis().updateKey(uk.key, { name: b.cardName.slice(0, 64) });
    return { ok: true, toast: mkT(uk).t('资料已保存') };
  }));

  ctx.registerRoute('POST', '/intent/password', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk || !uk.uid) return { ok: false, error: mkT(uk).t('卡密未绑定账号') };
    const user = cfg.users.find(x => x.uid === uk.uid);
    if (!user) return { ok: false, error: '账号不存在' };
    const b = p.body || {};
    if (!verifyPassword(String(b.oldPassword || ''), user.passwordHash)) return { ok: false, error: '原密码错误' };
    if (String(b.newPassword || '').length < (reg.minPasswordLen || 8)) return { ok: false, error: '新密码至少 ' + (reg.minPasswordLen || 8) + ' 位' };
    user.passwordHash = hashPassword(String(b.newPassword));
    save();
    return { ok: true, toast: mkT(uk).t('密码已修改') };
  }));

  ctx.registerRoute('POST', '/intent/create-key', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(uk).t('需要用户卡密') };
    const b = p.body || {};
    const pm = uk.models || [], pb = uk.branches || [];
    const models = Array.isArray(b.models) ? b.models.map(String).filter(x => !pm.length || pm.includes(x)) : [];
    const groups = Array.isArray(b.groups) ? b.groups.map(String).filter(x => !(uk.groups || []).length || (uk.groups || []).includes(x)) : [];
    const branches = Array.isArray(b.branches) ? b.branches.map(String).filter(x => !pb.length || pb.includes(x)) : [];
    const quota = clampQuota(uk, b.quotaTokens);
    if (Number(uk.quotaTokens) > 0 && quota > 0) {
      apis().updateKey(uk.key, { quotaTokens: Number(uk.quotaTokens) - quota }); /* 从主卡扣除 */
    }
    const nk = { key: apis().genKey(), name: String(b.name || uk.name || '子卡').slice(0, 64), enable: true, quotaTokens: quota, uid: uk.uid || '', models, groups, branches, note: 'App 自助', by: 'user', createdAt: new Date().toISOString() };
    apis().addKey(nk);
    /* 创建后直接进入「访问权限」页, 顺手把权限设好 */
    /* nav:'push' = 真子页(发子卡页 → 新卡权限页); 带副作用, 不可作刷新来源 */
    return { ok: true, toast: mkT(uk).t('子卡已创建: {0}', nk.key.slice(0, 8) + '…'), nav: 'push', ui: editKeyPage(uk, nk.key, 'all', [], [], '') };
  }));

  ctx.registerRoute('POST', '/intent/delete-key', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(uk).t('需要用户卡密') };
    const target = String((p.body && p.body.key) || '');
    if (target === uk.key) return { ok: false, error: '不能删除主卡' };
    if (!myKeysOf(uk.uid, uk.key).some(k => k.key === target)) return { ok: false, error: mkT(uk).t('卡密不存在或不属于你') };
    apis().deleteKey(target);
    return { ok: true, toast: mkT(uk).t('已删除') };
  }));

  /* ---- 卡密「访问权限」编辑意图 (SDUI: 每次点选都由服务端返回整页) ---- */
  const permDraft = (b) => ({
    key: String((b && b.key) || ''),
    mode: ['all', 'group', 'model'].includes(String(b && b.mode)) ? String(b.mode) : 'all',
    groups: Array.isArray(b && b.groups) ? b.groups.map(String) : [],
    models: Array.isArray(b && b.models) ? b.models.map(String) : [],
    q: String((b && b.q) == null ? '' : b.q).slice(0, 60),
  });
  const targetOf = (uk, key) => myKeysOf(uk.uid, uk.key).find(k => k.key === key) || null;

  ctx.registerRoute('POST', '/intent/key-edit-open', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(uk).t('需要用户卡密') };
    const t = targetOf(uk, String((p.body && p.body.key) || ''));
    if (!t) return { ok: false, error: mkT(uk).t('卡密不存在或不属于你') };
    /* 只读 → 允许 App 刷新该页时重跑本意图 */
    return { ok: true, ui: editKeyPage(uk, t.key, effMode(t), t.groups || [], t.models || [], ''), refresh: 'intent' };
  }));

  ctx.registerRoute('POST', '/intent/key-edit-mode', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(uk).t('需要用户卡密') };
    const d = permDraft(p.body);
    return { ok: true, nav: 'replace', ui: editKeyPage(uk, d.key, d.mode, d.groups, d.models, d.mode === 'model' ? d.q : '') };
  }));

  ctx.registerRoute('POST', '/intent/key-edit-toggle', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(uk).t('需要用户卡密') };
    const d = permDraft(p.body);
    const v = String((p.body && p.body.value) || '');
    if (!v) return { ok: false, error: '缺少参数' };
    const arr = (p.body && p.body.facet === 'group') ? d.groups : d.models;
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
    return { ok: true, nav: 'replace', ui: editKeyPage(uk, d.key, d.mode, d.groups, d.models, d.q) };
  }));

  ctx.registerRoute('POST', '/intent/key-edit-search', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(uk).t('需要用户卡密') };
    const d = permDraft(p.body);
    return { ok: true, nav: 'replace', ui: editKeyPage(uk, d.key, d.mode, d.groups, d.models, d.q) };
  }));

  ctx.registerRoute('POST', '/intent/key-edit-save', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(uk).t('需要用户卡密') };
    const d = permDraft(p.body);
    const t = targetOf(uk, d.key);
    if (!t) return { ok: false, error: mkT(uk).t('卡密不存在或不属于你') };
    const perm = clampPerm(uk, d.mode, d.groups, d.models);
    apis().updateKey(t.key, { groups: perm.groups, models: perm.models });
    return { ok: true, toast: mkT(uk).t('访问权限已保存'), back: true, ui: buildPersonalPage(uk) };
  }));

  ctx.registerRoute('POST', '/intent/key-edit-back', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(uk).t('需要用户卡密') };
    return { ok: true, back: true, ui: buildPersonalPage(uk) };
  }));

  /* ---- 卡密改名 (SDUI: input 页 + 保存) ---- */
  const renamePage = (uk, key) => {
    const { t } = mkT(uk);
    const t2 = (myKeysOf(uk.uid, uk.key).find(k => k.key === key) || {});
    return { gcui: 1, title: t('改名'), root: { type: 'column', gap: 14, padding: 16, children: [
      { type: 'card', variant: 'outlined', shape: 'extraLarge', children: [
        { type: 'text', text: t('卡密 {0}', String(key).slice(0, 8) + '…'), style: 'caption', color: '$onSurfaceVariant' },
        { type: 'input', key: 'name', label: t('卡名'), value: String(t2.name || '') },
        { type: 'row', gap: 8, children: [
          { type: 'button', text: t('保存'), style: 'filled', shape: 'pill', icon: 'msym:check', weight: 1, action: { type: 'intent', endpoint: './intent/key-rename-save', body: { key: key, name: '{{input.name}}' } } },
          { type: 'button', text: t('取消'), style: 'text', shape: 'pill', weight: 1, action: { type: 'intent', endpoint: './intent/key-rename-back', body: {} } },
        ] },
      ] },
    ] } };
  };
  ctx.registerRoute('POST', '/intent/key-rename-open', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(uk).t('需要用户卡密') };
    const key = String((p.body && p.body.key) || '');
    if (!targetOf(uk, key)) return { ok: false, error: mkT(uk).t('卡密不存在或不属于你') };
    return { ok: true, ui: renamePage(uk, key), refresh: 'intent' };
  }));
  ctx.registerRoute('POST', '/intent/key-rename-save', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(uk).t('需要用户卡密') };
    const key = String((p.body && p.body.key) || '');
    const t = targetOf(uk, key);
    if (!t) return { ok: false, error: mkT(uk).t('卡密不存在或不属于你') };
    const name = String((p.body && p.body.name) || '').trim().slice(0, 64);
    apis().updateKey(key, { name: name });
    return { ok: true, toast: mkT(uk).t('已改名'), back: true, ui: buildPersonalPage(uk) };
  }));
  ctx.registerRoute('POST', '/intent/key-rename-back', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(uk).t('需要用户卡密') };
    return { ok: true, back: true, ui: buildPersonalPage(uk) };
  }));

  /* ---- 语言切换(i18n 插件): 个人页「语言」卡 → 偏好经事件总线同步落盘 → 原地重渲染 ----
   * 事件名 = 'auth-user:setLang' (emit 自动带本插件 id 前缀); emit 同步送达,
   * 下方重取 bundle 时已能读到新语言 → toast 和新页面都直接是新语言。 */
  ctx.registerRoute('POST', '/intent/set-lang', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: mkT(uk).t('需要用户卡密') };
    const lang = String((p.body && p.body.lang) || '');
    if (!['zh-CN', 'en', 'zh-TW'].includes(lang)) return { ok: false, error: mkT(uk).t('不支持的语言') + ': ' + lang };
    try { ctx.emit('setLang', { fkey: uk.uid || uk.key, lang: lang }); } catch (e) { ctx.log('[auth-user] setLang 事件发送失败: ' + e.message); }
    const { t } = mkT(uk);   /* emit 已同步生效, 这里拿到的已是新语言 */
    return { ok: true, toast: t('已切换语言'), nav: 'replace', ui: buildPersonalPage(uk) };
  }));

  /* ---- 注销账号: 删除用户+所有卡密+用量记录 ---- */
  ctx.registerRoute('GET', '/ui/delete-account', (req, res, p) => {
    const uk = ukOf(p);
    if (!uk) return jsonRes(res, 401, { error: mkT(null).t('需要卡密登录') });
    const { t } = mkT(uk);
    if (!uk.uid) return jsonRes(res, 400, { error: t('卡密未绑定账号') });
    jsonRes(res, 200, { gcui: 1, title: t('注销账号'), root: { type: 'column', gap: 14, children: [
      { type: 'card', variant: 'outlined', shape: 'extraLarge', children: [
        { type: 'row', gap: 8, children: [
          { type: 'text', text: t('注销将永久删除'), style: 'title3', color: '$error', weight: 1 },
          { type: 'badge', text: t('不可恢复'), tone: 'error' },
        ] },
        { type: 'text', text: t('• 你的账号及所有卡密将被永久删除\n• 已签发的子卡也会一并失效\n• 此操作不可恢复'), style: 'caption', color: '$onSurfaceVariant' },
      ] },
      { type: 'card', variant: 'outlined', shape: 'extraLarge', children: [
        { type: 'input', key: 'password', label: t('输入密码确认注销'), inputType: 'password' },
      ] },
      { type: 'button', text: t('确认注销'), style: 'filled', shape: 'pill', icon: 'msym:delete', action: { type: 'intent', endpoint: './intent/delete-account', confirm: t('最后确认: 确定要注销账号吗? 所有数据将永久删除!'), body: { password: '{{input.password}}' } } },
    ] } });
  });

  ctx.registerRoute('POST', '/intent/delete-account', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk || !uk.uid) return { ok: false, error: mkT(uk).t('卡密未绑定账号') };
    const user = cfg.users.find(x => x.uid === uk.uid);
    if (!user) return { ok: false, error: '账号不存在' };
    if (!verifyPassword(String((p.body && p.body.password) || ''), user.passwordHash)) return { ok: false, error: mkT(uk).t('密码错误') };
    /* 删除该用户所有卡密 (含主卡+子卡) + 全局注销 */
    if (apis().deleteKeysOf) apis().deleteKeysOf(uk.uid);
    const i = cfg.users.findIndex(x => x.uid === uk.uid);
    if (i >= 0) cfg.users.splice(i, 1);
    save();
    /* nav:'reset' = 终结页: 账号已不存在, 返回键不该再回到个人中心 */
    const { t } = mkT(uk);
    return { ok: true, toast: t('账号已注销'), nav: 'reset', ui: { gcui: 1, title: t('已注销'), root: { type: 'column', gap: 14, children: [
      { type: 'card', variant: 'outlined', shape: 'extraLarge', children: [
        { type: 'text', text: t('你的账号已永久删除'), style: 'title3' },
        { type: 'text', text: t('感谢使用 Gay Core'), style: 'caption', color: '$onSurfaceVariant' },
      ] },
    ] } } };
  }));

  /* ---- 管理端点 ---- */
  /* ---- 用户分组: 列表 / 增删改 ---- */
  const groupCounts = () => {
    const out = {};
    for (const g of cfg.groups) out[g] = 0;
    for (const u of cfg.users) { const g = groupOf(u); out[g] = (out[g] || 0) + 1; }
    return out;
  };
  ctx.registerRoute('GET', '/admin/groups', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    jsonRes(res, 200, { ok: true, groups: cfg.groups.slice(), defaultGroup: cfg.defaultGroup, counts: groupCounts() });
  });
  ctx.registerRoute('POST', '/admin/groups', (req, res, p) => { // {action:'add'|'remove'|'rename', name, newName}
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const j = p.body || {};
    const name = String(j.name || '').trim().slice(0, 32);
    const act = String(j.action || 'add');
    if (!name) return jsonRes(res, 400, { error: '分组名不能为空' });
    if (act === 'add') {
      if (cfg.groups.includes(name)) return jsonRes(res, 409, { error: '分组已存在' });
      cfg.groups.push(name); save();
      return jsonRes(res, 200, { ok: true, groups: cfg.groups.slice() });
    }
    if (act === 'remove') {
      if (cfg.groups.length <= 1) return jsonRes(res, 400, { error: '至少保留一个分组' });
      const used = cfg.users.filter(u => groupOf(u) === name).length;
      if (used && !j.force) return jsonRes(res, 409, { error: '还有 ' + used + ' 个用户在这个分组, 加 force:true 可强制(用户改回默认分组)' });
      cfg.groups = cfg.groups.filter(g => g !== name);
      for (const u of cfg.users) if (groupOf(u) === name) u.group = cfg.defaultGroup;
      if (cfg.defaultGroup === name) cfg.defaultGroup = cfg.groups[0];
      save();
      return jsonRes(res, 200, { ok: true, groups: cfg.groups.slice(), moved: used });
    }
    if (act === 'rename') {
      const nn = String(j.newName || '').trim().slice(0, 32);
      if (!nn) return jsonRes(res, 400, { error: '新分组名不能为空' });
      if (cfg.groups.includes(nn)) return jsonRes(res, 409, { error: '新分组名已存在' });
      cfg.groups = cfg.groups.map(g => g === name ? nn : g);
      for (const u of cfg.users) if (groupOf(u) === name) u.group = nn;
      if (cfg.defaultGroup === name) cfg.defaultGroup = nn;
      save();
      return jsonRes(res, 200, { ok: true, groups: cfg.groups.slice() });
    }
    if (act === 'setDefault') {
      if (!cfg.groups.includes(name)) return jsonRes(res, 404, { error: '分组不存在' });
      cfg.defaultGroup = name; save();
      return jsonRes(res, 200, { ok: true, defaultGroup: name, groups: cfg.groups.slice() });
    }
    return jsonRes(res, 400, { error: '未知操作: ' + act });
  });

  ctx.registerRoute('GET', '/admin/users', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const allKeys = apis().listKeys ? apis().listKeys() : [];
    jsonRes(res, 200, { users: cfg.users.map(u => {
      const uks = allKeys.filter(k => k.uid === u.uid);
      return {
        uid: u.uid, username: u.username || u.name || '', name: u.name, nickname: u.nickname, avatar: u.avatar, note: u.note,
        group: groupOf(u),
        email: u.email || '', banned: !!u.banned, banReason: u.banReason || '', createdAt: u.createdAt,
        keyCount: uks.length,
        totalQuota: uks.reduce((s, k) => s + Math.max(0, k.quotaTokens || 0), 0),
        totalUsed: uks.reduce((s, k) => s + (k.usedTokens || 0), 0),
        keys: uks.map(k => ({ key: k.key, name: k.name, enable: k.enable !== false, quotaTokens: k.quotaTokens || 0, usedTokens: k.usedTokens || 0 })),
      };
    }) });
  });
  ctx.registerRoute('POST', '/admin/users', (req, res, p) => { // 建用户/重置密码/删用户
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const j = p.body || {};
    if (j.action === 'delete') {
      const i = cfg.users.findIndex(x => x.uid === j.uid);
      if (i < 0) return jsonRes(res, 404, { error: '用户不存在' });
      if (apis().deleteKeysOf) apis().deleteKeysOf(j.uid); /* 连带删该用户的卡 */
      cfg.users.splice(i, 1); save();
      return jsonRes(res, 200, { ok: true });
    }
    if (j.action === 'ban' || j.action === 'unban') {
      const user = cfg.users.find(x => x.uid === j.uid);
      if (!user) return jsonRes(res, 404, { error: '用户不存在' });
      user.banned = j.action === 'ban';
      user.banReason = user.banned ? String(j.reason || '').slice(0, 200) : '';
      save();
      return jsonRes(res, 200, { ok: true, banned: user.banned });
    }
    if (j.action === 'update') {
      const user = cfg.users.find(x => x.uid === j.uid);
      if (!user) return jsonRes(res, 404, { error: '用户不存在' });
      if (j.name !== undefined) user.name = String(j.name).slice(0, 64);
      if (j.nickname !== undefined) user.nickname = String(j.nickname).slice(0, 64);
      if (j.email !== undefined) user.email = String(j.email).slice(0, 120);
      if (j.note !== undefined) user.note = String(j.note).slice(0, 200);
      if (j.group !== undefined) {
        if (!cfg.groups.includes(String(j.group))) return jsonRes(res, 400, { error: '分组不存在: ' + j.group });
        user.group = String(j.group);
      }
      save();
      return jsonRes(res, 200, { ok: true });
    }
    if (j.action === 'resetPassword') {
      const user = cfg.users.find(x => x.uid === j.uid);
      if (!user) return jsonRes(res, 404, { error: '用户不存在' });
      user.passwordHash = hashPassword(String(j.password || ''));
      save();
      return jsonRes(res, 200, { ok: true });
    }
    const uid = String(j.uid || '').trim();
    const username = String(j.username || j.name || '').trim();
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) return jsonRes(res, 400, { error: '用户名需 3-32 位' });
    if (cfg.users.some(x => x.username === username || x.name === username)) return jsonRes(res, 409, { error: '用户名已存在' });
    const newUid = 'u' + crypto.randomBytes(4).toString('hex');
    const newGroup = cfg.groups.includes(String(j.group || '')) ? String(j.group) : cfg.defaultGroup;
    cfg.users.push({ uid: newUid, username, name: username, group: newGroup, passwordHash: hashPassword(String(j.password || 'changeme')), nickname: String(j.nickname || ''), avatar: '', email: String(j.email || ''), banned: false, note: String(j.note || ''), createdAt: new Date().toISOString() });
    save();
    /* 默认同时发一张主卡 —— 否则用户登录不上(客户端要求账号至少有一张卡密)。
     * 额度: 显式传 quotaTokens 优先, 否则用注册默认额度; 都没有 = 零额度(-1), 管理员再充值。 */
    let mainKey = null;
    if (apis().addKey && j.noCard !== true) {
      const raw = j.quotaTokens !== undefined ? j.quotaTokens : (reg && reg.defaultQuota);
      const dq = Math.floor(Number(raw) || 0);
      mainKey = { key: apis().genKey(), name: username + ' 的主卡', enable: true, quotaTokens: dq > 0 ? dq : 0, uid: newUid, models: [], branches: [], isMain: true, by: 'auto', createdAt: new Date().toISOString() };
      apis().addKey(mainKey);
    }
    jsonRes(res, 200, { ok: true, uid: newUid, username, key: mainKey ? mainKey.key : null });
  });

  /* 首次归一化后落盘: 让其它插件/管理端能读到分组列表 */
  if (!cfg._groupsPersisted) { cfg._groupsPersisted = true; save(); }
  /* ★能力注册 (2026-10-07): 用户分组数据不再只能靠"知道 auth-user 这个名字"来拿 */
  /* ★能力注册 (2026-10-07): 用户管理能力 —— 内核「用户」页据此取数据, 不再写死 'auth-user' */
  ctx.provideCapability('user-admin', {
    listUsers: () => { try { return cfg.users.map(u => ({ uid: u.uid, name: u.name, nickname: u.nickname, email: u.email, note: u.note, avatar: u.avatar || '', banned: !!u.banned, banReason: u.banReason })); } catch (_) { return []; } },
    adminApi: () => ({ pluginId: ctx.id, list: '/admin/users' }),
    /* ★api (2026-10-07): 同上 —— App 按能力名查端点, 不再写死 /plugins/auth-user/... */
    api: () => ({
      endpoints: {
        list:   '/admin/users',   // GET  列表
        action: '/admin/users',   // POST 用户操作(create/update/resetPassword/ban/unban/delete)
      },
    }),
  });

  /* ★能力注册 (2026-10-07): 注册配置公示 —— 内核 bootstrap 据此填 auth.registration,
   *  不再写死 'auth-user'。★字段形状与旧版**逐字段一致**(App Models.kt 的 RegistrationInfo 依赖它),
   *  secret(captchaSiteKey 之外的一切)绝不外泄。 */
  ctx.provideCapability('user-registration', {
    info: () => {
      try {
        const r = (cfg.registration && typeof cfg.registration === 'object') ? cfg.registration : {};
        return {
          enable: !!r.enable,
          minPasswordLen: Number(r.minPasswordLen) || 8,
          captchaProvider: r.captchaProvider === 'turnstile' ? 'turnstile' : 'none',
          captchaSiteKey: r.captchaProvider === 'turnstile' ? String(r.captchaSiteKey || '') : '',
          emailVerify: !!(r.emailVerify && r.emailVerify.enable),
        };
      } catch (_) { return null; }
    },
  });

  ctx.provideCapability('user-groups', {
    listUsers: () => { try { return (cfg.users || []).map(u => ({ uid: u.uid, group: u.group, groups: u.groups })); } catch (_) { return []; } },
    groups: () => { try { return Array.isArray(cfg.groups) ? cfg.groups.slice() : []; } catch (_) { return []; } },
    defaultGroup: () => { try { return cfg.defaultGroup || ''; } catch (_) { return ''; } },
  });

  ctx.log('用户体系已激活, 用户数:', cfg.users.length, '注册:', reg.enable ? '开' : '关', '分组:', cfg.groups.join('/'), '· 已提供能力 user-groups');
};
