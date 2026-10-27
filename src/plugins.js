'use strict';
/* plugins.js - PluginManager v2 (内核职责: 加载器本体, 文档 §2.1/§7)
 * 与旧版差异:
 *   - manifest.type: 'auth'|'business', 认证插件先于业务插件加载, 认证插件激活失败 = fail-closed 阻断 (§3.2)
 *   - 数据/配置按 UID 隔离 (plugins-data/<uid>/<id>.json, plugins-config/<id>.json[uid]), 改名不断 (§4/§6)
 *   - ctx 扩展 (§7.1): getPluginConfig/getInstanceConfig/registerAuth/registerExtraEndpoint/wrapWriter/
 *     onRequest/onResponse/encrypt/decrypt/emit/on/upstreamRequest/stats
 *   - permissions 运行时校验 (§7.3): 敏感 API 未声明即抛错
 *   - hook 聚合: hooksFor(uid) 产出 router.handleChat 所需的 hooks 对象
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

/** 极简 tar 解压（仅文件/目录，防路径穿越）。插件包用 .tar.gz 格式（零依赖跨平台）。 */
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

/** 下载 URL → Buffer（跟随重定向, 30s 超时, 默认上限 50MB） */
function downloadBuf(url, maxBytes = 50 * 1024 * 1024, redirects = 5, proxyUrl = null) {
  return new Promise((resolve, reject) => {
    let lib;
    try { lib = url.startsWith('https') ? https : http; } catch (e) { return reject(e); }
    /* 可选代理(下载插件包用, 如手机代理 127.0.0.1:7890) */
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

/* router hooks 的所有合法名称 (与 router.js NO_HOOKS 对齐) */
const HOOK_NAMES = ['onRequestBody', 'onChatAuth', 'onQuotaEstimate', 'needConvert', 'wrapWriter', 'processCanonicalResp',
  'onResponseEvent', 'onResponseLine', 'onResponseBody', 'sanitizeText', 'onUsage', 'onChatDone', 'billing'];

/* manifest.type 合法值: auth=认证插件 / business=业务插件 / theme=主题插件(仅提供配色, 无 server.js) */
const PLUGIN_TYPES = ['auth', 'business', 'theme'];

/** 插件目录内容 SHA256 (App 添加服务器时的安全验证公示用): 相对路径排序后逐文件 hash。 */
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
   * @param store  Store 实例 (UID/插件配置/数据目录)
   * @param deps   { authChain, upstreamRequest, encrypt, decrypt, log }
   */
  constructor(store, deps = {}) {
    this.store = store;
    this.gwDir = store.dir;
    this.pluginsDir = store.pluginsDir;
    this.dataDir = store.pluginsDataDir;
    this.log = deps.log || ((...a) => defaultLog('[plugins]', ...a));
    this.authChain = deps.authChain || null;          // AuthChain 实例 (registerAuth 用)
    this.upstreamRequest = deps.upstreamRequest || null;
    this.pickChannels = deps.pickChannels || null;
    this.crypt = deps.crypt || null;                  // {encrypt, decrypt} 字段级
    /* 插件贡献的管理端页面: 'uid/pluginId/pageId' → 页面定义 (registerAdminUi) */
    this._adminUiPages = new Map();
    this.bus = new EventEmitter();                    // 事件总线 (ctx.emit/on)
    this.bus.setMaxListeners(100);
    /** installed: id -> {manifest, dir} */
    this.installed = new Map();
    /** active: `${uid}/${id}` -> state */
    this.active = new Map();
    /** 扩展端点注册表: 'METHOD /v1/xxx' -> {pluginId, uid, handler} (§7.1 registerExtraEndpoint) */
    this.extraEndpoints = new Map();
    /** 顶层路由注册表: 'METHOD /credits' -> {pluginId, uid, handler} (auth 插件用) */
    this.topRoutes = new Map();
    /** 全局卡密分支白名单: token -> {uid, branches} (auth-cardkey 注册; core 路由后全局检查, 防目标实例免密绕过) */
    this.globalKeys = new Map();
    /** 插件配置版本号: pluginId -> number (跨实例共享, 用于发现配置副本过期) */
    this._cfgRev = new Map();
    /** 插件运行数据版本号: pluginId -> number (同上, 对象是 ctx.data)
     *  ★2026-09-18 加: 数据的写入路径(flushData)以前既不加版本号也不广播,
     *  于是"别实例刚写的卡密用量/规则"在本实例读不到, 本实例写盘时还会用旧快照抹掉它。 */
    this._dataRev = new Map();
    this.gateway = deps.gateway || null;
    /** 能力注册表 (2026-10-07 深度改造): uid+cap -> {uid,name,impl,pluginId,seq}
     *  为什么: 以前"谁提供模型价格"写死在内核(getPluginConfig('model-square', 0)), 换个插件提供就崩。
     *  改成运行期可查询的事实: 插件 provideCapability('model-pricing', impl), 消费方 requireCapability(...)。
     *  与 hooks 的区别: hooks 是内核定义的管线(内核必须知道有哪些钩子); capability 是插件间自由约定的能力面。 */
    this._capabilities = new Map();
    this._capSeq = 0;
    /** ★全局能力层 (2026-10-07): dataScope=global 的插件(价格/分组/用户/卡密这类全实例共享的数据),
     *  其能力注册在 uid=0 下, 供"不区分实例"的内核逻辑(如模型分组索引)查询。
     *  为什么需要: 分组/价格配置本身存在 uid=0 键(全局), 若能力只注册在实例 uid 下,
     *  内核的 groupIndex() 就查不到 —— 表现为"分组索引永远为空"。
     *  ★声明式: 由 manifest.dataScope==='global' 决定, 内核不认插件名。 */
    this._globalCaps = new Set();
    /** ★每实例最近一次请求的客户端能力(2026-10-07): 供 ctx.clientCaps() 同步读取。
     *  为什么需要"最近一次": gcui 页面是**请求驱动**的, 插件在 render 时通常就在处理某个请求;
     *  而 ctx 是激活期一次性创建的, 拿不到 per-request 参数。所以这里按请求滚动更新,
     *  render(params) 里另有精确值(优先级更高)。 */
    this._lastCaps = new Map();
    /* 意图安全协议存储: uid -> {keys:{tokenHash:{lastSeq,nonces[],intents{}}}, dirty} (Gay Core §3) */
    this._secCache = new Map();
    this._secTimer = setInterval(() => this._flushSecAll(), 30000);
    if (this._secTimer.unref) this._secTimer.unref();
    this.scanInstalled();
  }

  scanInstalled() {
    this.installed.clear();
    /* 两级插件目录: 内置(源码 plugins/) + 数据目录(用户安装, 同 id 覆盖内置) */
    const dirs = [
      path.resolve(__dirname, '..', 'plugins'), // 内置插件(随内核分发)
      this.pluginsDir,                           // 用户安装(数据目录)
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
          /* 主题插件硬约束 (Gay Core §11): 只允许样式令牌, 禁止服务端逻辑/权限 */
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

  /* 依赖拓扑排序 (2026-10-07 深度改造 §B)
   * 背景: manifest 里一直有 depends 字段(billing -> model-square), 但**从来没有任何代码读它** ——
   *   全仓搜索 .depends 只命中声明本身。后果是依赖缺失时静默降级(表现为"切分支后价格丢失"),
   *   而不是明确报错。这里把它激活, 对标 Minecraft Forge 的 mod 依赖解析。
   * 语义:
   *   - 拓扑排序: 被依赖者先加载(同 type 组内)
   *   - 缺失依赖: strict 模式 fail-fast(该插件不加载 + blocked 报告); 默认 fail-soft(加载但明确告警)
   *   - 环: 检测到环 → 保留原顺序并告警(绝不静默死循环)
   * @returns {{order:Array, missing:Array<{id,dep}>, cycles:string[]}}
   */
  _topoSort(entries) {
    const byId = new Map(entries.map(e => [e[0].id, e]));
    const missing = [], cycles = [];
    const out = [], state = new Map();   // id -> 1=访问中 2=已完成
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
        if (!byId.has(d)) { missing.push({ id, dep: d }); continue; }   // 依赖没启用/没安装
        visit(d, stack.concat(id));
      }
      state.set(id, 2);
      out.push(e);
    };
    for (const e of entries) visit(e[0].id, []);
    return { order: out, missing, cycles };
  }

  /* 激活某实例启用的插件。先 type:'auth' 后 type:'business'; 认证插件失败 fail-closed 阻断 (§3.2)。
   * ★2026-10-07: 组内按 manifest.depends 做拓扑排序(以前完全不读 depends)。
   * 返回 {ok, blocked?:原因, warnings?:[], missing?:[], cycles?:[]} */
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
    /* 依赖解析: 严格模式由实例配置 strictDepends=true 打开(默认 fail-soft, 不打断线上服务) */
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
      /* strict: 丢掉依赖不全的插件 */
      const order = strict ? r.order.filter(e => !r.missing.some(m => m.id === e[0].id)) : r.order;
      return order;
    };
    const authOrder = resolve(authPlugins);
    const bizOrder = resolve(bizPlugins);
    if (allMissing.length) warnings.push('依赖缺失 ' + allMissing.length + ' 处');
    if (allCycles.length) warnings.push('依赖成环 ' + allCycles.length + ' 处');

    // 1) 认证插件先加载, fail-closed
    for (const [pc, inst] of authOrder) {
      const r = this.activateOne(uid, pc, inst, cfg);
      if (!r.ok) {
        this.log(`[uid:${uid}] 认证插件 ${pc.id} 激活失败 → fail-closed, 阻断后续插件加载`);
        return { ok: false, blocked: 'auth plugin failed: ' + pc.id + ' — ' + r.error, warnings, missing: allMissing, cycles: allCycles };
      }
    }
    // 2) 业务插件 (已按依赖排序: 被依赖者在前)
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
      /* 运行数据版本号"已见"水位 —— 分发前据此决定要不要重读磁盘(见 maybeReloadData) */
      _dataSeen: this._dataRev.get(pc.id) || 0,
      // 配置: plugins-config/<id>.json[uid] 优先, 回退实例内联 cfg.plugins[].config (旧格式兼容)
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

  /** ctx 工厂 (文档 §7.1)。perms 运行时可校验的敏感能力逐项检查。 */
  makeCtx(state, cfg) {
    const self = this;
    state._instCfg = cfg; // 实例配置引用 (security.verifyIntent 认证用)
    const perms = new Set(state.manifest.permissions || []);
    const needPerm = (p) => { if (!perms.has(p)) throw new Error(`插件 ${state.pluginId} 未声明权限: ${p}`); };
    const uid = state.uid;
    return {
      id: state.pluginId,
      uid,
      instanceName: cfg._name,
      config: state.cfg,

      /* —— 配置 (§6.2 经内核中间层, 不直读文件) —— */
      getPluginConfig: (pluginId, u) => self.store.getPluginConfig(pluginId, u == null ? uid : u),
      setPluginConfig: (u, conf) => { // setPluginConfig(config) 或 setPluginConfig(uid, config)
        if (conf === undefined) { conf = u; u = uid; }
        self.store.setPluginConfig(state.pluginId, u == null ? uid : u, conf);
        state.cfg = conf;
        /* 配置版本号 +1, 并**立即**把新配置同步给同插件的其它实例(state.cfg 原地刷新)。
         * ★2026-09-18 从"只递增版本号"改成"主动同步": 版本号只有插件自己写 cfgLive() 去查才有用,
         *  而绝大多数插件没查(model-square 就没查 → 用户报「Guili 分支配了价格, 切回 default 显示无价格」)。
         *  详见 bumpCfgRev 的注释。 */
        self.bumpCfgRev(state.pluginId, state.key);
      },
      /** 配置版本号 (插件用: 变了说明该重新 getPluginConfig 取最新配置) */
      configRev: () => self._cfgRev.get(state.pluginId) || 0,
      getInstanceConfig: (u) => {
        const c = self.store.loadInstance(u == null ? uid : u);
        if (!c) return null;
        const masked = self.crypt ? self.crypt.maskFields(c) : c;
        for (const k of Object.keys(masked)) if (k.startsWith('_')) delete masked[k];
        return masked;
      },

      /* —— HTTP 路由 —— */
      registerRoute(method, p, handler) { // /plugins/<id><path>
        if (!p.startsWith('/')) p = '/' + p;
        state.routes.set(method.toUpperCase() + ' ' + p, handler);
      },
      registerExtraEndpoint(method, p, handler) { // /v1/* 扩展端点 (openaiExtras 插件用)
        needPerm('gateway:registerExtraEndpoint');
        const k = method.toUpperCase() + ' ' + p;
        self.extraEndpoints.set(k, { pluginId: state.pluginId, uid, handler });
      },
      registerTopRoute(method, p, handler) { // 顶层路由 (卡密 /credits、用户 /auth/* 用)
        needPerm('gateway:topRoute');
        const k = uid + '|' + method.toUpperCase() + ' ' + p; /* key 带 uid: 同插件多实例各自注册不互相覆盖 */
        if (self.topRoutes.has(k)) self.log(`[${state.pluginId}] 顶层路由覆盖: ${k}`);
        self.topRoutes.set(k, { pluginId: state.pluginId, uid, handler });
      },

      /* —— 认证 (仅 type:'auth' 插件) —— */
      registerAuth(strategy, opts = {}) {
        needPerm('auth:registerAuth');
        if (state.manifest.type !== 'auth') throw new Error('只有 type:"auth" 的插件能注册认证策略');
        if (!self.authChain) throw new Error('内核未提供 authChain');
        strategy._pluginId = state.pluginId;
        strategy._uid = uid;   /* 多实例: 注销时按 插件+实例 精确匹配 (见 deactivateByKey) */
        return self.authChain.registerAuth(strategy, opts);
      },
      /* 认证插件暴露 API 给其他插件 (findKey/grantQuota/listKeys/...) */
      bindAuthApis(apis) {
        if (state.manifest.type !== 'auth') throw new Error('只有 type:"auth" 的插件能 bindAuthApis');
        self._bindingPluginId = state.pluginId;
        self.bindGatewayAuthApis(uid, apis);
        self._bindingPluginId = null;
      },

      /* —— 转发 hook (thinkingSummary/redact/replace 等插件用) —— */
      hook(name, fn) {
        if (!HOOK_NAMES.includes(name)) throw new Error('未知 hook: ' + name + ' (可用: ' + HOOK_NAMES.join(', ') + ')');
        (state.hooks[name] = state.hooks[name] || []).push(fn);
      },
      wrapWriter(fn) { (state.hooks.wrapWriter = state.hooks.wrapWriter || []).push(fn); },
      onRequest(fn) { (state.hooks.onRequestBody = state.hooks.onRequestBody || []).push(fn); },
      onResponse(fn) { (state.hooks.onResponseBody = state.hooks.onResponseBody || []).push(fn); },

      /* —— 基础设施 —— */
      data: {
        get: k => state.data[k],
        set: (k, v) => { state.data[k] = v; state.dirty = true; },
        del: k => { delete state.data[k]; state.dirty = true; },
        all: () => state.data,
        /* ★2026-09-17 新增：管理端这类"低频但重要"的写入可调它立即落盘。
         * 默认仍走 30s 周期 flush（保护存储写入量）；billing 存规则用它，
         * 之前只标 dirty，重启/kill -9 抢在周期 flush 前会把刚存的规则丢掉。 */
        flush: () => self.flushData(state),
        /* ★2026-09-18 多实例一致性: 把磁盘上的最新数据**原地**并回内存(对象引用不变)。
         *  用在「读-改-写」型操作(如扣费累加用量)之前 —— 先 reload 再改, 才不至于拿旧快照做增量、
         *  把别实例刚记的用量整段覆盖掉。有未落盘的本地改动时**不刷新**(返回 false, 防丢)。 */
        reload: () => self.reloadData(state),
        /** 运行数据版本号(别实例写盘 or 本实例落盘都会 +1), 插件可据此自行判断新鲜度 */
        rev: () => self._dataRev.get(state.pluginId) || 0,
      },
      /* 插件专属数据目录 (plugins-data/<uid>/<id>/, 惰性创建, 可写文件) */
      get dataDir() {
        const d = path.join(self.dataDir, String(uid), state.pluginId);
        try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
        return d;
      },
      /* —— 管理端页面贡献 (registerAdminUi) ——
       * 让插件把自己的管理界面做成 **gcui 服务端页面**，由内核的 /admin/ui/<id> 一起下发，
       * App 管理端就能用原生渲染器画出来（而不是塞一个 WebView 进去，看着违和）。
       * 声明字段: { id, title, subtitle?, icon?, menu?, render(gw, cfg, q) → gcui 页面 }
       *   id     : 页面 id（小写字母/数字/连字符）。与内核页同名 = 覆盖内核页；否则作为新页面/菜单项。
       *   menu   : 默认 true（进侧边栏）；设 false 则只做子页，可被 `open page:/admin/ui/<id>` 打开。
       *   render : 返回 gcui JSON（同 admin-ui.js 的页面格式），异常会被兜住并显示错误页。
       * ★安全: 这页由**管理端**加载（x-admin-key），页面里的写操作请用 adminApi 打
       *   /admin/api/plugin-call（白名单插件）或自己的 /admin/ 端点 —— 页面里绝不放密钥。 */
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
        /* 宽容签名: cron(ms, fn) 或 cron(名字, ms, fn) */
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
        void inst; void delta; // 统计写入口预留: 由内核 stats 结构承载, 插件通常用 onUsage/onChatDone
      },
      emit: (ev, data) => self.bus.emit(state.pluginId + ':' + ev, data),
      on: (ev, fn) => self.bus.on(ev, fn),          // 可监听任意插件事件 'pluginId:event'
      encrypt: v => { if (!self.crypt) throw new Error('内核未启用加密'); return self.crypt.encrypt(v); },
      decrypt: v => { if (!self.crypt) throw new Error('内核未启用加密'); return self.crypt.decrypt(v); },

      /* —— 意图安全协议 (Gay Core SDUI, 设计文档 §3/§7) ——
       * guard(req, params, res, fn): 验签+时间窗+nonce去重+序列号防回滚+幂等 一体化; fn(keyRecord) 返回响应对象。
       * 签名 = HMAC_SHA256(卡密, ts\nnonce\nseq\nintentId\nMETHOD\npathname\nsha256(body)) */
      security: {
        verifyIntent: (req, params) => self.verifyIntent(state, req, params),
        commit: (token, intentId, seq, nonce, response) => self.commitIntent(state, token, intentId, seq, nonce, response),
        guard: (req, params, res, fn) => {
          const jsonRes = (code, obj) => { try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); } catch (_) {} };
          const v = self.verifyIntent(state, req, params);
          if (!v.ok) return jsonRes(v.status || 401, { ok: false, error: v.error, currentSeq: v.currentSeq });
          if (v.replay !== undefined) return jsonRes(200, v.replay); // 幂等命中: 返回上次响应
          let out;
          try { out = fn(v.keyRecord); } catch (e) { self.log(`[${state.pluginId}] intent 处理异常:`, e.stack || e.message); return jsonRes(500, { ok: false, error: '插件内部错误: ' + e.message }); }
          const h2 = (req && req.headers) || {};
          self.commitIntent(state, params.token || '', String(h2['x-gc-intent-id'] || ''), Number(h2['x-gc-seq'] || 0), String(h2['x-gc-nonce'] || ''), out);
          jsonRes(200, out);
        },
      },

      /* —— 能力倒置: 插件间协作不再靠"知道对方的插件 id" —— */
      /** 提供一项能力。name 自由约定(建议 kebab-case), 与插件 id 解耦。 */
      provideCapability(name, impl) {
        /* ★是否全局由 manifest.dataScope 决定(声明式), 内核不认插件名 */
        const isGlobal = (state.manifest && state.manifest.dataScope === 'global');
        return self.provideCapability(uid, name, impl, state.pluginId, isGlobal);
      },
      /** 取一项能力; 没装提供方 → null(自行降级, 不要抛)。 */
      requireCapability(name) { return self.requireCapability(uid, name); },
      /** 本实例已注册的能力名清单 */
      listCapabilities() { return self.listCapabilities(uid).map(c => c.name); },

      /* —— 客户端能力自检 (2026-10-07): 让插件能"按 App 会什么"渲染, 而不是撞上未知组件才降级 —— */
      /** 最近一次请求的 App 能力视图; 拿不到头 → null(请回退保守写法) */
      clientCaps() { return self._lastCaps.get(String(uid)) || null; },   /* 已是 capsView 视图(有 hasComponent 等方法) */

      /* ★gcui Kit (2026-10-08, DEVLOG 2.70): 双模式构件收进内核独立模块 src/gcui-kit.js
       *  —— 插件只声明「筛什么」, caps 探测与 setState/open 分支全在内核;
       *  App 零参与零重编; 插件作者测试可 require 该模块 stub ctx.gcui。 */
      gcui: require('./gcui-kit'),

      /* —— 上游调用 (复用内核 agent 池/代理) —— */
      upstreamRequest(opts) {
        if (!self.upstreamRequest) throw new Error('内核未提供 upstreamRequest');
        return self.upstreamRequest(cfg, opts);
      },
      /* 渠道路由(与内核同逻辑): 返回 [{ch, upstreamModel}] */
      pickChannels(model) { return self.pickChannels ? self.pickChannels(cfg, model) : []; },

      /* —— 网关能力 (permissions 放行) —— */
      gateway: {
        uid,
        instanceName: cfg._name,
        findKey: token => { needPerm('gateway:findKey'); const a = self._gwApisByUid && self._gwApisByUid.get(uid); return a && a.apis.findKey ? a.apis.findKey(cfg, token) : null; },
        grantQuota: (keyId, tokens) => { needPerm('gateway:grantQuota'); const a = self._gwApisByUid && self._gwApisByUid.get(uid); return a && a.apis.grantQuota ? a.apis.grantQuota(cfg, keyId, tokens) : false; },
        /** 热重载本实例(配置落盘后调) */
        reload() { if (self.gateway) self.gateway.loadInstance(uid); },
        /** 改实例配置并热重载: mutator(cfg) 就地修改 */
        saveInstanceConfig(mutator) {
          needPerm('gateway:saveConfig');
          const c = self.store.loadInstance(uid);
          if (!c) return false;
          mutator(c);
          self.store.saveInstance(uid, c);
          if (self.gateway) self.gateway.loadInstance(uid);
          return true;
        },
        /** 实例列表 (meta) */
        listInstances() { return self.store.index.instances.map(m => ({ uid: m.uid, name: m.name, port: m.port, enabled: m.enabled !== false })); },
        /** 本实例全部渠道 (未打码, 插件读模型/分组用) */
        instanceChannels() { const c = self.store.loadInstance(uid); return c ? (c.channels || []) : []; },
        /** 站点资料 (代币符号/汇率等; bootstrap 本就公开下发, 无敏感字段) */
        serverInfo() { return self.store.getServerInfo() || {}; },
        /** 模型分组索引 (模型名 → 分组; 卡密分组白名单/筛选用) —— 读 model-square 配置 + 名称前缀推导 */
        modelGroups() {
          needPerm('gateway:modelGroups');
          const gi = (self.gateway && self.gateway.groupIndex) ? self.gateway.groupIndex() : null;
          if (gi) return { declared: gi.declared.slice(), groupsOf: m => gi.groupsOf(m), matches: (m, g) => gi.matches(m, g) };
          const fb = require('./modelgroups').buildIndex(self.store);
          return { declared: fb.declared.slice(), groupsOf: m => fb.groupsOf(m), matches: (m, g) => fb.matches(m, g) };
        },
        /** 注册/注销全局卡密分支白名单 (auth-cardkey 用) */
        registerGlobalKey(token, branches) { needPerm('gateway:registerGlobalKey'); self.globalKeys.set(token, { uid, branches: branches || [], pluginId: state.pluginId }); },
        unregisterGlobalKey(token) { self.globalKeys.delete(token); },
        /** 认证插件暴露的 API (findKey/grantQuota/listKeys/addKey/...), 其他插件经此用卡密能力 */
        authApis() { needPerm('gateway:authApis'); const a = self._gwApisByUid && self._gwApisByUid.get(uid); return (a && a.apis) || {}; },
        /* ★加密口令开关 (2026-09-18「密钥保险箱」插件用): 口令只在内存, 不落盘。
         *  插件负责 UI/流程(签名意图 + SDUI 页), 内核只提供这四个动作与落盘/重载。 */
        cryptStatus() { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptStatus() : null; },
        cryptUnlock(pass, adminKey) { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptUnlock(pass, adminKey) : { ok: false, error: '内核不支持' }; },
        cryptLock() { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptLock() : { ok: false, error: '内核不支持' }; },
        cryptReencrypt(pass) { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptReencrypt(pass) : { ok: false, error: '内核不支持' }; },
        cryptCleanBackups() { needPerm('gateway:crypt'); return self.gateway ? self.gateway.cryptCleanBackups() : { ok: false, error: '内核不支持' }; },
      },

      log: (...a) => self.log(`[${state.pluginId}]`, ...a),
    };
  }

  /* 认证插件注册后提供的能力 (findKey/grantQuota/listKeys/addKey/updateKey/deleteKey 等, 由 auth 插件 bind) */
  bindGatewayAuthApis(uid, apis) {
    if (!this._gwApisByUid) this._gwApisByUid = new Map();
    const cur = this._gwApisByUid.get(uid);
    /* 同实例重复绑定时合并(覆盖同名字段), 并记录属主插件 */
    this._gwApisByUid.set(uid, { apis: Object.assign((cur && cur.apis) || {}, apis), pluginId: (cur && cur.pluginId) || this._bindingPluginId || null });
  }

  /* ---------- hook 聚合: 产出 router.handleChat 需要的 hooks ---------- */
  hooksFor(uid) {
    const states = [...this.active.values()].filter(s => s.uid === uid);
    if (!states.length) return null;
    const collect = (name) => states.flatMap(s => (s.hooks[name] || []));
    const hooks = {};
    const onRequestBody = collect('onRequestBody');
    if (onRequestBody.length) hooks.onRequestBody = (body, ctx) => { for (const fn of onRequestBody) { try { body = fn(body, ctx) || body; } catch (e) { this.log('onRequestBody:', e.message); } } return body; };
    const onChatAuth = collect('onChatAuth');
    /* ★2026-09-18：onChatAuth 原来是"第一个非空决定即返回"—— 而 auth-cardkey 对**放行**的请求
     *  也会返回一个"额度预授权"对象(非空)，于是排在后面的插件(如 billing 的"未定价禁止调用")
     *  **永远轮不到执行**。改为：任何插件的**拒绝**(status>=400 或带 message)立即生效；
     *  否则记住第一个非空对象返回(保留 quota 预授权语义)。 */
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
    /* ★预授权估算 (2026-09-18)：把「token 数」换算成「额度」的唯一通道。
     *  背景：结算走 billing（charged = raw/1e6 × 倍率，量级 1e-3），而预授权冻结原来
     *  直接用 token 数（量级 1e3）→ 差 100 万倍，额度 99.97 的卡被
     *  "本次请求预授权需要约 13209" 429 拒掉，而那次实际只扣 0.01。
     *  约定：注册方（billing，价格唯一真相在它手里）返回**额度单位**的预估值；
     *        返回 null/无效值 = 这次估不出来（没装 billing / 模型未定价）→
     *        调用方回退「1 token = 1 额度」的老口径（与老口径结算严格对齐）。
     *  取值语义：第一个有效（非 null、有限、≥0）的数生效。 */
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
    /* 动态计费：多插件时**按注册顺序**依次算，最后一个非空结果生效（后注册的优先级更高）。
     * 约定：返回数字 = 应扣加权 token；返回 {charged, detail} 可带明细；返回 null = 不参与（交给下一个）。 */
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

  /* ---------- 数据持久化 (按 UID 隔离) ---------- */
  dataFile(uid, pluginId) {
    /* dataScope=global 的插件(用户/卡密)数据全局共享: plugins-data/_global/<id>.json */
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
      /* ★写盘前"读旧合并"(2026-09-18 多实例一致性): 本实例的内存是**激活时的快照**,
       *  盘上可能已经有别实例后来写进去的键 —— 直接用内存覆盖会把它们整段抹掉
       *  (与插件配置 ctx.config 同一个坑, 已实测: default 实例写一次价就把 Guili 的键删了)。
       *  合并口径: 磁盘为底 + 内存覆盖(本实例改过的顶层键以内存为准; 只有别实例有的键保留下来)。 */
      let disk = null;
      try { disk = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { disk = null; }
      const out = (disk && typeof disk === 'object' && !Array.isArray(disk))
        ? Object.assign({}, disk, state.data) : state.data;
      fs.writeFileSync(f, JSON.stringify(out, null, 2));
      if (out !== state.data) {           /* 内存同步成合并结果, 保持"内存 = 盘上"(原地, 引用不变) */
        for (const k of Object.keys(state.data)) delete state.data[k];
        Object.assign(state.data, out);
      }
      state.dirty = false;
      this._dataRev.set(state.pluginId, (this._dataRev.get(state.pluginId) || 0) + 1);
      state._dataSeen = this._dataRev.get(state.pluginId);
    } catch (e) { this.log('插件数据落盘失败:', e.message); }
  }

  /** 全局作用域插件的数据是共享的: 没有未落盘改动时(且别实例写过)分发前重读磁盘。
   *  ★有本地改动就**不刷新** —— 刷新会丢掉本实例刚扣的费/刚改的规则(宁可旧一点, 不可丢)。 */
  maybeReloadData(pluginId, uid) {
    try {
      const st = this.active.get(uid + '/' + pluginId);
      if (!st || st.dirty) return;
      if (this.store.dataScope(pluginId) !== 'global') return;
      if ((this._dataRev.get(pluginId) || 0) === st._dataSeen) return;
      this.reloadData(st);
    } catch (_) {}
  }

  /** 原地重读运行数据(对象引用不变, 插件持有的 ctx.data.all() 引用依然有效)。dirty 时不动作。 */
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

  /** 配置版本号 +1, 并把最新配置**原地**同步给同插件的其它实例(多实例一致性, 2026-09-18)
   *  背景: 插件配置默认全局共享(manifest 未写 scope → 存 plugins-config/<id>.json 的 `_global`),
   *  但每个实例的插件在 activate() 时各抓一份**独立**的 ctx.config, 之后内核不刷新 →
   *  A 实例改完配置, B 实例还拿旧副本(实测 6 实例里 5 个是 231 条旧数据, 只有写入方 260 条)。
   *  为什么必须**原地**刷新(delete + assign): 插件在 activate() 里 `const cfg = ctx.config` 抓住了对象引用,
   *  整对象换引用它看不到(auth-cardkey/auth-user 还要靠自己的 cfgLive() 兜底, 原地刷新后它们也自动同步)。
   *  fromKey: 写入方自己跳过(state.cfg 就是它写进去的那份)。 */
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

  /* ---------- 意图安全协议存储 (plugins-data/<uid>/.gc-security.json) ---------- */
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

  /* 意图验签 (Gay Core §3): HMAC_SHA256(token, ts\nnonce\nseq\nintentId\nMETHOD\npathname\nsha256(body)) */
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
    /* 归属校验: 请求必须落在本插件命名空间 (/<branch>/plugins/<id>/...) */
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
    /* 认证: 确认卡密有效 (经 AuthChain) */
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
    rec.nonces = (rec.nonces || []).concat(nonce).slice(-200); // nonce 保最近 200
    rec.intents = rec.intents || {};
    rec.intents[intentId] = { ts: Date.now(), response };
    /* 幂等缓存裁剪: 只留 24h 内/最近 100 条 */
    const now = Date.now();
    const entries = Object.entries(rec.intents).filter(([, v]) => now - (v.ts || 0) < 86400e3).slice(-100);
    rec.intents = Object.fromEntries(entries);
    sec.keys[tokenHash] = rec;
    sec.dirty = true;
  }

  /* ---------- 停用 ---------- */
  deactivateByKey(key) {
    const state = this.active.get(key);
    if (!state) return;
    for (const t of state.timers) { try { clearInterval(t); } catch {} }
    this.flushData(state);
    // 注销该插件注册的认证策略与扩展端点/顶层路由/全局卡
    /* ★按对象注销 (不能按 name: 多实例下同名策略会被一起摘掉, 导致其它实例的卡密 401) */
    if (this.authChain) for (const s of [...this.authChain.strategies, ...this.authChain.adminStrategies]) {
      if (s._pluginId === state.pluginId && String(s._uid) === String(state.uid)) this.authChain.unregisterAuthObj(s);
    }
    for (const [k, v] of [...this.extraEndpoints]) if (v.pluginId === state.pluginId && v.uid === state.uid) this.extraEndpoints.delete(k);
    for (const [k, v] of [...this.topRoutes]) if (v.pluginId === state.pluginId && v.uid === state.uid) this.topRoutes.delete(k);
    if (this._gwApisByUid) { const ga = this._gwApisByUid.get(state.uid); if (ga && ga.pluginId === state.pluginId) this._gwApisByUid.delete(state.uid); }
    for (const [k, v] of [...this.globalKeys]) if (v.pluginId === state.pluginId && v.uid === state.uid) this.globalKeys.delete(k);
    /* 摘掉该插件贡献的管理端页面（停用/重载后不残留） */
    for (const k of [...this._adminUiPages.keys()]) if (k.startsWith(String(state.uid) + '/' + state.pluginId + '/')) this._adminUiPages.delete(k);
    /* 摘掉该插件贡献的能力 (与 effect 回收语义一致: 插件卸载 → 注册回滚) */
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

  /* ---------- 插件贡献的管理端页面 ---------- */
  /** 某实例的插件页面表（按插件注册顺序；同名 id 后注册者覆盖）
   *  ★2026-10-07: 每个页面定义的 render 被包一层 —— 把 App 能力视图作为**第 4 参数**注入,
   *  插件因此能在生成页面前自检("这台 App 认不认 segmented"), 而不是撞上未知组件才降级。 */
  adminPages(uid) {
    const out = [], seen = new Set();
    const pre = String(uid) + '/';
    for (const [k, v] of [...this._adminUiPages].reverse()) {
      if (!k.startsWith(pre)) continue;
      if (seen.has(v.id)) continue;   // 后注册的优先
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
  /** 查一个插件页（渲染用）；没有 → null */
  adminPage(uid, id) {
    return this.adminPages(uid).find(p => p.id === id) || null;
  }

  /* ---------- 管理端点代调声明 (2026-10-07 去硬编码) ----------
   * 读插件 manifest 的 adminApi 数组(路径前缀)。返回 null = 该插件未声明(禁止代调);
   * 返回数组 = 允许代调的前缀(空数组同样禁止)。内核不再持有任何插件名常量。 */
  adminApiDecl(pluginId, uid) {
    const id = String(pluginId || '');
    if (!id) return null;
    /* 必须同时"已安装"且"该实例已启用/运行" —— 未运行的插件没有端点可调 */
    const inst = this.installed.get(id);
    if (!inst) return null;
    const list = Array.isArray(inst.manifest.adminApi) ? inst.manifest.adminApi : null;
    if (!list) return null;
    return list.map(x => String(x || '')).filter(Boolean);
  }

  /* ---------- 能力注册表 (Capability Registry, 2026-10-07) ----------
   * 对标 Minecraft Forge 的 Capability / DSH 的 ctx 服务 seam:
   *   提供方: ctx.provideCapability(name, impl)   任意插件都能提供, 不要求是某个特定插件
   *   消费方: ctx.requireCapability(name)         拿不到返回 null(可降级), 不抛异常打断渲染
   *   内核:   listCapabilities(uid)               只按能力名查, 永不按插件名查
   * 语义(与 Forge 的 LazyOptional 对齐): 能力缺席 = null 让消费方降级, 而不是抛错 ——
   *   "缺能力"是正常状态(用户没装那个插件), 不是故障。
   */
  _capKey(uid, name) { return String(uid) + '\u0000' + String(name); }

  /** 注册能力。impl 任意(对象/函数皆可, 由提供方与消费方自行约定)。
   *  ★global 能力(manifest.dataScope==='global')同时注册到 uid=0 层, 供全局逻辑查询。 */
  provideCapability(uid, name, impl, pluginId, isGlobal) {
    const n = String(name || '').trim();
    if (!n) throw new Error('provideCapability: 缺少能力名');
    if (impl == null) throw new Error('provideCapability: 能力 ' + n + ' 的实现为空');
    const rec = { uid, name: n, impl, pluginId: pluginId || null, seq: ++this._capSeq };
    this._capabilities.set(this._capKey(uid, n), rec);
    /* 全局能力额外挂到 uid=0 层(同一 impl 引用, 不复制) */
    if (isGlobal && String(uid) !== '0') {
      this._capabilities.set(this._capKey(0, n), Object.assign({}, rec, { uid: 0, globalFrom: uid }));
      this._globalCaps.add(String(uid) + '\u0000' + n);
    }
    return true;
  }

  /** 取能力实现; 没有 → null (消费方据此降级)。同实例同能力多次注册时后注册者优先。
   *  ★回退顺序: 实例层 → 全局层(uid=0) —— 插件只注册在实例下时, 全局查询仍能拿到。 */
  requireCapability(uid, name) {
    const r = this._capabilities.get(this._capKey(uid, name));
    if (r) return r.impl;
    if (String(uid) !== '0') {
      const g = this._capabilities.get(this._capKey(0, name));
      if (g) return g.impl;
    }
    return null;
  }

  /** 记录某实例最近一次请求的客户端能力视图(供 ctx.clientCaps() 与插件页 render 第4参数读取)。
   *  传 null 表示"这次请求没上报能力"(网页端) —— 仍记录, 让插件据此回退保守写法。 */
  rememberCaps(uid, caps) {
    /* ★键一律 String(uid): 踩过 —— Map 的键 Number(1) 与 '1' 不相等,
     *  写入用 String、读取用 Number 会**静默查不到**(表现为"能力永远是 null")。 */
    if (caps) this._lastCaps.set(String(uid), caps);
    else this._lastCaps.delete(String(uid));
  }

  /** 依赖健康报告(供管理端展示): 缺依赖 / 成环 / 拓扑顺序 */
  dependsReport(uid, cfg) {
    const list = this.store.pluginEnableList(cfg);
    const enabled = list.filter(pc => pc && pc.enable && pc.id);
    const arr = [];
    for (const pc of enabled) { const inst = this.installed.get(pc.id); if (inst) arr.push([pc, inst]); }
    const r = this._topoSort(arr);
    return { order: r.order.map(e => e[0].id), missing: r.missing, cycles: r.cycles };
  }

  /** 某实例已注册的能力清单(名字+提供者), 供管理端展示 / 插件自检 */
  listCapabilities(uid) {
    const out = [];
    for (const v of this._capabilities.values()) {
      if (String(v.uid) !== String(uid)) continue;
      /* ★api (2026-10-07): 能力可自带一份**可序列化的端点说明**(impl.api() 返回普通对象)。
       *  为什么: App 的原生管理页原来把 `/plugins/auth-user/admin/users` 这类**具体插件端点**
       *  写死在源码里 → 换插件实现/新插件接管同名能力, App 都不认(违背"App 为未知插件服务")。
       *  现在能力自带端点说明, App 按**能力名**查端点, 永不按插件名。
       *  ★向后兼容: impl 没有 api() → 该字段为 null(老 App/老插件都不受影响)。 */
      let api = null;
      try { if (v.impl && typeof v.impl.api === 'function') api = v.impl.api() || null; } catch (_) { api = null; }
      out.push({ name: v.name, pluginId: v.pluginId, global: v.globalFrom !== undefined, api });
    }
    return out;
  }

  /* ---------- 查询 ---------- */
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
        /* App UI 注册 (Gay Core): provides 能力声明 / appUi 界面注册点 / theme 配色数据 */
        provides: Array.isArray(inst.manifest.provides) ? inst.manifest.provides : [],
        /* 运行期真正注册的能力(与 manifest 的静态 provides 分开: provides 是"意图", 这里是"事实") */
        capabilities: this.listCapabilities(uid).filter(c => c.pluginId === id).map(c => c.name),
        appUi: (inst.manifest.appUi && typeof inst.manifest.appUi === 'object') ? inst.manifest.appUi : null,
        theme: (inst.manifest.type === 'theme' && inst.manifest.theme && typeof inst.manifest.theme === 'object') ? inst.manifest.theme : null,
        permissions: Array.isArray(inst.manifest.permissions) ? inst.manifest.permissions : [],
        enable: pc ? !!pc.enable : false, running,
        schema: Array.isArray(inst.manifest.configSchema) ? inst.manifest.configSchema : [],
        /* ★主题插件读**管理端那份**（listForInstance 的结果只被管理端消费；用户端 bootstrap 不下发 config） */
        config: this.store.getPluginConfig(id, uid, inst.manifest.type === 'theme' ? 'admin' : undefined) || (pc ? (pc.config || {}) : {}),
      });
    }
    return out;
  }
  userPlugins(uid, cfg) {
    return this.listForInstance(uid, cfg).filter(p => p.enable && p.running && p.hasUserPage)
      .map(p => ({ id: p.id, name: p.name, icon: p.icon, description: p.description, userPage: p.userPage }));
  }

  /* 实例可用主题列表 (Gay Core): 已安装的 theme 插件默认可用, cfg.plugins 里显式 enable:false 才隐藏;
   * theme-md3 (内置默认主题) 强制在列, 不可隐藏/卸载。 */
  themesForInstance(uid, cfg, scope) {
    this.scanInstalled();
    const cfgMap = new Map(this.store.pluginEnableList(cfg).map(p => [p.id, p]));
    const out = [];
    for (const [id, inst] of this.installed) {
      if (inst.manifest.type !== 'theme' || !inst.manifest.theme) continue;
      const pc = cfgMap.get(id);
      /* ★声明式(2026-10-07): 默认主题由 manifest.theme.default 声明, 内核不再点名 theme-md3。
       *  兼容: 旧内置 theme-md3 若无该字段, 按"builtin 且 locked"仍强制在列。 */
      const isDefault = (inst.manifest.theme && inst.manifest.theme.default === true)
        || (inst.manifest._builtin === true && inst.manifest.locked === true);
      const forced = isDefault;
      if (!forced && pc && pc.enable === false) continue;
      const t = inst.manifest.theme;
      /* ★插件自定义主色: config.seed / seedDark (填一个颜色, 服务端生成整套调色板覆盖静态配色)。
       *  与 App 端「自定义主色」的关系: App 本机设置优先, 未设时用这里的插件配色。 */
      let dark = t.dark || {}, light = t.light || {};
      let cssVars = Object.assign({}, t.cssVars || {});
      try {
        /* ★配色参数按端分开读（_theme_admin / _theme_user）：用户端与 bootstrap 走 user，
         *  管理端在 plugin-config 里显式传 scope=admin —— 这样两端可以有不同的配色与圆角。 */
        const pc2 = this.store.getPluginConfig(id, uid, scope) || {};
        const seedLight = normalizeSeed(pc2.seed);
        const seedDark = normalizeSeed(pc2.seedDark) || seedLight;
        const scheme = String(pc2.scheme || 'standard');
        if (seedDark) { let p = paletteFromSeed(seedDark, true); if (p) dark = Object.assign({}, dark, applyScheme(p, scheme, true)); }
        if (seedLight) { let p = paletteFromSeed(seedLight, false); if (p) light = Object.assign({}, light, applyScheme(p, scheme, false)); }
        /* Compose 主题扩展: cardStyle / cornerScale / strokeWidth / scheme → cssVars */
        const cardStyle = String(pc2.cardStyle || cssVars['gc-card-style'] || 'outlined');
        const cornerScale = Math.max(0.5, Math.min(2, Number(pc2.cornerScale) || 1));
        /* ★回退链统一(2026-10-08): 用户配置(空串=跟随默认) → manifest 静态默认 → 硬编码兜底。
         *  旧写法 strokeWidth 的回退是硬编码 1, 用户清空参数后 manifest 的 1.5px 永远不生效。 */
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
      } catch (_) { /* 配置读取失败: 用静态配色 */ }
      out.push({
        id, name: t.name || inst.manifest.name || id, builtin: !!inst.manifest._builtin,
        locked: forced, dark, light, cssVars,
        /* ★2026-10-07: 声明式默认主题标记 —— core.js 据此决定要不要补内核兜底主题,
         *  内核因此不再点名 theme-md3。旧 App 忽略未知字段, 行为不变。 */
        isDefault: !!isDefault,
      });
    }
    out.sort((a, b) => (b.locked ? 1 : 0) - (a.locked ? 1 : 0)); // md3 排最前
    return out;
  }

  /* ---------- 安装 / 卸载 / 配置 ---------- */
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

  /* 拉取市场索引 (供 market API 用) */
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
      // 插件配置一并清 (卸载=干净, §6.3)
      try { fs.rmSync(this.store.pluginConfigFile(pluginId), { force: true }); } catch {}
    }
    this.scanInstalled();
    return true;
  }

  /** 插件的配置表单：`scope='admin'` 时读**管理端那份**（主题插件按端分开存）。 */
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

  /* ---------- HTTP 分发 (/plugins[/<id>[/<path...>]]) ---------- */
  async handle(cfg, req, res, u, p, body) {
    const uid = req._uid != null ? req._uid : (cfg._uid != null ? cfg._uid : 1);
    const segs = p.split('/').filter(Boolean);
    const json = (code, obj) => {
      const s = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(s);
    };

    if (segs.length === 1) { // GET /plugins → 插件中心页(HTML) 或 JSON
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
    /* ★多实例一致性(2026-09-18): 全局作用域插件的运行数据, 若本实例没有未落盘改动而别的实例写过,
     *  先原地重读磁盘再分发 —— 免得读到旧快照(如 billing 规则、卡密用量)。见 maybeReloadData。 */
    this.maybeReloadData(pluginId, uid);

    const handler = state.routes.get(req.method.toUpperCase() + ' ' + subPath);
    if (handler) {
      const params = {
        query: Object.fromEntries(u.searchParams),
        body: tryJson(body),
        rawBody: body,
        headers: req.headers,
        /* ★客户端能力(2026-10-07): App 上报的 X-GCUI-* 解析成"能用什么"的视图。
         *  插件可在渲染前自检 —— 拿不到头(网页端/旧 App) → null, 插件应回退保守写法。 */
        clientCaps: (() => {
          try {
            const adminUi = require('./admin-ui');
            return adminUi.capsView(adminUi.parseCaps(req.headers));
          } catch (_) { return null; }
        })(),
        /* 管理端鉴权: 插件管理端点用 (authAdmin() → {ok, ...}) */
        /* 管理端鉴权: 插件管理端点用 (authAdmin() → {ok, ...}) */
        authAdmin: () => this.authChain ? this.authChain.checkAdmin(cfg, req, u.searchParams) : { ok: true },
        /* ★用户密钥(认证链结果) —— 插件页面/意图用它鉴权。
         *  为什么要单独给: 插件原来用 apis().findKey(token) 从**卡密列表**里找, 而
         *  「管理员密钥当用户密钥」(auth-adminkey 插件) 是由认证链认领的, 不在卡密列表里
         *  → 管理员用密钥访问模型广场/个人资料会 401「需要卡密登录」。走认证链就都能认。 */
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
      /* 记录本次请求的客户端能力, 供 ctx.clientCaps() 同步读取 */
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

/** 插件中心页（浏览器访问 /plugins 时） */
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
