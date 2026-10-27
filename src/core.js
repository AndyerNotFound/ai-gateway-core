'use strict';
/* core.js - HTTP server + 多实例池(UID) + 请求路由 + setup 模式 + admin 最小 API (文档 §2.1/§3.3)
 *
 * 内核端点(白名单, 其余都是插件的事):
 *   GET  /health /status
 *   POST /setup/admin                 setup 模式(仅 localhost, 限时)
 *   GET  /v1/models /v1beta/models
 *   POST /v1/chat/completions         OpenAI
 *   POST /v1/messages                 Claude
 *   POST /v1beta/models/:m:(stream)GenerateContent   Gemini
 *   POST /v1/responses                OpenAI Responses (canonical 正统格式, 不再需要 openaiExtras 开关)
 *   *    /plugins[/<id>/...]          插件分发
 *   *    插件注册的扩展端点 (registerExtraEndpoint)
 *   *    /admin/api/*                 管理最小集(实例/配置/插件列表)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { log, logErr, readJson, utf8, keyIdOf, keyNameOf } = require('./util');
const { Store, RESERVED_PATHS, INST_NAME_RE } = require('./store');
const { AuthChain, isLocalhost } = require('./auth');
const { PluginManager } = require('./plugins');
const router = require('./router');
const { newStats } = require('./stats');
const crypt = require('./crypt');
const modelgroups = require('./modelgroups');
const modelref = require('./modelref');   /* 「实例:渠道:模型」模型引用 (2026-09-18) */
const usageHist = require('./usage-history');  /* 使用统计历史: 小时桶永久 + 10 分钟桶 30 天 (2026-09-18) */
const adminUi = require('./admin-ui');

const CORE_VERSION = require('../package.json').version;

/* ---------- 插件配置「合并写入」 ----------
 * 管理端(网页/App)的插件配置表单只回传 configSchema 里声明的字段，schema 之外的字段不在 body 里。
 * 若整体替换，运行期数据会被一起抹掉 —— 2026-09-16 事故：保存「用户体系」插件配置把整张用户表清空
 * （卡密表在另一个文件里，所以幸存 → 表现为"用户全没了但卡还在"）。
 * 语义：普通字段覆盖；值为 null = 删除该键；对象递归合并；数组整体替换。 */
function mergePluginConfig(base, patch) {
  const out = Object.assign({}, (base && typeof base === 'object') ? base : {});
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v === null) { delete out[k]; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergePluginConfig(out[k], v);
    } else out[k] = v;
  }
  return out;
}
const GEMINI_RE = /^\/v1(?:beta|alpha)?\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/;

/* ---------- 错误/工具 ---------- */
/* ★布尔参数解析 (2026-09-19 事故修复)
 * 管理端开关既有传 Boolean 的（App 原生页），也有传字符串的（SDUI 模板 {{input._checked}}）。
 *  **严禁 `!!v`**：`!!"false" === true`（关闭变成打开）、`!!"" === false`（模板解析失败被静默当成关闭）。
 *  返回 null = 值非法 → 调用方必须回 400，绝不猜。 */
function asBool(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === '1') return true;
    if (t === 'false' || t === '0') return false;
  }
  return null;
}

function corsHeaders(cfg) {
  if (cfg && cfg.cors === false) return {};
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': '*' };
}
function jsonErr(res, e, code) {
  try { res.writeHead(code || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: (e && e.message) || String(e) })); } catch (_) {}
}
function sendError(cfg, format, res, status, message, code) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  let body;
  if (format === 'claude') body = { type: 'error', error: { type: 'api_error', message } };
  else if (format === 'gemini') body = { error: { code: status, message, status: code || 'INTERNAL' } };
  else body = { error: { message, type: 'gateway_error', code: code || String(status) } };
  try {
    res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(cfg) });
    res.end(JSON.stringify(body));
  } catch (_) { try { res.end(); } catch (_) {} }
}
/** 从请求体里取模型名 (gemini 走 URL, 其余走 body.model) */
function modelFromBody(urlInfo, bodyStr) {
  if (urlInfo && urlInfo.model) return String(urlInfo.model);
  try {
    const o = JSON.parse(bodyStr || '{}');
    if (o && o.model) return String(o.model);
  } catch (_) { }
  return '';
}

