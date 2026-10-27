'use strict';
/** core.js - HTTP server + multi-instance pool (UID) + request routing + setup mode + the minimal admin API (doc §2.1/§3.3)
 *
   * kernel endpoints (whitelisted; everything else is a plugin's business):
 *   GET  /health /status
*   POST /setup/admin                 setup mode (localhost only, time-limited)
 *   GET  /v1/models /v1beta/models
 *   POST /v1/chat/completions         OpenAI
 *   POST /v1/messages                 Claude
 *   POST /v1beta/models/:m:(stream)GenerateContent   Gemini
*   POST /v1/responses                OpenAI Responses (canonical native format, no more openaiExtras switch)
*   *    /plugins[/<id>/...]          plugin dispatch
*   *    plugin-registered extra endpoints (registerExtraEndpoint)
*   *    /admin/api/*                 minimal admin set (instances / config / plugin list)
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

/** ---------- plugin config "merge-write" ----------
   * the admin's (web/App) plugin config form returns only fields declared in configSchema; anything outside the schema is absent from the body.
* A full replace would wipe runtime data too -- 2026-09-16 incident: saving the "user system" plugin config emptied the whole user table
   * (the card table lives in another file, so it survived -> "all users gone but the cards remain").
   * semantics: plain fields override; a null value deletes the key; objects merge recursively; arrays replace wholesale. */
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

