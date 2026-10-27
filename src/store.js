'use strict';
/** store.js - the storage layer (doc §4 UID / §5 storage / §8 migration)
   * structure:
*   <dir>/instances.json            main index: {version,nextUid,setupMode,setupDeadline,instances:[{uid,name,port,enabled,file}]}
*   <dir>/instances/<uid>.json      instance config: {uid,name,listen,gatewayKey,adminKey,channels,proxies,tls,plugins,...}
*   <dir>/plugins-config/<id>.json  plugin config: { "<uid>": {...} }  (UID references the instance; renames stay intact)
*   <dir>/.agwkey                   encryption passphrase (optional, mode 600)
   * UID: sequential 32-bit allocation starting at 1, with nextUid persisted in the master index; separate from instance names (name = mutable routing prefix, UID = immutable reference).
   * encryption: field-level AGWENC1 (only sensitive fields; the master index stays plaintext).
 */
const fs = require('fs');
const path = require('path');
const crypt = require('./crypt');
const { atomicWrite, readJson, logErr } = require('./util');

const INDEX_VERSION = 1;
const INST_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
//// routing reserved words (doc §2.1): never taken as instance names
const RESERVED_PATHS = new Set(['v1', 'v1beta', 'v1alpha', 'admin', 'health', 'status', 'favicon.ico', 'robots.txt', 'setup', 'plugins', 'user', 'credits', 'auth', 'api', 'theme-config', 'ui']);

const CHANNEL_TYPES = ['openai', 'gemini', 'claude'];

/** instance config default normalization (kernel version: kernel fields only; cards/users/probe/thinkingSummary/openaiExtras are plugin-owned) */
function applyDefaults(cfg) {
  cfg.listen = cfg.listen || {};
  /* *port=0 = no separate listener (only /<main-port>/<instance>/ prefix routing); only "unconfigured" falls back to 16384.
     writing `cfg.listen.port || 16384` treated 0 as falsy -> every non-listening instance raced for 16384,
     colliding with the old ai-gateway's port (first to start wins). */
  cfg.listen.port = cfg.listen.port == null ? 16384 : Number(cfg.listen.port);
  cfg.listen.host = String(cfg.listen.host || '0.0.0.0');
  cfg.gatewayKey = cfg.gatewayKey ? String(cfg.gatewayKey) : '';
  cfg.adminKey = cfg.adminKey ? String(cfg.adminKey) : '';
  cfg.maxBodyBytes = Number(cfg.maxBodyBytes || 64 * 1024 * 1024);
  cfg.connectTimeout = Number(cfg.connectTimeout || 15000);
  cfg.responseTimeout = Number(cfg.responseTimeout || 180000);
if (cfg.connRetry === undefined) cfg.connRetry = 2; // same-channel retries for connection-level errors; 0=off
  cfg.cors = cfg.cors !== false;
  cfg.tls = cfg.tls || {};
  if (cfg.tls.enable) {
    cfg.tls.cert = String(cfg.tls.cert || 'cert.pem');
    cfg.tls.key = String(cfg.tls.key || 'key.pem');
    cfg.tls.port = cfg.tls.port != null ? Number(cfg.tls.port) : null; // null = same port as HTTP (pure HTTPS)
  }
  cfg.plugins = Array.isArray(cfg.plugins) ? cfg.plugins.filter(p => p && p.id) : [];
  return cfg;
}

/** channel whitelist normalization (kernel fields only; unknown custom fields like probe/useResponses pass through untouched -- plugins need them) */
function normalizeChannels(list, log = logErr) {
  const out = [];
  let i = 0;
  for (const ch of (Array.isArray(list) ? list : [])) {
    i++;
    if (!ch || !CHANNEL_TYPES.includes(String(ch.type || '').toLowerCase())) { log(`[store] 渠道 #${i} type 无效(openai/gemini/claude), 跳过`); continue; }
    if (!ch.baseUrl) { log(`[store] 渠道 "${ch.name || i}" 缺 baseUrl, 跳过`); continue; }
    const c = Object.assign({}, ch, {
      name: String(ch.name || ('channel-' + i)),
      type: String(ch.type).toLowerCase(),
      baseUrl: String(ch.baseUrl).replace(/\/+$/, ''),
      apiKey: ch.apiKey != null ? String(ch.apiKey) : '',
      proxy: ch.proxy != null && ch.proxy !== '' ? String(ch.proxy) : null,
      insecure: !!ch.insecure,
      models: Array.isArray(ch.models) ? ch.models.map(String) : null,
      modelMap: (ch.modelMap && typeof ch.modelMap === 'object' && !Array.isArray(ch.modelMap)) ? ch.modelMap : null,
      default: !!ch.default,
      delayMs: Math.max(0, Number(ch.delayMs) || 0),
      addUsage: ch.addUsage !== false,
      anthropicVersion: ch.anthropicVersion ? String(ch.anthropicVersion) : null,
    });
    if (!c.apiKey) log(`[store] ⚠ 渠道 "${c.name}" 没有 apiKey`);
    out.push(c);
  }
  return out;
}

