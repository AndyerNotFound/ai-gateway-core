'use strict';
/** plugins.js - PluginManager v2 (kernel responsibility: the loader itself, doc §2.1/§7)
   * differences from the old version:
*   - manifest.type: 'auth'|'business', auth plugins load before business plugins; auth activation failure = fail-closed blocking (§3.2)
*   - Data/config isolated per UID (plugins-data/<uid>/<id>.json, plugins-config/<id>.json[uid]); renames stay intact (§4/§6)
*   - ctx extensions (§7.1): getPluginConfig/getInstanceConfig/registerAuth/registerExtraEndpoint/wrapWriter/
 *     onRequest/onResponse/encrypt/decrypt/emit/on/upstreamRequest/stats
*   - permissions checked at runtime (§7.3): calling an undeclared sensitive API throws
*   - hook aggregation: hooksFor(uid) produces the hooks object router.handleChat needs
 */
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

/** minimal tar extraction (files/dirs only, path-traversal safe). Plugin packages use .tar.gz (zero-dep, cross-platform). */
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

/** download a URL -> Buffer (follows redirects, 30s timeout, 50MB default cap) */
function downloadBuf(url, maxBytes = 50 * 1024 * 1024, redirects = 5, proxyUrl = null) {
  return new Promise((resolve, reject) => {
    let lib;
    try { lib = url.startsWith('https') ? https : http; } catch (e) { return reject(e); }
    /* optional proxy (for downloading plugin packages, e.g. a phone proxy at 127.0.0.1:7890) */
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

/** every legal router hook name (kept in sync with router.js NO_HOOKS) */
const HOOK_NAMES = ['onRequestBody', 'onChatAuth', 'onQuotaEstimate', 'needConvert', 'wrapWriter', 'processCanonicalResp',
  'onResponseEvent', 'onResponseLine', 'onResponseBody', 'sanitizeText', 'onUsage', 'onChatDone', 'billing'];

/** legal manifest.type values: auth = auth plugin / business = business plugin / theme = theme plugin (palette only, no server.js) */
const PLUGIN_TYPES = ['auth', 'business', 'theme'];

/** the plugin directory's content SHA256 (for security-verification disclosure when the App adds a server): hash file by file after sorting relative paths. */
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
  /**
* @param store  Store instance (UID / plugin config / data directory)
   * @param deps   { authChain, upstreamRequest, encrypt, decrypt, log }
   */
  constructor(store, deps = {}) {
    this.store = store;
    this.gwDir = store.dir;
    this.pluginsDir = store.pluginsDir;
    this.dataDir = store.pluginsDataDir;
    this.log = deps.log || ((...a) => defaultLog('[plugins]', ...a));
    this.authChain = deps.authChain || null;          // the AuthChain instance (used by registerAuth)
    this.upstreamRequest = deps.upstreamRequest || null;
    this.pickChannels = deps.pickChannels || null;
    this.crypt = deps.crypt || null;                  // {encrypt, decrypt}, field-level
    /* plugin-contributed admin pages: 'uid/pluginId/pageId' -> page definition (registerAdminUi) */
    this._adminUiPages = new Map();
    this.bus = new EventEmitter();                    // event bus (ctx.emit/on)
    this.bus.setMaxListeners(100);
    /** installed: id -> {manifest, dir} */
    this.installed = new Map();
    /** active: `${uid}/${id}` -> state */
    this.active = new Map();
    /** extended endpoint registry: 'METHOD /v1/xxx' -> {pluginId, uid, handler} (§7.1 registerExtraEndpoint) */
    this.extraEndpoints = new Map();
    /** top-level route registry: 'METHOD /credits' -> {pluginId, uid, handler} (auth plugins) */
    this.topRoutes = new Map();
    /** global card branch whitelist: token -> {uid, branches} (registered by auth-cardkey; checked globally after core routing, blocking keyless bypass of the target instance) */
    this.globalKeys = new Map();
    /** plugin config version: pluginId -> number (shared across instances; detects stale config copies) */
    this._cfgRev = new Map();
/** Plugin runtime-data version counter: pluginId -> number (same idea; the object is ctx.data)
     *  *added 2026-09-18: the data write path (flushData) used to neither bump a version nor broadcast,
     *  so "card usage/rules another instance just wrote" were invisible here, and persisting here would wipe them with the stale snapshot. */
    this._dataRev = new Map();
    this.gateway = deps.gateway || null;
/** Capability registry (2026-10-07 deep refactor): uid+cap -> {uid,name,impl,pluginId,seq}
     *  why: "who provides model prices" used to be hardcoded in the kernel (getPluginConfig('model-square', 0)); a different provider would break it.
     *  turned into a runtime-queryable fact: plugins provideCapability('model-pricing', impl); consumers requireCapability(...).
     *  vs hooks: hooks are a kernel-defined pipeline (the kernel must know which hooks exist); capabilities are a freely-contracted surface between plugins. */
    this._capabilities = new Map();
    this._capSeq = 0;
    /** *global capability layer (2026-10-07): dataScope=global plugins (prices/groups/users/cards -- data shared across all instances),
     *  its capability registers under uid=0 for kernel logic that ignores instances (e.g. the model group index).
     *  why needed: group/price config itself lives under the uid=0 key (global); if a capability registers only under an instance uid,
*  the core's groupIndex() finds nothing -- visible as "the group index is forever empty".
     *  *declarative: decided by manifest.dataScope==='global'; the kernel never checks plugin names. */
    this._globalCaps = new Set();
    /** *per-instance latest-request client capabilities (2026-10-07): for synchronous ctx.clientCaps() reads.
     *  why "the latest one": gcui pages are **request-driven**; a plugin's render usually runs while handling some request;
     *  but ctx is created once at activation and cannot see per-request args, so this rolls forward per request,
     *  render(params) carries the precise value too (higher priority). */
    this._lastCaps = new Map();
    /* intent security protocol store: uid -> {keys:{tokenHash:{lastSeq,nonces[],intents{}}}, dirty} (Gay Core §3) */
    this._secCache = new Map();
    this._secTimer = setInterval(() => this._flushSecAll(), 30000);
    if (this._secTimer.unref) this._secTimer.unref();
    this.scanInstalled();
  }

  scanInstalled() {
    this.installed.clear();
    /* two plugin dirs: built-ins (source plugins/) + the data dir (user-installed; same id overrides built-ins) */
    const dirs = [
      path.resolve(__dirname, '..', 'plugins'), // 内置插件(随内核分发)
      this.pluginsDir,                           // user-installed (data dir)
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
          /* Theme plugin hard constraint (Gay Core §11): style tokens only; no server logic/permissions */
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

  /* dependency topological sort (2026-10-07 deep refactor §B)
* Background: the manifest always had a depends field (billing -> model-square) but **no code ever read it** --
   *   searching the repo for .depends only found the declaration itself; the consequence was silent degradation on missing deps (showing up as "prices lost after switching branches"),
   *   instead of failing loudly. This activates it, benchmarked against Minecraft Forge's mod dependency resolution.
* Semantics:
   *   - topological sort: dependees load first (within the same type group)
   *   - missing dependencies: strict mode fails fast (the plugin does not load + a blocked report); default fail-soft (loads but warns clearly)
   *   - cycles: a detected cycle keeps the original order and warns (never a silent infinite loop)
   * @returns {{order:Array, missing:Array<{id,dep}>, cycles:string[]}}
   */
  _topoSort(entries) {
    const byId = new Map(entries.map(e => [e[0].id, e]));
    const missing = [], cycles = [];
    const out = [], state = new Map();   // id -> 1=in progress 2=done
    const visit = (id, stack) => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) { cycles.push(stack.concat(id).join(' → ')); return; }
      const e = byId.get(id);
      if (!e) return;
      state.set(id, 1);
      const deps = Array.isArray(e[1].manifest.depends) ? e[1].manifest.depends : [];
      for (const dep of deps) {
        const d = String(dep || '');
        if (!d) continue;
        if (!byId.has(d)) { missing.push({ id, dep: d }); continue; }   // dependency not enabled/not installed
        visit(d, stack.concat(id));
      }
      state.set(id, 2);
      out.push(e);
    };
    for (const e of entries) visit(e[0].id, []);
    return { order: out, missing, cycles };
  }

/* Activate the plugins an instance enables. type:'auth' first, then 'business'; auth plugin failure fail-closed blocks (§3.2).
* ★2026-10-07: topological sort within a group by manifest.depends (depends used to be ignored entirely).
* Returns {ok, blocked?:reason, warnings?:[], missing?:[], cycles?:[]} */
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
    /* dependency resolution: strict mode via instance config strictDepends=true (default fail-soft, never interrupting live service) */
    const strict = !!(cfg && cfg.strictDepends);
    const warnings = [], allMissing = [], allCycles = [];
    const resolve = (arr) => {
      const r = this._topoSort(arr);
      for (const m of r.missing) {
        allMissing.push(m);
        this.log(`[uid:${uid}] ⚠ 依赖缺失: 插件 ${m.id} 需要 ${m.dep}，但该插件未启用/未安装` +
          (strict ? ' → strictDepends 已开, 跳过该插件' : ' → 继续加载(可能功能降级)'));
      }
      for (const c of r.cycles) { allCycles.push(c); this.log(`[uid:${uid}] ⚠ 依赖成环: ${c} → 按声明顺序加载`); }
      /* strict: drop plugins with incomplete dependencies */
      const order = strict ? r.order.filter(e => !r.missing.some(m => m.id === e[0].id)) : r.order;
      return order;
    };
    const authOrder = resolve(authPlugins);
    const bizOrder = resolve(bizPlugins);
    if (allMissing.length) warnings.push('依赖缺失 ' + allMissing.length + ' 处');
    if (allCycles.length) warnings.push('依赖成环 ' + allCycles.length + ' 处');

    // 1) auth plugins load first, fail-closed
    for (const [pc, inst] of authOrder) {
      const r = this.activateOne(uid, pc, inst, cfg);
      if (!r.ok) {
        this.log(`[uid:${uid}] 认证插件 ${pc.id} 激活失败 → fail-closed, 阻断后续插件加载`);
        return { ok: false, blocked: 'auth plugin failed: ' + pc.id + ' — ' + r.error, warnings, missing: allMissing, cycles: allCycles };
      }
    }
    // 2) business plugins (dependency-ordered: dependees first)
    for (const [pc, inst] of bizOrder) this.activateOne(uid, pc, inst, cfg);
    return { ok: true, warnings, missing: allMissing, cycles: allCycles };
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
      /* the "seen" watermark for runtime-data versions -- decides whether to re-read disk before dispatch (see maybeReloadData) */
      _dataSeen: this._dataRev.get(pc.id) || 0,
      // config: plugins-config/<id>.json[uid] first, falling back to inline cfg.plugins[].config (legacy format)
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

/** ctx factory (docs §7.1). perms: per-item runtime checks of sensitive capabilities. */
  makeCtx(state, cfg) {
    const self = this;
    state._instCfg = cfg; // instance config reference (used by security.verifyIntent auth)
    const perms = new Set(state.manifest.permissions || []);
    const needPerm = (p) => { if (!perms.has(p)) throw new Error(`插件 ${state.pluginId} 未声明权限: ${p}`); };
    const uid = state.uid;
    return {
      id: state.pluginId,
      uid,
      instanceName: cfg._name,
      config: state.cfg,

      /* -- config (§6.2 via the kernel middle layer, never reading files directly) -- */
      getPluginConfig: (pluginId, u) => self.store.getPluginConfig(pluginId, u == null ? uid : u),
      setPluginConfig: (u, conf) => { // setPluginConfig(config) or setPluginConfig(uid, config)
        if (conf === undefined) { conf = u; u = uid; }
        self.store.setPluginConfig(state.pluginId, u == null ? uid : u, conf);
        state.cfg = conf;
        /* bump the config version +1 and **immediately** push-sync the new config to the plugin's other instances (state.cfg refreshed in place).
         * *2026-09-18 changed from "only bump the version" to "push-sync": a version number helps only if the plugin itself polls cfgLive(),
         *  yet most plugins never check (model-square didn't -> user report "Guili branch has prices, switching to default shows none").
         *  see the bumpCfgRev comment for details. */
        self.bumpCfgRev(state.pluginId, state.key);
      },
      /** config version (for plugins: a change means re-fetch via getPluginConfig) */
      configRev: () => self._cfgRev.get(state.pluginId) || 0,
      getInstanceConfig: (u) => {
        const c = self.store.loadInstance(u == null ? uid : u);
        if (!c) return null;
        const masked = self.crypt ? self.crypt.maskFields(c) : c;
        for (const k of Object.keys(masked)) if (k.startsWith('_')) delete masked[k];
        return masked;
      },

      /* -- HTTP routes -- */
      registerRoute(method, p, handler) { // /plugins/<id><path>
        if (!p.startsWith('/')) p = '/' + p;
        state.routes.set(method.toUpperCase() + ' ' + p, handler);
      },
      registerExtraEndpoint(method, p, handler) { // /v1/* extended endpoints (used by the openaiExtras plugin)
        needPerm('gateway:registerExtraEndpoint');
        const k = method.toUpperCase() + ' ' + p;
        self.extraEndpoints.set(k, { pluginId: state.pluginId, uid, handler });
      },
      registerTopRoute(method, p, handler) { // top-level routes (card /credits, user /auth/*)
        needPerm('gateway:topRoute');
        const k = uid + '|' + method.toUpperCase() + ' ' + p; /* key 带 uid: 同插件多实例各自注册不互相覆盖 */
        if (self.topRoutes.has(k)) self.log(`[${state.pluginId}] 顶层路由覆盖: ${k}`);
        self.topRoutes.set(k, { pluginId: state.pluginId, uid, handler });
      },

      /* -- auth (type:'auth' plugins only) -- */
      registerAuth(strategy, opts = {}) {
        needPerm('auth:registerAuth');
        if (state.manifest.type !== 'auth') throw new Error('只有 type:"auth" 的插件能注册认证策略');
        if (!self.authChain) throw new Error('内核未提供 authChain');
        strategy._pluginId = state.pluginId;
        strategy._uid = uid;   /* multi-instance: unregistration matches plugin+instance exactly (see deactivateByKey) */
        return self.authChain.registerAuth(strategy, opts);
      },
      /* auth plugin exposes APIs to other plugins (findKey/grantQuota/listKeys/...) */
      bindAuthApis(apis) {
        if (state.manifest.type !== 'auth') throw new Error('只有 type:"auth" 的插件能 bindAuthApis');
        self._bindingPluginId = state.pluginId;
        self.bindGatewayAuthApis(uid, apis);
        self._bindingPluginId = null;
      },

      /* -- forwarding hooks (used by thinkingSummary/redact/replace etc.) -- */
      hook(name, fn) {
        if (!HOOK_NAMES.includes(name)) throw new Error('未知 hook: ' + name + ' (可用: ' + HOOK_NAMES.join(', ') + ')');
        (state.hooks[name] = state.hooks[name] || []).push(fn);
      },
      wrapWriter(fn) { (state.hooks.wrapWriter = state.hooks.wrapWriter || []).push(fn); },
      onRequest(fn) { (state.hooks.onRequestBody = state.hooks.onRequestBody || []).push(fn); },
      onResponse(fn) { (state.hooks.onResponseBody = state.hooks.onResponseBody || []).push(fn); },

      /* -- infrastructure -- */
      data: {
        get: k => state.data[k],
        set: (k, v) => { state.data[k] = v; state.dirty = true; },
        del: k => { delete state.data[k]; state.dirty = true; },
        all: () => state.data,
        /* *2026-09-17 new: admin-side "low-frequency but important" writes can call this to flush immediately.
 * the default is still the 30s periodic flush (protects storage write volume); billing's rule saves use it,
         * previously only marked dirty; a restart / kill -9 beating the periodic flush lost freshly stored rules. */
        flush: () => self.flushData(state),
        /* *2026-09-18 multi-instance consistency: merge the freshest disk data back into memory **in place** (object references unchanged).
         *  before "read-modify-write" operations (like deducting usage) -- reload first, then modify, or you increment from a stale snapshot
         *  wiping usage another instance just wrote. With un-flushed local changes it **does not refresh** (returns false, preventing loss). */
        reload: () => self.reloadData(state),
        /** Runtime-data version (+1 on any instance's write); plugins can freshness-check against it */
        rev: () => self._dataRev.get(state.pluginId) || 0,
      },
      /* plugin-private data dir (plugins-data/<uid>/<id>/, created lazily, files writable) */
      get dataDir() {
        const d = path.join(self.dataDir, String(uid), state.pluginId);
        try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
        return d;
      },
      /* -- admin page contributions (registerAdminUi) --
       * lets plugins ship their admin UI as **gcui server pages**, delivered through the kernel's /admin/ui/<id>,
* the App admin can draw it with the native renderer (instead of stuffing a WebView in, which looks out of place).
       * declared fields: { id, title, subtitle?, icon?, menu?, render(gw, cfg, q) -> gcui page }
       *   id     : page id (lowercase letters/digits/hyphens). Same name as a kernel page = override it; otherwise a new page/menu item.
       *   menu   : default true (in the sidebar); false = sub-page only, openable via `open page:/admin/ui/<id>`.
       *   render : returns gcui JSON (same page format as admin-ui.js); exceptions are caught and shown as an error page.
       * *security: this page loads from the **admin side** (x-admin-key); route its write operations through adminApi
       *   /admin/api/plugin-call (whitelisted plugins) or its own /admin/ endpoints -- pages never embed secrets. */
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
        /* tolerant signature: cron(ms, fn) or cron(name, ms, fn) */
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
        void inst; void delta; // stats hook reserved: the kernel stats structure carries it; plugins usually use onUsage/onChatDone
      },
      emit: (ev, data) => self.bus.emit(state.pluginId + ':' + ev, data),
      on: (ev, fn) => self.bus.on(ev, fn),          // listen to any plugin event 'pluginId:event'
      encrypt: v => { if (!self.crypt) throw new Error('内核未启用加密'); return self.crypt.encrypt(v); },
      decrypt: v => { if (!self.crypt) throw new Error('内核未启用加密'); return self.crypt.decrypt(v); },

      /* -- intent security protocol (Gay Core SDUI, design doc §3/§7) --
       * guard(req, params, res, fn): all-in-one signature verification + time window + nonce dedup + sequence anti-rollback + idempotency; fn(keyRecord) returns the response object.
       * signature = HMAC_SHA256(card, ts\nnonce\nseq\nintentId\nMETHOD\npathname\nsha256(body)) */
      security: {
        verifyIntent: (req, params) => self.verifyIntent(state, req, params),
        commit: (token, intentId, seq, nonce, response) => self.commitIntent(state, token, intentId, seq, nonce, response),
        guard: (req, params, res, fn) => {
          const jsonRes = (code, obj) => { try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); } catch (_) {} };
          const v = self.verifyIntent(state, req, params);
          if (!v.ok) return jsonRes(v.status || 401, { ok: false, error: v.error, currentSeq: v.currentSeq });
          if (v.replay !== undefined) return jsonRes(200, v.replay); // idempotent hit: return the previous response
          let out;
          try { out = fn(v.keyRecord); } catch (e) { self.log(`[${state.pluginId}] intent 处理异常:`, e.stack || e.message); return jsonRes(500, { ok: false, error: '插件内部错误: ' + e.message }); }
          const h2 = (req && req.headers) || {};
          self.commitIntent(state, params.token || '', String(h2['x-gc-intent-id'] || ''), Number(h2['x-gc-seq'] || 0), String(h2['x-gc-nonce'] || ''), out);
          jsonRes(200, out);
        },
      },

      /* -- capability inversion: plugin-to-plugin cooperation no longer requires knowing the other's plugin id -- */
      /** provide a capability. name is a free convention (kebab-case advised), decoupled from plugin ids. */
      provideCapability(name, impl) {
        /* *global-ness is decided by manifest.dataScope (declarative); the kernel never checks plugin names */
        const isGlobal = (state.manifest && state.manifest.dataScope === 'global');
        return self.provideCapability(uid, name, impl, state.pluginId, isGlobal);
      },
      /** fetch one capability; no provider -> null (degrade on your own; never throw). */
      requireCapability(name) { return self.requireCapability(uid, name); },
      /** capability names registered on this instance */
      listCapabilities() { return self.listCapabilities(uid).map(c => c.name); },

      /* -- client capability self-check (2026-10-07): lets plugins render "to what the App knows" instead of degrading on unknown components -- */
      /** the latest request's App capability view; no header -> null (render conservatively) */
      clientCaps() { return self._lastCaps.get(String(uid)) || null; },   /* already a capsView (has hasComponent etc.) */

      /* *gcui Kit (2026-10-08, DEVLOG 2.70): dual-mode components moved into the standalone kernel module src/gcui-kit.js
       *  -- plugins declare only "what to filter"; caps probing and the setState/open branches live in the kernel;
       *  zero App involvement, zero rebuilds; plugin authors can require this module to stub ctx.gcui in tests. */
      gcui: require('./gcui-kit'),

      /* -- upstream calls (reusing the kernel agent pool/proxies) -- */
      upstreamRequest(opts) {
        if (!self.upstreamRequest) throw new Error('内核未提供 upstreamRequest');
        return self.upstreamRequest(cfg, opts);
      },
      /* channel routing (same logic as the kernel): returns [{ch, upstreamModel}] */
      pickChannels(model) { return self.pickChannels ? self.pickChannels(cfg, model) : []; },

      /* -- gateway capabilities (granted per permissions) -- */
      gateway: {
        uid,
        instanceName: cfg._name,
        findKey: token => { needPerm('gateway:findKey'); const a = self._gwApisByUid && self._gwApisByUid.get(uid); return a && a.apis.findKey ? a.apis.findKey(cfg, token) : null; },
        grantQuota: (keyId, tokens) => { needPerm('gateway:grantQuota'); const a = self._gwApisByUid && self._gwApisByUid.get(uid); return a && a.apis.grantQuota ? a.apis.grantQuota(cfg, keyId, tokens) : false; },
        /** Hot-reload this instance (call after config persistence) */
        reload() { if (self.gateway) self.gateway.loadInstance(uid); },
        /** Edit an instance config and hot-reload: mutator(cfg) edits in place */
        saveInstanceConfig(mutator) {
          needPerm('gateway:saveConfig');
          const c = self.store.loadInstance(uid);
          if (!c) return false;
          mutator(c);
          self.store.saveInstance(uid, c);
          if (self.gateway) self.gateway.loadInstance(uid);
          return true;
        },
        /** Instance list (meta) */
        listInstances() { return self.store.index.instances.map(m => ({ uid: m.uid, name: m.name, port: m.port, enabled: m.enabled !== false })); },
        /** All channels of this instance (unmasked; plugins use it for models/groups) */
        instanceChannels() { const c = self.store.loadInstance(uid); return c ? (c.channels || []) : []; },
        /** Site profile (currency symbol / FX etc.; bootstrap already publishes it; nothing sensitive) */
        serverInfo() { return self.store.getServerInfo() || {}; },
        /** Model group index (model -> group; for card group whitelists/filters) -- reads model-square config + name-prefix inference */
        modelGroups() {
          needPerm('gateway:modelGroups');
          const gi = (self.gateway && self.gateway.groupIndex) ? self.gateway.groupIndex() : null;
          if (gi) return { declared: gi.declared.slice(), groupsOf: m => gi.groupsOf(m), matches: (m, g) => gi.matches(m, g) };
          const fb = require('./modelgroups').buildIndex(self.store);
          return { declared: fb.declared.slice(), groupsOf: m => fb.groupsOf(m), matches: (m, g) => fb.matches(m, g) };
        },
        /** Register/unregister the global card branch whitelist (used by auth-cardkey) */
        registerGlobalKey(token, branches) { needPerm('gateway:registerGlobalKey'); self.globalKeys.set(token, { uid, branches: branches || [], pluginId: state.pluginId }); },
        unregisterGlobalKey(token) { self.globalKeys.delete(token); },
        /** APIs exposed by auth plugins (findKey/grantQuota/listKeys/addKey/...); other plugins reach card capabilities through it */
        authApis() { needPerm('gateway:authApis'); const a = self._gwApisByUid && self._gwApisByUid.get(uid); return (a && a.apis) || {}; },
        /* *encryption passphrase switch (for the 2026-09-18 "key vault" plugin): passphrase lives in memory only, never on disk.
         *  plugins own UI/flow (signed intents + SDUI pages); the kernel provides only these four actions plus persistence/reload. */
        cryptStatus() { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptStatus() : null; },
        cryptUnlock(pass, adminKey) { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptUnlock(pass, adminKey) : { ok: false, error: '内核不支持' }; },
        cryptLock() { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptLock() : { ok: false, error: '内核不支持' }; },
        cryptReencrypt(pass) { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptReencrypt(pass) : { ok: false, error: '内核不支持' }; },
        cryptCleanBackups() { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptCleanBackups() : { ok: false, error: '内核不支持' }; },
      },

      log: (...a) => self.log(`[${state.pluginId}]`, ...a),
    };
  }