/** ---------- Errors/utilities ---------- */
/** *boolean parameter parsing (2026-09-19 incident fix)
   * admin switches arrive both as Booleans (App native pages) and as strings (SDUI templates {{input._checked}}).
   *  **never use `!!v`**: `!!"false" === true` (off becomes on) and `!!"" === false` (template parse failures silently read as off).
   *  returning null = an illegal value -> the caller must 400; never guess. */
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
/** extract the model name from the request (gemini from the URL, everything else from body.model) */
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
/** build a /v1/models response straight from a model-name array (for aggregate routing) */
function modelsResponseFrom(ms, format) {
  if (format === 'gemini') {
    return { models: ms.map(m => ({ name: 'models/' + m, displayName: m, supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'] })) };
  }
  return { object: 'list', data: ms.map(m => ({ id: m, object: 'model', type: 'model', created: 1700000000, owned_by: 'ai-gateway-core', display_name: m })) };
}

/** Gay Core: user-side layout config validation (bottomBar/hidden/homeOrder = string arrays, theme = string) */
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
/** MD3 default-theme fallback (the App keeps a default theme even when the theme-md3 plugin files are missing) */
const FALLBACK_THEME = {
  id: 'theme-md3', name: 'Material Design 3', builtin: true, locked: true,
  dark: { primary: '#D0BCFF', onPrimary: '#381E72', secondary: '#CCC2DC', surface: '#141218', surfaceContainer: '#1D1B20', background: '#141218', onSurface: '#E6E0E9', onSurfaceVariant: '#CAC4D0', outline: '#938F99', error: '#F2B8B5' },
  light: { primary: '#6750A4', onPrimary: '#FFFFFF', secondary: '#625B71', surface: '#FEF7FF', surfaceContainer: '#F3EDF7', background: '#FEF7FF', onSurface: '#1D1B20', onSurfaceVariant: '#49454F', outline: '#79747E', error: '#B3261E' },
  cssVars: {},
};

/** ---------- Gateway core ---------- */
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
/* ★2026-09-18 multi-instance consistency: hang "plugin config was written" on the Store --
     *  both ctx.setPluginConfig and /admin/api/plugin-config/:uid/:pid (the path bypassing ctx) trigger it,
     *  the PluginManager bumps the version and push-syncs the new config **in place** to the plugin's other instances. */
    this.store.onPluginConfigWrite = (pid) => { try { this.plugins.bumpCfgRev(pid, null); } catch (_) {} };
    // pool: instances Map<uid, cfg>, servers Map<"http:port",...>, portOwner Map<port,uid>
    this.pool = { instances: new Map(), servers: new Map(), portOwner: new Map(), mainPort: 0, mainTlsPort: 0, mainHost: '0.0.0.0' };
    this.opts = opts;
    this._gi = { at: 0, idx: null };   // model group index cache
  }

  /* ---------- Model group index (3s cache; avoids per-request disk reads) ---------- */
  groupIndex() {
    const now = Date.now();
    if (!this._gi.idx || now - this._gi.at > 3000) {
      /* *capability first: when a model-pricing provider exists, it supplies the data; the kernel no longer names model-square.
       *  group/price are **global** config (manifest without scope -> stored under uid=0), so this queries uid=0,
       *  same convention as the old store.getPluginConfig('model-square', 0). */
      let capSrc = null;
      try { capSrc = this.plugins ? this.plugins.requireCapability(0, 'model-pricing') : null; } catch (_) {}
      this._gi = { at: now, idx: modelgroups.buildIndex(this.store, capSrc) };
    }
    return this._gi.idx;
  }
  invalidateGroupIndex() { this._gi = { at: 0, idx: null }; }

  /**
* Prefix-less (Default) aggregation: pool model names from all enabled instances.
* @param {object|null} userKey card key (used to trim by the per-branch instance whitelist); admin / anonymous = null
* @param {object|null} onlyCfg when given, only that instance is included (internal use)
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
* In aggregation mode, the list of participating instance configs (enabled + trimmed by the card-key instance whitelist).
* Order = pool insertion order (i.e. uid order), keeping /v1/models stable.
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
* id list for /v1/models (2026-09-18 user request "in case same-named models overwrite each other"):
   *   when a same-named model appears across **multiple (instance, channel)** pairs -> the id becomes `instance:channel:model`, letting clients target a source exactly;
   *   non-conflicting names keep the original. **The original name keeps working** (forwarding still resolves the real name); it just is no longer listed.
* @param {Array} cfgs instance configs participating in aggregation (pass [cfg] in single-instance mode)
   */
  modelRefs(cfgs) {
    return modelref.buildRefs((Array.isArray(cfgs) ? cfgs : []).map(c => ({ name: c && c._name, channels: (c && c.channels) || [] })));
  }

/** Find other instances that can serve a model (aggregation fallback; skips default itself) */
  findInstanceForModel(model, userKey) {    const allowed = (userKey && Array.isArray(userKey.branches) && userKey.branches.length) ? userKey.branches : null;
    for (const [, c] of this.pool.instances) {
      if (!c || c._disabled) continue;
      if (c._name === 'default') continue;
      if (allowed && !allowed.includes(c._name)) continue;
      if (collectModels(c).includes(model)) return c;
    }
    return null;
  }

/** Filter model names by card-key whitelist (intersection when both models and groups exist; empty = unrestricted) */
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

  /* ---------- Instance loading ---------- */
  loadInstance(uid) {
    const old = this.pool.instances.get(uid);
    let cfg;
    try { cfg = this.store.loadInstance(uid); } catch (e) { logErr('[pool] 实例 uid=' + uid + ' 配置加载失败: ' + e.message); return null; }
    if (!cfg) { if (old) { this.pool.instances.delete(uid); this.reconcilePorts(); } return null; }
    const meta = this.store.meta(uid);
    cfg._disabled = !(meta && meta.enabled !== false);
    cfg._stats = (old && old._stats) || newStats(); // hot reload keeps stats
    this.pool.instances.set(uid, cfg);
    const r = this.plugins.activateInstance(uid, cfg);
    if (!r.ok) logErr('[plugins] uid=' + uid + ' ' + r.blocked);
    this.reconcilePorts();
    return cfg;
  }

/** Reload all instances (required after unlock/lock/passphrase change: in-memory cfg holds ciphertext or plaintext, must re-read disk) */
  reloadAllInstances() {
    for (const meta of this.store.index.instances) this.loadInstance(meta.uid);
    return this.store.index.instances.length;
  }

  /* ---------- Encryption passphrase / lock (2026-09-18; used by the "key vault" plugin) ---------- */
  cryptStatus() { return Object.assign({ ok: true }, this.store.cryptStatus()); }

/** Unlock: the passphrase lives only in memory (never written to disk).
   *  - unencrypted/unlocked: the caller has already authenticated with the adminKey; only the passphrase needs checking;
   *  - **while locked**: normal auth cannot possibly pass (the adminKey itself is ciphertext) -> the adminKey must be supplied,
   *    "the passphrase decrypts this adminKey" proves both at once (see store.verifyAdminKeyWithPass). */
  cryptUnlock(pass, adminKey) {
    const p = String(pass == null ? '' : pass).trim();
    if (p.length < 8) return { ok: false, error: '口令至少 8 位' };
    /* *already in "this passphrase + unlocked" state -> return directly, **no reload**
     *  (otherwise every App refresh triggers an all-instance reload = thousands of scrypt runs, blocking the gateway; measured 2026-09-18) */
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

/** Lock: clear the in-memory passphrase and reload (clearing in-memory plaintext keys too). With ciphertext on disk, forwarding is blocked with 503. */
  cryptLock() {
    const had = !!this.store._pass;
    this.store.setPass(null);
    const n = this.reloadAllInstances();
    log('[crypt] 已锁定' + (had ? '(内存明文已随重载清除)' : '(此前本就未解锁)'));
    return { ok: true, reloaded: n, status: this.store.cryptStatus() };
  }

/** First-time encryption migration / passphrase change: rewrite sensitive fields on disk as ciphertext of the current (or new) passphrase, backing up each file first */
  cryptReencrypt(pass) {
    const cur = this.store._pass;
    const p = String(pass == null ? '' : pass).trim() || cur;
    if (!p) return { ok: false, error: '请先解锁（或提供口令）' };
    /* *gate: only one encrypt/passphrase-change at a time. Rapid taps stack re-encrypt + reload (thousands of scrypt runs each),
     *  measured 2026-09-18: it blocked the gateway completely -- prefer rejecting the second attempt over taking the whole gateway down. */
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

/** Delete plaintext backups left by migration/passphrase change (`.bak-crypt-*`) */
  cryptCleanBackups() {
    const r = this.store.cleanCryptBackups();
    log('[crypt] 已删除明文备份 ' + r.count + ' 个');
    return Object.assign({ ok: true, status: this.store.cryptStatus() }, r);
  }

  loadAll() {
    // first boot: no instances -> create default + enter setup mode (§3.3)
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

  /* ---------- Port management (UID-based pool) ---------- */
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

  /* ---------- Routing: compat-port direct / main-port /<instance>/ prefix / default ---------- */
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

  /* ---------- Main request dispatch ---------- */
  /* ---------- Requester identity (per-user stats isolation, 2026-09-18) ---------- */
  /**
* Resolve "which user this is" from credentials carried by the request (Bearer card key / ?key= / gatewayKey).
* ★For **display-layer filtering only**, never part of auth decisions.
* Three possible outcomes:
*   { keyId, name }  -- recognized card-key user
*   { admin: true }  -- gateway key / keyless deployment (admin-equivalent, sees the whole site)
*   { denied: true } -- invalid credentials provided / deployment requires credentials but none given -> **stats must be hidden**,
*                       never fall back to the site-wide view (otherwise a user with an expired card key could see other people's requests)
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

      /* ===== setup mode (whitelist, §3.3) ===== */
      if (this.store.isSetupMode()) {
        if (req.method === 'GET' && (p === '/health' || p === '/setup/status')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, setupMode: true, deadline: this.store.index.setupDeadline, hint: 'POST /setup/admin {adminKey} 创建管理员 (仅 localhost)' }));
        }
        // GET /admin passes (the in-page setup wizard calls /setup/admin); all APIs stay blocked
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

      /* ===== multi-instance routing ===== */
      const r = this.route(req, p);
      if (r.error) return sendError(null, 'openai', res, r.status || 404, r.error);
      let cfg = r.cfg;   /* let: prefix-less aggregate routing may switch instances after the body arrives */
      p = r.path;
      /* *compat with Apps like RikkaHub appending balance queries to /v1/credits -> normalized onto the /credits top-level route (2026-09-19) */
      if (req.method === 'GET' && p === '/v1/credits') p = '/credits';

      /* ===== access-source filter (accessGuard: public-domain leak protection) =====
       *  cfg.accessGuard = { mode:'off'|'app'|'web', exemptPaths:[...], allowUA:[...] }
       *  mode='app': App clients only (UA contains an allowUA keyword or carries X-GCUI-* headers); browsers get 403;
       *  mode='web': browsers only; off = no filtering. exemptPaths always pass (admin panel etc.).
       *  *this is a soft boundary (UA/headers are forgeable); it stops the honest, not the determined -- don't expose a public tunnel if you need strength. */
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

      /* global card branch whitelist (plugin-registered; blocks keyless bypass of the target instance): a card registered anywhere with non-empty branches -> whitelist instances only */
      const presented = require('./auth').presentedToken(req, u.searchParams);
      if (presented) {
        const gk = this.plugins.globalKeys.get(presented);
        if (gk && gk.branches.length && !gk.branches.includes(r.name)) {
          return sendError(cfg, 'openai', res, 403, '此卡密不允许访问分组: ' + r.name + ' (可用: ' + gk.branches.join(', ') + ')');
        }
      }

      if (cfg.cors && req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(cfg)); return res.end(); }
      const se = (format, res2, status, msg, code) => sendError(cfg, format, res2, status, msg, code);

      /* ===== health/status ===== */
      if (req.method === 'GET' && p === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, version: CORE_VERSION, uptime: Math.round(process.uptime()) }));
      }
      /* *user-side "Usage" page (2026-09-18): serve the kernel's gcui usage-stats page directly (the same one as /admin/ui/usage),
       *   the App's "Usage" page renders it via SduiController -> both ends identical; page edits need no app rebuild.
       *   *2026-09-18 per-user isolation: the page shows only the **requester's** stats (scope) -- it used to ignore key cards,
       *   so anyone opening it saw site-wide data ("a user who never called could still see requests"). */
      if (req.method === 'GET' && p === '/ui/usage') {
        try {
          /* *2026-10-08 admin language setting: POST /admin/api/set-lang { lang } -> persists i18n prefs[uid] */
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
          /* *must go through adminUi.render(): it stamps the page with the `gcui` version field (the App uses it to detect gcui pages),
           *   calling buildUsage() directly misses gcui -> the App reports "not a gcui page" (been there). */
          const scope = this.viewerScope(cfg, req, u.searchParams);
          const caps = adminUi.parseCaps(req.headers);
          this.plugins.rememberCaps(cfg._uid, adminUi.capsView(caps));
          /* *must await: render returns a Promise for async pages (see the admin-ui.render comment) */
          const page = (await adminUi.render(this, cfg, 'usage', u.searchParams, this.plugins.adminPages(cfg._uid), { base: '/ui/usage', admin: false, scope: scope, caps })) || {};

          /* *2026-10-08 admin language setting (user report: no way to change language on either end):
             kernel admin pages previously had zero language UI. The fix = the /admin/api/set-lang endpoint + an admin-ui.js language sub-page,
             persisting i18n prefs[admin uid] so every kernel page bundle follows (pure server-side, zero App involvement). */
          page.gcui = page.gcui || adminUi.UI_VERSION;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(JSON.stringify(page));
        } catch (e) { return jsonErr(res, '生成页面失败: ' + e.message, 500); }
      }
      if (req.method === 'GET' && p === '/status') {
        /* *security: /status is readable without auth (instance health info used by clients/scripts), but channel upstream addresses (baseUrl)
         *   and proxy addresses are internal** -- requests without the admin key are always masked, so nobody on the LAN can enumerate your upstreams.
         *   requests carrying the admin key (x-admin-key / Bearer adminKey / ?adminKey=) still get it verbatim.
         *   (an instance without adminKey = keyless admin; then every reader is "an admin", nothing is masked.) */
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
            /* *default aggregates all instances (§45): cross-instance routed requests count toward the target instance, so default's own
             *   stats would miss them -> the user home's "request trend" reads /status.stats.hourly; without aggregation it stays 0 forever */
            const isDef = cfg._name === 'default';
            const targets = isDef ? [...this.pool.instances.values()].filter(x => x) : [cfg];
            /* *per-user isolation (2026-09-18): /status is readable without auth and previously returned stats.recent too
             *   (it contains the key-card name keyName) -> anyone on the LAN without a key could see "who uses it, when, which model".
             *   now: admin = site-wide; ordinary key-card users = only their own slice (stats.byKey[<keyId>] + filtered recent);
             *   unrecognized identity = empty stats (prefer giving nothing over leaking others'). */
            const meScope = isAdmin ? null : this.viewerScope(cfg, req, u.searchParams);
            const meKey = (meScope && meScope.keyId) || '';
            const meAdmin = !!(meScope && meScope.admin);   /* gatewayKey / keyless deployment = admin semantics */
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
                /* per-key view: totals from stats.byKey, details from the recent entries with the same keyId */
                const b = (s.byKey || {})[meKey];
                if (b) {
                  gReq += b.requests || 0; gErr += b.errors || 0;
                  for (const [name, v] of Object.entries(b.byChannel || {})) addCh(t, name, v);
                }
                for (const r of (s.recent||[])) if (r.keyId === meKey) allRecent.push(isDef ? Object.assign({}, r, { instance: t._name }) : r);
                continue;
              }
              if (!seeAll) continue;   /* non-admin whose identity cannot be recognized / invalid card -> no stats at all */
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

      /* ===== Gay Core App: GET /api/app/bootstrap (public; aggregates site profile/branches/plugin disclosures/theme/layout) ===== */
      if (req.method === 'GET' && p === '/api/app/bootstrap') {
        return this.handleAppBootstrap(cfg, res);
      }

      /* ===== user-side theme params (2026-09-16) =====
       * theme params are stored per side (_theme_user / _theme_admin). The admin side goes through /admin/api/plugin-config,
       * the user side has no matching entry -> give it its own read/write channel here (key-card login required, inside the instance context,
       * because /theme-config is not under /admin/, it never reaches handleAdmin). */
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
            if (!schema.length) continue;   /* themes with no tunable params are not listed */
            out.push({ id: t.id, name: t.name, schema: schema, config: this.store.getPluginConfig(t.id, uid, 'user') || {} });
          }
          return jsonT(200, { ok: true, themes: out });
        }
        if (req.method === 'POST') {
          let raw = '';
          const u8 = utf8();   /* *chunk-safe decoding (2026-09-18) */
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

      /* ===== admin pages + API ===== */
      if ((p === '/admin' || p === '/admin/') && req.method === 'GET') {
        try {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(fs.readFileSync(path.join(__dirname, '..', 'web', 'admin.html'), 'utf8'));
        } catch (e) { return jsonErr(res, '管理页面缺失: web/admin.html', 404); }
      }
      /* user center (login lives in the page; APIs authenticate individually) */
      if ((p === '/user' || p === '/user/') && req.method === 'GET') {
        try {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(fs.readFileSync(path.join(__dirname, '..', 'web', 'user.html'), 'utf8'));
        } catch (e) { return jsonErr(res, '用户页面缺失: web/user.html', 404); }
      }
      if (req.method === 'GET' && p.startsWith('/admin/assets/')) return this.serveAdminAsset(req, res, p);
      /* ===== admin SDUI pages =====
       * going through the **same admin auth chain** (checkAdmin inside handleAdmin) --
       * without this line, /admin/ui/* falls through to the later default branch as 404 (been there: 404 with or without the key). */
      if (p.startsWith('/admin/ui')) {
        return this.handleAdmin(cfg, req, res, u, p, '').catch(e => jsonErr(res, e));
      }
      if (p.startsWith('/admin/api')) {
        if (req.method === 'POST' || req.method === 'DELETE') {
          let adminBody = '';
          const u8 = utf8();   /* *chunk-safe decoding (2026-09-18) */
          req.on('data', c => { adminBody += u8(c); if (adminBody.length > 4 * 1024 * 1024) req.destroy(); });
          req.on('end', () => { this.handleAdmin(cfg, req, res, u, p, adminBody).catch(e => jsonErr(res, e)); });
          req.on('error', () => {});
        } else {
          return this.handleAdmin(cfg, req, res, u, p, '');
        }
        return;
      }

      /* ===== plugin dispatch ===== */
      if (p === '/plugins' || p.startsWith('/plugins/')) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          this.plugins.handle(cfg, req, res, u, p, '').catch(e => jsonErr(res, e));
        } else {
          let pbody = '';
          const u8 = utf8();   /* *chunk-safe decoding (2026-09-18) */
          req.on('data', c => { pbody += u8(c); if (pbody.length > 8 * 1024 * 1024) req.destroy(); });
          req.on('end', () => { this.plugins.handle(cfg, req, res, u, p, pbody).catch(e => jsonErr(res, e)); });
          req.on('error', () => {});
        }
        return;
      }

      /* *encryption lock (key vault, 2026-09-18): while locked, channel apiKeys/the card table/admin keys are **all AGWENC1 ciphertext**,
       *  normal auth is guaranteed to fail (cards unreadable -> a wall of 401 invalid key). So for **all /v1 upstream endpoints**
       *  (including /v1/models and /v1beta/*) uniformly get 503 + an actionable hint. /api/app/models, /plugins/*,
       * all admin endpoints and /auth/* /credits are unaffected -- the unlock channel must stay open. */
      if (this.store.locked && (p === '/v1' || p.startsWith('/v1/') || p.startsWith('/v1beta/'))) {
        return se(p.startsWith('/v1beta') ? 'gemini' : 'openai', res, 503,
          '网关已锁定：渠道密钥处于加密状态，请在 Gay Core「密钥保险箱」里解锁后重试');
      }

      /* ===== plugin-registered extended endpoints (registerExtraEndpoint) ===== */
      const extraKey = req.method.toUpperCase() + ' ' + p;
      const extra = this.plugins.extraEndpoints.get(extraKey);
      if (extra && extra.uid === cfg._uid) {
        this.plugins.maybeReloadData(extra.pluginId, extra.uid);   /* *runtime-data multi-instance consistency (2026-09-18) */
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

      /* ===== plugin top-level routes (auth plugins: /credits /auth/* etc.) ===== */
      const topHit = this.plugins.topRoutes.get(cfg._uid + '|' + req.method.toUpperCase() + ' ' + p);
      if (topHit && topHit.uid === cfg._uid) {
        this.plugins.maybeReloadData(topHit.pluginId, topHit.uid);   /* *runtime-data multi-instance consistency (2026-09-18) */
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

      /* ===== model list ===== */
      if (req.method === 'GET' && (p === '/v1/models' || p === '/v1beta/models')) {
        const fmt = p === '/v1beta/models' ? 'gemini' : 'openai';
        const authR = this.authChain.check(cfg, req, u.searchParams);
        if (!authR.ok) return se(fmt, res, authR.status || 401, authR.error || 'invalid key');
        /* no prefix (via=default) = aggregation mode: the union of all instances' models (clipped by card instance/group/model whitelists);
 * with an instance prefix (/Abc/v1/models) it still returns only that instance's models. */
        const agg = r.via === 'default' && cfg.aggregate !== false;
        /* *id shape (2026-09-18): conflicted names use `instance:channel:model`; others keep the original;
         *   card whitelists match either the original or the composite name (modelref.filterEntries). */
        const cfgs = agg ? this.aggregateInstanceCfgs(authR.userKey) : [cfg];
        const refs = this.modelRefs(cfgs);
        let ms = modelref.filterEntries(refs.entries, authR.userKey, this.groupIndex()).map(e => e.id);
        /* fallback: if nothing resolved (extreme case), return to the old name-based dedup; never hand the client an empty list */
        if (!ms.length && cfgs.length) {
          const seen = [];
          for (const c of cfgs) for (const m of collectModels(c)) if (!seen.includes(m)) seen.push(m);
          ms = this.filterModelsFor(seen, authR.userKey);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(cfg) });
        return res.end(JSON.stringify(modelsResponseFrom(ms, fmt)));
      }

      /* ===== no-login: GET /api/app/models (public model list for guests browsing the site and model square) =====
       * returns only model name/group/alias/owning instance -- never baseUrl / apiKey / prices or other secrets. */
      if (req.method === 'GET' && p === '/api/app/models') {
        return this.handlePublicModels(cfg, res);
      }

      /* ===== forwarding endpoints ===== */
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
      const u8 = utf8();   /* *chunk-safe decoding (2026-09-18): a body split across packets would garble the prompt */
      req.on('data', c => {
        if (aborted) return;
        size += c.length;
        if (size > cfg.maxBodyBytes) { aborted = true; req.destroy(); se(clientFormat, res, 413, 'request body too large (>' + cfg.maxBodyBytes + ' bytes)'); return; }
        bodyStr += u8(c);
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          /* *model reference "instance:channel:model" (2026-09-18): lets clients pick an exact source on name conflicts.
*  Resolved and "the instance has this channel and the channel really serves this model" -> switch instance + pin channel + real name goes downstream;
           *  parse failures are not errors; treat as an ordinary model name (routing decides; may 503 no channel). */
          let wantPlain = modelFromBody(urlInfo, bodyStr);
          if (wantPlain) {
            const ref = modelref.parseRef(wantPlain);
            if (ref) {
              let tgt = null;
              for (const [, c] of this.pool.instances) {
                if (!c || !modelref.channelMatch(ref.instance, c._name)) continue;   /* instance names tolerate space/hyphen/case differences too */
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
                urlInfo.forceChannel = String(hit.name);   /* pin the channel (no rotation/fallback) */
                urlInfo.modelOverride = ref.model;         /* real name for billing/logs/groups */
                urlInfo.rawModel = wantPlain;
                wantPlain = ref.model;
              } else {
                log('[ref] 引用无法解析(实例/渠道/模型不匹配), 当普通模型名处理: ' + wantPlain);
              }
            }
          }
          /* ---- prefix-less aggregation fallback: when default cannot serve a model, look at other instances ---- */
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
          const u8 = utf8();   /* *chunk-safe decoding (2026-09-18) */
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

  /* gateway capabilities for plugins (findKey/grantQuota are provided by auth plugins' bindGatewayAuthApis) */
  gatewayApi(cfg) {
    return { uid: cfg._uid, instanceName: cfg._name, store: this.store, gateway: this };
  }

  /* ---------- Audit log (Gay Core §14: log/audit-<uid>.jsonl; uid=0 means global actions) ---------- */
  audit(uid, action, detail) {
    try {
      const dir = path.join(this.store.dir, 'log');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'audit-' + uid + '.jsonl'),
        JSON.stringify({ ts: new Date().toISOString(), action, ...(detail || {}) }) + '\n');
    } catch (_) {}
  }

  /* ---------- Gay Core: the App's boot aggregate info (public; disclosure-grade fields only, no secrets) ---------- */
  /* internal self-call: hit **this instance's own listening port** (used by the admin pages' "probe success rate / sync models / check balance")
   *  why: these capabilities live inside plugins, and plugin routes are not under the /admin/ prefix -- the SDUI adminApi whitelist would not allow them,
   *  so the kernel proxy-calls them on the plugins' behalf (adminKey still attached; no privilege escalation).
   *  when the instance is not listening (port 0) or times out -> resolve(null); callers treat it as "plugin did not respond". */
  selfReq(cfg, method, path, body, timeoutMs) {
    return new Promise(resolve => {
      /* *switched to the main port: it used cfg.listen.port, but (1) instances with port=0 gave null -> "plugin not enabled"
       *  (2) the port collides with the old gateway (e.g. 16384) -> connects to the old one -> "no instance found". Main port + path prefix works for every instance. */
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
    /* registration config disclosure (secret fields never leak)
* ★2026-10-07 de-hardcoded: previously has('auth-user') + getPluginConfig('auth-user', uid) --
     *   the kernel had to know "registration is provided by auth-user". Now it asks for the user-registration capability,
     *   any plugin providing it can take over. *the shipped field shape matches the old version field-for-field (the App's RegistrationInfo contract is unchanged). */
    let registration = null;
    try {
      const regCap = this.plugins ? this.plugins.requireCapability(uid, 'user-registration') : null;
      if (regCap && typeof regCap.info === 'function') registration = regCap.info() || null;
    } catch (_) { registration = null; }
    /* *theme plugins read the **user copy** by default (bootstrap is fetched user-side); the admin side explicitly asks for admin in plugin-config */
    let themes = this.plugins.themesForInstance(uid, cfg, 'user');
/* ★Declarative fallback (2026-10-07): the core no longer names theme-md3 --
     *  whenever the list holds **no default theme** (manifest.theme.default), add the kernel fallback theme.
     *  this way swapping the default theme to another plugin requires zero kernel changes. */
    if (!themes.some(t => t && (t.isDefault === true))) themes = [FALLBACK_THEME].concat(themes);
    /* user debug mode (§15): limited to one user + auto-expiring */
    const ud = cfg.userDebug;
    const userDebug = (ud && ud.uid && Number(ud.until) > Date.now()) ? { forUid: String(ud.uid), until: Number(ud.until) } : null;
    const body = {
      ok: true, core: CORE_VERSION, appApi: 1,
      branch: cfg._name, uid,
      serverInfo: this.store.getServerInfo(),
      userDebug,
      layout: (cfg.clientLayout && typeof cfg.clientLayout === 'object') ? cfg.clientLayout : null,
      /* admin SDUI page registration slot (older Apps ignore this field; behavior identical) */
      adminUi: adminUi.manifest(this.plugins.adminPages(uid)),
      /* this instance's registered capability table [{name, pluginId}] -- plugins use it to decide degradation/enabling */
      capabilities: this.plugins.listCapabilities(uid),
      branches: this.store.index.instances.filter(mm => mm.enabled !== false).map(mm => ({ name: mm.name, uid: mm.uid })),
      auth: { cardkey: has('auth-cardkey'), user: has('auth-user'), gatewayKey: !!cfg.gatewayKey, registration },
      themes,
      plugins: enabled.map(x => ({
        id: x.id, name: x.name, version: x.version, author: x.author, description: x.description,
        icon: x.icon, type: x.type, builtin: x.builtin, sha256: x.sha256,
        permissions: x.permissions, provides: x.provides, appUi: x.appUi,
        /* *runtime capability list (2026-10-07): separate from static provides -- provides is the "intent declaration",
         *  this is "what is actually registered right now". Apps/plugins self-check "does my capability have a provider" against it. */
        capabilities: x.capabilities || [],
        userPage: x.userPage, hasAdminPage: x.hasAdminPage,
      })),
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(cfg) });
    res.end(JSON.stringify(body));
  }

  /* GET /api/app/models -> the login-free public model list (for guests browsing the model square)
* Security: exposes only model name / group / alias / owning instance -- no baseUrl / apiKey / pricing. */
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

  /* GET /admin/assets/<file> -> static assets under web/assets/ (fonts/component libs, nothing sensitive, no auth) */
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

  /* ---- Plugin market indexes (global, data/market-indexes.json) ---- */
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

  /* ---------- minimal admin API ---------- */
  async handleAdmin(cfg, req, res, u, p, body) {
    const authR = this.authChain.checkAdmin(cfg, req, u.searchParams);
    if (!authR.ok) return sendError(cfg, 'openai', res, authR.status || 401, authR.error || 'unauthorized');
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...corsHeaders(cfg) }); res.end(JSON.stringify(obj)); };
    const j = () => { try { return JSON.parse(body || '{}'); } catch (_) { return null; } };

    /* ===== Admin SDUI pages (gcui JSON, 2026-09-15) =====
     * the App admin's kernel pages pull from here; on render/load failure the App automatically falls back to the native page.
     * read-only GET: in-page writes go back through the App's adminApi actions to /admin/api/**, still passing checkAdmin. */
    if (p.startsWith('/admin/ui/') && req.method === 'GET') {
      const name = p.slice('/admin/ui/'.length).replace(/[^a-zA-Z0-9-]/g, '');
      /* *capability negotiation (2026-10-07): trim pages per the App's X-GCUI-* headers (no headers on web -> no trimming) */
      const caps = adminUi.parseCaps(req.headers);
      /* *record this request's capabilities first -- what is stored is the **capsView** (with hasComponent/hasIcon methods),
       *  because the 4th render argument of plugin pages and ctx.clientCaps() read exactly this.
       *  (the kernel's outbound negotiate uses the raw caps; the two serve different roles. Been there: storing raw caps made plugins report
       *   "caps.hasComponent is not a function"。) */
      this.plugins.rememberCaps(cfg._uid, adminUi.capsView(caps));
      /* *must await: the channels page takes shape only after the plugin (probe success rates) returns */
      const page = await adminUi.render(this, cfg, name, u.searchParams, this.plugins.adminPages(cfg._uid), { base: '/admin/ui/' + name, admin: true, caps });
      if (!page) return json(404, { error: '没有这个管理端页面: ' + name });
      return json(200, page);
    }

    if (p === '/admin' || p === '/admin/api/status') {
      /* *the default instance overview shows the all-instance aggregate too (§45): cross-instance requests count toward the target,
 default's own counters miss them, so default's overview aggregates to avoid a false "not counted" read */
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
    /* ---- Gay Core: full instance stats (recent/byChannel/time series, for charts) ---- */
    if ((m = /^\/admin\/api\/stats\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const uidS = Number(m[1]);
      const ic = this.pool.instances.get(uidS);
      if (!ic) return json(404, { error: '实例未运行或不存在' });
      /* *default aggregates all instance data by default (2026-09-18): cross-instance routing (§35 composite refs) counts requests toward
       *   target instance (req._uid=tgt._uid), so default's stats page could not see those requests (users misdiagnosed it as
       *   "traffic bypassed core"). Querying default aggregates recent/byChannel/hourly/counters across all running instances,
       *   and stamp each recent entry with an instance field for provenance; non-default instances behave unchanged. */
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
    /* ---- Gay Core: audit log reads (latest limit entries, default 50) ---- */
    if ((m = /^\/admin\/api\/audit\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const uid3 = Number(m[1]);
      const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 500);
      const f = path.join(this.store.dir, 'log', 'audit-' + uid3 + '.jsonl');
      let lines = [];
      try {
        lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      } catch (_) {}
      return json(200, { ok: true, uid: uid3, entries: lines.reverse() }); // newest first
    }
    /* ---- Gay Core: site profile (global, stored in instances.json) ---- */
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
* -- the core calls **plugin** admin endpoints on their behalf (users / card keys / model sync / probe / balance / proxy).
     * why: these endpoints live under /plugins/<id>/admin/*, outside the SDUI adminApi whitelist (/admin/).
* ★2026-10-07 deep refactor: it used to be a constant table PLUGIN_CALL_OK hard-coding 9 plugin names --
     *   the kernel therefore **had to know every plugin's name**; adding a 10th plugin meant kernel source edits + restart.
     *   now **declarative**: a plugin declares `"adminApi": ["/admin/keys"]` in its own manifest.json,
     *   the kernel grants only per declarations, never judging by plugin name (plugins self-identify; the kernel ignores names).
     * security: (1) a plugin must explicitly declare proxy-callability in its manifest (2) only its declared /admin/ sub-path prefixes pass
     *   (3) still carries adminKey (no privilege escalation) (4) empty/undeclared -> always 403. */
    if (p === '/admin/api/plugin-call' && req.method === 'POST') {
      const d = j() || {};
      const pid = String(d.plugin || '');
      /* declarative lookup: manifest.adminApi (array). Legacy built-in compat: undeclared but on the historical whitelist,
       * each manifest adds its own declaration -- the kernel no longer holds any plugin-name constants. */
      const decl = this.plugins.adminApiDecl(pid, cfg._uid);
      if (!decl) return json(403, { error: '不允许代调该插件: ' + pid + '（未在 manifest 声明 adminApi）' });
      const sub = String(d.path || '');
      if (sub.indexOf('/admin/') !== 0) return json(403, { error: '只允许代调插件的 /admin/ 端点' });
      /* paths must stay inside the declared scope: decl is a prefix array; an empty array = declared but forbidden (equivalent to 403) */
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
      /* *normalize error: a plugin's error response may be OpenAI-style {error:{message,type,code}} or {error:'string'}.
       *  the App's SduiController.adminApi reads error via .asString -- a JsonObject makes it throw
       *  UnsupportedOperationException("JsonObject") -> the admin page would display just the word "JsonObject".
       *  flattened to strings here so the App can display error messages correctly. */
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
* -- notices live in that **single string** serverInfo.announcement (one per line, format matches the App's Notices.kt).
     * the server parses -> rewrites -> saves, avoiding string-assembly bugs on the App side. */
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
    /* ---- Gay Core: change the admin key (2026-09-16) ----
     * security design: (1) this request already passed checkAdmin (carrying the current key) (2) the body must still re-supply the current key
     *   (double confirmation, so a slip does not lock you out) (3) the new key is >=8 chars and different from the current one.
     * *after the change the App must update its locally stored key too (already implemented client-side), or the admin panel locks out next time. */
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
    /* ---- Gay Core: plugin market test mode (§10: custom sources forbidden while off) ---- */
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
    /* ---- Gay Core: user-side default layout + user debug mode (per instance; debug mode is single-user + time-boxed, §15) ---- */
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
            c.userDebug = { uid: String(ud.uid), until: Date.now() + Math.min(Number(ud.minutes), 1440) * 60000 }; // capped at 24h
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
    // GET /admin/api/instance/:uid -> full view (masked config + plugin configs)
    if ((m = /^\/admin\/api\/instance\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const full = this.store.instanceFull(Number(m[1]));
      if (!full) return json(404, { error: '实例不存在' });
      return json(200, { ok: true, ...full });
    }
    // GET /admin/api/config/:uid (masked) / POST saves and hot-reloads
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
        // masked values are backfilled verbatim (never overwriting real keys)
        const old = this.store.loadInstance(uid);
        const merged = this.unmaskMerge(data, old);
        this.store.saveInstance(uid, merged);
        this.loadInstance(uid);
        return json(200, { ok: true, uid });
      }
    }
    // GET/POST /admin/api/plugin-enable -> the global plugin enablement table {id, enable} / {all:true, enable}
    if (p === '/admin/api/plugin-enable') {
      if (req.method === 'GET') return json(200, { ok: true, plugins: this.store.pluginEnableList({}) });
      if (req.method === 'POST') {
        const b = j() || {};
        let list = this.store.pluginEnableList({});
        /* first run: seed from the first instance so "all plugins" appear in the table */
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
    // POST /admin/api/instance creates {name, listen?, gatewayKey?...}
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
* -- instance onboarding parameters (mirrors the old App's "edit instance" form: name / port / listen address / adminKey)
     * flat params: the App's form component packs a single-level object; accept it as-is, do not demand nesting.
* ★Changing the **current instance's** port cuts the admin side off (the App still dials the old port) -- the page must warn. */
    if ((m = /^\/admin\/api\/instance\/(\d+)\/basic$/.exec(p)) && req.method === 'POST') {
      const uid = Number(m[1]);
      const data = j() || {};
      const meta = this.store.meta(uid);
      if (!meta) return json(404, { error: '实例不存在' });
      const changed = [];
      /* validate the port first (avoid half-applied changes) */
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
      /* reload the instance (a changed port must be re-bound) */
      try { this.removeInstance(uid); } catch (_) { /* not running is fine too */ }
      this.loadInstance(uid);
      this.audit(uid, 'instance.basic', { changed });
      return json(200, { ok: true, toast: '已保存：' + changed.join('、') });
    }
    /* POST /admin/api/instance/:uid/channel -- add (empty origName) or edit a channel
     * body: {origName?, name, type, baseUrl, apiKey, models, modelMap, proxy, delayMs,
     *        isDefault, useResponses, insecure}
     * *the server edits "the channel object in the config" directly (the native version was bitten: editing a detached object -> saves never applied).
     * field semantics match native: an empty apiKey = no change; models split by comma/newline; modelMap accepts JSON or
     * "public name = upstream name", one per line; checking isDefault clears default from the other channels. */
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
      try { this.removeInstance(uid); } catch (_) { /* fine if not running */ }
      this.loadInstance(uid);
      this.audit(uid, origName ? 'channel.update' : 'channel.add', { name: name });
      return json(200, { ok: true, toast: (origName ? '已保存渠道 ' : '已新增渠道 ') + name });
    }
    /* DELETE /admin/api/instance/:uid/channel {name} -- delete a channel
     * *name goes in the **body**, not the query: channel names may contain CJK/spaces, and a naively built URL is rejected as invalid by the App. */
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
      try { this.removeInstance(uid); } catch (_) { /* fine if not running */ }
      this.loadInstance(uid);
      this.audit(uid, 'channel.remove', { name: name });
      return json(200, { ok: true, toast: '已删除渠道 ' + name });
    }
    /* POST /admin/api/instance/:uid/channel-action {action:'probe'|'sync'|'balance', channel?}
     * the kernel proxy-calls plugin endpoints (no privilege escalation: adminKey still attached, and only these three whitelisted actions) */
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
      /* *same as plugin-call: normalize error/toast (selfReq responses may carry OpenAI-style {error:{message}}) */
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
    /* POST /admin/api/instance/batch {enable, uids?} -- instance start/stop (one server-side loop handles it,
     * avoiding per-item requests from the App). When uids is given, only those are processed; omitted = all. */
    if (p === '/admin/api/instance/batch' && req.method === 'POST') {
      const data = j() || {};
      /* same as asBool: bulk enable/disable silently read as false = an outage for every instance; validate strictly */
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
    // GET /admin/api/plugins/:uid -> plugin list
    if ((m = /^\/admin\/api\/plugins\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const uid = Number(m[1]);
      const c = this.pool.instances.get(uid) || this.store.loadInstance(uid);
      if (!c) return json(404, { error: '实例不存在' });
      return json(200, { ok: true, plugins: this.plugins.listForInstance(uid, c) });
    }
    /* ===== Key vault: encryption passphrase (2026-09-18) =====
* The passphrase **never touches disk** (no .agwkey written) -- process memory only; a restart returns to locked state and the App unlocks automatically.
     * these endpoints serve plugin pages / debugging / CLI; inside plugins use ctx.gateway.crypt* (the same implementation). */
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

    // GET /admin/api/plugin-config/:uid/:pid -> {schema, config} / POST saves config and hot-reloads the plugin
    if ((m = /^\/admin\/api\/plugin-config\/(\d+)\/([a-z0-9][a-z0-9-]*)$/.exec(p))) {
      const uid = Number(m[1]), pid = m[2];
      const c = this.pool.instances.get(uid) || this.store.loadInstance(uid);
      if (!c) return json(404, { error: '实例不存在' });
      if (req.method === 'GET') {
        /* with scope=admin read the **admin copy** of theme params (theme plugins store per side; other plugins ignore this arg) */
        const scope = String(u.searchParams.get('scope') || 'admin');
        const r = this.plugins.configSchema(uid, pid, c, scope);
        if (!r) return json(404, { error: '插件不存在或未安装' });
        return json(200, { ok: true, id: pid, ...r });
      }
      if (req.method === 'POST') {
        const body = j();
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'body 必须是配置对象' });
        /* *admin APIs write the **admin copy** by default (theme plugins store per side; other plugins ignore scope).
         *  so the App side reads/writes its own copy naturally without passing scope. */
        const scope = String(u.searchParams.get('scope') || body.__scope || 'admin');
        delete body.__scope;
        /* *merge on write, never wholesale replace: forms submit only schema fields; replacing would wipe runtime data outside the schema
         *  (auth-user's users/groups, other plugins' runtime data). See the mergePluginConfig() comment. */
        const prevCfg = this.store.getPluginConfig(pid, uid, scope === 'admin' ? 'admin' : undefined) || {};
        const mergedCfg = mergePluginConfig(prevCfg, body);
        this.store.setPluginConfig(pid, uid, mergedCfg, scope === 'admin' ? 'admin' : undefined);
        // hot-reload a single plugin (when this instance has it enabled)
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

    /* ===== Plugin market ===== */
    // GET /admin/api/market/indexes -> index list
    if (p === '/admin/api/market/indexes' && req.method === 'GET') {
      return json(200, { ok: true, indexes: this.marketIndexes() });
    }
    // POST /admin/api/market/indexes {url} adds an index
    if (p === '/admin/api/market/indexes' && req.method === 'POST') {
      if (!this.store.index.marketTestMode) return json(403, { error: '未启用「测试模式」, 禁止添加自定义插件来源' });
      const body = j(); const url = String((body && body.url) || '').trim();
      if (!/^https?:\/\//.test(url)) return json(400, { error: 'index URL must be an http(s):// URL' });
      const list = this.marketIndexes();
      if (list.includes(url)) return json(409, { error: '索引已存在' });
      list.push(url); this.saveMarketIndexes(list);
      this.audit(0, 'market.index.add', { url });
      return json(200, { ok: true, indexes: list });
    }
    // POST /admin/api/market/indexes-delete {url} deletes an index
    if (p === '/admin/api/market/indexes-delete' && req.method === 'POST') {
      const body = j(); const url = String((body && body.url) || '').trim();
      const list = this.marketIndexes().filter(x => x !== url);
      this.saveMarketIndexes(list);
      return json(200, { ok: true, indexes: list });
    }
    // GET /admin/api/market/plugins?proxy= -> aggregate each index's plugin list (with install status)
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
    // POST /admin/api/market/install {url, sha256?, proxy?} installs a plugin package (.tar.gz)
    if (p === '/admin/api/market/install' && req.method === 'POST') {
      /* Gay Core §10: custom plugin sources are forbidden unless test mode is on */
      if (!this.store.index.marketTestMode) return json(403, { error: '未启用「测试模式」, 禁止添加自定义插件来源 (管理端 API /admin/api/market/test-mode 开启)' });
      const body = j(); const url = String((body && body.url) || '').trim();
      if (!/^https?:\/\//.test(url)) return json(400, { error: 'download URL must be an http(s):// URL' });
      try {
        const r = await this.plugins.installFromUrl(url, body.sha256 || null, body.proxy || null);
        this.audit(0, 'plugin.install', { id: r.id, version: r.manifest.version, sha256: r.sha256, url });
        return json(200, { ok: true, id: r.id, name: r.manifest.name || r.id, version: r.manifest.version, sha256: r.sha256, hint: '已安装(未启用), 到插件页打开开关启用' });
      } catch (e) { return json(400, { error: e.message }); }
    }
    // POST /admin/api/market/uninstall {id} uninstalls (built-ins refuse)
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

  /* masked backfill: sensitive fields reading "****"/"(encrypted)" keep their old values */
  unmaskMerge(newCfg, oldCfg) {
    const isMasked = v => typeof v === 'string' && (v === '(已加密)' || /^\S{0,4}\*{4}/.test(v));
    const merge = (n, o, key) => {
      if (typeof n === 'string' && isMasked(n) && o !== undefined && key && crypt.SENSITIVE_KEYS.test(key)) return o;
      if (Array.isArray(n)) {
        if (Array.isArray(o)) return n.map((x, i) => merge(x, o[i], null));
        return JSON.parse(JSON.stringify(n));
      }
      if (n && typeof n === 'object') {
        /* *merge starting from the old object (old fields kept), new keys win -- previously out started from {},
         *  POSTing {accessGuard:{...}} would replace the whole instance config with only accessGuard (2026-09-14 data-loss incident) */
        const out = (o && typeof o === 'object' && !Array.isArray(o)) ? Object.assign({}, o) : {};
        for (const k of Object.keys(n)) out[k] = merge(n[k], o ? o[k] : undefined, k);
        return out;
      }
      return n;
    };
    const patched = merge(newCfg, oldCfg || {}, null);
    /* old config as base + new keys on top: every top-level key the new config omits is preserved */
    return Object.assign(JSON.parse(JSON.stringify(oldCfg || {})), patched);
  }

  /* ---------- Start / stop ---------- */
  async start() {
    this.loadAll();
    /* *usage-stats history (2026-09-18): read from disk + a 60s flush timer (only changed buckets append to disk).
*  Must run after loadAll -- only then is the data directory known; disk writes are minimal (see usage-history.js). */
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
/* ★Flush in-memory "usage stats" buckets before exit -- otherwise the last 60s of request records vanish with the process */
    try { usageHist.flush(); } catch (_) {}
  }
}

module.exports = { Gateway, corsHeaders, sendError, jsonErr, collectModels, modelsResponse, modelsResponseFrom, GEMINI_RE, CORE_VERSION };