class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.instancesDir = path.join(this.dir, 'instances');
    this.pluginsConfigDir = path.join(this.dir, 'plugins-config');
    this.pluginsDataDir = path.join(this.dir, 'plugins-data');
    this.pluginsDir = path.join(this.dir, 'plugins');
    this.indexFile = path.join(this.dir, 'instances.json');
    for (const d of [this.dir, this.instancesDir, this.pluginsConfigDir, this.pluginsDataDir, this.pluginsDir])
      fs.mkdirSync(d, { recursive: true });
    this._pass = crypt.loadPass(this.dir);
    /* *encryption-locked state (key vault, 2026-09-18): with the passphrase memory-only, a restart yields "ciphertext but no passphrase".
*  At this point sensitive fields read back as AGWENC1 ciphertext; using them against upstreams means 401s across the board -- the core therefore **refuses to forward** and
     *  clearly hint to unlock (see Gateway's 503 interception) instead of leaving users debugging a mystery 401.
     *  the test is "ciphertext really exists on disk", so no extra marker file is needed and hand-edited configs cannot weaken security. */
    this.locked = false;
    if (!this._pass) {
      try { this.locked = this.hasCiphertext(); } catch (_) { this.locked = false; }
    }
/* ★Core callback (2026-09-18 multi-instance consistency): every path that writes plugin config -- including ones that **bypass ctx** --
     *  `/admin/api/plugin-config/:uid/:pid` (the App plugin-config page) -- both fire it after persisting,
     *  the PluginManager bumps the version and syncs the new config to the plugin's other instances.
     *  hooked only onto ctx.setPluginConfig, configs changed via the admin API would never be noticed by other instances. */
    this.onPluginConfigWrite = null;
    this.index = this.loadIndex();
    this.scanUidUnique();
  }

  /* ---------- Master index ---------- */
  loadIndex() {
    let idx = readJson(this.indexFile);
    if (!idx || typeof idx !== 'object' || !Array.isArray(idx.instances)) {
      idx = { version: INDEX_VERSION, nextUid: 1, setupMode: false, setupDeadline: 0, adminCreated: false, instances: [] };
      this._saveIndex(idx);
    }
    return idx;
  }
  _saveIndex(idx) { atomicWrite(this.indexFile, JSON.stringify(idx || this.index, null, 2)); if (!idx) return; }
  saveIndex() { atomicWrite(this.indexFile, JSON.stringify(this.index, null, 2)); }

  /* ---------- UID ---------- */
  allocUid() {
    const uid = this.index.nextUid || 1;
    this.index.nextUid = uid + 1;
    this.saveIndex();
    return uid;
  }
  /* scan UID uniqueness globally at startup; auto-regenerate duplicates (doc §4.3) */
  scanUidUnique() {
    const seen = new Set();
    let changed = false;
    for (const m of this.index.instances) {
      if (!Number.isInteger(m.uid) || m.uid < 1 || seen.has(m.uid)) {
        m.uid = this.index.nextUid || 1;
        this.index.nextUid = m.uid + 1;
        changed = true;
        logErr(`[store] 实例 "${m.name}" UID 重复/非法, 已重生为 ${m.uid}`);
      }
      seen.add(m.uid);
      m.file = 'instances/' + m.uid + '.json';
    }
    const maxUid = Math.max(0, ...this.index.instances.map(m => m.uid));
    if ((this.index.nextUid || 1) <= maxUid) { this.index.nextUid = maxUid + 1; changed = true; }
    if (changed) this.saveIndex();
  }
  uidOf(nameOrUid) {
    if (typeof nameOrUid === 'number') return nameOrUid;
    if (/^\d+$/.test(String(nameOrUid))) { const u = Number(nameOrUid); if (this.index.instances.some(m => m.uid === u)) return u; }
    const m = this.index.instances.find(x => x.name === String(nameOrUid));
    return m ? m.uid : null;
  }
  meta(uid) { return this.index.instances.find(m => m.uid === uid) || null; }
  metaByName(name) { return this.index.instances.find(m => m.name === name) || null; }

  /* ---------- Site (relay) profile: global, stored in instances.json (shown on the App/user pages) ---------- */
  getServerInfo() {
    const s = this.index.serverInfo;
    return (s && typeof s === 'object') ? s : {};
  }
  saveServerInfo(info) {
    const allow = ['name', 'description', 'icon', 'announcement', 'contact', 'website', 'currencySymbol'];
    const out = {};
    for (const k of allow) if (info && typeof info[k] === 'string') out[k] = info[k].slice(0, 2000);
    if (out.currencySymbol != null) out.currencySymbol = out.currencySymbol.slice(0, 8);
    /* token display rate: how many tokens one currency unit buys (number; unset = 1, i.e. display raw token counts).
     * affects only client **display**, never quota math. */
    if (info && info.currencyRate != null && info.currencyRate !== '') {
      const r = Number(info.currencyRate);
      if (isFinite(r) && r > 0) out.currencyRate = r;
    }
    this.index.serverInfo = out;
    this.saveIndex();
    return out;
  }

  /* ---------- Instance config ---------- */
  instFile(uid) { return path.join(this.dir, 'instances', uid + '.json'); }
  hasInstance(uid) { return fs.existsSync(this.instFile(uid)); }

  loadInstance(uid) {
    const file = this.instFile(uid);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
    let cfg;
    try { cfg = JSON.parse(raw); } catch (e) { throw new Error('实例配置解析失败 uid=' + uid + ': ' + e.message); }
    cfg = crypt.decryptFields(cfg, this._pass);
    cfg.channels = normalizeChannels(cfg.channels);
    applyDefaults(cfg);
    cfg._uid = uid;
    cfg._name = cfg.name || (this.meta(uid) || {}).name || ('inst-' + uid);
    cfg._configFile = file;
    cfg._store = this;
    return cfg;
  }

  saveInstance(uid, cfg) {
    const meta = this.meta(uid);
    if (!meta) throw new Error('实例不存在 uid=' + uid);
    const out = Object.assign({}, cfg);
    // strip runtime fields (_-prefixed)
    for (const k of Object.keys(out)) if (k.startsWith('_')) delete out[k];
    out.uid = uid;
    out.name = meta.name;
    const enc = crypt.encryptFields(out, this._pass);
    atomicWrite(this.instFile(uid), JSON.stringify(enc, null, 2));
  }

  createInstance(name, cfg = {}) {
    if (!INST_NAME_RE.test(name)) throw new Error('实例名非法: ' + name);
    if (RESERVED_PATHS.has(name)) throw new Error('实例名是保留字: ' + name);
    if (this.metaByName(name)) throw new Error('实例名已存在: ' + name);
    const uid = this.allocUid();
    const meta = { uid, name, port: Number(cfg.listen && cfg.listen.port) || 0, enabled: true, file: 'instances/' + uid + '.json' };
    this.index.instances.push(meta);
    this.saveIndex();
    cfg.uid = uid; cfg.name = name;
    this.saveInstance(uid, cfg);
    return uid;
  }

  deleteInstance(uid) {
    const meta = this.meta(uid);
    if (!meta) return false;
    if (meta.name === 'default') throw new Error('default 主实例不可删除');
    this.index.instances = this.index.instances.filter(m => m.uid !== uid);
    this.saveIndex();
    try { fs.unlinkSync(this.instFile(uid)); } catch (_) {}
    // also clear this UID's entry in the plugin config (doc §6.3: uninstall = clean)
    for (const f of fs.readdirSync(this.pluginsConfigDir)) {
      const p = path.join(this.pluginsConfigDir, f);
      const j = readJson(p);
      if (j && typeof j === 'object' && j[String(uid)] !== undefined) { delete j[String(uid)]; atomicWrite(p, JSON.stringify(j, null, 2)); }
    }
    return true;
  }

  renameInstance(uid, newName) {
    if (!INST_NAME_RE.test(newName)) throw new Error('实例名非法: ' + newName);
    if (RESERVED_PATHS.has(newName)) throw new Error('实例名是保留字: ' + newName);
    const meta = this.meta(uid);
    if (!meta) throw new Error('实例不存在 uid=' + uid);
    if (meta.name === 'default') throw new Error('default 主实例不可改名');
    if (this.metaByName(newName)) throw new Error('实例名已存在: ' + newName);
    meta.name = newName;
    this.saveIndex();
    const cfg = this.loadInstance(uid);
    if (cfg) { cfg.name = newName; this.saveInstance(uid, cfg); }
    return true;
  }

  setEnabled(uid, enabled) {
    const meta = this.meta(uid);
    if (!meta) throw new Error('实例不存在 uid=' + uid);
    if (meta.name === 'default' && !enabled) throw new Error('default 主实例不可停用');
    meta.enabled = !!enabled;
    this.saveIndex();
  }

  /* ---------- Plugin configs (UID-referenced, doc §6.1) ----------
* ★Scope (2026-09-12 user decision): plugin config is **globally shared** by default (one copy for all instances),
   *   plugin data stays per-instance by default. manifest.json can override:
   *     "scope":     "global" (default) | "instance"     -- config
   *     "dataScope": "instance" (default) | "global"     -- runtime data (ctx.data)
   *   note: applyDefaults/loadInstance rebuild channel objects and drop custom fields; plugin-relevant fields need separate preservation.
   */
  pluginConfigFile(pluginId) { return path.join(this.pluginsConfigDir, pluginId + '.json'); }
  /* ---------- Plugin enablement table (user decision 2026-09-12: one global copy; new instances inherit it) ---------- */
  pluginEnableFile() { return path.join(this.dir, 'plugin-enable.json'); }
  pluginEnableList(cfg) {
    let g = null;
    try { g = readJson(this.pluginEnableFile()); } catch (_) {}
    if (Array.isArray(g)) return g;
    /* compat: fall back to inline instance plugins[] when the global table is absent */
    return Array.isArray(cfg && cfg.plugins) ? cfg.plugins : [];
  }
  setPluginEnableList(list) {
    atomicWrite(this.pluginEnableFile(), JSON.stringify(Array.isArray(list) ? list : [], null, 2));
  }