/* Capabilities an auth plugin provides once registered (findKey/grantQuota/listKeys/addKey/updateKey/deleteKey etc., bound by the auth plugin) */
  bindGatewayAuthApis(uid, apis) {
    if (!this._gwApisByUid) this._gwApisByUid = new Map();
    const cur = this._gwApisByUid.get(uid);
    /* duplicate bindings within an instance merge (same-named fields overwritten) and record the owning plugin */
    this._gwApisByUid.set(uid, { apis: Object.assign((cur && cur.apis) || {}, apis), pluginId: (cur && cur.pluginId) || this._bindingPluginId || null });
  }

  /* ---------- hook aggregation: produce the hooks object router.handleChat needs ---------- */
  hooksFor(uid) {
    const states = [...this.active.values()].filter(s => s.uid === uid);
    if (!states.length) return null;
    const collect = (name) => states.flatMap(s => (s.hooks[name] || []));
    const hooks = {};
    const onRequestBody = collect('onRequestBody');
    if (onRequestBody.length) hooks.onRequestBody = (body, ctx) => { for (const fn of onRequestBody) { try { body = fn(body, ctx) || body; } catch (e) { this.log('onRequestBody:', e.message); } } return body; };
    const onChatAuth = collect('onChatAuth');
/* ★2026-09-18: onChatAuth used to "return on the first non-empty decision" -- but for **allowed** requests auth-cardkey
     *  it also returned a "quota pre-authorization" object (non-empty), so later plugins (like billing's "unpriced models must not be called")
     *  **never got its turn**. Now: any plugin's **rejection** (status>=400 or carrying a message) takes effect immediately;
     *  otherwise remember and return the first non-empty object (preserving quota pre-authorization semantics). */
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
    /* *pre-auth estimate (2026-09-18): the sole channel converting "token counts" into "quota".
     *  background: settlement goes through billing (charged = raw/1e6 x multiplier, magnitude 1e-3), while pre-auth freezing originally
     *  raw token counts (magnitude 1e3) -> a million-fold error; a card with 99.97 quota got
     *  "this request pre-authorizes about 13209" and 429-rejected, while it actually deducted 0.01.
     *  convention: the registrar (billing, the single source of pricing truth) returns the estimate in **quota units**;
     *        returning null/invalid = no estimate this time (billing absent / model unpriced) ->
     *        callers fall back to the legacy "1 token = 1 quota" convention (strictly aligned with legacy settlement).
     *  value semantics: the first valid (non-null, finite, >=0) number wins. */
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
    /* dynamic billing: with multiple plugins, evaluate **in registration order**; the last non-null result wins (later registrations have higher priority).
     * convention: return a number = weighted tokens to deduct; {charged, detail} may carry a breakdown; null = not participating (hand to the next one). */
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

  /* ---------- Data persistence (isolated per UID) ---------- */
  dataFile(uid, pluginId) {
    /* dataScope=global plugins (users/cards) share data globally: plugins-data/_global/<id>.json */
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
      /* *"read-old-then-merge" before persisting (2026-09-18 multi-instance consistency): this instance's memory is a **snapshot from activation**,
       *  the disk may already hold keys other instances wrote later -- overwriting straight from memory would wipe them wholesale
       *  (the same trap as plugin config ctx.config; verified: one price write from default deleted Guili's keys).
       *  merge convention: disk as base + memory overrides (top-level keys this instance changed win; keys only other instances have are preserved). */
      let disk = null;
      try { disk = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { disk = null; }
      const out = (disk && typeof disk === 'object' && !Array.isArray(disk))
        ? Object.assign({}, disk, state.data) : state.data;
      fs.writeFileSync(f, JSON.stringify(out, null, 2));
      if (out !== state.data) {           /* sync memory to the merged result, keeping "memory == disk" (in place, references unchanged) */
        for (const k of Object.keys(state.data)) delete state.data[k];
        Object.assign(state.data, out);
      }
      state.dirty = false;
      this._dataRev.set(state.pluginId, (this._dataRev.get(state.pluginId) || 0) + 1);
      state._dataSeen = this._dataRev.get(state.pluginId);
    } catch (e) { this.log('插件数据落盘失败:', e.message); }
  }

/** Global-scope plugin data is shared: re-read disk before dispatch when there are no local unflushed changes (and another instance wrote).
*  ★With local changes, do **not refresh** -- refreshing would drop this instance's just-charged fees / just-edited rules (slightly stale beats lost). */
  maybeReloadData(pluginId, uid) {
    try {
      const st = this.active.get(uid + '/' + pluginId);
      if (!st || st.dirty) return;
      if (this.store.dataScope(pluginId) !== 'global') return;
      if ((this._dataRev.get(pluginId) || 0) === st._dataSeen) return;
      this.reloadData(st);
    } catch (_) {}
  }

/** Re-read runtime data in place (object identity unchanged, so ctx.data.all() references held by plugins stay valid). No-op when dirty. */
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

/** Bump the config version and sync the latest config **in place** to other instances of the same plugin (multi-instance consistency, 2026-09-18)
*  Background: plugin config is global-shared by default (no scope in manifest -> stored under `_global` in plugins-config/<id>.json),
   *  but each instance's plugin grabs an **independent** ctx.config at activate(), and the kernel never refreshes it ->
   *  instance A saved, but B still held the stale copy (measured: 5 of 6 instances had 231 old entries; only the writer had 260).
   *  why refresh must be **in place** (delete + assign): plugins captured the object reference in activate() via `const cfg = ctx.config`,
   *  swapping the whole object reference is invisible to them (auth-cardkey/auth-user also had their own cfgLive() fallback; after in-place refresh they sync automatically too).
   *  fromKey: the writer skips itself (state.cfg is exactly what it wrote). */
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

  /* ---------- Intent security protocol store (plugins-data/<uid>/.gc-security.json) ---------- */
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

  /* intent signature (Gay Core §3): HMAC_SHA256(token, ts\nnonce\nseq\nintentId\nMETHOD\npathname\nsha256(body)) */
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
    /* ownership check: the request must land in this plugin's namespace (/<branch>/plugins/<id>/...) */
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
    /* auth: confirm the key card is valid (via AuthChain) */
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
    rec.nonces = (rec.nonces || []).concat(nonce).slice(-200); // keep the latest 200 nonces
    rec.intents = rec.intents || {};
    rec.intents[intentId] = { ts: Date.now(), response };
    /* idempotency cache trimming: keep only entries within 24h / the latest 100 */
    const now = Date.now();
    const entries = Object.entries(rec.intents).filter(([, v]) => now - (v.ts || 0) < 86400e3).slice(-100);
    rec.intents = Object.fromEntries(entries);
    sec.keys[tokenHash] = rec;
    sec.dirty = true;
  }

  /* ---------- Disable ---------- */
  deactivateByKey(key) {
    const state = this.active.get(key);
    if (!state) return;
    for (const t of state.timers) { try { clearInterval(t); } catch {} }
    this.flushData(state);
    // unregister this plugin's auth strategies and extended endpoints / top-level routes / global cards
    /* *unregister by object (not by name: in multi-instance, same-named strategies would be stripped together, 401-ing other instances' cards) */
    if (this.authChain) for (const s of [...this.authChain.strategies, ...this.authChain.adminStrategies]) {
      if (s._pluginId === state.pluginId && String(s._uid) === String(state.uid)) this.authChain.unregisterAuthObj(s);
    }
    for (const [k, v] of [...this.extraEndpoints]) if (v.pluginId === state.pluginId && v.uid === state.uid) this.extraEndpoints.delete(k);
    for (const [k, v] of [...this.topRoutes]) if (v.pluginId === state.pluginId && v.uid === state.uid) this.topRoutes.delete(k);
    if (this._gwApisByUid) { const ga = this._gwApisByUid.get(state.uid); if (ga && ga.pluginId === state.pluginId) this._gwApisByUid.delete(state.uid); }
    for (const [k, v] of [...this.globalKeys]) if (v.pluginId === state.pluginId && v.uid === state.uid) this.globalKeys.delete(k);
    /* remove this plugin's contributed admin pages (nothing lingers after disable/reload) */
    for (const k of [...this._adminUiPages.keys()]) if (k.startsWith(String(state.uid) + '/' + state.pluginId + '/')) this._adminUiPages.delete(k);
    /* remove this plugin's contributed capabilities (same reclamation semantics as effects: uninstall -> registration rollback) */
    for (const [ck, cv] of [...this._capabilities]) {
      if (cv.pluginId === state.pluginId && (String(cv.uid) === String(state.uid) || cv.globalFrom !== undefined)) {
        this._capabilities.delete(ck);
        this._globalCaps.delete(String(cv.globalFrom === undefined ? state.uid : cv.globalFrom) + '\u0000' + cv.name);
      }
    }
    if (state.module && typeof state.module.deactivate === 'function') {
      try { state.module.deactivate(); } catch (e) { this.log(`[${key}] deactivate:`, e.message); }
    }
    this.active.delete(key);
  }
  deactivateInstance(uid) {
    for (const key of [...this.active.keys()]) if (key.startsWith(uid + '/')) this.deactivateByKey(key);
  }

  /* ---------- Plugin-contributed admin pages ---------- */
