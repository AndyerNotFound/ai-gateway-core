'use strict';
/* store.js - 存储层 (文档 §4 UID / §5 存储 / §8 迁移)
 * 结构:
 *   <dir>/instances.json            主索引: {version,nextUid,setupMode,setupDeadline,instances:[{uid,name,port,enabled,file}]}
 *   <dir>/instances/<uid>.json      实例配置: {uid,name,listen,gatewayKey,adminKey,channels,proxies,tls,plugins,...}
 *   <dir>/plugins-config/<id>.json  插件配置: { "<uid>": {...} }  (UID 引用实例, 改名不断)
 *   <dir>/.agwkey                   加密口令(可选, 权限600)
 * UID: 顺序分配 32bit, 从 1 递增, nextUid 持久化在主索引; 与实例名分离(名=路由前缀可变, UID=引用永不变)。
 * 加密: 字段级 AGWENC1 (只加密敏感字段, 主索引明文)。
 */
const fs = require('fs');
const path = require('path');
const crypt = require('./crypt');
const { atomicWrite, readJson, logErr } = require('./util');

const INDEX_VERSION = 1;
const INST_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
// 路由保留字 (文档 §2.1): 不会被当作实例名
const RESERVED_PATHS = new Set(['v1', 'v1beta', 'v1alpha', 'admin', 'health', 'status', 'favicon.ico', 'robots.txt', 'setup', 'plugins', 'user', 'credits', 'auth', 'api', 'theme-config', 'ui']);

const CHANNEL_TYPES = ['openai', 'gemini', 'claude'];

/* 实例配置默认值规整 (内核版: 只保留内核字段; 卡密/用户/probe/thinkingSummary/openaiExtras 由插件管) */
function applyDefaults(cfg) {
  cfg.listen = cfg.listen || {};
  /* ★ port=0 = 不单独监听(只走 <主端口>/<实例名>/ 前缀路由); 只有「未配置」才回退 16384。
     原来写 `cfg.listen.port || 16384` 会把 0 当成 falsy → 每个不监听的实例都去抢 16384,
     和旧版 ai-gateway 的端口撞车(谁先启动谁占)。 */
  cfg.listen.port = cfg.listen.port == null ? 16384 : Number(cfg.listen.port);
  cfg.listen.host = String(cfg.listen.host || '0.0.0.0');
  cfg.gatewayKey = cfg.gatewayKey ? String(cfg.gatewayKey) : '';
  cfg.adminKey = cfg.adminKey ? String(cfg.adminKey) : '';
  cfg.maxBodyBytes = Number(cfg.maxBodyBytes || 64 * 1024 * 1024);
  cfg.connectTimeout = Number(cfg.connectTimeout || 15000);
  cfg.responseTimeout = Number(cfg.responseTimeout || 180000);
  if (cfg.connRetry === undefined) cfg.connRetry = 2; // 连接级错误的同渠道重试次数; 0=关闭
  cfg.cors = cfg.cors !== false;
  cfg.tls = cfg.tls || {};
  if (cfg.tls.enable) {
    cfg.tls.cert = String(cfg.tls.cert || 'cert.pem');
    cfg.tls.key = String(cfg.tls.key || 'key.pem');
    cfg.tls.port = cfg.tls.port != null ? Number(cfg.tls.port) : null; // null=与HTTP同端口(纯HTTPS)
  }
  cfg.plugins = Array.isArray(cfg.plugins) ? cfg.plugins.filter(p => p && p.id) : [];
  return cfg;
}