/** Read a plugin manifest (cached) */
/** Read a plugin manifest.
   *  *must check **both levels** (built-in `source plugins/` + the data dir `data/plugins/`), consistent with `PluginManager.scanInstalled()`
*  matches that lookup order -- if only the data directory were searched, built-in plugins (e.g. theme theme-compose) would never find their manifest,
   *  `configKey()` would degrade to `_global` (been there: per-side theme params silently not applying). */
  manifestOf(pluginId) {
    if (!this._mfCache) this._mfCache = {};
    if (this._mfCache[pluginId] !== undefined) return this._mfCache[pluginId];
    let m = null;
    const dirs = [
      path.resolve(__dirname, '..', 'plugins'),  // 内置（随内核分发）
      this.pluginsDir,                           // user-installed (data dir; same id overrides built-ins)
    ];
    for (const base of dirs) {
      try {
        m = readJson(path.join(base, String(pluginId), 'manifest.json'));
        if (m && typeof m === 'object') break;
        m = null;
      } catch (_) { m = null; }
    }
    this._mfCache[pluginId] = m || {};
    return this._mfCache[pluginId];
  }
  configScope(pluginId) {
    const m = this.manifestOf(pluginId);
    return m.scope === 'instance' ? 'instance' : 'global';
  }
  dataScope(pluginId) {
    const m = this.manifestOf(pluginId);
    return m.dataScope === 'global' ? 'global' : 'instance';
  }
