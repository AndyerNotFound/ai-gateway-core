'use strict';
                                             
      
                                                                                                                            
                                                                                                                 
                                                                               
                                                    
                                                                         
                                    
   
const fs = require('fs');
const path = require('path');
const crypt = require('./crypt');
const { atomicWrite, readJson, logErr } = require('./util');

const INDEX_VERSION = 1;
const INST_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
                            
const RESERVED_PATHS = new Set(['v1', 'v1beta', 'v1alpha', 'admin', 'health', 'status', 'favicon.ico', 'robots.txt', 'setup', 'plugins', 'user', 'credits', 'auth', 'api']);

const CHANNEL_TYPES = ['openai', 'gemini', 'claude'];

                                                                             
function applyDefaults(cfg) {
  cfg.listen = cfg.listen || {};
  cfg.listen.port = Number(cfg.listen.port || 16384);
  cfg.listen.host = String(cfg.listen.host || '0.0.0.0');
  cfg.gatewayKey = cfg.gatewayKey ? String(cfg.gatewayKey) : '';
  cfg.adminKey = cfg.adminKey ? String(cfg.adminKey) : '';
  cfg.maxBodyBytes = Number(cfg.maxBodyBytes || 64 * 1024 * 1024);
  cfg.connectTimeout = Number(cfg.connectTimeout || 15000);
  cfg.responseTimeout = Number(cfg.responseTimeout || 180000);
  if (cfg.connRetry === undefined) cfg.connRetry = 2;                       
  cfg.cors = cfg.cors !== false;
  cfg.tls = cfg.tls || {};
  if (cfg.tls.enable) {
    cfg.tls.cert = String(cfg.tls.cert || 'cert.pem');
    cfg.tls.key = String(cfg.tls.key || 'key.pem');
    cfg.tls.port = cfg.tls.port != null ? Number(cfg.tls.port) : null;                         
  }
  cfg.plugins = Array.isArray(cfg.plugins) ? cfg.plugins.filter(p => p && p.id) : [];
  return cfg;
}

                                                              
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
    this.index = this.loadIndex();
    this.scanUidUnique();
  }

                                 
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

                                 
  allocUid() {
    const uid = this.index.nextUid || 1;
    this.index.nextUid = uid + 1;
    this.saveIndex();
    return uid;
  }
                                         
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

                                                                           
  getServerInfo() {
    const s = this.index.serverInfo;
    return (s && typeof s === 'object') ? s : {};
  }
  saveServerInfo(info) {
    const allow = ['name', 'description', 'icon', 'announcement', 'contact', 'website'];
    const out = {};
    for (const k of allow) if (info && typeof info[k] === 'string') out[k] = info[k].slice(0, 2000);
    this.index.serverInfo = out;
    this.saveIndex();
    return out;
  }

                                  
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

                                                   
                                                  
                                        
                                                         
                                                                     
                                                               
     
  pluginConfigFile(pluginId) { return path.join(this.pluginsConfigDir, pluginId + '.json'); }
                                                                    
  pluginEnableFile() { return path.join(this.dir, 'plugin-enable.json'); }
  pluginEnableList(cfg) {
    let g = null;
    try { g = readJson(this.pluginEnableFile()); } catch (_) {}
    if (Array.isArray(g)) return g;
                                      
    return Array.isArray(cfg && cfg.plugins) ? cfg.plugins : [];
  }
  setPluginEnableList(list) {
    atomicWrite(this.pluginEnableFile(), JSON.stringify(Array.isArray(list) ? list : [], null, 2));
  }
                          
  manifestOf(pluginId) {
    if (!this._mfCache) this._mfCache = {};
    if (this._mfCache[pluginId] !== undefined) return this._mfCache[pluginId];
    let m = null;
    try { m = readJson(path.join(this.dir, 'plugins', String(pluginId), 'manifest.json')); } catch (_) {}
    this._mfCache[pluginId] = (m && typeof m === 'object') ? m : {};
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
                               
  configKey(pluginId, uid) {
    return this.configScope(pluginId) === 'global' ? '_global' : String(uid);
  }
  getPluginConfig(pluginId, uid) {
    const j = readJson(this.pluginConfigFile(pluginId));
    if (!j || typeof j !== 'object') return null;
    const v = j[this.configKey(pluginId, uid)];
    return (v && typeof v === 'object') ? crypt.decryptFields(v, this._pass) : null;
  }
  setPluginConfig(pluginId, uid, cfgObj) {
    const file = this.pluginConfigFile(pluginId);
    const j = readJson(file) || {};
    j[this.configKey(pluginId, uid)] = crypt.encryptFields(cfgObj || {}, this._pass);
    atomicWrite(file, JSON.stringify(j, null, 2));
  }
  deletePluginConfig(pluginId, uid) {
    const file = this.pluginConfigFile(pluginId);
    const j = readJson(file);
    if (j && j[String(uid)] !== undefined) { delete j[String(uid)]; atomicWrite(file, JSON.stringify(j, null, 2)); }
  }

                                                
  isSetupMode() {
    if (!this.index.setupMode) return false;
    if (this.index.setupDeadline && Date.now() > this.index.setupDeadline) return false;        
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

                                                                                       
  detectLegacy(legacyDir) {
    const d = legacyDir || this.dir;
    let files = [];
    try { files = fs.readdirSync(d); } catch (_) { return []; }
    return files.filter(f => /^config(\.[A-Za-z0-9_-]{1,32})?\.json$/.test(f));
  }

                                                               
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
                              
        for (const k of Object.keys(cfg)) if (k.startsWith('_')) delete cfg[k];
        const uid = this.createInstance(name, cfg);
        res.migrated.push({ name, uid });
                                                
        if (Array.isArray(cfg.plugins)) {
          for (const pc of cfg.plugins) {
            if (pc && pc.id && pc.config && typeof pc.config === 'object') {
              this.setPluginConfig(pc.id, uid, pc.config);
            }
          }
                                               
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