/** A plugin-page table for one instance (in registration order; later registration wins on duplicate ids)
*  ★2026-10-07: every page's render is wrapped -- the App capability view is injected as the **4th argument**,
   *  plugins can therefore self-check before generating a page ("does this App know segmented") instead of degrading upon hitting an unknown component. */
  adminPages(uid) {
    const out = [], seen = new Set();
    const pre = String(uid) + '/';
    for (const [k, v] of [...this._adminUiPages].reverse()) {
      if (!k.startsWith(pre)) continue;
      if (seen.has(v.id)) continue;   // later registrations win
      seen.add(v.id); out.push(v);
    }
    return out.reverse().map(v => {
      const raw = v.render;
      if (typeof raw !== 'function') return v;
      return Object.assign({}, v, {
        render: (gw, cfg, q) => raw(gw, cfg, q, this._lastCaps.get(String(uid)) || null),
      });
    });
  }
/** Look up a plugin page (for rendering); none -> null */
  adminPage(uid, id) {
    return this.adminPages(uid).find(p => p.id === id) || null;
  }

  /* ---------- Admin-endpoint proxy-call declarations (de-hardcoded 2026-10-07) ----------
* Read a plugin manifest's adminApi array (path prefixes). null = the plugin declared none (proxy calls forbidden);
* an array = prefixes allowed for proxy calls (empty array forbids too). The core no longer holds any plugin-name constants. */
  adminApiDecl(pluginId, uid) {
    const id = String(pluginId || '');
    if (!id) return null;
/* Must be both "installed" and "enabled/running on that instance" -- a plugin that is not running has no endpoints to call */
    const inst = this.installed.get(id);
    if (!inst) return null;
    const list = Array.isArray(inst.manifest.adminApi) ? inst.manifest.adminApi : null;
    if (!list) return null;
    return list.map(x => String(x || '')).filter(Boolean);
  }

  /* ---------- Capability Registry (2026-10-07) ----------
* Modeled on Minecraft Forge's Capability / DSH's ctx service seam:
   *   provider: ctx.provideCapability(name, impl)   any plugin may provide it; no specific plugin is required
   *   consumer: ctx.requireCapability(name)         returns null when unavailable (degrade gracefully); never throws and interrupts rendering
   *   kernel:   listCapabilities(uid)               queries by capability name only, never by plugin name
* Semantics (aligned with Forge's LazyOptional): a missing capability = null so the consumer can degrade, instead of throwing --
   *   "capability missing" is a normal state (the user has not installed that plugin), not a fault.
   */
  _capKey(uid, name) { return String(uid) + '\u0000' + String(name); }