/** Which key stores the config: global plugins always use _global;
   *  *theme plugins' "palette params" are stored per side (2026-09-16): within one instance, admin and user each keep their own copy
*  (`_admin` / `_user`), so "changing admin-side colors never touches the user side" (explicit user request: themes need no cross-side sync). */
  configKey(pluginId, uid, scope) {
    const m = this.manifestOf(pluginId);
    if (m && m.type === 'theme') return scope === 'admin' ? '_theme_admin' : '_theme_user';
    return this.configScope(pluginId) === 'global' ? '_global' : String(uid);
  }
  getPluginConfig(pluginId, uid, scope) {
    const j = readJson(this.pluginConfigFile(pluginId));
    if (!j || typeof j !== 'object') return null;
    let v = j[this.configKey(pluginId, uid, scope)];
/* Migration compatibility: the theme plugin's **old data lives in `_global`**. After the per-side split, a side that has not written yet keeps the old value --
     * so the user side sees no sudden change from this; the admin side also sees "the palette it tuned before" on first visit instead of snapping back to defaults. */
    if (v === undefined) {
      const m = this.manifestOf(pluginId);
      if (m && m.type === 'theme') v = j['_global'];
    }
    const raw = (v && typeof v === 'object') ? crypt.decryptFields(v, this._pass) : null;
    /* *also restore on read: historical dirty data ("true"/"false" strings) is corrected automatically, no manual file edits */
    return raw ? this.coerceConfigBySchema(pluginId, raw) : null;
  }
  /* *restore "client-stringified" values per manifest.configSchema (2026-09-19 incident fix)
* Background: the App's SDUI form packs every input as a **string** (Renderer's inputs is a Map<String,String>),
   *  so booleans persisted as "true"/"false" and numbers as "3"; the plugin wrote
   *  `cfg.x === false` / `!!cfg.x` -> fooled by strings, showing up as "the switch cannot be turned off"
*  (the music-remote "allow remote skip" incident: on disk "false" never equals false, so the 403 guard never fired).
* Rules: (1) touch only fields **declared** in the schema (runtime data like users/groups is never touched)
*      (2) values that fail to parse are **kept verbatim** -- no guessing, never repeat "empty string silently treated as off"
   *      (3) when the type is already right, return the original object (the read path is hot; avoid pointless copies). */
  coerceConfigBySchema(pluginId, obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const m = this.manifestOf(pluginId);
    const schema = (m && Array.isArray(m.configSchema)) ? m.configSchema : null;
    if (!schema || !schema.length) return obj;
    let out = null;
    const put = (k, v) => { if (!out) out = Object.assign({}, obj); out[k] = v; };
    for (const f of schema) {
      if (!f || !f.key) continue;
      const v = obj[f.key];
      if (v === undefined || v === null) continue;
      const t = String(f.type || 'string');
      if (t === 'boolean') {
        if (typeof v === 'boolean') continue;
        if (typeof v === 'number') { put(f.key, v !== 0); continue; }
        if (typeof v === 'string') {
          const t2 = v.trim().toLowerCase();
          if (t2 === 'true' || t2 === '1' || t2 === 'on' || t2 === 'yes') put(f.key, true);
          else if (t2 === 'false' || t2 === '0' || t2 === 'off' || t2 === 'no') put(f.key, false);
          /* anything else (including empty strings) -> keep the original value for the plugin */
        }
      } else if (t === 'number') {
        if (typeof v === 'number') continue;
        if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) put(f.key, Number(v));
      } else if (t === 'string') {
        if (typeof v !== 'string' && typeof v !== 'object') put(f.key, String(v));
      }
    }
    return out || obj;
  }

  setPluginConfig(pluginId, uid, cfgObj, scope) {
    const file = this.pluginConfigFile(pluginId);
    const j = readJson(file) || {};
    /* *restore types per schema before persisting (clients submit everything as strings) */
    j[this.configKey(pluginId, uid, scope)] = crypt.encryptFields(this.coerceConfigBySchema(pluginId, cfgObj || {}), this._pass);
    atomicWrite(file, JSON.stringify(j, null, 2));
    /* *notify the kernel after persisting (2026-09-18): bump the version and push-sync the new config to the plugin's other instances.
*  centralized on the Store -- so both ctx.setPluginConfig and /admin/api/plugin-config are covered (nothing slips through). */
    if (typeof this.onPluginConfigWrite === 'function') { try { this.onPluginConfigWrite(pluginId); } catch (_) {} }
  }

  /* ==================== Encryption passphrase / lock / re-encrypt (2026-09-18) ====================
* Design: the passphrase is **not persisted by default** (no .agwkey written), memory only; a restart = back to locked state,
* unlocked from Gay Core's "key vault" plugin page (passphrase stored in the App-side Keystore for automatic unlock).
* This module provides only the four pure functions "detect / verify / set / re-encrypt"; UI and flows live in the plugin. */