/* 渠道白名单规整 (只认内核字段; 未知自定义字段如 probe/useResponses 保留透传, 插件要用) */
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
    /* ★加密锁定状态 (2026-09-18「密钥保险箱」)：口令只在内存里时，重启后就是"有密文但没口令"。
     *  此时读出来的敏感字段是 AGWENC1 密文，直接拿去连上游必然 401 一片 —— 内核据此**拒绝转发**并
     *  明确提示去解锁（见 Gateway 的 503 拦截），而不是让用户对着莫名的 401 排查。
     *  判定方式是"盘上真的存在密文"，所以不依赖额外标记文件，也不怕用户手工改配置降低安全性。 */
    this.locked = false;
    if (!this._pass) {
      try { this.locked = this.hasCiphertext(); } catch (_) { this.locked = false; }
    }
    /* ★内核回调(2026-09-18 多实例一致性): 任何一条写插件配置的路径 —— 包括**绕过 ctx** 的
     *  `/admin/api/plugin-config/:uid/:pid`(App 插件配置页用) —— 写盘后都会触发它，
     *  由 PluginManager 递增版本号并把新配置同步给同插件的其它实例。
     *  只挂在 ctx.setPluginConfig 上的话，走管理 API 改的配置别的实例永远发现不了。 */
    this.onPluginConfigWrite = null;
    this.index = this.loadIndex();
    this.scanUidUnique();
  }

  /* ---------- 主索引 ---------- */
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
  /* 启动时全局扫描 UID 唯一性; 重复自动重生 (文档 §4.3) */
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

  /* ---------- 服务点(中转站)资料: 全局, 存 instances.json (App/用户页展示用) ---------- */
  getServerInfo() {
    const s = this.index.serverInfo;
    return (s && typeof s === 'object') ? s : {};
  }
  saveServerInfo(info) {
    const allow = ['name', 'description', 'icon', 'announcement', 'contact', 'website', 'currencySymbol'];
    const out = {};
    for (const k of allow) if (info && typeof info[k] === 'string') out[k] = info[k].slice(0, 2000);
    if (out.currencySymbol != null) out.currencySymbol = out.currencySymbol.slice(0, 8);
    /* 代币展示汇率: 1 个货币单位 = 多少代币 (数字; 不填 = 1, 即直接按代币数显示)。
     * 只影响客户端**显示**, 不影响额度计算。 */
    if (info && info.currencyRate != null && info.currencyRate !== '') {
      const r = Number(info.currencyRate);
      if (isFinite(r) && r > 0) out.currencyRate = r;
    }
    this.index.serverInfo = out;
    this.saveIndex();
    return out;
  }

  /* ---------- 实例配置 ---------- */
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
    // 剥运行时字段 (_ 开头)
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
    // 插件配置里该 UID 的配置一并清 (文档 §6.3 卸载=干净)
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

  /* ---------- 插件配置 (按 UID 引用, 文档 §6.1) ----------
   * ★作用域(2026-09-12 用户决策)：插件配置默认**全局共享**(所有实例一份)，
   *   插件数据默认仍按实例隔离。manifest.json 里可以覆盖：
   *     "scope":     "global"(默认) | "instance"     —— 配置
   *     "dataScope": "instance"(默认) | "global"     —— 运行数据(ctx.data)
   *   注意 applyDefaults/loadInstance 重建渠道对象会丢自定义字段, 插件相关字段要单独保。
   */
  pluginConfigFile(pluginId) { return path.join(this.pluginsConfigDir, pluginId + '.json'); }
  /* ---------- 插件启用表 (2026-09-12 用户决策: 全局一份, 新实例自动带上) ---------- */
  pluginEnableFile() { return path.join(this.dir, 'plugin-enable.json'); }
  pluginEnableList(cfg) {
    let g = null;
    try { g = readJson(this.pluginEnableFile()); } catch (_) {}
    if (Array.isArray(g)) return g;
    /* 兼容: 全局表不存在时回退实例内联的 plugins[] */
    return Array.isArray(cfg && cfg.plugins) ? cfg.plugins : [];
  }
  setPluginEnableList(list) {
    atomicWrite(this.pluginEnableFile(), JSON.stringify(Array.isArray(list) ? list : [], null, 2));
  }
  /** 读插件 manifest(带缓存) */
  /** 读插件 manifest。
   *  ★必须**两级都查**（内置 `源码 plugins/` + 数据目录 `data/plugins/`），与 `PluginManager.scanInstalled()`
   *  的查找顺序一致 —— 只查数据目录的话，内置插件（如主题 theme-compose）读不到 manifest，
   *  `configKey()` 会退化成 `_global`（踩过：主题参数按端分开存没生效）。 */
  manifestOf(pluginId) {
    if (!this._mfCache) this._mfCache = {};
    if (this._mfCache[pluginId] !== undefined) return this._mfCache[pluginId];
    let m = null;
    const dirs = [
      path.resolve(__dirname, '..', 'plugins'),  // 内置（随内核分发）
      this.pluginsDir,                           // 用户安装（数据目录，同 id 覆盖内置）
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
  /** 配置存哪个键：全局插件统一用 _global；
   *  ★主题插件的「配色参数」按端分开（2026-09-16）：同一实例内，管理端与用户端各存一份
   *  （`_admin` / `_user`），这样"改管理端配色不影响用户端"（用户明确要求：主题不需要双端同步）。 */
  configKey(pluginId, uid, scope) {
    const m = this.manifestOf(pluginId);
    if (m && m.type === 'theme') return scope === 'admin' ? '_theme_admin' : '_theme_user';
    return this.configScope(pluginId) === 'global' ? '_global' : String(uid);
  }
  getPluginConfig(pluginId, uid, scope) {
    const j = readJson(this.pluginConfigFile(pluginId));
    if (!j || typeof j !== 'object') return null;
    let v = j[this.configKey(pluginId, uid, scope)];
    /* 迁移兼容：主题插件**旧数据存在 `_global`**。按端分开后，某一端还没写过就沿用旧值 ——
     * 用户端因此不会因为这次改动突变；管理端首次也会看到"原来调过的那套"，而不是突然回默认。 */
    if (v === undefined) {
      const m = this.manifestOf(pluginId);
      if (m && m.type === 'theme') v = j['_global'];
    }
    const raw = (v && typeof v === 'object') ? crypt.decryptFields(v, this._pass) : null;
    /* ★读出来也还原一次：历史脏数据（"true"/"false" 字符串）自动纠正，无需手改文件 */
    return raw ? this.coerceConfigBySchema(pluginId, raw) : null;
  }
  /* ★按 manifest.configSchema 还原"被客户端字符串化"的值 (2026-09-19 事故修复)
   * 背景：App 的 SDUI 表单把所有输入打包成**字符串**（Renderer 的 inputs 是 Map<String,String>），
   *  于是 boolean 字段落盘成 "true"/"false"、number 落盘成 "3"；插件侧写的是
   *  `cfg.x === false` / `!!cfg.x` → 被字符串骗，表现为"开关关不掉"
   *  （music-remote「允许远程切歌」事故：盘上 "false" 恒 ≠ false，403 拦截永远不触发）。
   * 规则：①只处理 schema 里**声明过**的字段（运行数据如 users/groups 一律不碰）
   *      ②解析不出来的值**原样保留** —— 绝不猜、绝不重演"空串被静默当成关闭"
   *      ③类型本来就对时直接返回原对象（读路径调用频繁，避免无谓拷贝）。 */
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
          /* 其它（含空串）→ 保留原值交给插件 */
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
    /* ★落盘前按 schema 还原类型（客户端提交的都是字符串） */
    j[this.configKey(pluginId, uid, scope)] = crypt.encryptFields(this.coerceConfigBySchema(pluginId, cfgObj || {}), this._pass);
    atomicWrite(file, JSON.stringify(j, null, 2));
    /* ★写盘后通知内核(2026-09-18): 版本号 +1, 并把新配置同步给同插件的其它实例。
     *  集中挂在 Store 上 —— 这样 ctx.setPluginConfig 与 /admin/api/plugin-config 两条路都覆盖(不会漏)。 */
    if (typeof this.onPluginConfigWrite === 'function') { try { this.onPluginConfigWrite(pluginId); } catch (_) {} }
  }

  /* ==================== 加密口令 / 锁定 / 重加密 (2026-09-18) ====================
   * 设计：口令**默认不落盘**（不写 .agwkey），只在内存里；重启 = 自动回到锁定态，
   * 由 Gay Core 的「密钥保险箱」插件页解锁（口令存 App 侧 Keystore，自动解锁）。
   * 这里只提供"检测 / 校验 / 设置 / 重加密"四个纯函数，UI 与流程都在插件里。 */

  /** 数据目录里是否已存在 AGWENC1 密文（判断"已加密但未解锁"；.bak-* 备份不算） */
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

  /** 运行期设置口令（null = 锁定）。会自动重算 locked。 */
  setPass(pass) {
    this._pass = pass ? String(pass) : null;
    this.locked = !this._pass && this.hasCiphertext();
    return this.cryptStatus();
  }

  /** 用盘上已有密文校验口令：没有密文时返回 true（首次启用加密，任何合规口令都行） */
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

  /** 口令/加密状态（给「密钥保险箱」页显示） */
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

  /** ★锁定时"你是谁"怎么证明（2026-09-18）：盘上**不放任何明文凭据**。
   *  做法：拿提交的口令去解实例文件里的 adminKey/secondKey 密文，解出来 == 提交的管理员密钥
   *  ⇒ 口令对 **且** 管理员密钥对（两因子）。锁定时卡密表/管理员密钥本身都是密文，任何常规鉴权
   *  都过不了（这正是"锁"的意义），所以解锁这条路必须自带凭据。
   *  代价：爆破者仍需先算出 scrypt（每次 ~50ms，再加插件侧限速）；且若用户开了 secondKey/TOTP，
   *  解锁这一步不校验第二验证（口令本身就是解开一切的钥匙）。 */
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

  /** 删除迁移/换口令时留下的 `.bak-crypt-*` 备份（★里面是明文或旧密文，确认无误后应清掉） */  cleanCryptBackups() {
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

  /** 把所有实例配置 + 插件配置里的敏感字段重写为**新口令**的密文（做加密迁移 / 换口令）。
   *  oldPass = 当前内存口令（null 表示盘上是明文）；每个被改写的文件先留一份 `.bak-crypt-<ts>` 备份
   *  （用户要求保留，方便回滚；★注意这份备份里是明文/旧密文，敏感期过后应在插件页一键删除）。 */
  reencryptAll(newPass, { tag = 'crypt' } = {}) {
    const p = String(newPass || '').trim();
    if (!p) return { ok: false, error: '口令不能为空' };
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const out = { ok: true, scanned: 0, rewritten: 0, skipped: 0, backups: [], errors: [] };
    const targets = [];
    for (const d of [this.instancesDir, this.pluginsConfigDir]) {
      try { for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) targets.push(path.join(d, f)); } catch (_) {}
    }
    /* 找第一个密文（判断"这个文件已经加密过没有"） */
    const firstEnc = (o) => {
      if (typeof o === 'string') return crypt.isEncText(o) ? o : null;
      if (Array.isArray(o)) { for (const x of o) { const r = firstEnc(x); if (r) return r; } return null; }
      if (o && typeof o === 'object') { for (const k of Object.keys(o)) { const r = firstEnc(o[k]); if (r) return r; } }
      return null;
    };
    /* ★预检(2026-09-18)：只要有一个"已加密文件"用 (内存口令 → 目标口令) 都解不开，就**整体拒绝** ——
     *  绝不允许"部分跳过"式地写一半（否则会把网关留在半加密/假解锁状态，换口令时最危险）。
     *  ⚠️注意 `decryptFields` 对错口令是"原样返回密文"而**不抛错**，所以判定必须用 decryptText 取样。 */
    const plain = new Map();          /* 文件 → 已解出的明文（顺便缓存，后面复用） */
    for (const f of targets) {
      let j = null;
      try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
      const sample = firstEnc(j);
      if (!sample) { plain.set(f, j); continue; }           /* 明文文件：直接用 */
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
        /* ★已经是"目标口令"的密文、且没有残留明文敏感值 → 跳过（否则每点一次都重写 + 多一堆备份,
         *  还白烧几秒 CPU —— 2026-09-18 实测连点把网关阻塞到无响应）
         *  判定要用**原始文件对象 j**：encryptFields 不会重复加密已是密文的值 ⇒ 结果与 j 一致 = 无明文待加密。 */
        const sample = firstEnc(j);
        if (sample) {
          let samePass = false;
          try { crypt.decryptText(sample, p); samePass = true; } catch (_) { samePass = false; }
          const noPlain = JSON.stringify(crypt.encryptFields(j, p)) === JSON.stringify(j);
          if (samePass && noPlain) { out.skipped++; continue; }
        }
        const enc = crypt.encryptFields(dec, p);
        const text = JSON.stringify(enc, null, 2);
        if (text === raw) { out.skipped++; continue; }          /* 没有任何可加密字段 */
        /* ★只在"文件当前是明文"时留备份 —— 那才是真正的回滚点（含明文，可恢复）。
         *  已加密文件再加密（换口令/重复点）留的备份里是**旧密文**，既救不了急又白占空间，
         *  还会让"从备份找回明文密钥"的恢复手段误判（2026-09-18 踩过：6 份备份里只有最早那份是明文）。 */
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

  /* ---------- setup 模式 (文档 §3.3) ---------- */
  isSetupMode() {
    if (!this.index.setupMode) return false;
    if (this.index.setupDeadline && Date.now() > this.index.setupDeadline) return false; // 超时锁死
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

  /* ---------- 迁移 (文档 §8.2): 旧 config.<name>.json → instances/<uid>.json ---------- */
  detectLegacy(legacyDir) {
    const d = legacyDir || this.dir;
    let files = [];
    try { files = fs.readdirSync(d); } catch (_) { return []; }
    return files.filter(f => /^config(\.[A-Za-z0-9_-]{1,32})?\.json$/.test(f));
  }

  /* 执行迁移: 返回 {migrated:[{name,uid}], skipped:[], errors:[]} */
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
        // 旧格式整文件加密已解; 剥旧运行时字段
        for (const k of Object.keys(cfg)) if (k.startsWith('_')) delete cfg[k];
        const uid = this.createInstance(name, cfg);
        res.migrated.push({ name, uid });
        // 插件内联配置拆到 plugins-config (文档 §8.2 步骤2)
        if (Array.isArray(cfg.plugins)) {
          for (const pc of cfg.plugins) {
            if (pc && pc.id && pc.config && typeof pc.config === 'object') {
              this.setPluginConfig(pc.id, uid, pc.config);
            }
          }
          // 实例配置里 plugins 只留 id+enable (配置迁走了)
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

  /* 迁移校验: 对比实例数/渠道数 (文档 §8.2 步骤4) */
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

  /* 实例状态总览 (文档 §5.5): 按 UID 聚合实例配置 + 所有插件配置 */
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