/** Register a capability. impl is arbitrary (object or function, whatever provider and consumer agree on).
   *  *global capabilities (manifest.dataScope==='global') also register at the uid=0 layer for global logic to query. */
  provideCapability(uid, name, impl, pluginId, isGlobal) {
    const n = String(name || '').trim();
    if (!n) throw new Error('provideCapability: 缺少能力名');
    if (impl == null) throw new Error('provideCapability: 能力 ' + n + ' 的实现为空');
    const rec = { uid, name: n, impl, pluginId: pluginId || null, seq: ++this._capSeq };
    this._capabilities.set(this._capKey(uid, n), rec);
    /* global capabilities additionally mount at the uid=0 layer (same impl reference, not copied) */
    if (isGlobal && String(uid) !== '0') {
      this._capabilities.set(this._capKey(0, n), Object.assign({}, rec, { uid: 0, globalFrom: uid }));
      this._globalCaps.add(String(uid) + '\u0000' + n);
    }
    return true;
  }

/** Get a capability implementation; none -> null (consumers degrade on that). With multiple registrations on one instance, the latest wins.
*  ★Fallback order: instance layer -> global layer (uid=0) -- when a plugin registers only under an instance, global lookups still find it. */
  requireCapability(uid, name) {
    const r = this._capabilities.get(this._capKey(uid, name));
    if (r) return r.impl;
    if (String(uid) !== '0') {
      const g = this._capabilities.get(this._capKey(0, name));
      if (g) return g.impl;
    }
    return null;
  }