/** Whether AGWENC1 ciphertext already exists in the data directory (tells "encrypted but locked"; .bak-* backups do not count) */
  hasCiphertext() {
    for (const d of [this.instancesDir, this.pluginsConfigDir]) {
      let files = [];
      try { files = fs.readdirSync(d); } catch (_) { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try { if (fs.readFileSync(path.join(d, f), 'utf8').includes(crypt.MAGIC)) return true; } catch (_) {}
      }
    }
    return false;
  }

/** Set the passphrase at runtime (null = locked). Recomputes locked automatically. */
  setPass(pass) {
    this._pass = pass ? String(pass) : null;
    this.locked = !this._pass && this.hasCiphertext();
    return this.cryptStatus();
  }

/** Verify the passphrase against existing ciphertext on disk: returns true when there is none (first-time encryption, any compliant passphrase works) */
  verifyPass(pass) {
    const findEnc = (o) => {
      if (typeof o === 'string') return crypt.isEncText(o) ? o : null;
      if (Array.isArray(o)) { for (const x of o) { const r = findEnc(x); if (r) return r; } return null; }
      if (o && typeof o === 'object') { for (const k of Object.keys(o)) { const r = findEnc(o[k]); if (r) return r; } }
      return null;
    };
    for (const d of [this.instancesDir, this.pluginsConfigDir]) {
      let files = [];
      try { files = fs.readdirSync(d).filter(f => f.endsWith('.json')); } catch (_) { continue; }
      for (const f of files) {
        let j = null;
        try { j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch (_) { continue; }
        const hit = findEnc(j);
        if (hit) { try { crypt.decryptText(hit, pass); return true; } catch (_) { return false; } }
      }
    }
    return true;
  }

/** Passphrase / encryption status (for the "key vault" page) */
  cryptStatus() {
    let files = 0, encrypted = 0;
    const backups = [];
    for (const d of [this.instancesDir, this.pluginsConfigDir]) {
      let list = [];
      try { list = fs.readdirSync(d); } catch (_) { continue; }
      for (const f of list) {
        if (f.includes('.bak-crypt-')) { backups.push(f); continue; }   /* 迁移/换口令时留的备份(含明文) */
        if (!f.endsWith('.json')) continue;
        files++;
        try { if (fs.readFileSync(path.join(d, f), 'utf8').includes(crypt.MAGIC)) encrypted++; } catch (_) {}
      }
    }
    let source = null;
    if (process.env.AGW_CRYPT_PASS) source = 'env';
    else if (fs.existsSync(path.join(this.dir, '.agwkey'))) source = 'file';
    else if (this._pass) source = 'memory';
    return {
      unlocked: !!this._pass, locked: !!this.locked, source,
      files, encrypted, backups,
      dataDir: this.dir,
      keyFile: fs.existsSync(path.join(this.dir, '.agwkey')),
    };
  }

/** ★How to prove "who you are" while locked (2026-09-18): **no plaintext credentials on disk** whatsoever.
   *  approach: decrypt the instance file's adminKey/secondKey ciphertext with the submitted passphrase; the result == the submitted admin key
   *  => the passphrase is right **and** the admin key is right (two factors). While locked, the card table/admin key are themselves ciphertext, so any normal auth
*  none of them pass (that is the whole point of the lock), so the unlock path must carry its own credential.
   *  cost: an attacker still needs scrypt first (~50ms each, plus plugin-side rate limiting); and if the user enabled secondKey/TOTP,
*  Unlocking skips second-factor checks (the passphrase itself is the key that opens everything). */
  verifyAdminKeyWithPass(pass, adminKey) {
    const want = String(adminKey == null ? '' : adminKey).trim();
    if (!pass || !want) return false;
    const scan = (o) => {
      if (Array.isArray(o)) return o.some(scan);
      if (!o || typeof o !== 'object') return false;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === 'string' && crypt.isEncText(v) && /^(adminKey|secondKey)$/i.test(k)) {
          try { if (crypt.decryptText(v, pass) === want) return true; } catch (_) {}
        }
        if (scan(v)) return true;
      }
      return false;
    };
    let files = [];
    try { files = fs.readdirSync(this.instancesDir).filter(f => f.endsWith('.json')); } catch (_) { return false; }
    for (const f of files) {
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(this.instancesDir, f), 'utf8')); } catch (_) { continue; }
      if (scan(j)) return true;
    }
    return false;
  }

