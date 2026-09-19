'use strict';









const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { log: defaultLog } = require('./util');
const { paletteFromSeed, normalizeSeed, applyScheme } = require('./palette');


function untar(tarBuf, destDir) {
  let off = 0;
  while (off + 512 <= tarBuf.length) {
    const header = tarBuf.slice(off, off + 512);
    let name = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const prefix = header.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(header.slice(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const type = header.slice(156, 157).toString('utf8');
    off += 512;
    const content = tarBuf.slice(off, off + size);
    off += Math.ceil(size / 512) * 512;
    const safe = path.normalize(name).replace(/^([/\\])+/, '').replace(/(\.\.[/\\])+/g, '');
    if (!safe) continue;
    const dest = path.join(destDir, safe);
    if (type === '5') { fs.mkdirSync(dest, { recursive: true }); continue; }
    if (type === '0' || type === '\0' || type === '') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
  }
}


function downloadBuf(url, maxBytes = 50 * 1024 * 1024, redirects = 5, proxyUrl = null) {
  return new Promise((resolve, reject) => {
    let lib;
    try { lib = url.startsWith('https') ? https : http; } catch (e) { return reject(e); }
    
    let agent;
    if (proxyUrl) {
      try {
        const { normalizeProxy, HttpTunnelAgent, HttpsTunnelAgent } = require('./proxy');
        const proxy = normalizeProxy(proxyUrl);
        agent = url.startsWith('https') ? new HttpsTunnelAgent(proxy) : new HttpTunnelAgent(proxy);
      } catch (e) { return reject(new Error('代理地址无效: ' + e.message)); }
    }
    const req = lib.get(url, { timeout: 30000, agent }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(downloadBuf(new URL(res.headers.location, url).href, maxBytes, redirects - 1, proxyUrl));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = []; let len = 0;
      res.on('data', c => { len += c.length; if (len > maxBytes) { req.destroy(); reject(new Error('文件过大(>50MB)')); } else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
  });
}


const HOOK_NAMES = ['onRequestBody', 'onChatAuth', 'onQuotaEstimate', 'needConvert', 'wrapWriter', 'processCanonicalResp',
  'onResponseEvent', 'onResponseLine', 'onResponseBody', 'sanitizeText', 'onUsage', 'onChatDone', 'billing'];


const PLUGIN_TYPES = ['auth', 'business', 'theme'];


function hashDir(dir) {
  const h = crypto.createHash('sha256');
  const files = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const fp = path.join(d, name);
      const st = fs.statSync(fp);
      if (st.isDirectory()) walk(fp);
      else if (st.isFile()) files.push(fp);
    }
  })(dir);
  files.sort();
  for (const fp of files) {
    h.update(path.relative(dir, fp).replace(/\\/g, '/'));
    h.update(fs.readFileSync(fp));
  }
  return h.digest('hex');
}

class PluginManager {
  



  constructor(store, deps = {}) {
    this.store = store;
    this.gwDir = store.dir;
    this.pluginsDir = store.pluginsDir;
    this.dataDir = store.pluginsDataDir;
    this.log = deps.log || ((...a) => defaultLog('[plugins]', ...a));
    this.authChain = deps.authChain || null;          
    this.upstreamRequest = deps.upstreamRequest || null;
    this.pickChannels = deps.pickChannels || null;
    this.crypt = deps.crypt || null;                  
    
    this._adminUiPages = new Map();
    this.bus = new EventEmitter();                    
    this.bus.setMaxListeners(100);
    
    this.installed = new Map();
    
    this.active = new Map();
    
    this.extraEndpoints = new Map();
    
    this.topRoutes = new Map();
    
    this.globalKeys = new Map();
    
    this._cfgRev = new Map();
    


    this._dataRev = new Map();
    this.gateway = deps.gateway || null;
    
    this._secCache = new Map();
    this._secTimer = setInterval(() => this._flushSecAll(), 30000);
    if (this._secTimer.unref) this._secTimer.unref();
    this.scanInstalled();
  }

  scanInstalled() {
    this.installed.clear();
    
    const dirs = [
      path.resolve(__dirname, '..', 'plugins'), 
      this.pluginsDir,                           
    ];
    for (const baseDir of dirs) {
      if (!baseDir || !fs.existsSync(baseDir)) continue;
      for (const d of fs.readdirSync(baseDir)) {
        const pdir = path.join(baseDir, d);
        const mf = path.join(pdir, 'manifest.json');
        try {
          if (!fs.statSync(pdir).isDirectory() || !fs.existsSync(mf)) continue;
          const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
          if (!manifest.id) manifest.id = d;
          if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) { this.log('插件 id 非法, 跳过:', d); continue; }
          if (manifest.type && !PLUGIN_TYPES.includes(manifest.type)) { this.log('插件 type 非法(auth|business|theme), 跳过:', d); continue; }
          
          if (manifest.type === 'theme') {
            if (manifest.hasServer || fs.existsSync(path.join(pdir, 'server.js'))) { this.log('主题插件禁止携带 server.js, 跳过:', d); continue; }
            if (Array.isArray(manifest.permissions) && manifest.permissions.length) { this.log('主题插件禁止声明权限, 跳过:', d); continue; }
            manifest.hasServer = false;
          }
          manifest._builtin = baseDir !== this.pluginsDir;
          let sha256 = '';
          try { sha256 = hashDir(pdir); } catch (e) { this.log('插件目录哈希失败:', d, e.message); }
          this.installed.set(manifest.id, { manifest, dir: pdir, sha256 });
        } catch (e) { this.log('插件 manifest 解析失败:', d, e.message); }
      }
    }
  }

  

  activateInstance(uid, cfg) {
    this.deactivateInstance(uid);
    this.scanInstalled();
    const list = this.store.pluginEnableList(cfg);
    const enabled = list.filter(pc => pc && pc.enable && pc.id);
    const authPlugins = [], bizPlugins = [];
    for (const pc of enabled) {
      const inst = this.installed.get(pc.id);
      if (!inst) { this.log(`[uid:${uid}] 插件未安装:`, pc.id); continue; }
      (inst.manifest.type === 'auth' ? authPlugins : bizPlugins).push([pc, inst]);
    }
    
    for (const [pc, inst] of authPlugins) {
      const r = this.activateOne(uid, pc, inst, cfg);
      if (!r.ok) {
        this.log(`[uid:${uid}] 认证插件 ${pc.id} 激活失败 → fail-closed, 阻断后续插件加载`);
        return { ok: false, blocked: 'auth plugin failed: ' + pc.id + ' — ' + r.error };
      }
    }
    
    for (const [pc, inst] of bizPlugins) this.activateOne(uid, pc, inst, cfg);
    return { ok: true };
  }

  activateOne(uid, pc, inst, cfg) {
    const key = uid + '/' + pc.id;
    this.deactivateByKey(key);
    const { manifest, dir } = inst;
    const state = {
      key, uid, pluginId: pc.id, manifest, dir,
      routes: new Map(), timers: [], hooks: {},
      data: this.loadData(uid, pc.id),
      dirty: false,
      
      _dataSeen: this._dataRev.get(pc.id) || 0,
      
      cfg: this.store.getPluginConfig(pc.id, uid) || pc.config || {},
    };
    const saveTimer = setInterval(() => this.flushData(state), 30000);
    if (saveTimer.unref) saveTimer.unref();
    state.timers.push(saveTimer);

    const serverFile = path.join(dir, 'server.js');
    if (manifest.hasServer && fs.existsSync(serverFile)) {
      const ctx = this.makeCtx(state, cfg);
      state.ctx = ctx;
      try {
        delete require.cache[require.resolve(serverFile)];
        const mod = require(serverFile);
        state.module = mod;
        if (mod && typeof mod.activate === 'function') mod.activate(ctx);
        this.log(`[uid:${uid}] 插件已激活: ${pc.id} v${manifest.version || '?'} type=${manifest.type || 'business'} (路由${state.routes.size}条)`);
      } catch (e) {
        this.log(`[uid:${uid}] 插件 ${pc.id} 激活异常:`, e.stack || e.message);
        this.deactivateByKey(key);
        return { ok: false, error: e.message };
      }
    }
    this.active.set(key, state);
    return { ok: true };
  }

  
  makeCtx(state, cfg) {
    const self = this;
    state._instCfg = cfg; 
    const perms = new Set(state.manifest.permissions || []);
    const needPerm = (p) => { if (!perms.has(p)) throw new Error(`插件 ${state.pluginId} 未声明权限: ${p}`); };
    const uid = state.uid;
    return {
      id: state.pluginId,
      uid,
      instanceName: cfg._name,
      config: state.cfg,

      
      getPluginConfig: (pluginId, u) => self.store.getPluginConfig(pluginId, u == null ? uid : u),
      setPluginConfig: (u, conf) => { 
        if (conf === undefined) { conf = u; u = uid; }
        self.store.setPluginConfig(state.pluginId, u == null ? uid : u, conf);
        state.cfg = conf;
        



        self.bumpCfgRev(state.pluginId, state.key);
      },
      
      configRev: () => self._cfgRev.get(state.pluginId) || 0,
      getInstanceConfig: (u) => {
        const c = self.store.loadInstance(u == null ? uid : u);
        if (!c) return null;
        const masked = self.crypt ? self.crypt.maskFields(c) : c;
        for (const k of Object.keys(masked)) if (k.startsWith('_')) delete masked[k];
        return masked;
      },

      
      registerRoute(method, p, handler) { 
        if (!p.startsWith('/')) p = '/' + p;
        state.routes.set(method.toUpperCase() + ' ' + p, handler);
      },
      registerExtraEndpoint(method, p, handler) { 
        needPerm('gateway:registerExtraEndpoint');
        const k = method.toUpperCase() + ' ' + p;
        self.extraEndpoints.set(k, { pluginId: state.pluginId, uid, handler });
      },
      registerTopRoute(method, p, handler) { 
        needPerm('gateway:topRoute');
        const k = uid + '|' + method.toUpperCase() + ' ' + p; 
        if (self.topRoutes.has(k)) self.log(`[${state.pluginId}] 顶层路由覆盖: ${k}`);
        self.topRoutes.set(k, { pluginId: state.pluginId, uid, handler });
      },

      
      registerAuth(strategy, opts = {}) {
        needPerm('auth:registerAuth');
        if (state.manifest.type !== 'auth') throw new Error('只有 type:"auth" 的插件能注册认证策略');
        if (!self.authChain) throw new Error('内核未提供 authChain');
        strategy._pluginId = state.pluginId;
        strategy._uid = uid;   
        return self.authChain.registerAuth(strategy, opts);
      },
      
      bindAuthApis(apis) {
        if (state.manifest.type !== 'auth') throw new Error('只有 type:"auth" 的插件能 bindAuthApis');
        self._bindingPluginId = state.pluginId;
        self.bindGatewayAuthApis(uid, apis);
        self._bindingPluginId = null;
      },

      
      hook(name, fn) {
        if (!HOOK_NAMES.includes(name)) throw new Error('未知 hook: ' + name + ' (可用: ' + HOOK_NAMES.join(', ') + ')');
        (state.hooks[name] = state.hooks[name] || []).push(fn);
      },
      wrapWriter(fn) { (state.hooks.wrapWriter = state.hooks.wrapWriter || []).push(fn); },
      onRequest(fn) { (state.hooks.onRequestBody = state.hooks.onRequestBody || []).push(fn); },
      onResponse(fn) { (state.hooks.onResponseBody = state.hooks.onResponseBody || []).push(fn); },

      
      data: {
        get: k => state.data[k],
        set: (k, v) => { state.data[k] = v; state.dirty = true; },
        del: k => { delete state.data[k]; state.dirty = true; },
        all: () => state.data,
        


        flush: () => self.flushData(state),
        


        reload: () => self.reloadData(state),
        
        rev: () => self._dataRev.get(state.pluginId) || 0,
      },
      
      get dataDir() {
        const d = path.join(self.dataDir, String(uid), state.pluginId);
        try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
        return d;
      },
      








      registerAdminUi(def) {
        needPerm('gateway:adminUi');
        const d = def && typeof def === 'object' ? def : null;
        if (!d || !d.id || !/^[a-z0-9][a-z0-9-]*$/.test(String(d.id))) throw new Error('registerAdminUi: 缺少合法 id（小写字母/数字/连字符）');
        if (typeof d.render !== 'function') throw new Error('registerAdminUi: 缺少 render(gw, cfg, q) 函数');
        self._adminUiPages.set(uid + '/' + state.pluginId + '/' + d.id, {
          id: String(d.id), title: String(d.title || d.id), subtitle: String(d.subtitle || ''),
          icon: String(d.icon || 'apps'), menu: d.menu !== false,
          render: d.render, pluginId: state.pluginId, uid,
        });
      },

      cron(a, b, c) {
        
        let ms = a, fn = b;
        if (typeof c === 'function') { ms = b; fn = c; }
        if (typeof ms !== 'number' || !(ms > 0)) ms = 60000;
        if (typeof fn !== 'function') { self.log(`[${state.pluginId}] cron: 缺少回调函数`); return; }
        const t = setInterval(() => { try { fn(); } catch (e) { self.log(`[${state.pluginId}] cron:`, e.message); } }, ms);
        if (t.unref) t.unref();
        state.timers.push(t);
      },
      stats(u, delta) {
        const inst = self.store.meta(u == null ? uid : u);
        void inst; void delta; 
      },
      emit: (ev, data) => self.bus.emit(state.pluginId + ':' + ev, data),
      on: (ev, fn) => self.bus.on(ev, fn),          
      encrypt: v => { if (!self.crypt) throw new Error('内核未启用加密'); return self.crypt.encrypt(v); },
      decrypt: v => { if (!self.crypt) throw new Error('内核未启用加密'); return self.crypt.decrypt(v); },

      


      security: {
        verifyIntent: (req, params) => self.verifyIntent(state, req, params),
        commit: (token, intentId, seq, nonce, response) => self.commitIntent(state, token, intentId, seq, nonce, response),
        guard: (req, params, res, fn) => {
          const jsonRes = (code, obj) => { try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); } catch (_) {} };
          const v = self.verifyIntent(state, req, params);
          if (!v.ok) return jsonRes(v.status || 401, { ok: false, error: v.error, currentSeq: v.currentSeq });
          if (v.replay !== undefined) return jsonRes(200, v.replay); 
          let out;
          try { out = fn(v.keyRecord); } catch (e) { self.log(`[${state.pluginId}] intent 处理异常:`, e.stack || e.message); return jsonRes(500, { ok: false, error: '插件内部错误: ' + e.message }); }
          const h2 = (req && req.headers) || {};
          self.commitIntent(state, params.token || '', String(h2['x-gc-intent-id'] || ''), Number(h2['x-gc-seq'] || 0), String(h2['x-gc-nonce'] || ''), out);
          jsonRes(200, out);
        },
      },

      
      upstreamRequest(opts) {
        if (!self.upstreamRequest) throw new Error('内核未提供 upstreamRequest');
        return self.upstreamRequest(cfg, opts);
      },
      
      pickChannels(model) { return self.pickChannels ? self.pickChannels(cfg, model) : []; },

      
      gateway: {
        uid,
        instanceName: cfg._name,
        findKey: token => { needPerm('gateway:findKey'); const a = self._gwApisByUid && self._gwApisByUid.get(uid); return a && a.apis.findKey ? a.apis.findKey(cfg, token) : null; },
        grantQuota: (keyId, tokens) => { needPerm('gateway:grantQuota'); const a = self._gwApisByUid && self._gwApisByUid.get(uid); return a && a.apis.grantQuota ? a.apis.grantQuota(cfg, keyId, tokens) : false; },
        
        reload() { if (self.gateway) self.gateway.loadInstance(uid); },
        
        saveInstanceConfig(mutator) {
          needPerm('gateway:saveConfig');
          const c = self.store.loadInstance(uid);
          if (!c) return false;
          mutator(c);
          self.store.saveInstance(uid, c);
          if (self.gateway) self.gateway.loadInstance(uid);
          return true;
        },
        
        listInstances() { return self.store.index.instances.map(m => ({ uid: m.uid, name: m.name, port: m.port, enabled: m.enabled !== false })); },
        
        instanceChannels() { const c = self.store.loadInstance(uid); return c ? (c.channels || []) : []; },
        
        serverInfo() { return self.store.getServerInfo() || {}; },
        
        modelGroups() {
          needPerm('gateway:modelGroups');
          const gi = (self.gateway && self.gateway.groupIndex) ? self.gateway.groupIndex() : null;
          if (gi) return { declared: gi.declared.slice(), groupsOf: m => gi.groupsOf(m), matches: (m, g) => gi.matches(m, g) };
          const fb = require('./modelgroups').buildIndex(self.store);
          return { declared: fb.declared.slice(), groupsOf: m => fb.groupsOf(m), matches: (m, g) => fb.matches(m, g) };
        },
        
        registerGlobalKey(token, branches) { needPerm('gateway:registerGlobalKey'); self.globalKeys.set(token, { uid, branches: branches || [], pluginId: state.pluginId }); },
        unregisterGlobalKey(token) { self.globalKeys.delete(token); },
        
        authApis() { needPerm('gateway:authApis'); const a = self._gwApisByUid && self._gwApisByUid.get(uid); return (a && a.apis) || {}; },
        

        cryptStatus() { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptStatus() : null; },
        cryptUnlock(pass, adminKey) { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptUnlock(pass, adminKey) : { ok: false, error: '内核不支持' }; },
        cryptLock() { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptLock() : { ok: false, error: '内核不支持' }; },
        cryptReencrypt(pass) { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptReencrypt(pass) : { ok: false, error: '内核不支持' }; },
        cryptCleanBackups() { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptCleanBackups() : { ok: false, error: '内核不支持' }; },
      },

      log: (...a) => self.log(`[${state.pluginId}]`, ...a),
    };
  }

  
  bindGatewayAuthApis(uid, apis) {
    if (!this._gwApisByUid) this._gwApisByUid = new Map();
    const cur = this._gwApisByUid.get(uid);
    
    this._gwApisByUid.set(uid, { apis: Object.assign((cur && cur.apis) || {}, apis), pluginId: (cur && cur.pluginId) || this._bindingPluginId || null });
  }

  
  hooksFor(uid) {
    const states = [...this.active.values()].filter(s => s.uid === uid);
    if (!states.length) return null;
    const collect = (name) => states.flatMap(s => (s.hooks[name] || []));
    const hooks = {};
    const onRequestBody = collect('onRequestBody');
    if (onRequestBody.length) hooks.onRequestBody = (body, ctx) => { for (const fn of onRequestBody) { try { body = fn(body, ctx) || body; } catch (e) { this.log('onRequestBody:', e.message); } } return body; };
    const onChatAuth = collect('onChatAuth');
    



    if (onChatAuth.length) hooks.onChatAuth = (info) => {
      let first = null;
      for (const fn of onChatAuth) {
        let d; try { d = fn(info); } catch (e) { d = { status: 500, message: e.message }; }
        if (!d) continue;
        if (d.status >= 400 || (d.message && !d.quota)) return d;
        if (!first) first = d;
      }
      return first;
    };
    







    const onQuotaEstimate = collect('onQuotaEstimate');
    if (onQuotaEstimate.length) hooks.onQuotaEstimate = (info) => {
      for (const fn of onQuotaEstimate) {
        let r; try { r = fn(info); } catch (e) { this.log('onQuotaEstimate:', e.message); continue; }
        if (r === null || r === undefined || r === '') continue;
        const v = Number(r);
        if (isFinite(v) && v >= 0) return v;
      }
      return null;
    };
    const needConvert = collect('needConvert');
    if (needConvert.length) hooks.needConvert = (cfg, ch) => needConvert.some(fn => { try { return !!fn(cfg, ch); } catch (_) { return false; } });
    const wrapWriter = collect('wrapWriter');
    if (wrapWriter.length) hooks.wrapWriter = (w, ctx) => { for (const fn of wrapWriter) { try { w = fn(w, ctx) || w; } catch (e) { this.log('wrapWriter:', e.message); } } return w; };
    const pcr = collect('processCanonicalResp');
    if (pcr.length) hooks.processCanonicalResp = async (cresp, ctx) => { for (const fn of pcr) { await fn(cresp, ctx); } };
    const ore = collect('onResponseEvent');
    if (ore.length) hooks.onResponseEvent = (ev, ctx) => { for (const fn of ore) { let r; try { r = fn(ev, ctx); } catch (e) { this.log('onResponseEvent:', e.message); } if (r === false) return false; } return true; };
    const orl = collect('onResponseLine');
    if (orl.length) hooks.onResponseLine = (line, ctx) => { for (const fn of orl) { try { line = fn(line, ctx); } catch (e) { this.log('onResponseLine:', e.message); } } return line; };
    const orb = collect('onResponseBody');
    if (orb.length) hooks.onResponseBody = (out, ctx) => { for (const fn of orb) { try { fn(out, ctx); } catch (e) { this.log('onResponseBody:', e.message); } } };
    const st = collect('sanitizeText');
    if (st.length) hooks.sanitizeText = (s, ctx) => { for (const fn of st) { try { s = fn(s, ctx); } catch (e) { this.log('sanitizeText:', e.message); } } return s; };
    const ou = collect('onUsage');
    if (ou.length) hooks.onUsage = (usage, ctx) => { for (const fn of ou) { try { fn(usage, ctx); } catch (e) { this.log('onUsage:', e.message); } } };
    

    const bil = collect('billing');
    if (bil.length) hooks.billing = (usage, ctx) => {
      let out = null;
      for (const fn of bil) {
        try {
          const r = fn(usage, ctx);
          if (r == null) continue;
          if (typeof r === 'number' || typeof r === 'string') { out = { charged: Number(r) }; }
          else if (typeof r === 'object' && r.charged != null) { out = r; }
        } catch (e) { this.log('billing:', e.message); }
      }
      return out;
    };
    const ocd = collect('onChatDone');
    if (ocd.length) hooks.onChatDone = (rec, ctx) => { for (const fn of ocd) { try { fn(rec, ctx); } catch (e) { this.log('onChatDone:', e.message); } } };
    return Object.keys(hooks).length ? hooks : null;
  }

  
  dataFile(uid, pluginId) {
    
    const scope = this.store.dataScope(pluginId);
    const dir = scope === 'global' ? '_global' : String(uid);
    const safe = s => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dataDir, dir, safe(pluginId) + '.json');
  }
  loadData(uid, pluginId) {
    const f = this.dataFile(uid, pluginId);
    if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
    return {};
  }
  flushData(state) {
    if (!state || !state.dirty) return;
    try {
      const f = this.dataFile(state.uid, state.pluginId);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      



      let disk = null;
      try { disk = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { disk = null; }
      const out = (disk && typeof disk === 'object' && !Array.isArray(disk))
        ? Object.assign({}, disk, state.data) : state.data;
      fs.writeFileSync(f, JSON.stringify(out, null, 2));
      if (out !== state.data) {           
        for (const k of Object.keys(state.data)) delete state.data[k];
        Object.assign(state.data, out);
      }
      state.dirty = false;
      this._dataRev.set(state.pluginId, (this._dataRev.get(state.pluginId) || 0) + 1);
      state._dataSeen = this._dataRev.get(state.pluginId);
    } catch (e) { this.log('插件数据落盘失败:', e.message); }
  }

  

  maybeReloadData(pluginId, uid) {
    try {
      const st = this.active.get(uid + '/' + pluginId);
      if (!st || st.dirty) return;
      if (this.store.dataScope(pluginId) !== 'global') return;
      if ((this._dataRev.get(pluginId) || 0) === st._dataSeen) return;
      this.reloadData(st);
    } catch (_) {}
  }

  
  reloadData(state) {
    if (!state || state.dirty) return false;
    try {
      const fresh = this.loadData(state.uid, state.pluginId);
      if (fresh && typeof fresh === 'object' && !Array.isArray(fresh)) {
        for (const k of Object.keys(state.data)) delete state.data[k];
        Object.assign(state.data, fresh);
      }
      state._dataSeen = this._dataRev.get(state.pluginId) || 0;
      return true;
    } catch (e) { this.log('插件数据重读失败:', e.message); return false; }
  }

  






  bumpCfgRev(pluginId, fromKey) {
    const rev = (this._cfgRev.get(pluginId) || 0) + 1;
    this._cfgRev.set(pluginId, rev);
    for (const [key, st] of this.active) {
      if (st.pluginId !== pluginId || key === fromKey) continue;
      try {
        const fresh = this.store.getPluginConfig(pluginId, st.uid);
        if (fresh && typeof fresh === 'object' && st.cfg && typeof st.cfg === 'object') {
          for (const k of Object.keys(st.cfg)) delete st.cfg[k];
          Object.assign(st.cfg, fresh);
        }
      } catch (_) {}
    }
    return rev;
  }
  flushAll() { for (const [, s] of this.active) this.flushData(s); this._flushSecAll(); }

  
  _secFile(uid) { return path.join(this.dataDir, String(uid), '.gc-security.json'); }
  _loadSec(uid) {
    let s = this._secCache.get(uid);
    if (!s) {
      let data = null;
      try { data = JSON.parse(fs.readFileSync(this._secFile(uid), 'utf8')); } catch (_) {}
      s = { keys: (data && data.keys) || {}, dirty: false };
      this._secCache.set(uid, s);
    }
    return s;
  }
  _flushSecAll() {
    for (const [uid, s] of this._secCache) {
      if (!s.dirty) continue;
      try {
        fs.mkdirSync(path.dirname(this._secFile(uid)), { recursive: true });
        const tmp = this._secFile(uid) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ keys: s.keys }));
        fs.renameSync(tmp, this._secFile(uid));
        s.dirty = false;
      } catch (e) { this.log('意图安全记录落盘失败:', e.message); }
    }
  }

  
  verifyIntent(state, req, params) {
    const h = (req && req.headers) || {};
    const token = (params && params.token) || '';
    if (!token) return { ok: false, status: 401, error: '缺少凭据' };
    const ts = Number(h['x-gc-timestamp'] || 0);
    const nonce = String(h['x-gc-nonce'] || '');
    const seq = Number(h['x-gc-seq'] || 0);
    const intentId = String(h['x-gc-intent-id'] || '');
    const sign = String(h['x-gc-sign'] || '');
    if (!ts || !nonce || !seq || !intentId || !sign) return { ok: false, status: 400, error: '缺少签名头 (X-GC-Timestamp/Nonce/Seq/Intent-Id/Sign)' };
    if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) return { ok: false, status: 401, error: '时间戳超出 ±5 分钟窗口' };
    
    const pathname = String((req && req.url) || '').split('?')[0];
    if (!pathname.includes('/plugins/' + state.pluginId + '/')) return { ok: false, status: 403, error: '插件实例归属不匹配' };
    const sec = this._loadSec(state.uid);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const rec = sec.keys[tokenHash] || { lastSeq: 0, nonces: [], intents: {} };
    if (seq <= (rec.lastSeq || 0)) return { ok: false, status: 401, error: '序列号回滚 (需 > ' + (rec.lastSeq || 0) + ')', currentSeq: rec.lastSeq || 0 };
    if ((rec.nonces || []).includes(nonce)) return { ok: false, status: 401, error: 'nonce 重复' };
    if (rec.intents && rec.intents[intentId]) return { ok: true, replay: rec.intents[intentId].response, keyRecord: null };
    const bodyHash = crypto.createHash('sha256').update((params && params.rawBody) || '').digest('hex');
    const expect = crypto.createHmac('sha256', token).update([ts, nonce, seq, intentId, String(req.method || '').toUpperCase(), pathname, bodyHash].join('\n')).digest('hex');
    const a = Buffer.from(expect), b = Buffer.from(sign);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, status: 401, error: '验签失败' };
    
    let keyRecord = null;
    if (this.authChain && state._instCfg) {
      const r = this.authChain.check(state._instCfg, req, new URL(req.url, 'http://localhost').searchParams);
      if (!r.ok) return { ok: false, status: r.status || 401, error: r.error || 'invalid key' };
      keyRecord = r.userKey || null;
    }
    return { ok: true, keyRecord, _pending: { tokenHash, seq, nonce, intentId } };
  }

  commitIntent(state, token, intentId, seq, nonce, response) {
    if (!token || !intentId) return;
    const sec = this._loadSec(state.uid);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const rec = sec.keys[tokenHash] || { lastSeq: 0, nonces: [], intents: {} };
    if (seq > (rec.lastSeq || 0)) rec.lastSeq = seq;
    rec.nonces = (rec.nonces || []).concat(nonce).slice(-200); 
    rec.intents = rec.intents || {};
    rec.intents[intentId] = { ts: Date.now(), response };
    
    const now = Date.now();
    const entries = Object.entries(rec.intents).filter(([, v]) => now - (v.ts || 0) < 86400e3).slice(-100);
    rec.intents = Object.fromEntries(entries);
    sec.keys[tokenHash] = rec;
    sec.dirty = true;
  }

  
  deactivateByKey(key) {
    const state = this.active.get(key);
    if (!state) return;
    for (const t of state.timers) { try { clearInterval(t); } catch {} }
    this.flushData(state);
    
    
    if (this.authChain) for (const s of [...this.authChain.strategies, ...this.authChain.adminStrategies]) {
      if (s._pluginId === state.pluginId && String(s._uid) === String(state.uid)) this.authChain.unregisterAuthObj(s);
    }
    for (const [k, v] of [...this.extraEndpoints]) if (v.pluginId === state.pluginId && v.uid === state.uid) this.extraEndpoints.delete(k);
    for (const [k, v] of [...this.topRoutes]) if (v.pluginId === state.pluginId && v.uid === state.uid) this.topRoutes.delete(k);
    if (this._gwApisByUid) { const ga = this._gwApisByUid.get(state.uid); if (ga && ga.pluginId === state.pluginId) this._gwApisByUid.delete(state.uid); }
    for (const [k, v] of [...this.globalKeys]) if (v.pluginId === state.pluginId && v.uid === state.uid) this.globalKeys.delete(k);
    
    for (const k of [...this._adminUiPages.keys()]) if (k.startsWith(String(state.uid) + '/' + state.pluginId + '/')) this._adminUiPages.delete(k);
    if (state.module && typeof state.module.deactivate === 'function') {
      try { state.module.deactivate(); } catch (e) { this.log(`[${key}] deactivate:`, e.message); }
    }
    this.active.delete(key);
  }
  deactivateInstance(uid) {
    for (const key of [...this.active.keys()]) if (key.startsWith(uid + '/')) this.deactivateByKey(key);
  }

  
  
  adminPages(uid) {
    const out = [], seen = new Set();
    const pre = String(uid) + '/';
    for (const [k, v] of [...this._adminUiPages].reverse()) {
      if (!k.startsWith(pre)) continue;
      if (seen.has(v.id)) continue;   
      seen.add(v.id); out.push(v);
    }
    return out.reverse();
  }
  
  adminPage(uid, id) {
    return this.adminPages(uid).find(p => p.id === id) || null;
  }

  
  listForInstance(uid, cfg) {
    this.scanInstalled();
    const cfgMap = new Map(this.store.pluginEnableList(cfg).map(p => [p.id, p]));
    const out = [];
    for (const [id, inst] of this.installed) {
      const pc = cfgMap.get(id);
      const running = this.active.has(uid + '/' + id);
      out.push({
        id, name: inst.manifest.name || id, version: inst.manifest.version || '?',
        author: inst.manifest.author || '', description: inst.manifest.description || '',
        type: inst.manifest.type || 'business',
        icon: inst.manifest.icon || null, hasServer: !!inst.manifest.hasServer,
        builtin: !!inst.manifest._builtin,
        sha256: inst.sha256 || '',
        hasUserPage: !!inst.manifest.userPage, hasAdminPage: !!inst.manifest.adminPage,
        userPage: inst.manifest.userPage || null, adminPage: inst.manifest.adminPage || null,
        
        provides: Array.isArray(inst.manifest.provides) ? inst.manifest.provides : [],
        appUi: (inst.manifest.appUi && typeof inst.manifest.appUi === 'object') ? inst.manifest.appUi : null,
        theme: (inst.manifest.type === 'theme' && inst.manifest.theme && typeof inst.manifest.theme === 'object') ? inst.manifest.theme : null,
        permissions: Array.isArray(inst.manifest.permissions) ? inst.manifest.permissions : [],
        enable: pc ? !!pc.enable : false, running,
        schema: Array.isArray(inst.manifest.configSchema) ? inst.manifest.configSchema : [],
        
        config: this.store.getPluginConfig(id, uid, inst.manifest.type === 'theme' ? 'admin' : undefined) || (pc ? (pc.config || {}) : {}),
      });
    }
    return out;
  }
  userPlugins(uid, cfg) {
    return this.listForInstance(uid, cfg).filter(p => p.enable && p.running && p.hasUserPage)
      .map(p => ({ id: p.id, name: p.name, icon: p.icon, description: p.description, userPage: p.userPage }));
  }

  

  themesForInstance(uid, cfg, scope) {
    this.scanInstalled();
    const cfgMap = new Map(this.store.pluginEnableList(cfg).map(p => [p.id, p]));
    const out = [];
    for (const [id, inst] of this.installed) {
      if (inst.manifest.type !== 'theme' || !inst.manifest.theme) continue;
      const pc = cfgMap.get(id);
      const forced = id === 'theme-md3';
      if (!forced && pc && pc.enable === false) continue;
      const t = inst.manifest.theme;
      

      let dark = t.dark || {}, light = t.light || {};
      let cssVars = Object.assign({}, t.cssVars || {});
      try {
        

        const pc2 = this.store.getPluginConfig(id, uid, scope) || {};
        const seedLight = normalizeSeed(pc2.seed);
        const seedDark = normalizeSeed(pc2.seedDark) || seedLight;
        const scheme = String(pc2.scheme || 'standard');
        if (seedDark) { let p = paletteFromSeed(seedDark, true); if (p) dark = Object.assign({}, dark, applyScheme(p, scheme, true)); }
        if (seedLight) { let p = paletteFromSeed(seedLight, false); if (p) light = Object.assign({}, light, applyScheme(p, scheme, false)); }
        
        const cardStyle = String(pc2.cardStyle || cssVars['gc-card-style'] || 'outlined');
        const cornerScale = Math.max(0.5, Math.min(2, Number(pc2.cornerScale) || 1));
        const strokeW = Math.max(0, Math.min(4, Number(pc2.strokeWidth) || 1));
        const r = (base) => Math.round(base * cornerScale) + 'px';
        cssVars['gc-radius-card'] = r(Number(String(cssVars['gc-radius-card'] || '20').replace(/[^0-9.]/g, '')) || 20);
        cssVars['gc-radius-input'] = r(Number(String(cssVars['gc-radius-input'] || '12').replace(/[^0-9.]/g, '')) || 12);
        cssVars['gc-radius-btn'] = r(Number(String(cssVars['gc-radius-btn'] || '12').replace(/[^0-9.]/g, '')) || 12);
        cssVars['gc-radius-chip'] = r(Number(String(cssVars['gc-radius-chip'] || '8').replace(/[^0-9.]/g, '')) || 8);
        cssVars['gc-stroke-width'] = strokeW + 'px';
        cssVars['gc-card-style'] = cardStyle;
        cssVars['gc-scheme'] = scheme;
      } catch (_) {  }
      out.push({
        id, name: t.name || inst.manifest.name || id, builtin: !!inst.manifest._builtin,
        locked: forced, dark, light, cssVars,
      });
    }
    out.sort((a, b) => (b.locked ? 1 : 0) - (a.locked ? 1 : 0)); 
    return out;
  }

  
  installPackage(buf, expectedSha256) {
    const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
    if (expectedSha256 && actualSha !== String(expectedSha256).toLowerCase()) {
      throw new Error(`SHA256 不匹配! 期望 ${expectedSha256} 实际 ${actualSha} —— 安装已中止(可能被篡改)`);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-pkg-'));
    try {
      const tarBuf = zlib.gunzipSync(buf);
      untar(tarBuf, tmp);
      let root = tmp;
      if (!fs.existsSync(path.join(root, 'manifest.json'))) {
        const subs = fs.readdirSync(tmp).filter(d => fs.statSync(path.join(tmp, d)).isDirectory());
        if (subs.length === 1 && fs.existsSync(path.join(tmp, subs[0], 'manifest.json'))) root = path.join(tmp, subs[0]);
      }
      const mfPath = path.join(root, 'manifest.json');
      if (!fs.existsSync(mfPath)) throw new Error('包内找不到 manifest.json（不是合法的插件包）');
      const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
      if (!manifest.id || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) throw new Error('manifest.id 缺失或非法（只能小写字母/数字/连字符）');
      if (manifest.type && !['auth', 'business'].includes(manifest.type)) throw new Error('manifest.type 只能 auth 或 business');
      if (manifest.hasServer && !fs.existsSync(path.join(root, 'server.js'))) throw new Error('manifest 声明 hasServer 但缺少 server.js');
      const dest = path.join(this.pluginsDir, manifest.id);
      if (fs.existsSync(dest)) throw new Error(`插件已存在: ${manifest.id}（更新请先卸载旧版）`);
      fs.mkdirSync(this.pluginsDir, { recursive: true });
      fs.renameSync(root, dest);
      this.scanInstalled();
      return { id: manifest.id, manifest, sha256: actualSha };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  async installFromUrl(url, sha256, proxyUrl) {
    const buf = await downloadBuf(url, undefined, undefined, proxyUrl || null);
    return this.installPackage(buf, sha256);
  }

  
  async downloadIndex(url, proxyUrl) {
    const buf = await downloadBuf(url, 2 * 1024 * 1024, 5, proxyUrl || null);
    return buf;
  }

  removePlugin(pluginId, keepData) {
    for (const key of [...this.active.keys()]) if (key.endsWith('/' + pluginId)) this.deactivateByKey(key);
    const dir = path.join(this.pluginsDir, pluginId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (!keepData) {
      try {
        for (const u of fs.readdirSync(this.dataDir)) {
          const f = this.dataFile(u, pluginId);
          if (fs.existsSync(f)) fs.rmSync(f, { force: true });
        }
      } catch {}
      
      try { fs.rmSync(this.store.pluginConfigFile(pluginId), { force: true }); } catch {}
    }
    this.scanInstalled();
    return true;
  }

  
  configSchema(uid, pluginId, cfg, scope) {
    const inst = this.installed.get(pluginId);
    if (!inst) return null;
    const pc = this.store.pluginEnableList(cfg).find(p => p.id === pluginId);
    const isTheme = inst.manifest.type === 'theme';
    const s = isTheme ? (scope === 'admin' ? 'admin' : 'user') : undefined;
    return {
      schema: inst.manifest.configSchema || [],
      config: this.store.getPluginConfig(pluginId, uid, s) || (pc ? (pc.config || {}) : {}),
    };
  }

  
  async handle(cfg, req, res, u, p, body) {
    const uid = req._uid != null ? req._uid : (cfg._uid != null ? cfg._uid : 1);
    const segs = p.split('/').filter(Boolean);
    const json = (code, obj) => {
      const s = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(s);
    };

    if (segs.length === 1) { 
      if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' });
      const list = this.userPlugins(uid, cfg);
      const accept = String(req.headers.accept || '');
      if (accept.includes('text/html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderPluginIndex(list, cfg._name || 'default'));
      }
      return json(200, { ok: true, plugins: list });
    }
    if (segs[1] === 'required') {
      if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' });
      return json(200, { ok: true, required: cfg.requiredPlugins || [] });
    }

    const pluginId = segs[1];
    const subPath = '/' + segs.slice(2).join('/');
    const state = this.active.get(uid + '/' + pluginId);
    if (!state) return json(404, { error: `插件未启用: ${pluginId}` });
    

    this.maybeReloadData(pluginId, uid);

    const handler = state.routes.get(req.method.toUpperCase() + ' ' + subPath);
    if (handler) {
      const params = {
        query: Object.fromEntries(u.searchParams),
        body: tryJson(body),
        rawBody: body,
        headers: req.headers,
        
        
        authAdmin: () => this.authChain ? this.authChain.checkAdmin(cfg, req, u.searchParams) : { ok: true },
        



        userKey: (() => {
          try {
            if (!this.authChain) return null;
            const r = this.authChain.check(cfg, req, u.searchParams);
            return (r && r.ok && r.userKey) ? r.userKey : null;
          } catch (_) { return null; }
        })(),
        token: (() => {
          const a = req.headers.authorization || '';
          if (a.startsWith('Bearer ')) return a.slice(7).trim();
          return req.headers['x-api-key'] || u.searchParams.get('key') || '';
        })(),
      };
      try { await handler(req, res, params); }
      catch (e) { this.log(`[${pluginId}] ${subPath} 处理异常:`, e.stack || e.message); if (!res.headersSent) json(500, { error: '插件内部错误: ' + e.message }); }
      return;
    }

    const rel = subPath.replace(/^\/+/, '') || state.manifest.userPage || 'index.html';
    const filePath = path.normalize(path.join(state.dir, rel));
    if (!filePath.startsWith(state.dir)) { res.writeHead(403); return res.end('Forbidden'); }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(fs.readFileSync(filePath));
    }
    json(404, { error: `插件路由不存在: ${pluginId}${subPath}` });
  }
}

function tryJson(s) { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }


function renderPluginIndex(list, instName) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = (instName === 'default' ? '' : '/' + encodeURIComponent(instName)) + '/plugins/';
  const cards = list.map(p => {
    const href = base + p.id + '/' + (p.userPage || 'pages/user.html');
    const icon = p.icon
      ? `<img class="icon" src="${esc(base + p.id + '/' + p.icon)}" alt="">`
      : `<div class="icon emoji">🧩</div>`;
    return `<a class="card" href="${esc(href)}">${icon}<div class="name">${esc(p.name)}</div><div class="desc">${esc(p.description || '')}</div><div class="open">打开 →</div></a>`;
  }).join('\n');
  const empty = `<div class="empty">🧩<br><br>还没有启用的插件<br><span>请管理员在插件管理里安装并启用</span></div>`;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>插件中心${instName === 'default' ? '' : ' · ' + esc(instName)}</title>
<style>
  *{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#121212;color:#e8eaed;margin:0;padding:20px}
  header{max-width:880px;margin:8px auto 22px;display:flex;align-items:center;gap:12px}
  header h1{font-size:22px;margin:0}
  header .inst{font-size:12px;color:#9aa0a6;background:#1e1e1e;padding:4px 12px;border-radius:20px}
  .grid{max-width:880px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
  .card{background:#1e1e1e;border-radius:20px;padding:22px;text-decoration:none;color:inherit;display:flex;flex-direction:column;transition:.15s;box-shadow:0 2px 10px rgba(0,0,0,.35)}
  .card:hover{background:#262626;transform:translateY(-2px)}
  .icon{font-size:38px;width:56px;height:56px;display:flex;align-items:center;justify-content:center;background:#2a2a2a;border-radius:16px;margin-bottom:14px}
  img.icon{object-fit:cover}
  .name{font-size:17px;font-weight:600;margin-bottom:6px}
  .desc{font-size:13px;color:#9aa0a6;line-height:1.5;flex:1}
  .open{margin-top:14px;font-size:13px;color:#8ab4f8;font-weight:600}
  .empty{max-width:880px;margin:60px auto;text-align:center;color:#9aa0a6;font-size:16px;line-height:2}
  .empty span{font-size:13px;color:#666}
</style></head><body>
<header><h1>🧩 插件中心</h1><span class="inst">${esc(instName)}</span></header>
<div class="grid">${list.length ? cards : empty}</div>
</body></html>`;
}

module.exports = { PluginManager, downloadBuf, HOOK_NAMES };