/** Record the client capability view of an instance's most recent request (read by ctx.clientCaps() and plugin-page render's 4th argument).
*  Passing null means "this request reported no capabilities" (web side) -- still recorded, so plugins can fall back to conservative rendering. */
  rememberCaps(uid, caps) {
/* ★Keys are always String(uid): learned the hard way -- Map keys Number(1) and '1' are not equal,
     *  writing as String and reading as Number **silently misses** (showing up as "the capability is always null"). */
    if (caps) this._lastCaps.set(String(uid), caps);
    else this._lastCaps.delete(String(uid));
  }

/** Dependency health report (for admin display): missing deps / cycles / topological order */
  dependsReport(uid, cfg) {
    const list = this.store.pluginEnableList(cfg);
    const enabled = list.filter(pc => pc && pc.enable && pc.id);
    const arr = [];
    for (const pc of enabled) { const inst = this.installed.get(pc.id); if (inst) arr.push([pc, inst]); }
    const r = this._topoSort(arr);
    return { order: r.order.map(e => e[0].id), missing: r.missing, cycles: r.cycles };
  }

/** List of capabilities registered by an instance (name + provider), for admin display / plugin self-checks */
  listCapabilities(uid) {
    const out = [];
    for (const v of this._capabilities.values()) {
      if (String(v.uid) !== String(uid)) continue;
      /* *api (2026-10-07): a capability may carry a **serializable endpoint description** (impl.api() returns a plain object).
       *  why: the App's native admin pages used to hardcode **specific plugin endpoints** like /plugins/auth-user/admin/users
       *  hardcoding them in source -> a different plugin (or a new one taking over the same capability) would be rejected by the App (violating "serve unknown plugins").
       *  capabilities now carry their own endpoint descriptions; the App looks endpoints up by **capability name**, never by plugin name.
       *  *backward compatible: impl without api() -> the field is null (old Apps/plugins unaffected). */
      let api = null;
      try { if (v.impl && typeof v.impl.api === 'function') api = v.impl.api() || null; } catch (_) { api = null; }
      out.push({ name: v.name, pluginId: v.pluginId, global: v.globalFrom !== undefined, api });
    }
    return out;
  }

  /* ---------- Queries ---------- */
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
        /* App UI registration (Gay Core): provides capability declarations / appUi UI slots / theme palette data */
        provides: Array.isArray(inst.manifest.provides) ? inst.manifest.provides : [],
        /* capabilities actually registered at runtime (separate from manifest's static provides: provides = intent, this = fact) */
        capabilities: this.listCapabilities(uid).filter(c => c.pluginId === id).map(c => c.name),
        appUi: (inst.manifest.appUi && typeof inst.manifest.appUi === 'object') ? inst.manifest.appUi : null,
        theme: (inst.manifest.type === 'theme' && inst.manifest.theme && typeof inst.manifest.theme === 'object') ? inst.manifest.theme : null,
        permissions: Array.isArray(inst.manifest.permissions) ? inst.manifest.permissions : [],
        enable: pc ? !!pc.enable : false, running,
        schema: Array.isArray(inst.manifest.configSchema) ? inst.manifest.configSchema : [],
        /* *theme plugins read the **admin copy** (listForInstance output is consumed by the admin side only; the user-side bootstrap ships no config) */
        config: this.store.getPluginConfig(id, uid, inst.manifest.type === 'theme' ? 'admin' : undefined) || (pc ? (pc.config || {}) : {}),
      });
    }
    return out;
  }
  userPlugins(uid, cfg) {
    return this.listForInstance(uid, cfg).filter(p => p.enable && p.running && p.hasUserPage)
      .map(p => ({ id: p.id, name: p.name, icon: p.icon, description: p.description, userPage: p.userPage }));
  }

  /* instance-available theme list (Gay Core): installed theme plugins are usable by default; hidden only by an explicit enable:false in cfg.plugins;
* theme-md3 (built-in default theme) is always listed, cannot be hidden/uninstalled. */
  themesForInstance(uid, cfg, scope) {
    this.scanInstalled();
    const cfgMap = new Map(this.store.pluginEnableList(cfg).map(p => [p.id, p]));
    const out = [];
    for (const [id, inst] of this.installed) {
      if (inst.manifest.type !== 'theme' || !inst.manifest.theme) continue;
      const pc = cfgMap.get(id);
      /* *declarative (2026-10-07): the default theme is declared by manifest.theme.default; the kernel no longer names theme-md3.
       *  compatibility: the old built-in theme-md3 without this field is still forced listed as "builtin and locked". */
      const isDefault = (inst.manifest.theme && inst.manifest.theme.default === true)
        || (inst.manifest._builtin === true && inst.manifest.locked === true);
      const forced = isDefault;
      if (!forced && pc && pc.enable === false) continue;
      const t = inst.manifest.theme;
      /* *plugin custom primary: config.seed / seedDark (one color in; the server derives a full palette overriding the static scheme).
       *  relation to the App's "custom primary color": the App's local setting wins; this plugin palette applies when unset. */
      let dark = t.dark || {}, light = t.light || {};
      let cssVars = Object.assign({}, t.cssVars || {});
      try {
        /* *palette params read per side (_theme_admin / _theme_user): the user side and bootstrap use user,
         *  the admin side passes scope=admin explicitly in plugin-config -- so the two ends can have different palettes and radii. */
        const pc2 = this.store.getPluginConfig(id, uid, scope) || {};
        const seedLight = normalizeSeed(pc2.seed);
        const seedDark = normalizeSeed(pc2.seedDark) || seedLight;
        const scheme = String(pc2.scheme || 'standard');
        if (seedDark) { let p = paletteFromSeed(seedDark, true); if (p) dark = Object.assign({}, dark, applyScheme(p, scheme, true)); }
        if (seedLight) { let p = paletteFromSeed(seedLight, false); if (p) light = Object.assign({}, light, applyScheme(p, scheme, false)); }
        /* Compose theme extensions: cardStyle / cornerScale / strokeWidth / scheme -> cssVars */
        const cardStyle = String(pc2.cardStyle || cssVars['gc-card-style'] || 'outlined');
        const cornerScale = Math.max(0.5, Math.min(2, Number(pc2.cornerScale) || 1));
        /* *unified fallback chain (2026-10-08): user config (empty string = follow default) -> manifest static default -> hardcoded fallback.
         *  the old strokeWidth fallback was hardcoded 1, so a cleared user param kept the manifest's 1.5px from ever applying. */
        const strokeW = Math.max(0, Math.min(4, Number(pc2.strokeWidth)
          || Number(String(cssVars['gc-stroke-width'] || '').replace(/[^0-9.]/g, '')) || 1));
        const r = (base) => Math.round(base * cornerScale) + 'px';
        cssVars['gc-radius-card'] = r(Number(String(cssVars['gc-radius-card'] || '20').replace(/[^0-9.]/g, '')) || 20);
        cssVars['gc-radius-input'] = r(Number(String(cssVars['gc-radius-input'] || '12').replace(/[^0-9.]/g, '')) || 12);
        cssVars['gc-radius-btn'] = r(Number(String(cssVars['gc-radius-btn'] || '12').replace(/[^0-9.]/g, '')) || 12);
        cssVars['gc-radius-chip'] = r(Number(String(cssVars['gc-radius-chip'] || '8').replace(/[^0-9.]/g, '')) || 8);
        cssVars['gc-stroke-width'] = strokeW + 'px';
        cssVars['gc-card-style'] = cardStyle;
        cssVars['gc-scheme'] = scheme;
      } catch (_) { /* config read failed: use the static palette */ }
      out.push({
        id, name: t.name || inst.manifest.name || id, builtin: !!inst.manifest._builtin,
        locked: forced, dark, light, cssVars,
        /* *2026-10-07: declarative default-theme flag -- core.js uses it to decide whether to add the kernel fallback theme,
         *  the kernel no longer names theme-md3. Older Apps ignore unknown fields; behavior unchanged. */
        isDefault: !!isDefault,
      });
    }
    out.sort((a, b) => (b.locked ? 1 : 0) - (a.locked ? 1 : 0)); // md3 first
    return out;
  }

  /* ---------- Install / uninstall / configure ---------- */
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

  /* fetch market indexes (for the market API) */
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
      // plugin configs cleared too (uninstall = clean, §6.3)
      try { fs.rmSync(this.store.pluginConfigFile(pluginId), { force: true }); } catch {}
    }
    this.scanInstalled();
    return true;
  }