/** Delete `.bak-crypt-*` backups left by migration/passphrase change (★they hold plaintext or old ciphertext; clean up once confirmed) */  cleanCryptBackups() {
    const removed = [];
    for (const d of [this.instancesDir, this.pluginsConfigDir]) {
      let list = [];
      try { list = fs.readdirSync(d); } catch (_) { continue; }
      for (const f of list) {
        if (!f.includes('.bak-crypt-')) continue;
        try { fs.unlinkSync(path.join(d, f)); removed.push(f); } catch (_) {}
      }
    }
    return { ok: true, removed, count: removed.length };
  }

/** Rewrite sensitive fields in all instance configs + plugin configs as ciphertext of the **new passphrase** (encryption migration / passphrase change).
   *  oldPass = the current in-memory passphrase (null = the disk file is plaintext); every rewritten file leaves a `.bak-crypt-<ts>` backup first
*  (kept at the user's request for easy rollback; ★the backups hold plaintext/old ciphertext -- delete them from the plugin page once the risky window closes). */
  reencryptAll(newPass, { tag = 'crypt' } = {}) {
    const p = String(newPass || '').trim();
    if (!p) return { ok: false, error: '口令不能为空' };
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const out = { ok: true, scanned: 0, rewritten: 0, skipped: 0, backups: [], errors: [] };
    const targets = [];
    for (const d of [this.instancesDir, this.pluginsConfigDir]) {
      try { for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) targets.push(path.join(d, f)); } catch (_) {}
    }
    /* find the first ciphertext (to tell "whether this file was ever encrypted") */
    const firstEnc = (o) => {
      if (typeof o === 'string') return crypt.isEncText(o) ? o : null;
      if (Array.isArray(o)) { for (const x of o) { const r = firstEnc(x); if (r) return r; } return null; }
      if (o && typeof o === 'object') { for (const k of Object.keys(o)) { const r = firstEnc(o[k]); if (r) return r; } }
      return null;
    };
