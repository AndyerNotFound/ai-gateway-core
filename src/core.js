'use strict';














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
const modelref = require('./modelref');   
const usageHist = require('./usage-history');  
const adminUi = require('./admin-ui');

const CORE_VERSION = require('../package.json').version;






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

function modelsResponseFrom(ms, format) {
  if (format === 'gemini') {
    return { models: ms.map(m => ({ name: 'models/' + m, displayName: m, supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'] })) };
  }
  return { object: 'list', data: ms.map(m => ({ id: m, object: 'model', type: 'model', created: 1700000000, owned_by: 'ai-gateway-core', display_name: m })) };
}


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

const FALLBACK_THEME = {
  id: 'theme-md3', name: 'Material Design 3', builtin: true, locked: true,
  dark: { primary: '#D0BCFF', onPrimary: '#381E72', secondary: '#CCC2DC', surface: '#141218', surfaceContainer: '#1D1B20', background: '#141218', onSurface: '#E6E0E9', onSurfaceVariant: '#CAC4D0', outline: '#938F99', error: '#F2B8B5' },
  light: { primary: '#6750A4', onPrimary: '#FFFFFF', secondary: '#625B71', surface: '#FEF7FF', surfaceContainer: '#F3EDF7', background: '#FEF7FF', onSurface: '#1D1B20', onSurfaceVariant: '#49454F', outline: '#79747E', error: '#B3261E' },
  cssVars: {},
};


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
    


    this.store.onPluginConfigWrite = (pid) => { try { this.plugins.bumpCfgRev(pid, null); } catch (_) {} };
    
    this.pool = { instances: new Map(), servers: new Map(), portOwner: new Map(), mainPort: 0, mainTlsPort: 0, mainHost: '0.0.0.0' };
    this.opts = opts;
    this._gi = { at: 0, idx: null };   
  }

  
  groupIndex() {
    const now = Date.now();
    if (!this._gi.idx || now - this._gi.at > 3000) {
      this._gi = { at: now, idx: modelgroups.buildIndex(this.store) };
    }
    return this._gi.idx;
  }
  invalidateGroupIndex() { this._gi = { at: 0, idx: null }; }

  




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

  





  modelRefs(cfgs) {
    return modelref.buildRefs((Array.isArray(cfgs) ? cfgs : []).map(c => ({ name: c && c._name, channels: (c && c.channels) || [] })));
  }

  
  findInstanceForModel(model, userKey) {    const allowed = (userKey && Array.isArray(userKey.branches) && userKey.branches.length) ? userKey.branches : null;
    for (const [, c] of this.pool.instances) {
      if (!c || c._disabled) continue;
      if (c._name === 'default') continue;
      if (allowed && !allowed.includes(c._name)) continue;
      if (collectModels(c).includes(model)) return c;
    }
    return null;
  }

  
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

  
  loadInstance(uid) {
    const old = this.pool.instances.get(uid);
    let cfg;
    try { cfg = this.store.loadInstance(uid); } catch (e) { logErr('[pool] 实例 uid=' + uid + ' 配置加载失败: ' + e.message); return null; }
    if (!cfg) { if (old) { this.pool.instances.delete(uid); this.reconcilePorts(); } return null; }
    const meta = this.store.meta(uid);
    cfg._disabled = !(meta && meta.enabled !== false);
    cfg._stats = (old && old._stats) || newStats(); 
    this.pool.instances.set(uid, cfg);
    const r = this.plugins.activateInstance(uid, cfg);
    if (!r.ok) logErr('[plugins] uid=' + uid + ' ' + r.blocked);
    this.reconcilePorts();
    return cfg;
  }

  
  reloadAllInstances() {
    for (const meta of this.store.index.instances) this.loadInstance(meta.uid);
    return this.store.index.instances.length;
  }

  
  cryptStatus() { return Object.assign({ ok: true }, this.store.cryptStatus()); }

  



  cryptUnlock(pass, adminKey) {
    const p = String(pass == null ? '' : pass).trim();
    if (p.length < 8) return { ok: false, error: '口令至少 8 位' };
    

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

  
  cryptLock() {
    const had = !!this.store._pass;
    this.store.setPass(null);
    const n = this.reloadAllInstances();
    log('[crypt] 已锁定' + (had ? '(内存明文已随重载清除)' : '(此前本就未解锁)'));
    return { ok: true, reloaded: n, status: this.store.cryptStatus() };
  }

  
  cryptReencrypt(pass) {
    const cur = this.store._pass;
    const p = String(pass == null ? '' : pass).trim() || cur;
    if (!p) return { ok: false, error: '请先解锁（或提供口令）' };
    

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

  
  cryptCleanBackups() {
    const r = this.store.cleanCryptBackups();
    log('[crypt] 已删除明文备份 ' + r.count + ' 个');
    return Object.assign({ ok: true, status: this.store.cryptStatus() }, r);
  }

  loadAll() {
    
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

      
      if (this.store.isSetupMode()) {
        if (req.method === 'GET' && (p === '/health' || p === '/setup/status')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, setupMode: true, deadline: this.store.index.setupDeadline, hint: 'POST /setup/admin {adminKey} 创建管理员 (仅 localhost)' }));
        }
        
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

      
      const r = this.route(req, p);
      if (r.error) return sendError(null, 'openai', res, r.status || 404, r.error);
      let cfg = r.cfg;   
      p = r.path;
      
      if (req.method === 'GET' && p === '/v1/credits') p = '/credits';

      




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

      
      const presented = require('./auth').presentedToken(req, u.searchParams);
      if (presented) {
        const gk = this.plugins.globalKeys.get(presented);
        if (gk && gk.branches.length && !gk.branches.includes(r.name)) {
          return sendError(cfg, 'openai', res, 403, '此卡密不允许访问分组: ' + r.name + ' (可用: ' + gk.branches.join(', ') + ')');
        }
      }

      if (cfg.cors && req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(cfg)); return res.end(); }
      const se = (format, res2, status, msg, code) => sendError(cfg, format, res2, status, msg, code);

      
      if (req.method === 'GET' && p === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, version: CORE_VERSION, uptime: Math.round(process.uptime()) }));
      }
      



      if (req.method === 'GET' && p === '/ui/usage') {
        try {
          

          const scope = this.viewerScope(cfg, req, u.searchParams);
          const page = adminUi.render(this, cfg, 'usage', u.searchParams, this.plugins.adminPages(cfg._uid), { base: '/ui/usage', admin: false, scope: scope }) || {};
          page.gcui = page.gcui || adminUi.UI_VERSION;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(JSON.stringify(page));
        } catch (e) { return jsonErr(res, '生成页面失败: ' + e.message, 500); }
      }
      if (req.method === 'GET' && p === '/status') {
        



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
            

            const isDef = cfg._name === 'default';
            const targets = isDef ? [...this.pool.instances.values()].filter(x => x) : [cfg];
            



            const meScope = isAdmin ? null : this.viewerScope(cfg, req, u.searchParams);
            const meKey = (meScope && meScope.keyId) || '';
            const meAdmin = !!(meScope && meScope.admin);   
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
                
                const b = (s.byKey || {})[meKey];
                if (b) {
                  gReq += b.requests || 0; gErr += b.errors || 0;
                  for (const [name, v] of Object.entries(b.byChannel || {})) addCh(t, name, v);
                }
                for (const r of (s.recent||[])) if (r.keyId === meKey) allRecent.push(isDef ? Object.assign({}, r, { instance: t._name }) : r);
                continue;
              }
              if (!seeAll) continue;   
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

      
      if (req.method === 'GET' && p === '/api/app/bootstrap') {
        return this.handleAppBootstrap(cfg, res);
      }

      



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
            if (!schema.length) continue;   
            out.push({ id: t.id, name: t.name, schema: schema, config: this.store.getPluginConfig(t.id, uid, 'user') || {} });
          }
          return jsonT(200, { ok: true, themes: out });
        }
        if (req.method === 'POST') {
          let raw = '';
          const u8 = utf8();   
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

      
      if ((p === '/admin' || p === '/admin/') && req.method === 'GET') {
        try {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(fs.readFileSync(path.join(__dirname, '..', 'web', 'admin.html'), 'utf8'));
        } catch (e) { return jsonErr(res, '管理页面缺失: web/admin.html', 404); }
      }
      
      if ((p === '/user' || p === '/user/') && req.method === 'GET') {
        try {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(fs.readFileSync(path.join(__dirname, '..', 'web', 'user.html'), 'utf8'));
        } catch (e) { return jsonErr(res, '用户页面缺失: web/user.html', 404); }
      }
      if (req.method === 'GET' && p.startsWith('/admin/assets/')) return this.serveAdminAsset(req, res, p);
      


      if (p.startsWith('/admin/ui')) {
        return this.handleAdmin(cfg, req, res, u, p, '').catch(e => jsonErr(res, e));
      }
      if (p.startsWith('/admin/api')) {
        if (req.method === 'POST' || req.method === 'DELETE') {
          let adminBody = '';
          const u8 = utf8();   
          req.on('data', c => { adminBody += u8(c); if (adminBody.length > 4 * 1024 * 1024) req.destroy(); });
          req.on('end', () => { this.handleAdmin(cfg, req, res, u, p, adminBody).catch(e => jsonErr(res, e)); });
          req.on('error', () => {});
        } else {
          return this.handleAdmin(cfg, req, res, u, p, '');
        }
        return;
      }

      
      if (p === '/plugins' || p.startsWith('/plugins/')) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          this.plugins.handle(cfg, req, res, u, p, '').catch(e => jsonErr(res, e));
        } else {
          let pbody = '';
          const u8 = utf8();   
          req.on('data', c => { pbody += u8(c); if (pbody.length > 8 * 1024 * 1024) req.destroy(); });
          req.on('end', () => { this.plugins.handle(cfg, req, res, u, p, pbody).catch(e => jsonErr(res, e)); });
          req.on('error', () => {});
        }
        return;
      }

      



      if (this.store.locked && (p === '/v1' || p.startsWith('/v1/') || p.startsWith('/v1beta/'))) {
        return se(p.startsWith('/v1beta') ? 'gemini' : 'openai', res, 503,
          '网关已锁定：渠道密钥处于加密状态，请在 Gay Core「密钥保险箱」里解锁后重试');
      }

      
      const extraKey = req.method.toUpperCase() + ' ' + p;
      const extra = this.plugins.extraEndpoints.get(extraKey);
      if (extra && extra.uid === cfg._uid) {
        this.plugins.maybeReloadData(extra.pluginId, extra.uid);   
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

      
      const topHit = this.plugins.topRoutes.get(cfg._uid + '|' + req.method.toUpperCase() + ' ' + p);
      if (topHit && topHit.uid === cfg._uid) {
        this.plugins.maybeReloadData(topHit.pluginId, topHit.uid);   
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

      
      if (req.method === 'GET' && (p === '/v1/models' || p === '/v1beta/models')) {
        const fmt = p === '/v1beta/models' ? 'gemini' : 'openai';
        const authR = this.authChain.check(cfg, req, u.searchParams);
        if (!authR.ok) return se(fmt, res, authR.status || 401, authR.error || 'invalid key');
        

        const agg = r.via === 'default' && cfg.aggregate !== false;
        

        const cfgs = agg ? this.aggregateInstanceCfgs(authR.userKey) : [cfg];
        const refs = this.modelRefs(cfgs);
        let ms = modelref.filterEntries(refs.entries, authR.userKey, this.groupIndex()).map(e => e.id);
        
        if (!ms.length && cfgs.length) {
          const seen = [];
          for (const c of cfgs) for (const m of collectModels(c)) if (!seen.includes(m)) seen.push(m);
          ms = this.filterModelsFor(seen, authR.userKey);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(cfg) });
        return res.end(JSON.stringify(modelsResponseFrom(ms, fmt)));
      }

      

      if (req.method === 'GET' && p === '/api/app/models') {
        return this.handlePublicModels(cfg, res);
      }

      
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
      const u8 = utf8();   
      req.on('data', c => {
        if (aborted) return;
        size += c.length;
        if (size > cfg.maxBodyBytes) { aborted = true; req.destroy(); se(clientFormat, res, 413, 'request body too large (>' + cfg.maxBodyBytes + ' bytes)'); return; }
        bodyStr += u8(c);
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          


          let wantPlain = modelFromBody(urlInfo, bodyStr);
          if (wantPlain) {
            const ref = modelref.parseRef(wantPlain);
            if (ref) {
              let tgt = null;
              for (const [, c] of this.pool.instances) {
                if (!c || !modelref.channelMatch(ref.instance, c._name)) continue;   
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
                urlInfo.forceChannel = String(hit.name);   
                urlInfo.modelOverride = ref.model;         
                urlInfo.rawModel = wantPlain;
                wantPlain = ref.model;
              } else {
                log('[ref] 引用无法解析(实例/渠道/模型不匹配), 当普通模型名处理: ' + wantPlain);
              }
            }
          }
          
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

  
  handleSetupAdmin(req, res) {
    if (!isLocalhost(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'setup 仅允许 localhost 调用' }));
    }
    let body = '';
    const u8 = utf8();   
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

  
  gatewayApi(cfg) {
    return { uid: cfg._uid, instanceName: cfg._name, store: this.store, gateway: this };
  }

  
  audit(uid, action, detail) {
    try {
      const dir = path.join(this.store.dir, 'log');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'audit-' + uid + '.jsonl'),
        JSON.stringify({ ts: new Date().toISOString(), action, ...(detail || {}) }) + '\n');
    } catch (_) {}
  }

  
  



  selfReq(cfg, method, path, body, timeoutMs) {
    return new Promise(resolve => {
      

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
    
    let registration = null;
    if (has('auth-user')) {
      const c = this.store.getPluginConfig('auth-user', uid) || {};
      const r = c.registration || {};
      registration = {
        enable: !!r.enable,
        minPasswordLen: Number(r.minPasswordLen) || 8,
        captchaProvider: r.captchaProvider === 'turnstile' ? 'turnstile' : 'none',
        captchaSiteKey: r.captchaProvider === 'turnstile' ? String(r.captchaSiteKey || '') : '',
        emailVerify: !!(r.emailVerify && r.emailVerify.enable),
      };
    }
    
    let themes = this.plugins.themesForInstance(uid, cfg, 'user');
    if (!themes.some(t => t.id === 'theme-md3')) themes = [FALLBACK_THEME].concat(themes); 
    
    const ud = cfg.userDebug;
    const userDebug = (ud && ud.uid && Number(ud.until) > Date.now()) ? { forUid: String(ud.uid), until: Number(ud.until) } : null;
    const body = {
      ok: true, core: CORE_VERSION, appApi: 1,
      branch: cfg._name, uid,
      serverInfo: this.store.getServerInfo(),
      userDebug,
      layout: (cfg.clientLayout && typeof cfg.clientLayout === 'object') ? cfg.clientLayout : null,
      
      adminUi: adminUi.manifest(this.plugins.adminPages(uid)),
      branches: this.store.index.instances.filter(mm => mm.enabled !== false).map(mm => ({ name: mm.name, uid: mm.uid })),
      auth: { cardkey: has('auth-cardkey'), user: has('auth-user'), gatewayKey: !!cfg.gatewayKey, registration },
      themes,
      plugins: enabled.map(x => ({
        id: x.id, name: x.name, version: x.version, author: x.author, description: x.description,
        icon: x.icon, type: x.type, builtin: x.builtin, sha256: x.sha256,
        permissions: x.permissions, provides: x.provides, appUi: x.appUi,
        userPage: x.userPage, hasAdminPage: x.hasAdminPage,
      })),
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(cfg) });
    res.end(JSON.stringify(body));
  }

  

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

  
  async handleAdmin(cfg, req, res, u, p, body) {
    const authR = this.authChain.checkAdmin(cfg, req, u.searchParams);
    if (!authR.ok) return sendError(cfg, 'openai', res, authR.status || 401, authR.error || 'unauthorized');
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...corsHeaders(cfg) }); res.end(JSON.stringify(obj)); };
    const j = () => { try { return JSON.parse(body || '{}'); } catch (_) { return null; } };

    


    if (p.startsWith('/admin/ui/') && req.method === 'GET') {
      const name = p.slice('/admin/ui/'.length).replace(/[^a-zA-Z0-9-]/g, '');
      
      const page = await adminUi.render(this, cfg, name, u.searchParams, this.plugins.adminPages(cfg._uid), { base: '/admin/ui/' + name, admin: true });
      if (!page) return json(404, { error: '没有这个管理端页面: ' + name });
      return json(200, page);
    }

    if (p === '/admin' || p === '/admin/api/status') {
      

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
    
    if ((m = /^\/admin\/api\/stats\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const uidS = Number(m[1]);
      const ic = this.pool.instances.get(uidS);
      if (!ic) return json(404, { error: '实例未运行或不存在' });
      



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
    
    if ((m = /^\/admin\/api\/audit\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const uid3 = Number(m[1]);
      const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 500);
      const f = path.join(this.store.dir, 'log', 'audit-' + uid3 + '.jsonl');
      let lines = [];
      try {
        lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      } catch (_) {}
      return json(200, { ok: true, uid: uid3, entries: lines.reverse() }); 
    }
    
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
    



    if (p === '/admin/api/plugin-call' && req.method === 'POST') {
      const PLUGIN_CALL_OK = {
        'auth-user': 1, 'auth-cardkey': 1, 'model-sync': 1,
        'balance': 1, 'probe': 1, 'proxy': 1, 'model-square': 1, 'billing': 1, 'vault': 1,
      };
      const d = j() || {};
      const pid = String(d.plugin || '');
      if (!PLUGIN_CALL_OK[pid]) return json(403, { error: '不允许代调该插件: ' + pid });
      const sub = String(d.path || '');
      if (sub.indexOf('/admin/') !== 0) return json(403, { error: '只允许代调插件的 /admin/ 端点' });
      const c = this.store.loadInstance(cfg._uid);
      if (!c) return json(404, { error: '实例不存在' });
      const prefix = (c._name && c._name !== 'default') ? '/' + c._name : '';
      const r = await this.selfReq(
        c, String(d.method || 'GET').toUpperCase(),
        prefix + '/plugins/' + pid + sub, d.body || null, 10000,
      );
      if (r == null) return json(502, { error: '插件没有响应（未启用，或该实例未运行）' });
      



      const flat = Object.assign({ ok: true }, r);
      if (flat.error && typeof flat.error === 'object') {
        flat.error = flat.error.message || flat.error.error || JSON.stringify(flat.error);
      }
      if (flat.toast && typeof flat.toast === 'object') {
        flat.toast = flat.toast.message || JSON.stringify(flat.toast);
      }
      return json(200, flat);
    }
    


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
            c.userDebug = { uid: String(ud.uid), until: Date.now() + Math.min(Number(ud.minutes), 1440) * 60000 }; 
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
    
    if ((m = /^\/admin\/api\/instance\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const full = this.store.instanceFull(Number(m[1]));
      if (!full) return json(404, { error: '实例不存在' });
      return json(200, { ok: true, ...full });
    }
    
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
        
        const old = this.store.loadInstance(uid);
        const merged = this.unmaskMerge(data, old);
        this.store.saveInstance(uid, merged);
        this.loadInstance(uid);
        return json(200, { ok: true, uid });
      }
    }
    
    if (p === '/admin/api/plugin-enable') {
      if (req.method === 'GET') return json(200, { ok: true, plugins: this.store.pluginEnableList({}) });
      if (req.method === 'POST') {
        const b = j() || {};
        let list = this.store.pluginEnableList({});
        
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
    
    if (p === '/admin/api/instance' && req.method === 'POST') {
      const data = j();
      if (!data || !data.name) return json(400, { error: '需要 name' });
      try {
        const uid = this.store.createInstance(String(data.name), data);
        this.loadInstance(uid);
        return json(200, { ok: true, uid });
      } catch (e) { return json(400, { error: e.message }); }
    }
    



    if ((m = /^\/admin\/api\/instance\/(\d+)\/basic$/.exec(p)) && req.method === 'POST') {
      const uid = Number(m[1]);
      const data = j() || {};
      const meta = this.store.meta(uid);
      if (!meta) return json(404, { error: '实例不存在' });
      const changed = [];
      
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
      
      try { this.removeInstance(uid); } catch (_) {  }
      this.loadInstance(uid);
      this.audit(uid, 'instance.basic', { changed });
      return json(200, { ok: true, toast: '已保存：' + changed.join('、') });
    }
    





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
      try { this.removeInstance(uid); } catch (_) {  }
      this.loadInstance(uid);
      this.audit(uid, origName ? 'channel.update' : 'channel.add', { name: name });
      return json(200, { ok: true, toast: (origName ? '已保存渠道 ' : '已新增渠道 ') + name });
    }
    

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
      try { this.removeInstance(uid); } catch (_) {  }
      this.loadInstance(uid);
      this.audit(uid, 'channel.remove', { name: name });
      return json(200, { ok: true, toast: '已删除渠道 ' + name });
    }
    

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
      
      const flat = Object.assign({ ok: true }, r, { toast: toast });
      if (flat.error && typeof flat.error === 'object') flat.error = flat.error.message || flat.error.error || JSON.stringify(flat.error);
      if (flat.toast && typeof flat.toast === 'object') flat.toast = flat.toast.message || JSON.stringify(flat.toast);
      return json(200, flat);
    }
    
    if ((m = /^\/admin\/api\/instance\/(\d+)\/rename$/.exec(p)) && req.method === 'POST') {
      const uid = Number(m[1]); const data = j() || {};
      try {
        this.store.renameInstance(uid, String(data.name || ''));
        const cfg = this.pool.instances.get(uid);
        if (cfg) { this.pool.instances.delete(uid); this.loadInstance(uid); }
        return json(200, { ok: true });
      } catch (e) { return json(400, { error: e.message }); }
    }
    
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
    

    if (p === '/admin/api/instance/batch' && req.method === 'POST') {
      const data = j() || {};
      
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
    
    if ((m = /^\/admin\/api\/instance\/(\d+)\/reload$/.exec(p)) && req.method === 'POST') {
      const uid = Number(m[1]);
      const c = this.loadInstance(uid);
      return c ? json(200, { ok: true }) : json(404, { error: '实例不存在' });
    }
    
    if ((m = /^\/admin\/api\/instance\/(\d+)$/.exec(p)) && req.method === 'DELETE') {
      const uid = Number(m[1]);
      try {
        this.removeInstance(uid);
        this.store.deleteInstance(uid);
        return json(200, { ok: true });
      } catch (e) { return json(400, { error: e.message }); }
    }
    
    if ((m = /^\/admin\/api\/plugins\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const uid = Number(m[1]);
      const c = this.pool.instances.get(uid) || this.store.loadInstance(uid);
      if (!c) return json(404, { error: '实例不存在' });
      return json(200, { ok: true, plugins: this.plugins.listForInstance(uid, c) });
    }
    


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

    
    if ((m = /^\/admin\/api\/plugin-config\/(\d+)\/([a-z0-9][a-z0-9-]*)$/.exec(p))) {
      const uid = Number(m[1]), pid = m[2];
      const c = this.pool.instances.get(uid) || this.store.loadInstance(uid);
      if (!c) return json(404, { error: '实例不存在' });
      if (req.method === 'GET') {
        
        const scope = String(u.searchParams.get('scope') || 'admin');
        const r = this.plugins.configSchema(uid, pid, c, scope);
        if (!r) return json(404, { error: '插件不存在或未安装' });
        return json(200, { ok: true, id: pid, ...r });
      }
      if (req.method === 'POST') {
        const body = j();
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'body 必须是配置对象' });
        

        const scope = String(u.searchParams.get('scope') || body.__scope || 'admin');
        delete body.__scope;
        

        const prevCfg = this.store.getPluginConfig(pid, uid, scope === 'admin' ? 'admin' : undefined) || {};
        const mergedCfg = mergePluginConfig(prevCfg, body);
        this.store.setPluginConfig(pid, uid, mergedCfg, scope === 'admin' ? 'admin' : undefined);
        
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

    
    
    if (p === '/admin/api/market/indexes' && req.method === 'GET') {
      return json(200, { ok: true, indexes: this.marketIndexes() });
    }
    
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
    
    if (p === '/admin/api/market/indexes-delete' && req.method === 'POST') {
      const body = j(); const url = String((body && body.url) || '').trim();
      const list = this.marketIndexes().filter(x => x !== url);
      this.saveMarketIndexes(list);
      return json(200, { ok: true, indexes: list });
    }
    
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
    
    if (p === '/admin/api/market/install' && req.method === 'POST') {
      
      if (!this.store.index.marketTestMode) return json(403, { error: '未启用「测试模式」, 禁止添加自定义插件来源 (管理端 API /admin/api/market/test-mode 开启)' });
      const body = j(); const url = String((body && body.url) || '').trim();
      if (!/^https?:\/\//.test(url)) return json(400, { error: '下载地址必须是 http(s):// URL' });
      try {
        const r = await this.plugins.installFromUrl(url, body.sha256 || null, body.proxy || null);
        this.audit(0, 'plugin.install', { id: r.id, version: r.manifest.version, sha256: r.sha256, url });
        return json(200, { ok: true, id: r.id, name: r.manifest.name || r.id, version: r.manifest.version, sha256: r.sha256, hint: '已安装(未启用), 到插件页打开开关启用' });
      } catch (e) { return json(400, { error: e.message }); }
    }
    
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

  
  unmaskMerge(newCfg, oldCfg) {
    const isMasked = v => typeof v === 'string' && (v === '(已加密)' || /^\S{0,4}\*{4}/.test(v));
    const merge = (n, o, key) => {
      if (typeof n === 'string' && isMasked(n) && o !== undefined && key && crypt.SENSITIVE_KEYS.test(key)) return o;
      if (Array.isArray(n)) {
        if (Array.isArray(o)) return n.map((x, i) => merge(x, o[i], null));
        return JSON.parse(JSON.stringify(n));
      }
      if (n && typeof n === 'object') {
        

        const out = (o && typeof o === 'object' && !Array.isArray(o)) ? Object.assign({}, o) : {};
        for (const k of Object.keys(n)) out[k] = merge(n[k], o ? o[k] : undefined, k);
        return out;
      }
      return n;
    };
    const patched = merge(newCfg, oldCfg || {}, null);
    
    return Object.assign(JSON.parse(JSON.stringify(oldCfg || {})), patched);
  }

  
  async start() {
    this.loadAll();
    

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
    
    try { usageHist.flush(); } catch (_) {}
  }
}

module.exports = { Gateway, corsHeaders, sendError, jsonErr, collectModels, modelsResponse, modelsResponseFrom, GEMINI_RE, CORE_VERSION };