/** A plugin's config form: with `scope='admin'`, read the **admin-side copy** (theme plugins store per side). */
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

  /* ---------- HTTP dispatch (/plugins[/<id>[/<path...>]]) ---------- */
  async handle(cfg, req, res, u, p, body) {
    const uid = req._uid != null ? req._uid : (cfg._uid != null ? cfg._uid : 1);
    const segs = p.split('/').filter(Boolean);
    const json = (code, obj) => {
      const s = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(s);
    };

    if (segs.length === 1) { // GET /plugins -> the plugin center page (HTML) or JSON
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
    /* *multi-instance consistency (2026-09-18): for global-scope plugin runtime data, when this instance has no un-flushed changes but others wrote,
*  re-read disk in place before dispatch -- avoids stale snapshots (billing rules, card-key usage). See maybeReloadData. */
    this.maybeReloadData(pluginId, uid);

    const handler = state.routes.get(req.method.toUpperCase() + ' ' + subPath);
    if (handler) {
      const params = {
        query: Object.fromEntries(u.searchParams),
        body: tryJson(body),
        rawBody: body,
        headers: req.headers,
        /* *client capabilities (2026-10-07): the App's X-GCUI-* headers parsed into a "what it can render" view.
         *  plugins can self-check before rendering -- no header (web/old App) -> null; plugins should render conservatively. */
        clientCaps: (() => {
          try {
            const adminUi = require('./admin-ui');
            return adminUi.capsView(adminUi.parseCaps(req.headers));
          } catch (_) { return null; }
        })(),
        /* Admin auth: for plugin admin endpoints (authAdmin() -> {ok, ...}) */
        /* Admin auth: for plugin admin endpoints (authAdmin() -> {ok, ...}) */
        authAdmin: () => this.authChain ? this.authChain.checkAdmin(cfg, req, u.searchParams) : { ok: true },
        /* *user key (the auth chain's result) -- plugin pages/intents authenticate with it.
         *  why a separate one: plugins used apis().findKey(token) to search the **card list**, but
         *  "admin key as user key" (auth-adminkey plugin) is claimed by the auth chain, not present in the card list
         *  -> admins browsing the model square / profile would get 401 "key card login required". Going through the auth chain recognizes both. */
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
      /* record this request's client capabilities for synchronous ctx.clientCaps() reads */
      if (params.clientCaps) this._lastCaps.set(String(uid), params.clientCaps);
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

/** the plugin center page (when browsers hit /plugins) */
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