/* ★Pre-check (2026-09-18): if even one "encrypted file" cannot be decrypted with (in-memory passphrase -> target passphrase), **reject the whole operation** --
     *  never allow "skip some, write the rest" partial writes (they leave the gateway half-encrypted/falsely unlocked -- most dangerous during a passphrase change).
     *  note: decryptFields returns ciphertext as-is for a wrong passphrase **without throwing**, so the check must sample via decryptText. */
    const plain = new Map();          /* file -> decrypted plaintext (cached for reuse below) */
    for (const f of targets) {
      let j = null;
      try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
      const sample = firstEnc(j);
      if (!sample) { plain.set(f, j); continue; }           /* plaintext file: use directly */
      let dec = null;
      if (this._pass) {
        try { crypt.decryptText(sample, this._pass); dec = crypt.decryptFields(j, this._pass); } catch (_) { dec = null; }
      }
      if (!dec) {
        try { crypt.decryptText(sample, p); dec = crypt.decryptFields(j, p); } catch (_) { dec = null; }
      }
      if (!dec) {
        return { ok: false, error: '口令不正确：有文件是用别的口令加密的（请先用原口令解锁，再换口令）', file: path.basename(f) };
      }
      plain.set(f, dec);
    }
    for (const f of targets) {
      out.scanned++;
      try {
        const raw = fs.readFileSync(f, 'utf8');
        const j = JSON.parse(raw);
        const dec = plain.get(f) || j;
        /* *already ciphertext of the target passphrase with no plaintext leftovers -> skip (otherwise every tap rewrites everything and piles up backups,
         *  and burns seconds of CPU -- measured 2026-09-18: rapid taps blocked the gateway entirely)
         *  the check must use the **original file object j**: encryptFields never re-encrypts ciphertext, so result == j means no plaintext left to encrypt. */
        const sample = firstEnc(j);
        if (sample) {
          let samePass = false;
          try { crypt.decryptText(sample, p); samePass = true; } catch (_) { samePass = false; }
          const noPlain = JSON.stringify(crypt.encryptFields(j, p)) === JSON.stringify(j);
          if (samePass && noPlain) { out.skipped++; continue; }
        }
        const enc = crypt.encryptFields(dec, p);
        const text = JSON.stringify(enc, null, 2);
        if (text === raw) { out.skipped++; continue; }          /* nothing encryptable */
        /* *keep a backup only when the file is currently plaintext -- that is the real rollback point (contains plaintext, recoverable).
         *  re-encrypting encrypted files (pass change / repeated taps) leaves backups holding **old ciphertext** -- useless in an emergency and a waste of space,
         *  and fools the "recover plaintext keys from backups" procedure (2026-09-18: of 6 backups only the earliest was plaintext). */
        if (!sample) {
          const bak = f + '.bak-' + tag + '-' + ts;
          fs.copyFileSync(f, bak);
          out.backups.push(path.basename(bak));
        }
        atomicWrite(f, text);
        out.rewritten++;
      } catch (e) { out.errors.push(path.basename(f) + ': ' + e.message); }
    }
    return out;
  }
  deletePluginConfig(pluginId, uid) {
    const file = this.pluginConfigFile(pluginId);
    const j = readJson(file);
    if (j && j[String(uid)] !== undefined) { delete j[String(uid)]; atomicWrite(file, JSON.stringify(j, null, 2)); }
  }

  /* ---------- setup mode (doc §3.3) ---------- */
  isSetupMode() {
    if (!this.index.setupMode) return false;
    if (this.index.setupDeadline && Date.now() > this.index.setupDeadline) return false; // locked after the deadline
    return !this.index.adminCreated;
  }
  armSetup(windowMs = 10 * 60 * 1000) {
    this.index.setupMode = true;
    this.index.setupDeadline = Date.now() + windowMs;
    this.saveIndex();
  }
  completeSetup() {
    this.index.adminCreated = true;
    this.index.setupMode = false;
    this.saveIndex();
  }

  /* ---------- Migration (doc §8.2): old config.<name>.json -> instances/<uid>.json ---------- */
  detectLegacy(legacyDir) {
    const d = legacyDir || this.dir;
    let files = [];
    try { files = fs.readdirSync(d); } catch (_) { return []; }
    return files.filter(f => /^config(\.[A-Za-z0-9_-]{1,32})?\.json$/.test(f));
  }

  /* run the migration: returns {migrated:[{name,uid}], skipped:[], errors:[]} */
  migrate(legacyDir, { log = logErr } = {}) {
    const d = legacyDir || this.dir;
    const files = this.detectLegacy(d);
    const res = { migrated: [], skipped: [], errors: [] };
    if (!files.length) return res;
    const oldPass = crypt.loadPass(d);
    for (const f of files.sort()) {
      try {
        const m = /^config(?:\.([A-Za-z0-9_-]{1,32}))?\.json$/.exec(f);
        const name = m[1] || 'default';
        if (this.metaByName(name)) { res.skipped.push({ name, reason: '已存在' }); continue; }
        let raw = fs.readFileSync(path.join(d, f), 'utf8');
        if (crypt.isEncText(raw)) {
          if (!oldPass) throw new Error('旧配置已加密但无口令(AGW_CRYPT_PASS/.agwkey)');
          raw = crypt.decryptText(raw, oldPass);
        }
        let cfg = JSON.parse(raw);
        // old whole-file encryption already decrypted; strip legacy runtime fields
        for (const k of Object.keys(cfg)) if (k.startsWith('_')) delete cfg[k];
        const uid = this.createInstance(name, cfg);
        res.migrated.push({ name, uid });
        // split inline plugin config out to plugins-config (doc §8.2 step 2)
        if (Array.isArray(cfg.plugins)) {
          for (const pc of cfg.plugins) {
            if (pc && pc.id && pc.config && typeof pc.config === 'object') {
              this.setPluginConfig(pc.id, uid, pc.config);
            }
          }
          // instance configs keep only id+enable in plugins (the config itself moved out)
          const inst = this.loadInstance(uid);
          inst.plugins = inst.plugins.map(pc => ({ id: pc.id, enable: !!pc.enable }));
          this.saveInstance(uid, inst);
        }
        if (d === this.dir) fs.renameSync(path.join(d, f), path.join(d, f + '.bak-migrate'));
        log('[store] 迁移 ' + name + ' → uid ' + uid);
      } catch (e) {
        res.errors.push({ file: f, error: e.message });
      }
    }
    return res;
  }

