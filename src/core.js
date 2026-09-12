'use strict';
                                                                                    
  
                       
                         
                                                                
                                   
                                             
                                             
                                                            
                                                                                              
                                           
                                           
                                                        
   
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { log, logErr, readJson } = require('./util');
const { Store, RESERVED_PATHS, INST_NAME_RE } = require('./store');
const { AuthChain, isLocalhost } = require('./auth');
const { PluginManager } = require('./plugins');
const router = require('./router');
const { newStats } = require('./stats');
const crypt = require('./crypt');

const CORE_VERSION = require('../package.json').version;
const GEMINI_RE = /^\/v1(?:beta|alpha)?\/models\/([^:]+):(generateContent|streamGenerateContent|countTokens)$/;

                                 
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
function collectModels(cfg) {
  const set = [];
  for (const ch of (cfg.channels || [])) {
    if (ch.models) for (const m of ch.models) if (!set.includes(m)) set.push(m);
    if (ch.modelMap) for (const m of Object.keys(ch.modelMap)) if (!set.includes(m)) set.push(m);
  }
  return set;
}
function modelsResponse(cfg, format) {
  const ms = collectModels(cfg);
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
                                                                                           
    this.pool = { instances: new Map(), servers: new Map(), portOwner: new Map(), mainPort: 0, mainTlsPort: 0, mainHost: '0.0.0.0' };
    this.opts = opts;
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
      const cfg = r.cfg;
      p = r.path;
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
      if (req.method === 'GET' && p === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true, version: CORE_VERSION, startedAt: cfg._stats.startedAt, uptime: Math.round(process.uptime()),
          uid: cfg._uid, name: cfg._name, listen: cfg.listen,
          channels: cfg.channels.map(c => ({ name: c.name, type: c.type, baseUrl: c.baseUrl, proxy: c.proxy || null, models: c.models, modelMap: c.modelMap, groups: c.groups || [], default: c.default, delayMs: c.delayMs || 0, useResponses: !!c.useResponses })),
          proxies: Object.entries(cfg.proxies || {}).map(([k, v]) => ({ name: k, type: v.type, host: v.host, port: v.port })),
          stats: { requests: cfg._stats.requests, errors: cfg._stats.errors, byChannel: cfg._stats.byChannel },
          plugins: this.plugins.listForInstance(cfg._uid, cfg).map(x => ({ id: x.id, name: x.name, version: x.version, type: x.type, enable: x.enable, running: x.running })),
        }));
      }

                                                                                        
      if (req.method === 'GET' && p === '/api/app/bootstrap') {
        return this.handleAppBootstrap(cfg, res);
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
      if (p.startsWith('/admin/api')) {
        if (req.method === 'POST' || req.method === 'DELETE') {
          let adminBody = '';
          req.on('data', c => { adminBody += c.toString('utf8'); if (adminBody.length > 4 * 1024 * 1024) req.destroy(); });
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
          req.on('data', c => { pbody += c.toString('utf8'); if (pbody.length > 8 * 1024 * 1024) req.destroy(); });
          req.on('end', () => { this.plugins.handle(cfg, req, res, u, p, pbody).catch(e => jsonErr(res, e)); });
          req.on('error', () => {});
        }
        return;
      }

                                                         
      const extraKey = req.method.toUpperCase() + ' ' + p;
      const extra = this.plugins.extraEndpoints.get(extraKey);
      if (extra && extra.uid === cfg._uid) {
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
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(cfg) });
        return res.end(JSON.stringify(modelsResponse(cfg, fmt)));
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
      req.on('data', c => {
        if (aborted) return;
        size += c.length;
        if (size > cfg.maxBodyBytes) { aborted = true; req.destroy(); se(clientFormat, res, 413, 'request body too large (>' + cfg.maxBodyBytes + ' bytes)'); return; }
        bodyStr += c.toString('utf8');
      });
      req.on('end', () => {
        if (aborted) return;
        try {
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
    req.on('data', c => { body += c.toString('utf8'); if (body.length > 65536) req.destroy(); });
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
    let themes = this.plugins.themesForInstance(uid, cfg);
    if (!themes.some(t => t.id === 'theme-md3')) themes = [FALLBACK_THEME].concat(themes);             
                                      
    const ud = cfg.userDebug;
    const userDebug = (ud && ud.uid && Number(ud.until) > Date.now()) ? { forUid: String(ud.uid), until: Number(ud.until) } : null;
    const body = {
      ok: true, core: CORE_VERSION, appApi: 1,
      branch: cfg._name, uid,
      serverInfo: this.store.getServerInfo(),
      userDebug,
      layout: (cfg.clientLayout && typeof cfg.clientLayout === 'object') ? cfg.clientLayout : null,
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

    if (p === '/admin' || p === '/admin/api/status') {
      return json(200, {
        ok: true, version: CORE_VERSION,
        instances: this.store.index.instances.map(m => ({
          uid: m.uid, name: m.name, port: m.port, enabled: m.enabled !== false,
          running: this.pool.instances.has(m.uid),
          requests: (this.pool.instances.get(m.uid) || {})._stats ? this.pool.instances.get(m.uid)._stats.requests : 0,
          errors: (this.pool.instances.get(m.uid) || {})._stats ? this.pool.instances.get(m.uid)._stats.errors : 0,
        })),
        mainPort: this.pool.mainPort, mainTlsPort: this.pool.mainTlsPort,
      });
    }

    let m;
                                                        
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
        if (b.all) { for (const x of list) x.enable = !!b.enable; }
        else if (b.id) setOne(String(b.id), !!b.enable);
        else return json(400, { error: '需要 id 或 all' });
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
      try {
        this.store.setEnabled(uid, !!data.enable);
        if (data.enable === false) this.removeInstance(uid); else this.loadInstance(uid);
        return json(200, { ok: true });
      } catch (e) { return json(400, { error: e.message }); }
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
                                                                                   
    if ((m = /^\/admin\/api\/plugin-config\/(\d+)\/([a-z0-9][a-z0-9-]*)$/.exec(p))) {
      const uid = Number(m[1]), pid = m[2];
      const c = this.pool.instances.get(uid) || this.store.loadInstance(uid);
      if (!c) return json(404, { error: '实例不存在' });
      if (req.method === 'GET') {
        const r = this.plugins.configSchema(uid, pid, c);
        if (!r) return json(404, { error: '插件不存在或未安装' });
        return json(200, { ok: true, id: pid, ...r });
      }
      if (req.method === 'POST') {
        const body = j();
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'body 必须是配置对象' });
        this.store.setPluginConfig(pid, uid, body);
                             
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
      if (Array.isArray(n) && Array.isArray(o)) return n.map((x, i) => merge(x, o[i], null));
      if (n && typeof n === 'object' && o && typeof o === 'object' && !Array.isArray(n)) {
        const out = {};
        for (const k of Object.keys(n)) out[k] = merge(n[k], o[k], k);
        return out;
      }
      return n;
    };
    const merged = merge(newCfg, oldCfg || {}, null);
    return merged;
  }

                                
  async start() {
    this.loadAll();
    const defMeta = this.store.metaByName('default');
    log('ai-gateway-core v' + CORE_VERSION + ' 已启动 (实例 ' + this.store.index.instances.length + ' 个, 主端口 ' + this.pool.mainPort + ')');
    return this;
  }
  close() {
    for (const [, srv] of this.pool.servers) { try { srv.server.close(); } catch (_) {} }
    try { this.plugins.flushAll(); } catch (_) {}
  }
}

module.exports = { Gateway, corsHeaders, sendError, jsonErr, collectModels, modelsResponse, GEMINI_RE, CORE_VERSION };