function collectModels(cfg) {
  const set = [];
  for (const ch of (cfg.channels || [])) {
    if (ch.models) for (const m of ch.models) if (!set.includes(m)) set.push(m);
    if (ch.modelMap) for (const m of Object.keys(ch.modelMap)) if (!set.includes(m)) set.push(m);
  }
  return set;
}
function modelsResponse(cfg, format) {
  return modelsResponseFrom(collectModels(cfg), format);
}
/** 由模型名数组直接构造 /v1/models 响应 (聚合路由用) */
function modelsResponseFrom(ms, format) {
  if (format === 'gemini') {
    return { models: ms.map(m => ({ name: 'models/' + m, displayName: m, supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'] })) };
  }
  return { object: 'list', data: ms.map(m => ({ id: m, object: 'model', type: 'model', created: 1700000000, owned_by: 'ai-gateway-core', display_name: m })) };
}

/* Gay Core: 用户端布局配置校验 (bottomBar/hidden/homeOrder=字符串数组, theme=字符串) */
function sanitizeLayout(l) {
  if (!l || typeof l !== 'object') return null;
  const arr = v => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 64).slice(0, 32) : undefined;
  const out = {};
  const bb = arr(l.bottomBar), hd = arr(l.hidden), ho = arr(l.homeOrder);
  if (bb) out.bottomBar = bb;
  if (hd) out.hidden = hd;
  if (ho) out.homeOrder = ho;
  if (typeof l.theme === 'string' && l.theme.length <= 64) out.theme = l.theme;
  return out;
}
/* MD3 默认主题兜底 (theme-md3 插件文件丢失时 App 仍有默认主题可用) */
const FALLBACK_THEME = {
  id: 'theme-md3', name: 'Material Design 3', builtin: true, locked: true,
  dark: { primary: '#D0BCFF', onPrimary: '#381E72', secondary: '#CCC2DC', surface: '#141218', surfaceContainer: '#1D1B20', background: '#141218', onSurface: '#E6E0E9', onSurfaceVariant: '#CAC4D0', outline: '#938F99', error: '#F2B8B5' },
  light: { primary: '#6750A4', onPrimary: '#FFFFFF', secondary: '#625B71', surface: '#FEF7FF', surfaceContainer: '#F3EDF7', background: '#FEF7FF', onSurface: '#1D1B20', onSurfaceVariant: '#49454F', outline: '#79747E', error: '#B3261E' },
  cssVars: {},
};

/* ---------- 网关主体 ---------- */
class Gateway {
  constructor(dir, opts = {}) {
    this.store = new Store(dir);
    this.authChain = new AuthChain();
    this.plugins = new PluginManager(this.store, {
      authChain: this.authChain,
      gateway: this,
      upstreamRequest: (cfg, o) => router.upstreamRequest(cfg, o.ch || (cfg.channels && cfg.channels[0]), o.url, o.headers || {}, o.body || o.bodyBuf || null, o.cb || (() => {}), o.method),
      pickChannels: (cfg, model) => router.pickChannels(cfg, model),
      crypt: { encrypt: v => crypt.encryptText(v, this.store._pass), decrypt: v => crypt.decryptText(v, this.store._pass), maskFields: crypt.maskFields },
      log: (...a) => log('[plugins]', ...a),
    });
    /* ★2026-09-18 多实例一致性: 把"插件配置被写过"挂到 Store 上 ——
     *  ctx.setPluginConfig 与 /admin/api/plugin-config/:uid/:pid(绕过 ctx 的那条)都会触发,
     *  由 PluginManager 递增版本号并把新配置**原地**同步给同插件的其它实例。 */
    this.store.onPluginConfigWrite = (pid) => { try { this.plugins.bumpCfgRev(pid, null); } catch (_) {} };
    // pool: instances Map<uid, cfg>, servers Map<"http:port",...>, portOwner Map<port,uid>
    this.pool = { instances: new Map(), servers: new Map(), portOwner: new Map(), mainPort: 0, mainTlsPort: 0, mainHost: '0.0.0.0' };
    this.opts = opts;
    this._gi = { at: 0, idx: null };   // 模型分组索引缓存
  }

  /* ---------- 模型分组索引 (缓存 3s, 避免每请求读盘) ---------- */
  groupIndex() {
    const now = Date.now();
    if (!this._gi.idx || now - this._gi.at > 3000) {
      /* ★能力优先: 有 model-pricing 提供方就让它供数, 内核不再点名 model-square。
       *  分组/价格是**全局**配置(manifest 未写 scope → 存 uid=0 键), 所以这里查 uid=0,
       *  与旧路径 store.getPluginConfig('model-square', 0) 的口径一致。 */
      let capSrc = null;
      try { capSrc = this.plugins ? this.plugins.requireCapability(0, 'model-pricing') : null; } catch (_) {}
      this._gi = { at: now, idx: modelgroups.buildIndex(this.store, capSrc) };
    }
    return this._gi.idx;
  }
  invalidateGroupIndex() { this._gi = { at: 0, idx: null }; }

  /**
   * 无前缀(Default)聚合: 汇总所有已启用实例的模型名。
   * @param {object|null} userKey 卡密(用于按 branches 实例白名单裁剪); 管理员/未登录 = null
   * @param {object|null} onlyCfg 传入时只收该实例(内部用)
   */
  aggregateModels(userKey) {
    const allowed = (userKey && Array.isArray(userKey.branches) && userKey.branches.length) ? userKey.branches : null;
    const out = [];
    for (const [, c] of this.pool.instances) {
      if (!c || c._disabled) continue;
      if (allowed && !allowed.includes(c._name)) continue;
      for (const m of collectModels(c)) if (!out.includes(m)) out.push(m);
    }
    return out;
  }

  /**
   * 聚合模式下"参与聚合的实例配置"清单（已启用 + 已按卡密实例白名单裁剪）。
   * 顺序 = pool 的插入顺序（即 uid 顺序），保证 /v1/models 稳定。
   */
  aggregateInstanceCfgs(userKey) {
    const allowed = (userKey && Array.isArray(userKey.branches) && userKey.branches.length) ? userKey.branches : null;
    const out = [];
    for (const [, c] of this.pool.instances) {
      if (!c || c._disabled) continue;
      if (allowed && !allowed.includes(c._name)) continue;
      out.push(c);
    }
    return out;
  }

  /**
   * /v1/models 的 id 列表（2026-09-18 用户要求「以防同名模型覆盖」）：
   *   同名模型出现在**多个 (实例,渠道)** 时 → id 变成 `实例:渠道:模型名`，客户端可精确指定来源；
   *   没冲突的保持原名。**原名继续可用**（转发侧照旧解析真名），只是不再列在清单里。
   * @param {Array} cfgs 参与聚合的实例配置（单实例模式传 [cfg]）
   */
  modelRefs(cfgs) {
    return modelref.buildRefs((Array.isArray(cfgs) ? cfgs : []).map(c => ({ name: c && c._name, channels: (c && c.channels) || [] })));
  }

  /** 找能提供某模型的其它实例(聚合兜底; 跳过 default 本身) */
  findInstanceForModel(model, userKey) {    const allowed = (userKey && Array.isArray(userKey.branches) && userKey.branches.length) ? userKey.branches : null;
    for (const [, c] of this.pool.instances) {
      if (!c || c._disabled) continue;
      if (c._name === 'default') continue;
      if (allowed && !allowed.includes(c._name)) continue;
      if (collectModels(c).includes(model)) return c;
    }
    return null;
  }

  /** 按卡密白名单过滤模型名 (models 与 groups 同时存在时取交集; 空 = 不限) */
  filterModelsFor(list, userKey) {
    if (!userKey) return list;
    const ms = Array.isArray(userKey.models) ? userKey.models : [];
    const gs = Array.isArray(userKey.groups) ? userKey.groups : [];
    if (!ms.length && !gs.length) return list;
    const gi = this.groupIndex();
    return list.filter(m => {
      if (ms.length && !ms.includes(m)) return false;
      if (gs.length && !gi.matches(m, gs)) return false;
      return true;
    });
  }

  /* ---------- 实例加载 ---------- */
  loadInstance(uid) {
    const old = this.pool.instances.get(uid);
    let cfg;
    try { cfg = this.store.loadInstance(uid); } catch (e) { logErr('[pool] 实例 uid=' + uid + ' 配置加载失败: ' + e.message); return null; }
    if (!cfg) { if (old) { this.pool.instances.delete(uid); this.reconcilePorts(); } return null; }
    const meta = this.store.meta(uid);
    cfg._disabled = !(meta && meta.enabled !== false);
    cfg._stats = (old && old._stats) || newStats(); // 热重载保留统计
    this.pool.instances.set(uid, cfg);
    const r = this.plugins.activateInstance(uid, cfg);
    if (!r.ok) logErr('[plugins] uid=' + uid + ' ' + r.blocked);
    this.reconcilePorts();
    return cfg;
  }

  /** 重载所有实例(解锁/锁定/换口令后必须做: 内存里的 cfg 是密文或明文, 要重新读盘) */
  reloadAllInstances() {
    for (const meta of this.store.index.instances) this.loadInstance(meta.uid);
    return this.store.index.instances.length;
  }

  /* ---------- 加密口令 / 锁定 (2026-09-18, 「密钥保险箱」插件用) ---------- */
  cryptStatus() { return Object.assign({ ok: true }, this.store.cryptStatus()); }

  /** 解锁：口令只在内存里（不落盘）。
   *  · 未加密/已解锁时：调用方已用 adminKey 鉴权过，只校验口令即可；
   *  · **锁定时**：常规鉴权根本过不了（adminKey 自己也是密文）→ 必须传 adminKey，
   *    用"口令能解出这个 adminKey"来同时证明两样（见 store.verifyAdminKeyWithPass）。 */
  cryptUnlock(pass, adminKey) {
    const p = String(pass == null ? '' : pass).trim();
    if (p.length < 8) return { ok: false, error: '口令至少 8 位' };
    /* ★已经是"这把口令 + 已解锁"的状态 → 直接返回，**不做重载**
     *  （否则 App 每次刷新都触发一次全实例重载 = 几千次 scrypt，把网关阻塞到无响应；2026-09-18 实测） */
    if (this.store._pass === p && !this.store.locked) {
      return { ok: true, noop: true, note: '已解锁（口令未变，无需重载）', status: this.store.cryptStatus() };
    }
    if (this.store.locked) {
      if (!this.store.verifyAdminKeyWithPass(p, adminKey)) return { ok: false, error: '口令或管理员密钥不正确' };
    } else if (this.store.hasCiphertext() && !this.store.verifyPass(p)) {
      return { ok: false, error: '口令不正确' };
    }
    this.store.setPass(p);
    const n = this.reloadAllInstances();
    log('[crypt] 已解锁(口令仅存内存), 已重载 ' + n + ' 个实例');
    return { ok: true, reloaded: n, status: this.store.cryptStatus() };
  }

  /** 锁定：清掉内存口令并重载(把内存里的明文 key 一并清掉)。有密文时转发请求会被 503 拦。 */
  cryptLock() {
    const had = !!this.store._pass;
    this.store.setPass(null);
    const n = this.reloadAllInstances();
    log('[crypt] 已锁定' + (had ? '(内存明文已随重载清除)' : '(此前本就未解锁)'));
    return { ok: true, reloaded: n, status: this.store.cryptStatus() };
  }

  /** 首次加密迁移 / 换口令：把盘上敏感字段重写为当前(或新)口令的密文，每个文件先留备份 */
  cryptReencrypt(pass) {
    const cur = this.store._pass;
    const p = String(pass == null ? '' : pass).trim() || cur;
    if (!p) return { ok: false, error: '请先解锁（或提供口令）' };
    /* ★闸门：同一时间只允许一次加密/换口令。连点按钮会叠加重加密+重载(每次几千次 scrypt)，
     *  2026-09-18 实测把网关阻塞到完全无响应 —— 宁可拒绝第二次，也不要拖垮整个网关。 */
    if (this._cryptBusy) return { ok: false, error: '上一次加密/换口令还在处理中，请等几秒再试（不要连点）' };
    this._cryptBusy = true;
    const t0 = Date.now();
    try {
      if (!cur && this.store.hasCiphertext() && !this.store.verifyPass(p)) return { ok: false, error: '口令不正确' };
      const r = this.store.reencryptAll(p, { tag: 'crypt' });
      if (!r.ok) return r;
      this.store.setPass(p);
      const n = this.reloadAllInstances();
      log('[crypt] 重加密: 改写 ' + r.rewritten + '/跳过 ' + (r.skipped || 0) + '/共 ' + r.scanned
        + ' 个文件, 重载 ' + n + ' 个实例, 用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'
        + (r.errors.length ? ', 失败 ' + r.errors.length : ''));
      return Object.assign({ ok: true, reloaded: n, status: this.store.cryptStatus() }, r);
    } finally { this._cryptBusy = false; }
  }

  /** 删掉迁移/换口令时留下的明文备份（`.bak-crypt-*`） */
  cryptCleanBackups() {
    const r = this.store.cleanCryptBackups();
    log('[crypt] 已删除明文备份 ' + r.count + ' 个');
    return Object.assign({ ok: true, status: this.store.cryptStatus() }, r);
  }

  loadAll() {
    // 首次启动: 无实例 → 创建 default + 进入 setup 模式 (§3.3)
    if (!this.store.index.instances.length) {
      log('[init] 首次启动: 创建 default 实例并进入 setup 模式 (10 分钟内 POST /setup/admin 创建管理员, 仅 localhost)');
      this.store.createInstance('default', { listen: { port: Number(this.opts.port) || 16384, host: '0.0.0.0' } });
      this.store.armSetup();
    }
    for (const meta of this.store.index.instances) {
      const cfg = this.loadInstance(meta.uid);
      if (cfg) log('[pool] 实例 ' + meta.name + '(uid=' + meta.uid + ') 已加载 (' + cfg.channels.length + ' 渠道' + (cfg._disabled ? ', 已停用' : '') + ')');
    }
    this.reconcilePorts();
  }

  removeInstance(uid) {
    this.plugins.deactivateInstance(uid);
    this.pool.instances.delete(uid);
    this.reconcilePorts();
  }

  /* ---------- 端口管理 (UID 版 pool) ---------- */
  readTlsCfg(cfg) {
    if (!(cfg.tls && cfg.tls.enable)) return null;
    if (cfg._tlsCache) return cfg._tlsCache;
    const base = this.store.dir;
    const certPath = path.isAbsolute(cfg.tls.cert) ? cfg.tls.cert : path.join(base, String(cfg.tls.cert || 'cert.pem'));
    const keyPath = path.isAbsolute(cfg.tls.key) ? cfg.tls.key : path.join(base, String(cfg.tls.key || 'key.pem'));
    try {
      cfg._tlsCache = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), port: cfg.tls.port };
    } catch (e) {
      logErr('[pool] 实例 ' + cfg._name + ' TLS 证书读取失败(' + e.message + '), 该实例 HTTPS 端口跳过');
      return null;
    }
    return cfg._tlsCache;
  }

  desiredPorts() {
    const d = new Map();
    const defMeta = this.store.metaByName('default');
    if (!defMeta) return d;
    const def = this.pool.instances.get(defMeta.uid);
    if (!def) return d;
    const mainPort = def.listen.port;
    this.pool.mainPort = mainPort;
    this.pool.mainTlsPort = 0;
    this.pool.mainHost = def.listen.host || '0.0.0.0';
    const defTls = this.readTlsCfg(def);
    if (defTls && defTls.port == null) {
      d.set('https:' + mainPort, { uid: defMeta.uid, port: mainPort, tls: true, tlsCfg: defTls, main: true });
      this.pool.mainTlsPort = mainPort;
    } else {
      d.set('http:' + mainPort, { uid: defMeta.uid, port: mainPort, tls: false, main: true });
      if (defTls && defTls.port != null && defTls.port !== mainPort) {
        d.set('https:' + defTls.port, { uid: defMeta.uid, port: defTls.port, tls: true, tlsCfg: defTls, main: true });
        this.pool.mainTlsPort = defTls.port;
      }
    }
    for (const meta of this.store.index.instances) {
      if (meta.name === 'default' || meta.enabled === false) continue;
      const cfg = this.pool.instances.get(meta.uid);
      if (!cfg) continue;
      const p = cfg.listen.port;
      if (p && p !== mainPort && !d.has('http:' + p) && !d.has('https:' + p)) d.set('http:' + p, { uid: meta.uid, port: p, tls: false });
      const tc = this.readTlsCfg(cfg);
      if (tc && tc.port != null && tc.port !== mainPort && !d.has('http:' + tc.port) && !d.has('https:' + tc.port))
        d.set('https:' + tc.port, { uid: meta.uid, port: tc.port, tls: true, tlsCfg: tc });
    }
    return d;
  }

  reconcilePorts() {
    const desired = this.desiredPorts();
    for (const [key, srv] of [...this.pool.servers]) {
      if (!desired.has(key)) {
        this.pool.servers.delete(key);
        try { srv.server.close(); } catch (_) {}
        log('[pool] 端口 ' + srv.port + (srv.tls ? '(https)' : '') + ' 已关闭');
      }
    }
    for (const [key, dd] of desired) {
      if (this.pool.servers.has(key)) continue;
      let server;
      const handler = (req, res) => this.handleHttp(req, res);
      try {
        server = dd.tls ? https.createServer({ cert: dd.tlsCfg.cert, key: dd.tlsCfg.key }, handler) : http.createServer(handler);
      } catch (e) { logErr('[pool] 创建服务失败 ' + key + ': ' + e.message); continue; }
      server.on('error', e => logErr('[pool] 端口 ' + dd.port + ' 监听错误: ' + e.message));
      try {
        server.listen(dd.port, this.pool.mainHost, () => {
          const meta = this.store.meta(dd.uid);
          log('[pool] 监听 ' + (dd.tls ? 'https' : 'http') + ' :' + dd.port + (dd.main ? ' (主端口)' : ' → 实例 ' + (meta ? meta.name : dd.uid)));
        });
      } catch (e) { logErr('[pool] 端口 ' + dd.port + ' 监听失败: ' + e.message); continue; }
      this.pool.servers.set(key, { server, port: dd.port, tls: dd.tls, uid: dd.uid });
    }
    this.pool.portOwner = new Map();
    for (const dd of desired.values()) this.pool.portOwner.set(dd.port, dd.uid);
  }

  /* ---------- 路由: 端口直达 / 主端口 /实例名/ 前缀 / default ---------- */
  route(req, p) {
    const lp = req.socket && req.socket.localPort;
    if (lp && lp !== this.pool.mainPort && lp !== this.pool.mainTlsPort) {
      const uid = this.pool.portOwner.get(lp);
      if (uid != null) {
        const cfg = this.pool.instances.get(uid);
        const meta = this.store.meta(uid);
        if (cfg && meta) {
          if (cfg._disabled) return { error: '实例已停用: ' + meta.name, status: 503 };
          return { cfg, path: p, uid, name: meta.name, via: 'port' };
        }
      }
      return { error: '端口 ' + lp + ' 没有对应的实例', status: 404 };
    }
    const m = /^\/([A-Za-z0-9_-]{1,32})(?=\/|$)/.exec(p);
    if (m && !RESERVED_PATHS.has(m[1])) {
      const meta = this.store.metaByName(m[1]);
      if (!meta) return { error: '未知实例: ' + m[1] + ' (可用: ' + this.store.index.instances.map(x => x.name).join(', ') + ')', status: 404 };
      const cfg = this.pool.instances.get(meta.uid);
      if (!cfg) return { error: '实例配置损坏: ' + m[1] + ' (uid=' + meta.uid + ')', status: 503 };
      if (cfg._disabled) return { error: '实例已停用: ' + m[1], status: 503 };
      const rest = p.slice(m[1].length + 1) || '/';
      return { cfg, path: rest, uid: meta.uid, name: meta.name, via: 'path' };
    }
    const defMeta = this.store.metaByName('default');
    if (!defMeta) return { error: 'default 实例不存在', status: 503 };
    const cfg = this.pool.instances.get(defMeta.uid);
    if (!cfg) return { error: 'default 实例配置损坏', status: 503 };
    return { cfg, path: p, uid: defMeta.uid, name: 'default', via: 'default' };
  }

  /* ---------- 主请求分发 ---------- */
  /* ---------- 请求者身份（按用户隔离统计，2026-09-18） ---------- */
  /**
   * 从请求自带的凭证（Bearer 卡密 / ?key= / gatewayKey）解析出"这是哪个用户"。
   * ★只用于**展示层过滤**，不参与鉴权放行。
   * 返回三种情况：
   *   { keyId, name }  —— 认出了卡密用户
   *   { admin: true }  —— 网关密钥 / 免密部署（等价管理员，看全站）
   *   { denied: true } —— 带了无效凭证 / 部署要求凭证但没带 → **必须隐藏统计**，
   *                       绝不能退回全站视图（否则"卡密失效的用户"反而能看到别人的请求）
   */
  viewerScope(cfg, req, query) {
    try {
      const r = this.authChain.check(cfg, req, query);
      if (r && r.ok) {
        if (r.userKey) {
          const keyId = keyIdOf(r.userKey);
          if (keyId) return { keyId: keyId, name: keyNameOf(r.userKey) || String(r.userKey.name || '') };
          return { denied: true };
        }
        return { admin: true };
      }
      return { denied: true };
    } catch (_) { return { denied: true }; }
  }

  async handleHttp(req, res) {
    try {
      const u = new URL(req.url, 'http://localhost');
      let p = u.pathname;

      /* ===== setup 模式 (白名单, §3.3) ===== */
      if (this.store.isSetupMode()) {
        if (req.method === 'GET' && (p === '/health' || p === '/setup/status')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, setupMode: true, deadline: this.store.index.setupDeadline, hint: 'POST /setup/admin {adminKey} 创建管理员 (仅 localhost)' }));
        }
        // GET /admin 放行(页面内的 setup 引导表单调 /setup/admin); API 仍全部拦截
        if (req.method === 'GET' && (p === '/admin' || p === '/admin/')) {
          try {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(fs.readFileSync(path.join(__dirname, '..', 'web', 'admin.html'), 'utf8'));
          } catch (e) { return jsonErr(res, '管理页面缺失: web/admin.html', 404); }
        }
        if (req.method === 'GET' && p.startsWith('/admin/assets/')) return this.serveAdminAsset(req, res, p);
        if (req.method === 'POST' && p === '/setup/admin') return this.handleSetupAdmin(req, res);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'setup 模式: 请先创建管理员', setup: true, hint: 'POST /setup/admin {adminKey} (仅 localhost)' }));
      }

      /* ===== 多实例路由 ===== */
      const r = this.route(req, p);
      if (r.error) return sendError(null, 'openai', res, r.status || 404, r.error);
      let cfg = r.cfg;   /* let: 无前缀聚合路由可能在拿到 body 后切到别的实例 */
      p = r.path;
      /* ★兼容 RikkaHub 等 App 把余额查询拼到 /v1/credits → 归一到 /credits 顶层路由(2026-09-19) */
      if (req.method === 'GET' && p === '/v1/credits') p = '/credits';

      /* ===== 访问来源过滤 (accessGuard: 泄漏公网域名防护) =====
       *  cfg.accessGuard = { mode:'off'|'app'|'web', exemptPaths:[...], allowUA:[...] }
       *  mode='app': 只放行 App 客户端(UA 含 allowUA 关键字或带 X-GCUI-* 头), 浏览器 403;
       *  mode='web': 只放行浏览器; off=不过滤。exemptPaths 永远放行(管理面板等)。
       *  ★这是弱边界(UA/头可伪造), 防君子不防小人; 真要强就别开公网隧道。 */
      const ag = cfg.accessGuard;
      if (ag && ag.mode && ag.mode !== 'off') {
        const exempt = (ag.exemptPaths || ['/admin', '/health']).some(pp => p === pp || p.startsWith(pp + '/'));
        if (!exempt) {
          const ua = String(req.headers['user-agent'] || '');
          const isApp = (ag.allowUA || ['okhttp', 'dalvik', 'gaycore']).some(k => ua.toLowerCase().includes(String(k).toLowerCase())) || !!req.headers['x-gcui-version'];
          const isWeb = /mozilla/i.test(ua);
          const blocked = ag.mode === 'app' ? !isApp : (ag.mode === 'web' ? !isWeb : false);
          if (blocked) {
            const t = Date.now();
            if (!this._agLogAt || t - this._agLogAt > 60000) { this._agLogAt = t; try { this.log('[accessGuard] 拒绝 ' + req.method + ' ' + p + ' UA=' + ua.slice(0, 60) + ' (60s去重)'); } catch (_) {} }
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ error: '访问被拒绝: 此服务点仅允许 ' + (ag.mode === 'app' ? 'APP 客户端' : '网页端') + ' 访问' }));
          }
        }
      }
      req._uid = r.uid;
      req._branchName = r.name;

      /* 全局卡密分支白名单(插件注册, 防目标实例免密绕过): 卡在任何实例注册过且 branches 非空 → 只能访问白名单实例 */
      const presented = require('./auth').presentedToken(req, u.searchParams);
      if (presented) {
        const gk = this.plugins.globalKeys.get(presented);
        if (gk && gk.branches.length && !gk.branches.includes(r.name)) {
          return sendError(cfg, 'openai', res, 403, '此卡密不允许访问分组: ' + r.name + ' (可用: ' + gk.branches.join(', ') + ')');
        }
      }

      if (cfg.cors && req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(cfg)); return res.end(); }
      const se = (format, res2, status, msg, code) => sendError(cfg, format, res2, status, msg, code);

      /* ===== 健康/状态 ===== */
      if (req.method === 'GET' && p === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, version: CORE_VERSION, uptime: Math.round(process.uptime()) }));
      }
      /* ★用户端「使用」页(2026-09-18): 直接下发内核 gcui「使用统计」页(与 /admin/ui/usage 同款),
       *   用户端 App 的「使用」页用 SduiController 渲染它 → 两端一致、改页面不用重编 App。
       *   ★2026-09-18 按用户隔离: 页面只展示**请求者本人**的统计(scope) —— 以前这里忽略卡密,
       *   任何人打开都看到全站数据("另一个从没调用过的用户也能看到请求")。 */
      if (req.method === 'GET' && p === '/ui/usage') {
        try {
          /* ★2026-10-08 管理端语言设置: POST /admin/api/set-lang { lang } → 落盘 i18n prefs[本端 uid] */
          if (req.method === 'POST' && u.pathname === '/admin/api/set-lang') {
            let langBody = '';
            req.on('data', c => { langBody += u8(c); if (langBody.length > 1024 * 1024) req.destroy(); });
            req.on('error', () => {});
            req.on('end', () => {
              let b = {};
              try { b = JSON.parse(langBody || '{}'); } catch (_) {}
              const lang = String((b && b.lang) || '');
              if (!['zh-CN', 'en', 'zh-TW'].includes(lang)) { se('json', res, 400, '不支持的语言: ' + lang, 'BAD_LANG'); return; }
              try {
                const pc = this.store.getPluginConfig('i18n', cfg._uid, 'user') || {};
                pc.prefs = Object.assign({}, pc.prefs, { [String(cfg._uid)]: lang });
                this.store.setPluginConfig('i18n', cfg._uid, pc, 'user');
              } catch (e) { this.log('[admin] set-lang 落盘失败: ' + e.message); }
              res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(cfg) });
              res.end(JSON.stringify({ ok: true, toast: '已切换语言', lang }));
            });
            return;
          }
          /* ★必须走 adminUi.render(): 它会给页面加 `gcui` 版本字段(App 靠它判"是不是 gcui 页"),
           *   直接调 buildUsage() 会漏掉 gcui → App 报「不是 gcui 页面」(踩过)。 */
          const scope = this.viewerScope(cfg, req, u.searchParams);
          const caps = adminUi.parseCaps(req.headers);
          this.plugins.rememberCaps(cfg._uid, adminUi.capsView(caps));
          /* ★必须 await: render 对 async 页面返回 Promise(见 admin-ui.render 注释) */
          const page = (await adminUi.render(this, cfg, 'usage', u.searchParams, this.plugins.adminPages(cfg._uid), { base: '/ui/usage', admin: false, scope: scope, caps })) || {};

          /* ★2026-10-08 管理端语言设置(用户报「找不到设置语言的入口」——两端都没有):
             管理端内核页此前零语言 UI。治本 = /admin/api/set-lang 端点 + admin-ui.js 语言子页,
             落盘 i18n prefs[管理端 uid] → 所有内核页 bundle 跟着切(纯服务端, App 零参与)。 */
          page.gcui = page.gcui || adminUi.UI_VERSION;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(JSON.stringify(page));
        } catch (e) { return jsonErr(res, '生成页面失败: ' + e.message, 500); }
      }
      if (req.method === 'GET' && p === '/status') {
        /* ★安全: /status 不鉴权即可读(实例健康信息, 客户端/脚本在用), 但**渠道上游地址(baseUrl)
         *   与代理地址属于内部信息** —— 未带管理密钥的请求一律打码, 防止局域网里任何人枚举你的上游。
         *   带管理密钥(x-admin-key / Bearer adminKey / ?adminKey=)仍是原样返回。
         *   (实例没设 adminKey = 免密管理, 此时谁读都是"管理员", 不打码。) */
        const isAdmin = (() => {
          try { return !!this.authChain.checkAdmin(cfg, req, u.searchParams).ok; } catch (_) { return false; }
        })();
        const hide = (v) => (isAdmin || !v) ? v : '***';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true, version: CORE_VERSION, startedAt: cfg._stats.startedAt, uptime: Math.round(process.uptime()),
          uid: cfg._uid, name: cfg._name, listen: cfg.listen,
          redacted: !isAdmin,
          channels: cfg.channels.map(c => ({ name: c.name, type: c.type, baseUrl: hide(c.baseUrl), proxy: c.proxy || null, models: c.models, modelMap: c.modelMap, groups: c.groups || [], default: c.default, delayMs: c.delayMs || 0, useResponses: !!c.useResponses })),
          proxies: Object.entries(cfg.proxies || {}).map(([k, v]) => ({ name: k, type: v.type, host: hide(v.host), port: isAdmin ? v.port : (v.port ? 0 : v.port) })),
          stats: (() => {
            /* ★default 实例聚合全实例(§45): 跨实例路由的请求计入目标实例, default 自己的
             *   stats 会漏掉 → 用户端首页"请求趋势"读 /status.stats.hourly, 不聚合就恒 0 不变 */
            const isDef = cfg._name === 'default';
            const targets = isDef ? [...this.pool.instances.values()].filter(x => x) : [cfg];
            /* ★按用户隔离（2026-09-18）：/status 免鉴权可读，以前**连 stats.recent 一起返回**
             *   （里面有卡密名 keyName）→ 局域网内任何人不带密钥就能看到"谁在用、什么时候、什么模型"。
             *   现在：管理员 = 全站；带卡密的普通用户 = 只给自己那份（stats.byKey[<keyId>] + 过滤后的 recent）；
             *   认不出身份 = 统计为空（宁可不给，也不泄露他人）。 */
            const meScope = isAdmin ? null : this.viewerScope(cfg, req, u.searchParams);
            const meKey = (meScope && meScope.keyId) || '';
            const meAdmin = !!(meScope && meScope.admin);   /* gatewayKey / 免密部署 = 管理员语义 */
            const seeAll = isAdmin || meAdmin;
            let gReq = 0, gErr = 0; const allRecent = []; const byChMap = {};
            const addCh = (t, name, v) => {
              const key = (isDef && targets.length > 1) ? (t._name + ' / ' + name) : name;
              const dst = byChMap[key] || (byChMap[key] = { requests:0, inputTokens:0, outputTokens:0, cacheReadTokens:0, cacheWriteTokens:0 });
              dst.requests += v.requests||0; dst.inputTokens += v.inputTokens||0; dst.outputTokens += v.outputTokens||0;
              dst.cacheReadTokens += v.cacheReadTokens||0; dst.cacheWriteTokens += v.cacheWriteTokens||0;
            };
            for (const t of targets) {
              const s = (t && t._stats) || { requests:0, errors:0, byChannel:{}, recent:[] };
              if (meKey) {
                /* per-key 视图：累计量取 stats.byKey，明细取 recent 里 keyId 相同的那几条 */
                const b = (s.byKey || {})[meKey];
                if (b) {
                  gReq += b.requests || 0; gErr += b.errors || 0;
                  for (const [name, v] of Object.entries(b.byChannel || {})) addCh(t, name, v);
                }
                for (const r of (s.recent||[])) if (r.keyId === meKey) allRecent.push(isDef ? Object.assign({}, r, { instance: t._name }) : r);
                continue;
              }
              if (!seeAll) continue;   /* 非管理员又认不出身份 / 卡密无效 → 不给任何统计 */
              gReq += s.requests || 0; gErr += s.errors || 0;
              for (const [name, v] of Object.entries(s.byChannel || {})) addCh(t, name, v);
              for (const r of (s.recent||[])) allRecent.push(isDef ? Object.assign({}, r, { instance: t._name }) : r);
            }
            allRecent.sort((a,b) => { const ta = new Date(String(a.time||'').replace(' ','T')+'Z').getTime(); const tb = new Date(String(b.time||'').replace(' ','T')+'Z').getTime(); return (isNaN(ta)?0:ta) - (isNaN(tb)?0:tb); });
            const recent = allRecent.slice(-50);
            const now = Date.now();
            const bk = {};
            for (let h = 23; h >= 0; h--) { const ts = now - h*3600000; bk[h] = { hour: new Date(ts).toISOString().slice(0,13), count: 0, errors: 0 }; }
            for (const r of allRecent) {
              const rt = new Date(String(r.time||'').replace(' ','T')+'Z').getTime();
              if (isNaN(rt)) continue;
              const dh = Math.floor((now-rt)/3600000);
              if (dh>=0 && dh<24) { bk[dh].count++; if (r.status>=400) bk[dh].errors++; }
            }
            return { requests: gReq, errors: gErr, byChannel: byChMap, recent, hourly: Object.values(bk).reverse(), aggregated: isDef, scope: seeAll ? 'all' : (meKey ? 'me' : 'none') };
          })(),
          plugins: this.plugins.listForInstance(cfg._uid, cfg).map(x => ({ id: x.id, name: x.name, version: x.version, type: x.type, enable: x.enable, running: x.running })),
        }));
      }

      /* ===== Gay Core App: GET /api/app/bootstrap (公开, 聚合服务点资料/分支/插件公示/主题/布局) ===== */
      if (req.method === 'GET' && p === '/api/app/bootstrap') {
        return this.handleAppBootstrap(cfg, res);
      }

      /* ===== 用户端主题参数 (2026-09-16) =====
       * 主题参数按端分开存（_theme_user / _theme_admin）。管理端走 /admin/api/plugin-config，
       * 用户端没有对应入口 → 这里给它一条自己的读写通道（需卡密登录，放在实例上下文里，
       * 因为 /theme-config 不在 /admin/ 下，进不了 handleAdmin）。 */
      if (p === '/theme-config') {
        const authR = this.authChain.check(cfg, req, u.searchParams);
        if (!authR.ok) return sendError(cfg, 'openai', res, authR.status || 401, authR.error || 'unauthorized');
        const uid = Number(cfg._uid) || 0;
        const themes = this.plugins.themesForInstance(uid, cfg, 'user') || [];
        const jsonT = (code, obj) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(cfg) });
          res.end(JSON.stringify(obj));
        };
        if (req.method === 'GET') {
          const out = [];
          for (const t of themes) {
            const inst = this.plugins.installed.get(t.id);
            const schema = (inst && Array.isArray(inst.manifest.configSchema)) ? inst.manifest.configSchema : [];
            if (!schema.length) continue;   /* 没有可调参数的主题不列出 */
            out.push({ id: t.id, name: t.name, schema: schema, config: this.store.getPluginConfig(t.id, uid, 'user') || {} });
          }
          return jsonT(200, { ok: true, themes: out });
        }
        if (req.method === 'POST') {
          let raw = '';
          const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
          req.on('data', c => { raw += u8(c); if (raw.length > 1024 * 1024) req.destroy(); });
          req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch (_) { return jsonT(400, { error: 'bad json' }); }
            const tid = String(body.id || '');
            const conf = body.config;
            if (!tid || !conf || typeof conf !== 'object' || Array.isArray(conf)) return jsonT(400, { error: '需要 {id, config}' });
            if (!themes.some(t => t.id === tid)) return jsonT(404, { error: '没有这个主题插件: ' + tid });
            this.store.setPluginConfig(tid, uid, conf, 'user');
            this.audit(uid, 'theme.config.user', { id: tid });
            return jsonT(200, { ok: true, toast: '已保存，用户端配色已更新' });
          });
          req.on('error', () => {});
          return;
        }
        return jsonT(405, { error: 'Method Not Allowed' });
      }

      /* ===== admin 页面 + API ===== */
      if ((p === '/admin' || p === '/admin/') && req.method === 'GET') {
        try {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(fs.readFileSync(path.join(__dirname, '..', 'web', 'admin.html'), 'utf8'));
        } catch (e) { return jsonErr(res, '管理页面缺失: web/admin.html', 404); }
      }
      /* 用户中心(登录在页面内, API 各自鉴权) */
      if ((p === '/user' || p === '/user/') && req.method === 'GET') {
        try {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(fs.readFileSync(path.join(__dirname, '..', 'web', 'user.html'), 'utf8'));
        } catch (e) { return jsonErr(res, '用户页面缺失: web/user.html', 404); }
      }
      if (req.method === 'GET' && p.startsWith('/admin/assets/')) return this.serveAdminAsset(req, res, p);
      /* ===== 管理端 SDUI 页面 =====
       * 走**同一条管理鉴权链**（handleAdmin 内部 checkAdmin）——
       * 少了这一句，/admin/ui/* 会掉到后面的默认分支变成 404（踩过：带不带密钥都 404）。 */
      if (p.startsWith('/admin/ui')) {
        return this.handleAdmin(cfg, req, res, u, p, '').catch(e => jsonErr(res, e));
      }
      if (p.startsWith('/admin/api')) {
        if (req.method === 'POST' || req.method === 'DELETE') {
          let adminBody = '';
          const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
          req.on('data', c => { adminBody += u8(c); if (adminBody.length > 4 * 1024 * 1024) req.destroy(); });
          req.on('end', () => { this.handleAdmin(cfg, req, res, u, p, adminBody).catch(e => jsonErr(res, e)); });
          req.on('error', () => {});
        } else {
          return this.handleAdmin(cfg, req, res, u, p, '');
        }
        return;
      }

      /* ===== 插件分发 ===== */
      if (p === '/plugins' || p.startsWith('/plugins/')) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          this.plugins.handle(cfg, req, res, u, p, '').catch(e => jsonErr(res, e));
        } else {
          let pbody = '';
          const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
          req.on('data', c => { pbody += u8(c); if (pbody.length > 8 * 1024 * 1024) req.destroy(); });
          req.on('end', () => { this.plugins.handle(cfg, req, res, u, p, pbody).catch(e => jsonErr(res, e)); });
          req.on('error', () => {});
        }
        return;
      }

      /* ★加密锁定（密钥保险箱, 2026-09-18）：未解锁时渠道 apiKey/卡密表/管理员密钥**全是 AGWENC1 密文**，
       *  常规鉴权必然失败（卡片查不到 → 一片 401 invalid key）。所以这里对**所有 /v1 上游端点**
       *  （含 /v1/models 与 /v1beta/*）统一给 503 + 可行动的提示。/api/app/models、/plugins/*、
       * 全部管理端点与 /auth/* /credits 不受影响 —— 解锁通道必须留着。 */
      if (this.store.locked && (p === '/v1' || p.startsWith('/v1/') || p.startsWith('/v1beta/'))) {
        return se(p.startsWith('/v1beta') ? 'gemini' : 'openai', res, 503,
          '网关已锁定：渠道密钥处于加密状态，请在 Gay Core「密钥保险箱」里解锁后重试');
      }

      /* ===== 插件注册的扩展端点 (registerExtraEndpoint) ===== */
      const extraKey = req.method.toUpperCase() + ' ' + p;
      const extra = this.plugins.extraEndpoints.get(extraKey);
      if (extra && extra.uid === cfg._uid) {
        this.plugins.maybeReloadData(extra.pluginId, extra.uid);   /* ★运行数据多实例一致性(2026-09-18) */
        const authR = this.authChain.check(cfg, req, u.searchParams);
        if (!authR.ok) return se('openai', res, authR.status || 401, authR.error || 'invalid key');
        const chunks = [];
        let size = 0, aborted = false;
        req.on('data', c => {
          if (aborted) return;
          size += c.length;
          if (size > cfg.maxBodyBytes) { aborted = true; req.destroy(); se('openai', res, 413, 'request body too large'); return; }
          chunks.push(c);
        });
        req.on('end', () => {
          if (aborted) return;
          Promise.resolve(extra.handler({ cfg, req, res, body: Buffer.concat(chunks), contentType: req.headers['content-type'] || '', query: u.searchParams, userKey: authR.userKey || null, gateway: this.gatewayApi(cfg) }))
            .catch(e => { logErr('[extra]', e.message); if (!res.headersSent) jsonErr(res, e); });
        });
        req.on('error', () => {});
        return;
      }

      /* ===== 插件顶层路由 (auth 插件: /credits /auth/* 等) ===== */
      const topHit = this.plugins.topRoutes.get(cfg._uid + '|' + req.method.toUpperCase() + ' ' + p);
      if (topHit && topHit.uid === cfg._uid) {
        this.plugins.maybeReloadData(topHit.pluginId, topHit.uid);   /* ★运行数据多实例一致性(2026-09-18) */
        const bodyChunks = [];
        let tsize = 0, taborted = false;
        req.on('data', c => {
          if (taborted) return;
          tsize += c.length;
          if (tsize > 2 * 1024 * 1024) { taborted = true; req.destroy(); }
          bodyChunks.push(c);
        });
        req.on('end', () => {
          if (taborted) return;
          const bodyStr = Buffer.concat(bodyChunks).toString('utf8');
          Promise.resolve(topHit.handler({
            cfg, req, res, query: u.searchParams,
            body: (() => { try { return JSON.parse(bodyStr || '{}'); } catch (_) { return null; } })(),
            rawBody: bodyStr,
            auth: (c2, rq) => this.authChain.check(c2 || cfg, rq || req, u.searchParams),
            gateway: this.gatewayApi(cfg),
          })).catch(e => { logErr('[toproute]', e.message); if (!res.headersSent) jsonErr(res, e); });
        });
        req.on('error', () => {});
        return;
      }

      /* ===== 模型列表 ===== */
      if (req.method === 'GET' && (p === '/v1/models' || p === '/v1beta/models')) {
        const fmt = p === '/v1beta/models' ? 'gemini' : 'openai';
        const authR = this.authChain.check(cfg, req, u.searchParams);
        if (!authR.ok) return se(fmt, res, authR.status || 401, authR.error || 'invalid key');
        /* 无前缀(via=default) = 聚合模式: 返回所有实例的模型并集(受卡密实例/分组/模型白名单裁剪);
         * 带实例前缀(/Abc/v1/models) 仍只返回该实例的模型。 */
        const agg = r.via === 'default' && cfg.aggregate !== false;
        /* ★id 形态（2026-09-18）：同名冲突的模型用 `实例:渠道:模型名`，其余原名；
         *   卡密白名单里写原名或复合名都能命中（modelref.filterEntries）。 */
        const cfgs = agg ? this.aggregateInstanceCfgs(authR.userKey) : [cfg];
        const refs = this.modelRefs(cfgs);
        let ms = modelref.filterEntries(refs.entries, authR.userKey, this.groupIndex()).map(e => e.id);
        /* 兜底：一个都没算出来(极端情况)时退回旧的按名去重，别让客户端拿到空清单 */
        if (!ms.length && cfgs.length) {
          const seen = [];
          for (const c of cfgs) for (const m of collectModels(c)) if (!seen.includes(m)) seen.push(m);
          ms = this.filterModelsFor(seen, authR.userKey);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(cfg) });
        return res.end(JSON.stringify(modelsResponseFrom(ms, fmt)));
      }

      /* ===== 免登录: GET /api/app/models (公开模型清单, 供游客浏览站点与模型广场) =====
       * 只返回 模型名/分组/别名/所属实例 —— 不含 baseUrl / apiKey / 价格等敏感信息。 */
      if (req.method === 'GET' && p === '/api/app/models') {
        return this.handlePublicModels(cfg, res);
      }

      /* ===== 转发端点 ===== */
      if (req.method !== 'POST') return se('openai', res, 404, 'not found: ' + req.method + ' ' + p);

      let clientFormat = null;
      let clientApi = 'chat';
      const urlInfo = { model: null, altSse: false };
      if (p === '/v1/chat/completions' || p === '/chat/completions') clientFormat = 'openai';
      else if (p === '/v1/messages' || p === '/messages') clientFormat = 'claude';
      else if (p === '/v1/responses') { clientFormat = 'openai'; clientApi = 'responses'; }
      else {
        const m = GEMINI_RE.exec(p);
        if (m) {
          clientFormat = 'gemini';
          urlInfo.model = decodeURIComponent(m[1]);
          urlInfo.altSse = u.searchParams.get('alt') === 'sse';
          urlInfo.stream = m[2] === 'streamGenerateContent';
          if (m[2] === 'countTokens') return se('gemini', res, 501, 'countTokens is not supported by this gateway');
        }
      }
      if (!clientFormat) return se('openai', res, 404, 'unknown endpoint: ' + p + ' (支持: /v1/chat/completions | /v1/messages | /v1/responses | /v1beta/models/{model}:generateContent|:streamGenerateContent)');

      const authR = this.authChain.check(cfg, req, u.searchParams);
      if (!authR.ok) return se(clientFormat, res, authR.status || 401, authR.error || 'invalid key');
      urlInfo.userKey = authR.userKey || null;

      let bodyStr = '';
      let size = 0, aborted = false;
      const u8 = utf8();   /* ★跨分块安全解码(2026-09-18)：请求体跨包切断会让 prompt 变乱码 */
      req.on('data', c => {
        if (aborted) return;
        size += c.length;
        if (size > cfg.maxBodyBytes) { aborted = true; req.destroy(); se(clientFormat, res, 413, 'request body too large (>' + cfg.maxBodyBytes + ' bytes)'); return; }
        bodyStr += u8(c);
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          /* ★模型引用「实例:渠道:模型」(2026-09-18): 同名冲突时客户端用它精确指定来源。
           *  解析成功且"该实例有这个渠道、该渠道确实提供这个模型" → 换实例 + 锁定渠道 + 真名进下游;
           *  解析失败不报错, 当普通模型名照旧处理(最终由路由决定, 可能 503 no channel)。 */
          let wantPlain = modelFromBody(urlInfo, bodyStr);
          if (wantPlain) {
            const ref = modelref.parseRef(wantPlain);
            if (ref) {
              let tgt = null;
              for (const [, c] of this.pool.instances) {
                if (!c || !modelref.channelMatch(ref.instance, c._name)) continue;   /* 实例名同样容许 空格/连字符/大小写 差异 */
                const okBranch = !authR.userKey || !Array.isArray(authR.userKey.branches) || !authR.userKey.branches.length
                  || authR.userKey.branches.includes(c._name);
                if (!c._disabled && okBranch) tgt = c;
                break;
              }
              let hit = null;
              if (tgt) {
                for (const ch of (tgt.channels || [])) {
                  if (!ch || !ch.name || !modelref.channelMatch(ref.channel, ch.name)) continue;
                  const mm = (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {};
                  if (Object.prototype.hasOwnProperty.call(mm, ref.model)
                    || (Array.isArray(ch.models) && ch.models.includes(ref.model))) { hit = ch; break; }
                }
              }
              if (tgt && hit) {
                if (cfg !== tgt) log('[ref] ' + wantPlain + ' → 实例 ' + tgt._name + ' / 渠道 ' + hit.name);
                cfg = tgt;
                req._uid = tgt._uid;
                req._branchName = tgt._name;
                urlInfo.forceChannel = String(hit.name);   /* 锁定渠道(不走轮转/兜底) */
                urlInfo.modelOverride = ref.model;         /* 计费/日志/分组用真名 */
                urlInfo.rawModel = wantPlain;
                wantPlain = ref.model;
              } else {
                log('[ref] 引用无法解析(实例/渠道/模型不匹配), 当普通模型名处理: ' + wantPlain);
              }
            }
          }
          /* ---- 无前缀聚合兜底: default 实例提供不了该模型时, 去其它实例找 ---- */
          if (r.via === 'default' && cfg.aggregate !== false) {
            const want = wantPlain;
            if (want && !collectModels(cfg).includes(want)) {
              const gk = presented ? this.plugins.globalKeys.get(presented) : null;
              const alt = this.findInstanceForModel(want, authR.userKey);
              if (alt && (!gk || !gk.branches.length || gk.branches.includes(alt._name))) {
                log('[agg] 模型 ' + want + ' 不在 default, 改由实例 ' + alt._name + ' 处理');
                cfg = alt;
                req._uid = alt._uid;
                req._branchName = alt._name;
              }
            }
          }
          router.handleChat(cfg, clientFormat, clientApi, req, res, urlInfo, bodyStr, this.plugins.hooksFor(cfg._uid), se);
        } catch (e) {
          logErr('chat crash:', e);
          se(clientFormat, res, 500, 'internal: ' + e.message);
        }
      });
      req.on('error', () => {});
    } catch (e) {
      logErr('handler crash:', e);
      sendError(null, 'openai', res, 500, 'internal: ' + (e && e.message));
    }
  }

  /* ---------- setup: POST /setup/admin ---------- */
  handleSetupAdmin(req, res) {
    if (!isLocalhost(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'setup 仅允许 localhost 调用' }));
    }
    let body = '';
    const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
    req.on('data', c => { body += u8(c); if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        const adminKey = String(j.adminKey || '').trim();
        if (adminKey.length < 8) return jsonErr(res, 'adminKey 至少 8 位', 400);
        const defMeta = this.store.metaByName('default');
        if (!defMeta) return jsonErr(res, 'default 实例不存在', 500);
        const cfg = this.store.loadInstance(defMeta.uid);
        cfg.adminKey = adminKey;
        if (j.gatewayKey) cfg.gatewayKey = String(j.gatewayKey);
        this.store.saveInstance(defMeta.uid, cfg);
        this.store.completeSetup();
        this.loadInstance(defMeta.uid);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: '管理员已创建, setup 模式已关闭', uid: defMeta.uid }));
        log('[setup] 管理员已创建, setup 模式关闭');
      } catch (e) { jsonErr(res, e, 400); }
    });
    req.on('error', () => {});
  }

  /* 插件用的网关能力 (findKey/grantQuota 由认证插件 bindGatewayAuthApis 提供) */
  gatewayApi(cfg) {
    return { uid: cfg._uid, instanceName: cfg._name, store: this.store, gateway: this };
  }

  /* ---------- 审计日志 (Gay Core §14: log/audit-<uid>.jsonl; uid=0 表示全局动作) ---------- */
  audit(uid, action, detail) {
    try {
      const dir = path.join(this.store.dir, 'log');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'audit-' + uid + '.jsonl'),
        JSON.stringify({ ts: new Date().toISOString(), action, ...(detail || {}) }) + '\n');
    } catch (_) {}
  }

  /* ---------- Gay Core: App 启动聚合信息 (公开; 只含公示级字段, 无秘密) ---------- */
  /* 内部自调：把请求打到**本实例自己的监听端口**（管理端页面里的「探测成功率 / 同步模型 / 查余额」用）
   * 为什么需要：这些能力在插件里，而插件路由不在 /admin/ 前缀下 —— SDUI 的 adminApi 白名单不放行，
   * 所以由内核代为调用（仍然带 adminKey，权限不放大）。
   * 实例未监听（端口 0）或超时 → resolve(null)，调用方按"插件未响应"处理。 */
  selfReq(cfg, method, path, body, timeoutMs) {
    return new Promise(resolve => {
      /* ★改走主端口：以前用 cfg.listen.port，但 ①port=0 的实例直接 null → '插件未启用'
       *  ②port 撞旧版网关(如 16384) → 连到旧版 → '未发现实例'。主端口+路径前缀对所有实例都通。 */
      const port = this.pool.mainPort;
      if (!port) return resolve(null);
      const data = body ? JSON.stringify(body) : null;
      let req;
      try {
        req = http.request({
          host: '127.0.0.1', port, path, method,
          headers: Object.assign(
            { 'x-admin-key': cfg.adminKey || '', Accept: 'application/json' },
            data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
          ),
        }, res => {
          let s = '';
          res.on('data', d => { s += d; });
          res.on('end', () => { try { resolve(JSON.parse(s)); } catch (_) { resolve(null); } });
        });
      } catch (_) { return resolve(null); }
      req.setTimeout(timeoutMs || 2500, () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      if (data) req.write(data);
      req.end();
    });
  }

  handleAppBootstrap(cfg, res) {
    const uid = cfg._uid;
    const list = this.plugins.listForInstance(uid, cfg);
    const enabled = list.filter(x => x.enable);
    const has = id => enabled.some(x => x.id === id);
    /* 注册配置公示 (secret 字段绝不外泄)
     * ★2026-10-07 去硬编码: 以前是 has('auth-user') + getPluginConfig('auth-user', uid) ——
     *   内核必须知道"注册功能由 auth-user 提供"。现在改成问能力 user-registration,
     *   任何插件提供它都能顶上。★下发的字段形状与旧版逐字段一致(App 的 RegistrationInfo 契约不变)。 */
    let registration = null;
    try {
      const regCap = this.plugins ? this.plugins.requireCapability(uid, 'user-registration') : null;
      if (regCap && typeof regCap.info === 'function') registration = regCap.info() || null;
    } catch (_) { registration = null; }
    /* ★主题插件默认读**用户端**那份（bootstrap 是用户端拿的）；管理端在 plugin-config 里显式要 admin */
    let themes = this.plugins.themesForInstance(uid, cfg, 'user');
    /* ★声明式兜底(2026-10-07): 内核不再点名 theme-md3 ——
     *  只要列表里**没有任何默认主题**(manifest.theme.default), 就补内核兜底主题。
     *  这样把默认主题换成别的插件, 内核不需要改一行。 */
    if (!themes.some(t => t && (t.isDefault === true))) themes = [FALLBACK_THEME].concat(themes);
    /* 用户调试模式 (§15): 限定单用户 + 限时自动失效 */
    const ud = cfg.userDebug;
    const userDebug = (ud && ud.uid && Number(ud.until) > Date.now()) ? { forUid: String(ud.uid), until: Number(ud.until) } : null;
    const body = {
      ok: true, core: CORE_VERSION, appApi: 1,
      branch: cfg._name, uid,
      serverInfo: this.store.getServerInfo(),
      userDebug,
      layout: (cfg.clientLayout && typeof cfg.clientLayout === 'object') ? cfg.clientLayout : null,
      /* 管理端 SDUI 页面注册点（旧版 App 会忽略该字段，行为完全不变） */
      adminUi: adminUi.manifest(this.plugins.adminPages(uid)),
      /* 本实例已注册的能力总表 [{name, pluginId}] —— 插件可据此决定降级/启用某功能 */
      capabilities: this.plugins.listCapabilities(uid),
      branches: this.store.index.instances.filter(mm => mm.enabled !== false).map(mm => ({ name: mm.name, uid: mm.uid })),
      auth: { cardkey: has('auth-cardkey'), user: has('auth-user'), gatewayKey: !!cfg.gatewayKey, registration },
      themes,
      plugins: enabled.map(x => ({
        id: x.id, name: x.name, version: x.version, author: x.author, description: x.description,
        icon: x.icon, type: x.type, builtin: x.builtin, sha256: x.sha256,
        permissions: x.permissions, provides: x.provides, appUi: x.appUi,
        /* ★运行期能力清单(2026-10-07): 与静态 provides 分开 —— provides 是"意图声明",
         *  这里是"当前真注册了什么"。App/插件据此自检"我要的能力有没有提供方"。 */
        capabilities: x.capabilities || [],
        userPage: x.userPage, hasAdminPage: x.hasAdminPage,
      })),
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(cfg) });
    res.end(JSON.stringify(body));
  }

  /* GET /api/app/models → 免登录公开模型清单 (游客浏览模型广场用)
   * 安全: 只暴露 模型名/分组/别名/所属实例 —— 不含 baseUrl / apiKey / 价格。 */
  handlePublicModels(cfg, res) {
    const gi = this.groupIndex();
    const seen = new Map();
    const instNames = [];
    for (const [, c] of this.pool.instances) {
      if (!c || c._disabled) continue;
      instNames.push(c._name);
      for (const ch of (c.channels || [])) {
        if (!ch || !ch.name) continue;
        const mm = (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {};
        const names = [];
        for (const m of (Array.isArray(ch.models) ? ch.models : [])) if (m) names.push(String(m));
        for (const k of Object.keys(mm)) if (k) names.push(String(k));
        for (const n of names) {
          let e = seen.get(n);
          if (!e) { e = { name: n, alias: '', instances: [], channels: [], groups: [], channel: ch.name || '' }; seen.set(n, e); }
          if (c._name && !e.instances.includes(c._name)) e.instances.push(c._name);
          if (ch.name && !e.channels.includes(ch.name)) e.channels.push(ch.name);
          const gs = gi.groupsOf(n);
          for (const g of gs) if (!e.groups.includes(g)) e.groups.push(g);
        }
      }
    }
    const models = [...seen.values()].map(m => Object.assign({}, m, { group: m.groups[0] || modelgroups.DEFAULT_GROUP }));
    const body = {
      ok: true, branch: cfg._name,
      serverInfo: this.store.getServerInfo(),
      groups: gi.allGroups(models.map(m => m.name)),
      instances: instNames,
      models,
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(cfg) });
    res.end(JSON.stringify(body));
  }

  /* GET /admin/assets/<file> → web/assets/ 下的静态资源 (字体/组件库, 无敏感数据, 不鉴权) */
  serveAdminAsset(req, res, p) {
    const rel = decodeURIComponent(p.replace(/^\/admin\/assets\//, '')).replace(/^\/+/, '');
    const base = path.join(__dirname, '..', 'web', 'assets');
    const fp = path.normalize(path.join(base, rel));
    if (!fp.startsWith(base) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); return res.end('Not Found'); }
    const ext = path.extname(fp).toLowerCase();
    const mime = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
    res.end(fs.readFileSync(fp));
  }

  /* ---- 插件市场索引 (全局, data/market-indexes.json) ---- */
  marketIndexes() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.store.dir, 'market-indexes.json'), 'utf8'));
      return Array.isArray(j.indexes) ? j.indexes : [];
    } catch (_) { return []; }
  }
  saveMarketIndexes(list) {
    const fp = path.join(this.store.dir, 'market-indexes.json');
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ indexes: list }, null, 2));
    fs.renameSync(tmp, fp);
  }

  /* ---------- admin API 最小集 ---------- */
  async handleAdmin(cfg, req, res, u, p, body) {
    const authR = this.authChain.checkAdmin(cfg, req, u.searchParams);
    if (!authR.ok) return sendError(cfg, 'openai', res, authR.status || 401, authR.error || 'unauthorized');
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...corsHeaders(cfg) }); res.end(JSON.stringify(obj)); };
    const j = () => { try { return JSON.parse(body || '{}'); } catch (_) { return null; } };

    /* ===== 管理端 SDUI 页面（gcui JSON, 2026-09-15）=====
     * App 的管理端内核页从这里拉页面；渲染/加载失败时 App 会自动回退到原生页。
     * 只读 GET：页面里的写操作走 App 的 adminApi 动作回打 /admin/api/**，仍然过 checkAdmin。 */
    if (p.startsWith('/admin/ui/') && req.method === 'GET') {
      const name = p.slice('/admin/ui/'.length).replace(/[^a-zA-Z0-9-]/g, '');
      /* ★能力协商(2026-10-07): 按 App 上报的 X-GCUI-* 头裁剪页面(网页端不带头 → 不裁剪) */
      const caps = adminUi.parseCaps(req.headers);
      /* ★先记录本次请求的能力 —— ★存的是 **capsView 视图**(带 hasComponent/hasIcon 方法),
       *  因为插件页 render 的第4参数与 ctx.clientCaps() 读的就是它。
       *  (内核出口的 negotiate 用的是原始 caps, 两套各司其职; 踩过: 存原始 caps 会让插件报
       *   "caps.hasComponent is not a function"。) */
      this.plugins.rememberCaps(cfg._uid, adminUi.capsView(caps));
      /* ★必须 await：渠道页要等插件（探测成功率）返回后才成形 */
      const page = await adminUi.render(this, cfg, name, u.searchParams, this.plugins.adminPages(cfg._uid), { base: '/admin/ui/' + name, admin: true, caps });
      if (!page) return json(404, { error: '没有这个管理端页面: ' + name });
      return json(200, page);
    }

    if (p === '/admin' || p === '/admin/api/status') {
      /* ★default 实例概览也显示全实例聚合(§45): 跨实例路由的请求计入目标实例,
         default 自己的计数会漏掉它们, 概览里 default 用聚合避免"没统上"误判 */
      let totalReq = 0, totalErr = 0;
      for (const [, ic] of this.pool.instances) { const s = ic && ic._stats; if (s) { totalReq += s.requests || 0; totalErr += s.errors || 0; } }
      return json(200, {
        ok: true, version: CORE_VERSION,
        instances: this.store.index.instances.map(m => {
          const isDef = m.name === 'default';
          return {
            uid: m.uid, name: m.name, port: m.port, enabled: m.enabled !== false,
            running: this.pool.instances.has(m.uid),
            requests: isDef ? totalReq : ((this.pool.instances.get(m.uid) || {})._stats ? this.pool.instances.get(m.uid)._stats.requests : 0),
            errors: isDef ? totalErr : ((this.pool.instances.get(m.uid) || {})._stats ? this.pool.instances.get(m.uid)._stats.errors : 0),
            aggregated: isDef,
          };
        }),
        mainPort: this.pool.mainPort, mainTlsPort: this.pool.mainTlsPort,
      });
    }

    let m;
    /* ---- Gay Core: 实例完整统计 (含 recent/byChannel/时间序列, 供图表用) ---- */
    if ((m = /^\/admin\/api\/stats\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const uidS = Number(m[1]);
      const ic = this.pool.instances.get(uidS);
      if (!ic) return json(404, { error: '实例未运行或不存在' });
      /* ★default 实例默认聚合所有实例数据(2026-09-18): 跨实例路由(§35 复合引用)把请求计入
       *   目标实例(req._uid=tgt._uid), 导致从 default 的统计页看不到这些请求(用户曾误判
       *   "流量没过 core"). 查询 default 时聚合全部运行中实例的 recent/byChannel/hourly/计数,
       *   并在 recent 每条补 instance 字段区分来源; 非 default 实例行为不变. */
      const idxEntry = this.store.index.instances.find(x => x.uid === uidS);
      const isDefault = !!(idxEntry && idxEntry.name === 'default');
      const targets = isDefault ? [...this.pool.instances.values()].filter(x => x) : [ic];
      let gReq = 0, gErr = 0; const allRecent = []; const byChMap = {};
      for (const t of targets) {
        const s = (t && t._stats) || { requests:0, errors:0, byChannel:{}, recent:[] };
        gReq += s.requests || 0; gErr += s.errors || 0;
        for (const [name, v] of Object.entries(s.byChannel || {})) {
          const key = (isDefault && targets.length > 1) ? (t._name + ' / ' + name) : name;
          const dst = byChMap[key] || (byChMap[key] = { requests:0, inputTokens:0, outputTokens:0, cacheReadTokens:0, cacheWriteTokens:0 });
          dst.requests += v.requests||0; dst.inputTokens += v.inputTokens||0; dst.outputTokens += v.outputTokens||0;
          dst.cacheReadTokens += v.cacheReadTokens||0; dst.cacheWriteTokens += v.cacheWriteTokens||0;
        }
        for (const r of (s.recent||[])) allRecent.push(isDefault ? Object.assign({}, r, { instance: t._name }) : r);
      }
      allRecent.sort((a,b) => {
        const ta = new Date(String(a.time||'').replace(' ','T')+'Z').getTime();
        const tb = new Date(String(b.time||'').replace(' ','T')+'Z').getTime();
        return (isNaN(ta)?0:ta) - (isNaN(tb)?0:tb);
      });
      const recent = allRecent.slice(-50);
      const buckets = {};
      const now = Date.now();
      for (let h = 23; h >= 0; h--) {
        const ts = now - h * 3600000;
        const key = new Date(ts).toISOString().slice(0,13);
        buckets[h] = { hour: key, count: 0, errors: 0 };
      }
      for (const r of allRecent) {
        const rt = new Date(String(r.time||'').replace(' ','T')+'Z').getTime();
        if (isNaN(rt)) continue;
        const diffH = Math.floor((now - rt) / 3600000);
        if (diffH >= 0 && diffH < 24) {
          buckets[diffH].count++;
          if (r.status >= 400) buckets[diffH].errors++;
        }
      }
      const byChannel = Object.entries(byChMap)
        .map(([name, v]) => ({ name, requests: v.requests||0, inputTokens: v.inputTokens||0, outputTokens: v.outputTokens||0 }))
        .sort((a,b) => b.requests - a.requests);
      return json(200, {
        ok: true, uid: uidS, name: ic._name,
        startedAt: ic._stats && ic._stats.startedAt, uptime: Math.round(process.uptime()),
        requests: gReq, errors: gErr,
        recent, byChannel,
        hourly: Object.values(buckets).reverse(),
        aggregated: isDefault,
      });
    }
    /* ---- Gay Core: 审计日志读取 (最近 limit 条, 默认 50) ---- */
    if ((m = /^\/admin\/api\/audit\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const uid3 = Number(m[1]);
      const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 500);
      const f = path.join(this.store.dir, 'log', 'audit-' + uid3 + '.jsonl');
      let lines = [];
      try {
        lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      } catch (_) {}
      return json(200, { ok: true, uid: uid3, entries: lines.reverse() }); // 新→旧
    }
    /* ---- Gay Core: 服务点资料 (全局, 存 instances.json) ---- */
    if (p === '/admin/api/server-info') {
      if (req.method === 'GET') return json(200, { ok: true, serverInfo: this.store.getServerInfo() });
      if (req.method === 'POST') {
        const data = j();
        if (!data || typeof data !== 'object') return json(400, { error: 'bad json' });
        const si = this.store.saveServerInfo(data);
        this.audit(0, 'serverInfo.save', { name: si.name || '' });
        return json(200, { ok: true, serverInfo: si });
      }
    }
    /* POST /admin/api/plugin-call {plugin, path, method, body}
     * —— 内核代调**插件**的管理端点（用户/卡密/模型同步/探测/余额/代理）。
     * 为什么需要：这些端点在 /plugins/<id>/admin/* 下，不在 SDUI 的 adminApi 白名单(/admin/)内。
     * ★2026-10-07 深度改造: 原来是一张写死 9 个插件名的常量表 PLUGIN_CALL_OK ——
     *   内核因此**必须知道每个插件叫什么**, 装第 10 个插件想代调就得改内核源码 + 重启。
     *   现在改成**声明式**: 插件在自己的 manifest.json 里声明 `"adminApi": ["/admin/keys"]`,
     *   内核只按声明放行, 永不按插件名判断(插件自报家门, 内核不认名字)。
     * 安全：①插件必须在 manifest 显式声明可代调 ②只放行其声明的 /admin/ 子路径前缀
     *   ③仍然带 adminKey（权限不放大）④声明为空/未声明 → 一律 403。 */
    if (p === '/admin/api/plugin-call' && req.method === 'POST') {
      const d = j() || {};
      const pid = String(d.plugin || '');
      /* 声明式查表: manifest.adminApi (数组)。兼容旧内置插件: 未声明但属于历史白名单的,
       * 由各自的 manifest 补上声明 —— 内核不再保留任何插件名常量。 */
      const decl = this.plugins.adminApiDecl(pid, cfg._uid);
      if (!decl) return json(403, { error: '不允许代调该插件: ' + pid + '（未在 manifest 声明 adminApi）' });
      const sub = String(d.path || '');
      if (sub.indexOf('/admin/') !== 0) return json(403, { error: '只允许代调插件的 /admin/ 端点' });
      /* 路径也要落在声明范围内: decl 是前缀数组, 空数组 = 声明了但禁止(等价 403) */
      if (!decl.some(pre => sub === pre || sub.indexOf(pre.replace(/\/$/, '') + '/') === 0 || sub.indexOf(pre) === 0)) {
        return json(403, { error: '该插件未声明可代调此路径: ' + sub });
      }
      const c = this.store.loadInstance(cfg._uid);
      if (!c) return json(404, { error: '实例不存在' });
      const prefix = (c._name && c._name !== 'default') ? '/' + c._name : '';
      const r = await this.selfReq(
        c, String(d.method || 'GET').toUpperCase(),
        prefix + '/plugins/' + pid + sub, d.body || null, 10000,
      );
      if (r == null) return json(502, { error: '插件没有响应（未启用，或该实例未运行）' });
      /* ★归一化 error：插件的错误响应可能是 OpenAI 风格 {error:{message,type,code}} 或 {error:'字符串'}。
       *  App 的 SduiController.adminApi 用 .asString 取 error —— 遇到 JsonObject 会抛
       *  UnsupportedOperationException("JsonObject") → 管理端只显示 "JsonObject" 三个字。
       *  这里统一拍平成字符串，App 就能正确显示错误信息了。 */
      const flat = Object.assign({ ok: true }, r);
      if (flat.error && typeof flat.error === 'object') {
        flat.error = flat.error.message || flat.error.error || JSON.stringify(flat.error);
      }
      if (flat.toast && typeof flat.toast === 'object') {
        flat.toast = flat.toast.message || JSON.stringify(flat.toast);
      }
      return json(200, flat);
    }
    /* POST /admin/api/notice {op:'add'|'edit'|'delete', idx?, body?, target?, timed?}
     * —— 公告存在 serverInfo.announcement 这**一个字符串**里（一行一条，格式与 App 的 Notices.kt 一致）。
     * 服务端负责解析 → 改写 → 回存，避免 App 端拼字符串出错。 */
    if (p === '/admin/api/notice' && req.method === 'POST') {
      const d = j() || {};
      const op = String(d.op || '');
      const si = this.store.getServerInfo() || {};
      const list = adminUi.noticeParse(si.announcement);
      if (op === 'add') {
        const body = String(d.body || '').trim();
        if (!body) return json(400, { error: '内容不能为空' });
        const timed = d.timed === true || d.timed === 'true';
        const target = String(d.target || '').trim();
        list.push({ time: timed ? adminUi.nowStamp() : '', target: target, body: body });
      } else if (op === 'edit') {
        const i = Number(d.idx);
        if (!(i >= 0 && i < list.length)) return json(404, { error: '这条公告不存在' });
        const body = String(d.body || '').trim();
        if (!body) return json(400, { error: '内容不能为空' });
        list[i].body = body;
      } else if (op === 'delete') {
        const i = Number(d.idx);
        if (!(i >= 0 && i < list.length)) return json(404, { error: '这条公告不存在' });
        list.splice(i, 1);
      } else {
        return json(400, { error: '未知操作: ' + op });
      }
      const text = adminUi.noticeEncode(list);
      if (text.length > 2000) return json(400, { error: '公告总长超过 2000 字（当前 ' + text.length + '）' });
      si.announcement = text;
      this.store.saveServerInfo(si);
      this.audit(0, 'notice.' + op, { count: list.length });
      return json(200, { ok: true, toast: '公告已更新（共 ' + list.length + ' 条）' });
    }
    /* ---- Gay Core: 修改管理密钥 (2026-09-16) ----
     * 安全设计: ①本请求本身已过 checkAdmin(带的就是当前密钥) ②仍要求 body 再给一次当前密钥
     *   (二次确认, 防"手滑改完把自己锁在外面") ③新密钥 ≥8 位且不能与当前相同。
     * ★改完后 App 必须同步更新本地保存的密钥(客户端已实现), 否则下次进不来管理端。 */
    if (p === '/admin/api/settings/admin-key' && req.method === 'POST') {
      const data = j() || {};
      const oldKey = String(data.oldKey || '');
      const newKey = String(data.newKey || '').trim();
      if (cfg.adminKey && oldKey !== cfg.adminKey) return json(403, { error: '当前管理密钥不正确' });
      if (newKey.length < 8) return json(400, { error: '新密钥至少 8 位' });
      if (newKey === cfg.adminKey) return json(400, { error: '新密钥与当前密钥相同' });
      const c = this.store.loadInstance(cfg._uid);
      c.adminKey = newKey;
      this.store.saveInstance(cfg._uid, c);
      this.loadInstance(cfg._uid);
      this.audit(cfg._uid, 'adminKey.change', {});
      return json(200, { ok: true, toast: '管理密钥已修改（请记牢新密钥）' });
    }
    /* ---- Gay Core: 插件市场测试模式 (§10: 未开启时禁止自定义插件来源) ---- */
    if (p === '/admin/api/market/test-mode') {
      if (req.method === 'GET') return json(200, { ok: true, testMode: !!this.store.index.marketTestMode });
      if (req.method === 'POST') {
        const data = j();
        this.store.index.marketTestMode = !!(data && data.enable);
        this.store.saveIndex();
        this.audit(0, this.store.index.marketTestMode ? 'market.testMode.on' : 'market.testMode.off', {});
        return json(200, { ok: true, testMode: !!this.store.index.marketTestMode });
      }
    }
    /* ---- Gay Core: 用户端默认布局 + 用户调试模式 (每实例; 调试模式限单用户+限时, §15) ---- */
    if ((m = /^\/admin\/api\/client-config\/(\d+)$/.exec(p))) {
      const uid2 = Number(m[1]);
      if (!this.store.meta(uid2)) return json(404, { error: '实例不存在 uid=' + uid2 });
      if (req.method === 'GET') {
        const c = this.store.loadInstance(uid2);
        return json(200, { ok: true, uid: uid2, layout: c.clientLayout || null, userDebug: c.userDebug || null });
      }
      if (req.method === 'POST') {
        const data = j();
        if (!data || typeof data !== 'object') return json(400, { error: 'bad json' });
        const c = this.store.loadInstance(uid2);
        if (data.layout !== undefined) { c.clientLayout = sanitizeLayout(data.layout); this.audit(uid2, 'layout.save', { layout: c.clientLayout }); }
        if (data.userDebug !== undefined) {
          const ud = data.userDebug;
          if (ud && ud.uid && Number(ud.minutes) > 0) {
            c.userDebug = { uid: String(ud.uid), until: Date.now() + Math.min(Number(ud.minutes), 1440) * 60000 }; // 上限 24h
            this.audit(uid2, 'userDebug.on', { forUid: c.userDebug.uid, minutes: Number(ud.minutes) });
          } else {
            c.userDebug = null;
            this.audit(uid2, 'userDebug.off', {});
          }
        }
        this.store.saveInstance(uid2, c);
        this.loadInstance(uid2);
        return json(200, { ok: true, uid: uid2, layout: c.clientLayout || null, userDebug: c.userDebug || null });
      }
    }
    // GET /admin/api/instance/:uid → 完整视图(配置打码+插件配置)
    if ((m = /^\/admin\/api\/instance\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const full = this.store.instanceFull(Number(m[1]));
      if (!full) return json(404, { error: '实例不存在' });
      return json(200, { ok: true, ...full });
    }
    // GET /admin/api/config/:uid (打码) / POST 保存并热重载
    if ((m = /^\/admin\/api\/config\/(\d+)$/.exec(p))) {
      const uid = Number(m[1]);
      if (!this.store.meta(uid)) return json(404, { error: '实例不存在 uid=' + uid });
      if (req.method === 'GET') {
        const c = this.store.loadInstance(uid);
        const masked = crypt.maskFields(c);
        for (const k of Object.keys(masked)) if (k.startsWith('_')) delete masked[k];
        return json(200, { ok: true, uid, name: (this.store.meta(uid) || {}).name, config: masked });
      }
      if (req.method === 'POST') {
        const data = j();
        if (!data || typeof data !== 'object') return json(400, { error: 'bad json' });
        // 打码值原样回填(不覆盖真实密钥)
        const old = this.store.loadInstance(uid);
        const merged = this.unmaskMerge(data, old);
        this.store.saveInstance(uid, merged);
        this.loadInstance(uid);
        return json(200, { ok: true, uid });
      }
    }
    // GET/POST /admin/api/plugin-enable → 全局插件启用表 {id, enable} / {all:true, enable}
    if (p === '/admin/api/plugin-enable') {
      if (req.method === 'GET') return json(200, { ok: true, plugins: this.store.pluginEnableList({}) });
      if (req.method === 'POST') {
        const b = j() || {};
        let list = this.store.pluginEnableList({});
        /* 首次: 从第一个实例播种, 保证"全部插件"都在表里 */
        if (!list.length) {
          const metas = this.store.index.instances || [];
          if (metas.length) {
            const c0 = this.pool.instances.get(metas[0].uid) || this.store.loadInstance(metas[0].uid);
            if (c0) list = this.plugins.listForInstance(metas[0].uid, c0).map(x => ({ id: x.id, enable: !!x.enable }));
          }
        }
        const setOne = (id, en) => {
          const x = list.find(y => y && y.id === id);
          if (x) x.enable = en; else list.push({ id, enable: en });
        };
        const bad = { error: 'enable 必须是布尔值（收到 ' + JSON.stringify(b.enable === undefined ? null : b.enable) + '）—— 客户端模板可能未解析成功' };
        if (b.all) {
          const en = asBool(b.enable); if (en === null) return json(400, bad);
          for (const x of list) x.enable = en;
        } else if (b.id) {
          const en = asBool(b.enable); if (en === null) return json(400, bad);
          setOne(String(b.id), en);
        } else return json(400, { error: '需要 id 或 all' });
        this.store.setPluginEnableList(list);
        for (const m of (this.store.index.instances || [])) this.loadInstance(m.uid);
        return json(200, { ok: true, plugins: list });
      }
    }
    // POST /admin/api/instance 新建 {name, listen?, gatewayKey?...}
    if (p === '/admin/api/instance' && req.method === 'POST') {
      const data = j();
      if (!data || !data.name) return json(400, { error: '需要 name' });
      try {
        const uid = this.store.createInstance(String(data.name), data);
        this.loadInstance(uid);
        return json(200, { ok: true, uid });
      } catch (e) { return json(400, { error: e.message }); }
    }
    /* POST /admin/api/instance/:uid/basic {name, port, host, adminKey}
     * —— 实例接入参数（对齐旧版 App 的「编辑实例」表单：名称 / 端口 / 监听地址 / adminKey）
     * 扁平参数：App 的 form 组件打包出来就是一层对象，这里直接收，别要求嵌套。
     * ★改**当前实例**的端口会让管理端失联（App 连的还是旧端口）—— 页面侧必须警告。 */
    if ((m = /^\/admin\/api\/instance\/(\d+)\/basic$/.exec(p)) && req.method === 'POST') {
      const uid = Number(m[1]);
      const data = j() || {};
      const meta = this.store.meta(uid);
      if (!meta) return json(404, { error: '实例不存在' });
      const changed = [];
      /* 端口先校验（避免只改了一半） */
      let port = 0;
      if (data.port !== undefined && String(data.port).trim() !== '') {
        port = Number(data.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) return json(400, { error: '端口必须是 0-65535 的整数（0 = 不独占端口，走主端口+路径前缀）' });
      }
      let newName = '';
      if (data.name !== undefined && String(data.name).trim() !== '' && String(data.name).trim() !== meta.name) {
        newName = String(data.name).trim();
        if (!INST_NAME_RE.test(newName)) return json(400, { error: '实例名称只能用字母/数字/短横线' });
      }
      const c = this.store.loadInstance(uid);
      if (newName) {
        try { this.store.renameInstance(uid, newName); changed.push('名称'); }
        catch (e) { return json(400, { error: '改名失败: ' + e.message }); }
      }
      c.listen = c.listen || {};
      if (port >= 0 && port !== c.listen.port) { c.listen.port = port; changed.push('端口 ' + (port === 0 ? '0(不独占)' : port)); }
      const host = String(data.host || '').trim();
      if (host && host !== c.listen.host) { c.listen.host = host; changed.push('监听地址 ' + host); }
      const ak = String(data.adminKey || '').trim();
      if (ak) {
        if (ak.length < 8) return json(400, { error: '管理密钥至少 8 位' });
        c.adminKey = ak; changed.push('管理密钥');
      }
      if (!changed.length) return json(200, { ok: true, toast: '没有改动' });
      this.store.saveInstance(uid, c);
      /* 重新加载实例（端口变了必须重监听） */
      try { this.removeInstance(uid); } catch (_) { /* 未运行也没关系 */ }
      this.loadInstance(uid);
      this.audit(uid, 'instance.basic', { changed });
      return json(200, { ok: true, toast: '已保存：' + changed.join('、') });
    }
    /* POST /admin/api/instance/:uid/channel —— 新增（origName 空）或编辑渠道
     * body: {origName?, name, type, baseUrl, apiKey, models, modelMap, proxy, delayMs,
     *        isDefault, useResponses, insecure}
     * ★服务端直接改"配置里的那个渠道对象"（原生版曾踩过：改了游离对象 → 保存永远无效）。
     * 字段语义与原生一致：apiKey 留空 = 不改；models 逗号/换行分隔；modelMap 接受 JSON 或
     * "对外名=上游名" 每行一条；isDefault 勾上会把其它渠道的 default 清掉。 */
    if ((m = /^\/admin\/api\/instance\/(\d+)\/channel$/.exec(p)) && req.method === 'POST') {
      const uid = Number(m[1]);
      const data = j() || {};
      const c = this.store.loadInstance(uid);
      if (!c) return json(404, { error: '实例不存在' });
      const name = String(data.name || '').trim();
      if (!name) return json(400, { error: '渠道名称不能为空' });
      const origName = String(data.origName || '').trim();
      c.channels = Array.isArray(c.channels) ? c.channels : [];
      let ch = null;
      if (origName) {
        ch = c.channels.find(x => x && String(x.name) === origName);
        if (!ch) return json(404, { error: '找不到渠道: ' + origName });
        if (name !== origName && c.channels.some(x => x !== ch && String(x.name) === name)) {
          return json(400, { error: '已存在同名渠道: ' + name });
        }
      } else {
        if (c.channels.some(x => x && String(x.name) === name)) return json(400, { error: '已存在同名渠道: ' + name });
        ch = { apiKey: '' };
        c.channels.push(ch);
      }
      const type = String(data.type || 'openai').toLowerCase();
      if (['openai', 'claude', 'gemini'].indexOf(type) < 0) return json(400, { error: '类型只能是 openai / claude / gemini' });
      const baseUrl = String(data.baseUrl || '').trim().replace(/\/+$/, '');
      if (!baseUrl) return json(400, { error: 'Base URL 不能为空' });
      const mapTxt = String(data.modelMap == null ? '' : data.modelMap).trim();
      let modelMap = null;
      if (mapTxt) {
        if (mapTxt.charAt(0) === '{') {
          try { modelMap = JSON.parse(mapTxt); }
          catch (e) { return json(400, { error: 'modelMap 不是合法 JSON' }); }
        } else {
          modelMap = {};
          for (const line of mapTxt.split('\n')) {
            const t = String(line).trim();
            if (!t) continue;
            const i = t.indexOf('=');
            if (i <= 0) return json(400, { error: '模型改名应写成「对外名=上游名」: ' + t });
            modelMap[t.slice(0, i).trim()] = t.slice(i + 1).trim();
          }
          if (!Object.keys(modelMap).length) modelMap = null;
        }
      }
      const bool = v => v === true || v === 'true' || v === 1 || v === '1';
      ch.name = name;
      ch.type = type;
      ch.baseUrl = baseUrl;
      const k = String(data.apiKey || '').trim();
      if (k) ch.apiKey = k;
      ch.models = String(data.models == null ? '' : data.models)
        .split(/[,\n]/).map(s => s.trim()).filter(Boolean);
      if (modelMap) ch.modelMap = modelMap; else delete ch.modelMap;
      const px = String(data.proxy || '').trim();
      if (px) ch.proxy = px; else delete ch.proxy;
      ch.delayMs = Math.max(0, Number(data.delayMs) || 0);
      ch.insecure = bool(data.insecure);
      ch.useResponses = bool(data.useResponses);
      ch.default = bool(data.isDefault);
      if (ch.default) for (const x of c.channels) if (x !== ch) x.default = false;
      this.store.saveInstance(uid, c);
      try { this.removeInstance(uid); } catch (_) { /* 未运行也无妨 */ }
      this.loadInstance(uid);
      this.audit(uid, origName ? 'channel.update' : 'channel.add', { name: name });
      return json(200, { ok: true, toast: (origName ? '已保存渠道 ' : '已新增渠道 ') + name });
    }
    /* DELETE /admin/api/instance/:uid/channel {name} —— 删除渠道
     * ★name 放在 **body** 里而不是 query：渠道名可能是中文/空格，App 直接拼 URL 会报非法地址。 */
    if ((m = /^\/admin\/api\/instance\/(\d+)\/channel$/.exec(p)) && req.method === 'DELETE') {
      const uid = Number(m[1]);
      const data = j() || {};
      const name = String(data.name || u.searchParams.get('name') || '');
      if (!name) return json(400, { error: '缺少 name' });
      const c = this.store.loadInstance(uid);
      if (!c) return json(404, { error: '实例不存在' });
      const before = (c.channels || []).length;
      c.channels = (c.channels || []).filter(x => !(x && String(x.name) === name));
      if (c.channels.length === before) return json(404, { error: '找不到渠道: ' + name });
      this.store.saveInstance(uid, c);
      try { this.removeInstance(uid); } catch (_) { /* 未运行也无妨 */ }
      this.loadInstance(uid);
      this.audit(uid, 'channel.remove', { name: name });
      return json(200, { ok: true, toast: '已删除渠道 ' + name });
    }
    /* POST /admin/api/instance/:uid/channel-action {action:'probe'|'sync'|'balance', channel?}
     * 内核代调插件端点（权限不放大：仍然带 adminKey，且只允许这三个白名单动作） */
    if ((m = /^\/admin\/api\/instance\/(\d+)\/channel-action$/.exec(p)) && req.method === 'POST') {
      const uid = Number(m[1]);
      const data = j() || {};
      const act = String(data.action || '');
      const chName = String(data.channel || '');
      const c = this.store.loadInstance(uid);
      if (!c) return json(404, { error: '实例不存在' });
      const prefix = (c._name && c._name !== 'default') ? '/' + c._name : '';
      let r = null;
      if (act === 'probe') r = await this.selfReq(c, 'POST', prefix + '/plugins/probe/run', {});
      else if (act === 'sync') r = await this.selfReq(c, 'POST', prefix + '/plugins/model-sync/run', chName ? { channel: chName } : {});
      else if (act === 'balance') r = await this.selfReq(c, 'GET', prefix + '/plugins/balance/query?ch=' + encodeURIComponent(chName), null);
      else return json(400, { error: '未知动作: ' + act });
      if (r == null) return json(502, { error: '插件没有响应（可能未启用，或该实例未运行）' });
      const toast = r.toast || (act === 'probe' ? '探测已执行' : (act === 'sync' ? '模型同步已执行' : '余额查询完成'));
      /* ★同 plugin-call：归一化 error/toast（selfReq 的响应可能含 OpenAI 风格 {error:{message}}） */
      const flat = Object.assign({ ok: true }, r, { toast: toast });
      if (flat.error && typeof flat.error === 'object') flat.error = flat.error.message || flat.error.error || JSON.stringify(flat.error);
      if (flat.toast && typeof flat.toast === 'object') flat.toast = flat.toast.message || JSON.stringify(flat.toast);
      return json(200, flat);
    }
    // POST /admin/api/instance/:uid/rename {name}
    if ((m = /^\/admin\/api\/instance\/(\d+)\/rename$/.exec(p)) && req.method === 'POST') {
      const uid = Number(m[1]); const data = j() || {};
      try {
        this.store.renameInstance(uid, String(data.name || ''));
        const cfg = this.pool.instances.get(uid);
        if (cfg) { this.pool.instances.delete(uid); this.loadInstance(uid); }
        return json(200, { ok: true });
      } catch (e) { return json(400, { error: e.message }); }
    }
    // POST /admin/api/instance/:uid/enable {enable}
    if ((m = /^\/admin\/api\/instance\/(\d+)\/enable$/.exec(p)) && req.method === 'POST') {
      const uid = Number(m[1]); const data = j() || {};
      const en = asBool(data.enable);
      if (en === null) return json(400, { error: 'enable 必须是布尔值（收到 ' + JSON.stringify(data.enable === undefined ? null : data.enable) + '）—— 客户端模板可能未解析成功' });
      try {
        this.store.setEnabled(uid, en);
        if (en === false) this.removeInstance(uid); else this.loadInstance(uid);
        return json(200, { ok: true, enable: en });
      } catch (e) { return json(400, { error: e.message }); }
    }
    /* POST /admin/api/instance/batch {enable, uids?} —— 实例启停（服务端一次循环搞定，
     * 避免 App 端逐个发请求）。uids 给定时只处理选中的那几个；不给 = 全部。 */
    if (p === '/admin/api/instance/batch' && req.method === 'POST') {
      const data = j() || {};
      /* 同 asBool：批量启停一旦被静默当成 false = 全实例停服，必须严格校验 */
      const enB = asBool(data.enable);
      if (enB === null) return json(400, { error: 'enable 必须是布尔值（收到 ' + JSON.stringify(data.enable === undefined ? null : data.enable) + '）' });
      const wanted = Array.isArray(data.uids) && data.uids.length
        ? new Set(data.uids.map(x => String(x))) : null;
      const targets = this.store.index.instances.filter(mm =>
        !wanted || wanted.has(String(mm.uid)) || wanted.has(String(mm.name)));
      const done = [];
      const failed = [];
      for (const mm of targets) {
        try {
          this.store.setEnabled(mm.uid, enB);
          if (enB === false) this.removeInstance(mm.uid); else this.loadInstance(mm.uid);
          done.push(mm.name);
        } catch (e) { failed.push(mm.name + ': ' + e.message); }
      }
      this.audit(0, enB ? 'instance.batchEnable' : 'instance.batchDisable', { done: done.length, picked: !!wanted });
      return json(200, {
        ok: true, done: done.length, failed: failed,
        toast: (enB ? '已启动 ' : '已停止 ') + done.length + ' 个实例' +
          (failed.length ? '，失败 ' + failed.length + ' 个' : ''),
      });
    }
    // POST /admin/api/instance/:uid/reload
    if ((m = /^\/admin\/api\/instance\/(\d+)\/reload$/.exec(p)) && req.method === 'POST') {
      const uid = Number(m[1]);
      const c = this.loadInstance(uid);
      return c ? json(200, { ok: true }) : json(404, { error: '实例不存在' });
    }
    // DELETE /admin/api/instance/:uid
    if ((m = /^\/admin\/api\/instance\/(\d+)$/.exec(p)) && req.method === 'DELETE') {
      const uid = Number(m[1]);
      try {
        this.removeInstance(uid);
        this.store.deleteInstance(uid);
        return json(200, { ok: true });
      } catch (e) { return json(400, { error: e.message }); }
    }
    // GET /admin/api/plugins/:uid → 插件列表
    if ((m = /^\/admin\/api\/plugins\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const uid = Number(m[1]);
      const c = this.pool.instances.get(uid) || this.store.loadInstance(uid);
      if (!c) return json(404, { error: '实例不存在' });
      return json(200, { ok: true, plugins: this.plugins.listForInstance(uid, c) });
    }
    /* ===== 密钥保险箱：加密口令 (2026-09-18) =====
     * 口令**不落盘**（不写 .agwkey）—— 只存进程内存，重启即回到锁定态，由 App 自动解锁。
     * 这组端点供插件页 / 调试 / 命令行使用；插件内部走 ctx.gateway.crypt*（同一份实现）。 */
    if (p === '/admin/api/crypt/status' && req.method === 'GET') return json(200, this.cryptStatus());
    if (p === '/admin/api/crypt/unlock' && req.method === 'POST') {
      const r = this.cryptUnlock((j() || {}).pass);
      return json(r.ok ? 200 : 400, r);
    }
    if (p === '/admin/api/crypt/lock' && req.method === 'POST') return json(200, this.cryptLock());
    if (p === '/admin/api/crypt/clean-backups' && req.method === 'POST') return json(200, this.cryptCleanBackups());
    if (p === '/admin/api/crypt/reencrypt' && req.method === 'POST') {
      const r = this.cryptReencrypt((j() || {}).pass);
      return json(r.ok ? 200 : 400, r);
    }

    // GET /admin/api/plugin-config/:uid/:pid → {schema, config} / POST 保存配置并热重载该插件
    if ((m = /^\/admin\/api\/plugin-config\/(\d+)\/([a-z0-9][a-z0-9-]*)$/.exec(p))) {
      const uid = Number(m[1]), pid = m[2];
      const c = this.pool.instances.get(uid) || this.store.loadInstance(uid);
      if (!c) return json(404, { error: '实例不存在' });
      if (req.method === 'GET') {
        /* scope=admin 时读**管理端那份**主题参数（主题插件按端分开存；其它插件忽略该参数） */
        const scope = String(u.searchParams.get('scope') || 'admin');
        const r = this.plugins.configSchema(uid, pid, c, scope);
        if (!r) return json(404, { error: '插件不存在或未安装' });
        return json(200, { ok: true, id: pid, ...r });
      }
      if (req.method === 'POST') {
        const body = j();
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'body 必须是配置对象' });
        /* ★管理端 API 默认写**管理端那份**（主题插件按端分开存；其它插件忽略 scope）。
         *  这样 App 侧不用传 scope 就天然读写自己那一份。 */
        const scope = String(u.searchParams.get('scope') || body.__scope || 'admin');
        delete body.__scope;
        /* ★合并写入, 不要整体替换: 表单只带 schema 字段, 替换会抹掉 schema 之外的运行期数据
         *  (auth-user 的 users/groups、其它插件的运行数据)。详见 mergePluginConfig() 注释。 */
        const prevCfg = this.store.getPluginConfig(pid, uid, scope === 'admin' ? 'admin' : undefined) || {};
        const mergedCfg = mergePluginConfig(prevCfg, body);
        this.store.setPluginConfig(pid, uid, mergedCfg, scope === 'admin' ? 'admin' : undefined);
        // 单插件热重载(若该实例已启用此插件)
        const pc = this.store.pluginEnableList(c).find(x => x && x.id === pid && x.enable);
        const inst = this.plugins.installed.get(pid);
        if (pc && inst) {
          const r = this.plugins.activateOne(uid, pc, inst, c);
          if (!r.ok) return json(500, { error: '配置已保存, 但插件重载失败: ' + r.error });
        }
        return json(200, { ok: true, reloaded: !!(pc && inst) });
      }
      return json(405, { error: 'Method Not Allowed' });
    }

    /* ===== 插件市场 ===== */
    // GET /admin/api/market/indexes → 索引列表
    if (p === '/admin/api/market/indexes' && req.method === 'GET') {
      return json(200, { ok: true, indexes: this.marketIndexes() });
    }
    // POST /admin/api/market/indexes {url} 添加索引
    if (p === '/admin/api/market/indexes' && req.method === 'POST') {
      if (!this.store.index.marketTestMode) return json(403, { error: '未启用「测试模式」, 禁止添加自定义插件来源' });
      const body = j(); const url = String((body && body.url) || '').trim();
      if (!/^https?:\/\//.test(url)) return json(400, { error: '索引地址必须是 http(s):// URL' });
      const list = this.marketIndexes();
      if (list.includes(url)) return json(409, { error: '索引已存在' });
      list.push(url); this.saveMarketIndexes(list);
      this.audit(0, 'market.index.add', { url });
      return json(200, { ok: true, indexes: list });
    }
    // POST /admin/api/market/indexes-delete {url} 删除索引
    if (p === '/admin/api/market/indexes-delete' && req.method === 'POST') {
      const body = j(); const url = String((body && body.url) || '').trim();
      const list = this.marketIndexes().filter(x => x !== url);
      this.saveMarketIndexes(list);
      return json(200, { ok: true, indexes: list });
    }
    // GET /admin/api/market/plugins?proxy= → 聚合各索引的插件列表(标注安装状态)
    if (p === '/admin/api/market/plugins' && req.method === 'GET') {
      const proxy = u.searchParams.get('proxy') || null;
      const indexes = this.marketIndexes();
      const out = [];
      for (const idx of indexes) {
        try {
          const buf = await this.plugins.downloadIndex(idx, proxy);
          const doc = JSON.parse(buf.toString('utf8'));
          const plist = Array.isArray(doc.plugins) ? doc.plugins : [];
          for (const pl of plist) {
            if (!pl || !pl.id) continue;
            const installed = this.plugins.installed.get(pl.id);
            out.push({
              id: pl.id, name: pl.name || pl.id, version: pl.version || '?', author: pl.author || '',
              description: pl.description || '', type: pl.type || 'business', icon: pl.icon || null,
              url: pl.url || '', sha256: pl.sha256 || '', size: pl.size || 0,
              index: idx, indexName: doc.name || idx,
              installed: !!installed, builtin: !!(installed && installed.manifest && installed.manifest._builtin),
              installedVersion: installed ? (installed.manifest.version || '?') : null,
            });
          }
        } catch (e) {
          out.push({ _error: true, index: idx, error: '索引拉取失败: ' + e.message });
        }
      }
      return json(200, { ok: true, plugins: out });
    }
    // POST /admin/api/market/install {url, sha256?, proxy?} 安装插件包(tar.gz)
    if (p === '/admin/api/market/install' && req.method === 'POST') {
      /* Gay Core §10: 未启用测试模式时禁止自定义插件来源 */
      if (!this.store.index.marketTestMode) return json(403, { error: '未启用「测试模式」, 禁止添加自定义插件来源 (管理端 API /admin/api/market/test-mode 开启)' });
      const body = j(); const url = String((body && body.url) || '').trim();
      if (!/^https?:\/\//.test(url)) return json(400, { error: '下载地址必须是 http(s):// URL' });
      try {
        const r = await this.plugins.installFromUrl(url, body.sha256 || null, body.proxy || null);
        this.audit(0, 'plugin.install', { id: r.id, version: r.manifest.version, sha256: r.sha256, url });
        return json(200, { ok: true, id: r.id, name: r.manifest.name || r.id, version: r.manifest.version, sha256: r.sha256, hint: '已安装(未启用), 到插件页打开开关启用' });
      } catch (e) { return json(400, { error: e.message }); }
    }
    // POST /admin/api/market/uninstall {id} 卸载(内置插件拒绝)
    if (p === '/admin/api/market/uninstall' && req.method === 'POST') {
      const body = j(); const id = String((body && body.id) || '').trim();
      const inst = this.plugins.installed.get(id);
      if (!inst) return json(404, { error: '插件未安装: ' + id });
      if (inst.manifest._builtin) return json(403, { error: '内置插件不可卸载(随内核分发), 只能禁用' });
      this.plugins.removePlugin(id, false);
      this.audit(0, 'plugin.uninstall', { id });
      return json(200, { ok: true });
    }
    return json(404, { error: '未知管理接口: ' + p });
  }

  /* 打码值回填: "****"/"(已加密)" 的敏感字段保留旧值 */
  unmaskMerge(newCfg, oldCfg) {
    const isMasked = v => typeof v === 'string' && (v === '(已加密)' || /^\S{0,4}\*{4}/.test(v));
    const merge = (n, o, key) => {
      if (typeof n === 'string' && isMasked(n) && o !== undefined && key && crypt.SENSITIVE_KEYS.test(key)) return o;
      if (Array.isArray(n)) {
        if (Array.isArray(o)) return n.map((x, i) => merge(x, o[i], null));
        return JSON.parse(JSON.stringify(n));
      }
      if (n && typeof n === 'object') {
        /* ★从旧对象出发合并(旧字段保留), 新键覆盖 —— 之前 out 从空对象开始,
         *  POST {accessGuard:{...}} 会把整个实例配置替换成只剩 accessGuard (2026-09-14 数据丢失事故) */
        const out = (o && typeof o === 'object' && !Array.isArray(o)) ? Object.assign({}, o) : {};
        for (const k of Object.keys(n)) out[k] = merge(n[k], o ? o[k] : undefined, k);
        return out;
      }
      return n;
    };
    const patched = merge(newCfg, oldCfg || {}, null);
    /* 旧配置打底 + 新键覆盖: 新配置没提供的顶层键全部保留 */
    return Object.assign(JSON.parse(JSON.stringify(oldCfg || {})), patched);
  }

  /* ---------- 启停 ---------- */
  async start() {
    this.loadAll();
    /* ★使用统计历史(2026-09-18): 读盘 + 起 60s 定时 flush(只有变化的桶才追加写盘)。
     *  必须在 loadAll 之后 —— 数据目录那时才确定；写盘量极低(见 usage-history.js)。 */
    try {
      usageHist.init(this.store.dir);
      log('[usage] 统计历史已加载 桶=' + usageHist._stats().buckets + ' 存量行=' + usageHist._stats().lines);
    } catch (e) { logErr('[usage] 统计历史加载失败:', e.message); }
    const defMeta = this.store.metaByName('default');
    log('ai-gateway-core v' + CORE_VERSION + ' 已启动 (实例 ' + this.store.index.instances.length + ' 个, 主端口 ' + this.pool.mainPort + ')');
    return this;
  }
  close() {
    for (const [, srv] of this.pool.servers) { try { srv.server.close(); } catch (_) {} }
    try { this.plugins.flushAll(); } catch (_) {}
    /* ★退出前落盘「使用统计」内存桶 —— 否则最后 60s 的请求记录会随进程一起消失 */
    try { usageHist.flush(); } catch (_) {}
  }
}

module.exports = { Gateway, corsHeaders, sendError, jsonErr, collectModels, modelsResponse, modelsResponseFrom, GEMINI_RE, CORE_VERSION };