/* Migration check: compare instance/channel counts (docs §8.2 step 4) */
  verifyMigration(legacyDir) {
    const d = legacyDir || this.dir;
    const files = this.detectLegacy(d).concat(
      (() => { try { return fs.readdirSync(d).filter(f => f.endsWith('.json.bak-migrate')); } catch (_) { return []; } })()
    );
    const report = [];
    const oldPass = crypt.loadPass(d);
    for (const f of files.sort()) {
      try {
        let raw = fs.readFileSync(path.join(d, f), 'utf8');
        if (crypt.isEncText(raw)) raw = crypt.decryptText(raw, oldPass);
        const oldCfg = JSON.parse(raw);
        const m = /^config(?:\.([A-Za-z0-9_-]{1,32}))?\.json/.exec(f);
        const name = m[1] || 'default';
        const meta = this.metaByName(name);
        if (!meta) { report.push({ name, ok: false, reason: '新存储中不存在' }); continue; }
        const newCfg = this.loadInstance(meta.uid);
        const oldCh = (oldCfg.channels || []).length, newCh = (newCfg.channels || []).length;
        const oldPort = oldCfg.listen && oldCfg.listen.port, newPort = newCfg.listen && newCfg.listen.port;
        report.push({ name, uid: meta.uid, ok: oldCh === newCh && oldPort === newPort, channels: oldCh + '→' + newCh, port: oldPort + '→' + newPort });
      } catch (e) { report.push({ file: f, ok: false, reason: e.message }); }
    }
    return report;
  }

  /* instance status overview (doc §5.5): aggregate the instance config + all plugin configs by UID */
  instanceFull(uid) {
    const meta = this.meta(uid);
    if (!meta) return null;
    const cfg = this.loadInstance(uid);
    const masked = crypt.maskFields(cfg);
    for (const k of Object.keys(masked)) if (k.startsWith('_')) delete masked[k];
    const plugins = {};
    for (const f of fs.readdirSync(this.pluginsConfigDir)) {
      const j = readJson(path.join(this.pluginsConfigDir, f));
      if (j && j[String(uid)] !== undefined) plugins[f.replace(/\.json$/, '')] = crypt.maskFields(j[String(uid)]);
    }
    return { meta, config: masked, pluginConfigs: plugins };
  }
}

module.exports = { Store, applyDefaults, normalizeChannels, INST_NAME_RE, RESERVED_PATHS, INDEX_VERSION };
