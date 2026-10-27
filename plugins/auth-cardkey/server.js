'use strict';
/* auth-cardkey 插件 (type:auth) - 卡密认证系统
 * 配置 plugins-config/auth-cardkey.json[<uid>]: { apiKeys: [...], keyLength: 24 }
 * 数据 plugins-data/<uid>/auth-cardkey.json: { usage: { "<key>": usedTokens } }
 * 端点: GET /credits(顶层) + /plugins/auth-cardkey/admin/keys*(管理)
 */
const crypto = require('crypto');

/* 预授权冻结是进程内并发闸门，不是最终账单。
 * 网关进程重启时冻结自然清零；真正的 usedTokens 仍由 onUsage 按上游 usage 结算。
 * ★单位（2026-09-18）：冻结量 = **额度**（与结算同单位：raw/1e6 × 倍率，量级 1e-3），
 *   不是 token 数。换算由 billing 的 onQuotaEstimate 提供；估不出来才回退 token 口径。 */
const quotaFrozen = new Map(); // key -> estimated 额度 currently in-flight

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

module.exports.activate = (ctx) => {
  /* ★多实例一致性: 本插件的配置(卡密表)是全局共享的, 但每个实例各有一份内存副本。
   * 用内核给的配置版本号做失效检查 —— 任何实例改过配置后, 其它实例这里会自动重新读盘,
   * 否则新建的卡密在别的实例上会 401 invalid key。 */
  let _cfgCache = null, _cfgRev = -1;
  const cfgLive = () => {
    const r = ctx.configRev ? ctx.configRev() : 0;
    if (!_cfgCache || r !== _cfgRev) {
      const fresh = ctx.getPluginConfig('auth-cardkey');
      _cfgCache = (fresh && typeof fresh === 'object') ? fresh : Object.assign({}, ctx.config);
      _cfgRev = r;
    }
    return _cfgCache;
  };
  const keys = () => { const c = cfgLive(); if (!Array.isArray(c.apiKeys)) c.apiKeys = []; return c.apiKeys; };
  const keyLength = () => Math.min(128, Math.max(8, Number(cfgLive().keyLength) || 24));
  const usage = () => ctx.data.get('usage') || {};
  const usedOf = k => (usage()[k.key] || 0);
  const frozenOf = k => quotaFrozen.get(k.key) || 0;
  /* 额度文案：最多 6 位小数、去尾零（额度本就是小数，报错里别刷一长串） */
  const fmtAmt = (v) => {
    const x = Number(v);
    if (!isFinite(x)) return '0';
    return String(Math.round(x * 1e6) / 1e6);
  };
  const setUsed = (k, v) => {
    /* ★必须保留小数：动态计费会算出加权额度（如权重 0.5、金额模式的小数），
     *  若在这里 Math.round 成整数，小额扣费会被抹成 0（= 变相白嫖），
     *  且"扣了多少"与 billing 的账单对不上（对账会崩）。
     *  取 6 位小数足够；整数值的存量数据行为完全不变。 */
    const u = usage();
    const x = Number(v);
    u[k.key] = isFinite(x) ? Math.max(0, Math.round(x * 1e6) / 1e6) : (u[k.key] || 0);
    ctx.data.set('usage', u);
  };
  const save = () => ctx.setPluginConfig(cfgLive());
  /* 生成卡密: base64url 随机 + 存活唯一性检查(碰撞就重生成)。
   *  24 字符 base64url ≈ 144 bit 熵, 碰撞概率 ~2^-72(数十亿张也安全);
   *  这里再挡一道"同一实例内重复", 把实际可触发的碰撞归零。 */
  const genKey = () => {
    const live = keys();
    let k;
    do { k = 'sk-' + crypto.randomBytes(Math.ceil(keyLength() * 3 / 4) + 2).toString('base64url').slice(0, keyLength()); }
    while (live.some(x => x && x.key === k));
    return k;
  };

  const creditsJSON = (uk) => {
    const qt = Number(uk.quotaTokens);
    const zeroLimited = qt === 0; /* 0 = 零额度(不可用) */
    const unlimited = qt === -1; /* -1 = 不限(无限) */
    const quota = (zeroLimited || unlimited) ? 0 : Math.max(0, qt);
    const used = usedOf(uk);
    return {
      name: uk.name || '', uid: uk.uid || '', quotaTokens: quota, usedTokens: used,
      /* ★额度一律按 6 位小数显示：动态计费会产生小数用量（如 0.5 权重）。
       *  App 端原本按整数展示，小数会被显示成 0 → 用户以为"没扣费"。 */
      usedTokensDisplay: Math.round(used * 1e6) / 1e6,
      remainingTokens: zeroLimited ? 0 : (unlimited ? null : Math.max(0, quota - used - frozenOf(uk))),
      reservedTokens: unlimited ? 0 : Math.round(frozenOf(uk) * 1e6) / 1e6,
      unlimited, zeroLimited,
      expiresAt: uk.expiresAt || '', models: uk.models || [], groups: uk.groups || [], branches: uk.branches || [],
    };
  };

  /* 1) 认证策略: 查卡 → 禁用/过期/额度校验 */
  ctx.registerAuth({
    name: 'cardkey',
    check: ({ token, req }) => {
      if (!token) return null;
      const uk = keys().find(k => k && k.key === token);
      if (!uk) return null;
      if (uk.enable === false) return { ok: false, status: 401, error: 'key 已禁用' };
      if (uk.expiresAt) {
        const t = new Date(uk.expiresAt).getTime();
        if (!isNaN(t) && t < Date.now()) return { ok: false, status: 401, error: 'key 已过期 (' + uk.expiresAt + ')' };
      }
      const used = usedOf(uk);
      if (uk.quotaTokens === 0) {
        /* 零额度: 拦截真正花钱的推理请求; 自助/只读端点放行 —— 让用户能查账号、看模型列表。
         * 放行: /auth/*  ·  /credits  ·  /v1/models  ·  /v1/models/xxx (只读元数据, 不打上游) */
        const p = (req && req.url || '').split('?')[0];
        /* 零额度放行清单: 自助/只读端点 —— 让用户能查账号、看模型列表、使用插件界面
         *  (含「保存资料」「签到」等自助意图, 这些不打上游不花钱)。
         *  注意: ① 插件的 /admin/* 管理端点**不**放行(另有管理密钥校验);
         *        ② 真正花钱的推理请求(/v1/chat/completions 等)仍然被拦。 */
        const selfServe = /(^|\/)auth\//.test(p)
          || /\/credits$/.test(p)
          || /\/v1\/models(\/[^\/]+)?$/.test(p)
          || /\/v1\/branches$/.test(p)
          || /\/plugins\/[^\/]+\/(ui|intent|data)(\/|$)/.test(p);
        /* 零额度 = 余额不足, 只挡**花钱的推理请求**; 自助操作(登录/发卡/改权限/看模型)一律放行 */
        if (!selfServe) return { ok: false, status: 429, error: '余额不足：当前额度为 0，无法调用模型（请联系管理员充值）' };
      }
      if (uk.quotaTokens > 0 && used >= uk.quotaTokens)
        return { ok: false, status: 429, error: '余额不足：额度已用尽 (' + fmtAmt(used) + '/' + fmtAmt(uk.quotaTokens) + ')，无法调用模型（请联系管理员充值）' };
      return { ok: true, userKey: Object.assign({}, uk, { usedTokens: used }) };
    },
  });

  /* 2) 全局分支白名单(防目标实例免密绕过) */
  const syncGlobal = () => { for (const k of keys()) if (k && k.key) ctx.gateway.registerGlobalKey(k.key, k.branches || []); };
  syncGlobal();

  /* 3) 模型白名单 + 分组白名单 (分支白名单由内核全局检查覆盖)
   *    · models[]  精确模型名白名单 (空 = 不限)
   *    · groups[]  模型分组白名单 (空 = 不限); 分组来自 model-square 的「快速分组」定义,
   *                未定义时按名称前缀推导 (gpt-4o → gpt)
   *    两者同时非空 = 交集 (都要满足)。 */
  ctx.hook('onChatAuth', ({ userKey, model, body }) => {
    if (!userKey) return null;
    if (Array.isArray(userKey.models) && userKey.models.length && !userKey.models.includes(model))
      return { status: 403, message: '此卡密不允许使用模型: ' + model + ' (可用: ' + userKey.models.join(', ') + ')' };
    const gs = Array.isArray(userKey.groups) ? userKey.groups : [];
    if (gs.length) {
      let ok = true;
      try { ok = ctx.gateway.modelGroups().matches(model, gs); }
      catch (e) { ok = true; ctx.log('分组校验不可用(放行):', e.message); }
      if (!ok) return { status: 403, message: '此卡密只能使用分组内的模型: ' + model + ' (允许分组: ' + gs.join(', ') + ')' };
    }
    /* 预授权只冻结，不计入 usedTokens。估算在 router 确认存在可用渠道后才执行。 */
    return { quota: {
      reserve: ({ canonical, cfg, estimateCharge, ch }) => {
        const qt = Number(userKey.quotaTokens);
        if (qt === -1) return { release: () => {} };
        const promptEstimate = Math.ceil(JSON.stringify(body || {}).length / 2);
        let maxOut = Math.max(1, Math.min(1000000, Number(
          body && (body.max_tokens ?? body.max_completion_tokens ?? (body.generationConfig && body.generationConfig.maxOutputTokens))
        ) || 4096));
        /* ★预授权只冻结一小部分输出: 客户端常把 max_tokens 设很大(如 32768),
         *  "你好"也会被冻结 32k —— 但实际生成往往只有几十 token, 真实用量由
         *  onUsage 按上游 usage 结算。冻结过多会导致: 可用额度被高估扣减、
         *  甚至把本可成功的请求 429 拒掉。封顶 4096 已足够防超支。 */
        maxOut = Math.min(maxOut, 4096);
        const tokens = promptEstimate + maxOut;
        /* ★单位口径 (2026-09-18)：冻结量必须与**结算**同单位。
         *  结算走 billing 的加权额度（raw/1e6 × 倍率，量级 1e-3），而这里原来直接拿
         *  token 数当额度冻结（量级 1e3）→ 大 100 万倍：额度 99.97 的卡被
         *  「本次请求预授权需要约 13209」429 拒掉，而那次实际只扣 0.01。
         *  所以先请 billing 把 token 换算成额度（内核给的 estimateCharge 回调 →
         *  onQuotaEstimate）；**拿不到估算**（未装 billing / 模型未定价 → 结算也走
         *  老口径 1 token = 1 额度）时回退 token 口径 —— 两种口径各自自洽。 */
        let estimate = tokens, inChargeUnit = false;
        if (typeof estimateCharge === 'function') {
          const v = estimateCharge({
            model: (canonical && canonical.model) || '',
            inst: (cfg && cfg._name) || ctx.instanceName || '',
            ch: ch || '', input: promptEstimate, output: maxOut, uid: userKey.uid || '', cfg,
          });
          if (v !== null && v !== undefined && isFinite(Number(v)) && Number(v) >= 0) {
            estimate = Number(v); inChargeUnit = true;
          }
        }
        const used = usedOf(userKey);
        const frozen = frozenOf(userKey);
        const available = Math.max(0, qt - used - frozen);
        if (estimate > available) return {
          error: '余额不足：当前可用额度约 ' + fmtAmt(available) + (inChargeUnit
            ? '，本次请求预计消耗约 ' + fmtAmt(estimate) + ' 额度（max_tokens=' + maxOut + '）'
            : '，本次请求预授权需要约 ' + estimate + '（max_tokens=' + maxOut + '）'),
          status: 429,
        };
        quotaFrozen.set(userKey.key, frozen + estimate);
        let released = false;
        return { estimate, inChargeUnit, release: () => {
          if (released) return;
          released = true;
          const next = (quotaFrozen.get(userKey.key) || 0) - estimate;
          if (next > 0) quotaFrozen.set(userKey.key, next); else quotaFrozen.delete(userKey.key);
        }};
      },
    }};
  });

  /* 4) 用量累计 —— ★动态计费(billing 插件)的唯一接入点
   *  内核在 usage.charged 里给「这次该扣多少加权额度」：
   *    · charged 有值 → 按它扣（可为小数，如 0.5 权重；0 = 免费，是合法值）
   *    · charged 为 null（未装 billing / 模型既没配价也没规则命中）→ 回退老口径 input+output
   *  这样「没配过计费的模型」扣费与改造前**逐字节一致**，已发出的卡密额度零迁移。
   *  ⚠️判断必须用 `!= null`：`if (charged)` 会把 0（免费规则）误判成"没值"再扣一遍老口径。 */
  ctx.hook('onUsage', (usage, c) => {
    const uk = c.urlInfo && c.urlInfo.userKey;
    if (!uk || !uk.key || !usage) return;
    const legacy = (Number(usage.input) || 0) + (Number(usage.output) || 0);
    const charged = (usage.charged != null) ? Number(usage.charged) : legacy;
    if (!isFinite(charged)) return;
    setUsed(uk, usedOf(uk) + charged);
  });

  /* 5) 暴露 API 给其他插件(签到/充值/用户体系) */
  ctx.bindAuthApis({
    findKey: (cfg2, token) => { const k = keys().find(x => x && x.key === token); return k ? Object.assign({}, k, { usedTokens: usedOf(k) }) : null; },
    /** 可勾选项清单(编辑卡密权限用)。scope=父卡密时按其白名单裁剪, null=全量 */
    accessOptions: (scope) => optionsJSON(scope || null),
    grantQuota: (cfg2, keyId, tokens) => { const k = keys().find(x => x && x.key === keyId); if (!k || !(tokens > 0)) return false; setUsed(k, usedOf(k) - tokens); return true; },
    listKeys: () => keys().map(k => Object.assign({}, k, { usedTokens: usedOf(k) })),
    addKey: (k) => { keys().push(k); save(); syncGlobal(); return k; },
    updateKey: (key, patch) => { const k = keys().find(x => x && x.key === key); if (!k) return false; Object.assign(k, patch); save(); syncGlobal(); return true; },
    deleteKey: (key) => { const i = keys().findIndex(x => x && x.key === key); if (i < 0) return false; const k = keys()[i]; keys().splice(i, 1); save(); ctx.gateway.unregisterGlobalKey(k.key); return true; },
    deleteKeysOf: (uid) => { const list = keys().filter(x => x && x.uid === uid); for (const k of list) { const i = keys().indexOf(k); if (i >= 0) keys().splice(i, 1); ctx.gateway.unregisterGlobalKey(k.key); } if (list.length) save(); return list.length; },
    creditsJSON, genKey,
  });

  /* 6) GET /credits 顶层路由(用户端查余额) */
  ctx.registerTopRoute('GET', '/credits', ({ res, auth }) => {
    const r = auth();
    if (!r.ok) return jsonRes(res, r.status || 401, { error: r.error || 'invalid key' });
    if (r.userKey) return jsonRes(res, 200, creditsJSON(r.userKey));
    return jsonRes(res, 200, { admin: true, unlimited: true });
  });

  /* 7) 管理端点 /plugins/auth-cardkey/admin/* */
  const adminOnly = (p, res) => { const a = p.authAdmin(); if (!a.ok) { jsonRes(res, a.status || 401, { error: a.error || 'unauthorized' }); return false; } return true; };

  ctx.registerRoute('GET', '/admin/keys', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    jsonRes(res, 200, { keys: keys().map(k => Object.assign({}, k, { usedTokens: usedOf(k) })) });
  });

  ctx.registerRoute('POST', '/admin/keys', (req, res, p) => { // 发卡
    if (!adminOnly(p, res)) return;
    const j = p.body || {};
    const nk = {
      key: genKey(), name: String(j.name || '卡密').slice(0, 64), enable: true,
      /* -1 = 不限额度 (别被 Math.max(0,..) 吃掉, 否则发不出不限卡) */
      quotaTokens: Number(j.quotaTokens) === -1 ? -1 : Math.max(0, Number(j.quotaTokens) || 0), uid: String(j.uid || ''),
      models: Array.isArray(j.models) ? j.models.map(String) : [],
      groups: Array.isArray(j.groups) ? j.groups.map(String) : [],
      branches: Array.isArray(j.branches) ? j.branches.map(String) : [],
      channels: Array.isArray(j.channels) ? j.channels.map(String) : [],
      redact: j.redact == null ? null : !!j.redact,
      expiresAt: String(j.expiresAt || ''), note: String(j.note || '').slice(0, 200),
      by: 'admin',   /* 来源: admin=管理员分发 / auto=建号自动发 / user=用户自助子卡 */
      createdAt: new Date().toISOString(),
    };
    keys().push(nk); save(); syncGlobal();
    jsonRes(res, 200, { ok: true, key: Object.assign({}, nk, { usedTokens: 0 }) });
  });

  ctx.registerRoute('POST', '/admin/keys-update', (req, res, p) => { // 改卡(充值/禁用/白名单)
    if (!adminOnly(p, res)) return;
    const j = p.body || {};
    const k = keys().find(x => x && x.key === j.key);
    if (!k) return jsonRes(res, 404, { error: '卡密不存在' });
    if (j.name !== undefined) k.name = String(j.name).slice(0, 64);
    if (j.enable !== undefined) k.enable = !!j.enable;
    if (j.models !== undefined) k.models = Array.isArray(j.models) ? j.models.map(String) : [];
    if (j.groups !== undefined) k.groups = Array.isArray(j.groups) ? j.groups.map(String) : [];
    if (j.branches !== undefined) k.branches = Array.isArray(j.branches) ? j.branches.map(String) : [];
    if (j.expiresAt !== undefined) k.expiresAt = String(j.expiresAt);
    if (j.note !== undefined) k.note = String(j.note).slice(0, 200);
    if (j.quotaTokens !== undefined) k.quotaTokens = Math.max(-1, Number(j.quotaTokens) || 0); /* -1=零额度 */
    /* 充值 / 扣减: **正数增加、负数扣减** (用户要求能手动扣减余额)。
     *  不限额度(-1) 保持不变(充/扣都没意义, 也不能降级成有限额度);
     *  扣减下限为 0 (0 即"零额度, 不可用")。 */
    if (j.addQuota !== undefined && j.addQuota !== '' && j.addQuota !== null) {
      const delta = Number(j.addQuota);
      if (isFinite(delta) && delta !== 0) {
        if (k.quotaTokens !== -1) {
          k.quotaTokens = Math.max(0, (Number(k.quotaTokens) || 0) + delta);
        }
      }
    }
    if (j.resetUsage) setUsed(k, 0);
    save(); syncGlobal();
    jsonRes(res, 200, { ok: true, key: Object.assign({}, k, { usedTokens: usedOf(k) }) });
  });

  ctx.registerRoute('DELETE', '/admin/keys', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    const j = p.body || {};
    const i = keys().findIndex(x => x && x.key === j.key);
    if (i < 0) return jsonRes(res, 404, { error: '卡密不存在' });
    const k = keys()[i];
    keys().splice(i, 1); save(); ctx.gateway.unregisterGlobalKey(k.key);
    jsonRes(res, 200, { ok: true });
  });

  /* 8) 可勾选清单 (卡密「访问权限」多选面板用)
   *    返回: 全部分组 / 全部模型(带分组与所属实例) / 全部实例
   *    scope: 传卡密时按该卡密的父级限制裁剪(用户端编辑子卡用)。
   *           传入 null = 不裁剪(管理端)。 */
  const optionsJSON = (scope) => {
    const gi = ctx.gateway.modelGroups ? ctx.gateway.modelGroups() : { declared: [], groupsOf: m => [], matches: () => true };
    const models = [];
    const instances = [];
    for (const inst of ctx.gateway.listInstances()) {
      if (inst.enabled === false) continue;
      instances.push(inst.name);
      let ic = null;
      try { ic = ctx.getInstanceConfig(inst.uid); } catch (_) { }
      if (!ic || !Array.isArray(ic.channels)) continue;
      for (const ch of ic.channels) {
        if (!ch || !ch.name) continue;
        const mm = (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {};
        const names = [];
        for (const m of (Array.isArray(ch.models) ? ch.models : [])) if (m) names.push(String(m));
        for (const k of Object.keys(mm)) if (k) names.push(String(k));
        for (const n of names) {
          if (models.some(x => x.name === n)) continue;
          const gs = gi.groupsOf(n);
          models.push({ name: n, group: gs[0] || 'Default', groups: gs, instance: inst.name, channel: ch.name });
        }
      }
    }
    let groups = gi.declared.slice();
    for (const m of models) for (const g of m.groups) if (!groups.includes(g)) groups.push(g);
    let outModels = models;
    if (scope) {
      const sm = Array.isArray(scope.models) ? scope.models : [];
      const sg = Array.isArray(scope.groups) ? scope.groups : [];
      if (sm.length) outModels = outModels.filter(m => sm.includes(m.name));
      if (sg.length) outModels = outModels.filter(m => m.groups.some(g => sg.includes(g)));
      if (sg.length) groups = groups.filter(g => sg.includes(g));
    }
    return { ok: true, groups, models: outModels, instances,
      defaultGroup: groups.includes('Default') ? 'Default' : (groups[0] || '') };
  };

  ctx.registerRoute('GET', '/admin/options', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    jsonRes(res, 200, optionsJSON(null));
  });

  /* 用户端: 编辑自己子卡时能勾选的清单 (受父卡白名单裁剪) */
  ctx.registerTopRoute('GET', '/auth/access-options', ({ res, auth }) => {
    const r = auth();
    if (!r.ok) return jsonRes(res, r.status || 401, { error: r.error || 'invalid key' });
    jsonRes(res, 200, optionsJSON(r.userKey || null));
  });

  /* ===== 9) 管理端「编辑卡密」SDUI 页 (2026-09-17) =====
   * 由 registerAdminUi 贡献（menu:false 子页）。App 管理端在卡密卡片点「编辑」时打开：
   *   /admin/ui/key-edit?key=<卡密>
   * 内容：卡密信息 + 基本信息表单（卡名/额度/到期/备注）+ 访问权限（模式 chip + 分组/模型网格多选）。
   *
   * ★无状态设计（关键）：渲染时**为每个候选项预计算好「点它之后的完整白名单」**，
   *   塞进该 chip 的 action.body（{{item.g}} / {{item.m}}）。App 渲染期就把 {{item.*}} 绑成
   *   真正的 JSON 数组（Template.bindJsonKeep 支持 List→JsonArray），点击即 adminApi 提交完整结果。
   *   好处：不需要临时状态、不需要签名意图；提交后 then:'reload' 原地刷新同一 URL
   *   （SduiController 走 refreshInto），**不会压栈 → 根治嵌套打开**。
   *
   * ★模式是「纯 UI 状态」（2026-09-17 二修）：一开始把模式做成由数据推断（groups 非空=按分组…），
   *   结果「按模型」在 models 为空时**点不进去**（提交空数组 → 数据没变 → 又退回不限），
   *   管理员根本没法开始选模型。现在：模式 chip 用 setState 只切本地显隐（showGroup/showModel），
   *   真正的权限由「勾选网格里的项」提交决定 —— 从任意状态都能进入任一模式的候选列表。
   *   两套网格的候选**都预计算好**，且各自提交时清空另一维度（模式语义互斥，不叠加）。 */
  /* ---- key-create 子页: 管理员发卡(用户/额度/卡名) —— App「用户管理」页的卡密 tab 入口 ---- */
  ctx.registerAdminUi({
    id: 'key-create', menu: false,
    render(gw, _cfg, q, caps) {
      const get = (k) => { try { return String((q && q.get) ? q.get(k) || '' : ''); } catch (_) { return ''; } };
      const txt = (text, style, color) => { const o = { type: 'text', text }; if (style) o.style = style; if (color) o.color = color; return o; };
      const act = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
        body: { plugin: 'auth-cardkey', path: '/admin/keys', method: 'POST', body } });
      /* 用户候选(供 uid 填写提示) —— 能力拿, 不写死 auth-user */
      let userHint = '';
      try {
        const ua = ctx.gateway.listCapabilities ? null : null;
      } catch (_) {}
      const kids = [
        txt('发卡', 'title3'),
        txt('发一张新卡密给指定用户。额度 -1 = 不限。', 'caption', '$onSurfaceVariant'),
        { type: 'input', key: 'uid', label: '用户 UID（在用户管理列表里看）', value: get('uid') },
        { type: 'input', key: 'name', label: '卡名（可选，默认「卡密」）', value: '' },
        { type: 'input', key: 'quota', label: '额度（token 数，-1 = 不限）', value: '', inputType: 'number' },
        { type: 'input', key: 'note', label: '备注（可选）', value: '' },
        { type: 'button', text: '发卡', style: 'filled', shape: 'pill', icon: 'msym:add',
          action: act({ uid: '{{input.uid}}', name: '{{input.name}}', quotaTokens: '{{input.quota}}', note: '{{input.note}}' }) },
      ];
      return { title: '发卡', state: {}, root: { type: 'column', gap: 10, children: kids } };
    },
  });

  ctx.registerAdminUi({
    id: 'key-edit',
    title: '编辑卡密',
    icon: 'edit',
    menu: false,
    render: (gw, c, q) => {
      const qs = (n) => String((q && q.get) ? (q.get(n) || '') : '');
      const key = qs('key');
      const txt = (text, style, color) => { const o = { type: 'text', text: text }; if (style) o.style = style; if (color) o.color = color; return o; };
      const gap = (h) => ({ type: 'spacer', height: h || 8 });
      const btn = (text, style, action) => ({ type: 'button', text: text, style: style, action: action });
      const kids = [];
      const k = keys().find(x => x && x.key === key);
      if (!k) {
        kids.push(txt('卡密不存在或已被删除。', 'body'));
        kids.push(btn('关闭', 'text', { type: 'close' }));
        return { gcui: 1, title: '编辑卡密', state: {}, root: { type: 'column', gap: 10, children: kids } };
      }
      const groups = Array.isArray(k.groups) ? k.groups.map(String) : [];
      const models = Array.isArray(k.models) ? k.models.map(String) : [];
      const branches = Array.isArray(k.branches) ? k.branches.map(String) : [];
      const quota = Number(k.quotaTokens) || 0;
      const used = Math.round(usedOf(k) * 100) / 100;
      const mode = groups.length ? 'group' : (models.length ? 'model' : 'all');
      const opts = optionsJSON(null);
      const allGroups = (opts.groups || []).map(String);
      const allModels = [];
      for (const m of (opts.models || [])) { const n = String((m && m.name) || ''); if (n && allModels.indexOf(n) < 0) allModels.push(n); }
      const upd = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
        body: { plugin: 'auth-cardkey', path: '/admin/keys-update', method: 'POST', body: Object.assign({ key: key }, body) } });
      const permText = groups.length ? ('分组 ' + groups.join('/'))
        : (models.length ? (models.length + ' 个模型') : '全部模型');
      /* 两套候选网格（各自预计算「点它之后」的完整白名单；提交时清空另一维度） */
      const gc = allGroups.map(g => {
        const on = groups.indexOf(g) >= 0;
        return { name: g, on: on, g: (on ? groups.filter(x => x !== g) : groups.concat([g])), m: [] };
      });
      const mc = allModels.map(m => {
        const on = models.indexOf(m) >= 0;
        return { name: m, on: on, g: [], m: (on ? models.filter(x => x !== m) : models.concat([m])) };
      });

      /* ---- 卡密信息 ---- */
      kids.push(txt(k.name || '(未命名)', 'title3'));
      kids.push(txt('卡号 ' + key.slice(0, 8) + '\u2026' + key.slice(-4) + (k.enable === false ? ' \u00b7 已禁用' : ''), 'caption', '$onSurfaceVariant'));
      kids.push(txt('额度 ' + (quota === -1 ? '不限' : String(quota)) + ' \u00b7 已用 ' + used, 'caption', '$onSurfaceVariant'));
      kids.push(gap(10));

      /* ---- 基本信息表单（只提交这几个字段，不碰白名单） ---- */
      kids.push(txt('基本信息', 'title3'));
      kids.push({
        type: 'form', submitText: '保存基本信息', submitShape: 'large',
        fields: [
          { type: 'input', key: 'name', label: '卡名', value: String(k.name || '') },
          { type: 'input', key: 'quotaTokens', label: '额度（0 = 零额度；-1 = 不限）', inputType: 'number', value: String(quota) },
          { type: 'input', key: 'expiresAt', label: '到期日（YYYY-MM-DD，可空）', value: String(k.expiresAt || '') },
          { type: 'input', key: 'note', label: '备注', value: String(k.note || '') },
        ],
        submit: upd({
          name: '{{form.name}}', quotaTokens: '{{form.quotaTokens}}',
          expiresAt: '{{form.expiresAt}}', note: '{{form.note}}',
        }),
      });
      kids.push(gap(12));

      /* ---- 访问权限 ---- */
      kids.push(txt('访问权限', 'title3'));
      kids.push(txt('当前：' + permText + (branches.length ? ' \u00b7 实例 ' + branches.join('/') : ''), 'caption', '$onSurfaceVariant'));
      kids.push({
        type: 'hscroll', gap: 8, children: [
          { type: 'chip', text: '不限', icon: 'msym:check', selected: '{{state.showNone}}', action: upd({ groups: [], models: [] }) },
          { type: 'chip', text: '按分组', icon: 'msym:group', selected: '{{state.showGroup}}',
            action: { type: 'setState', patch: { showGroup: true, showModel: false, showNone: false } } },
          { type: 'chip', text: '按模型', icon: 'msym:apps', selected: '{{state.showModel}}',
            action: { type: 'setState', patch: { showGroup: false, showModel: true, showNone: false } } },
        ],
      });
      kids.push(txt('「不限」立即生效；「按分组/按模型」只是切换下面的列表，点选具体项才保存。', 'caption', '$onSurfaceVariant'));

      /* 分组网格 */
      kids.push({ type: 'text', text: '点分组即勾选/取消并立即保存（已选 ' + groups.length + ' / 共 ' + allGroups.length + '）',
        style: 'caption', color: '$onSurfaceVariant', visible: '{{state.showGroup}}' });
      if (allGroups.length) {
        kids.push({
          type: 'list', items: '{{state.gc}}', columns: 2, visible: '{{state.showGroup}}',
          template: {
            type: 'chip', text: '{{item.name}}', selected: '{{item.on}}',
            action: upd({ groups: '{{item.g}}', models: '{{item.m}}' }),
          },
        });
      } else {
        kids.push({ type: 'text', text: '没有可选分组（先在「模型分组 / 快速分组」里定义）。', style: 'caption', color: '$error', visible: '{{state.showGroup}}' });
      }

      /* 模型网格 */
      kids.push({ type: 'text', text: '点模型即勾选/取消并立即保存（已选 ' + models.length + ' / 共 ' + allModels.length + '）',
        style: 'caption', color: '$onSurfaceVariant', visible: '{{state.showModel}}' });
      if (allModels.length) {
        kids.push({
          type: 'list', items: '{{state.mc}}', columns: 2, visible: '{{state.showModel}}',
          template: {
            type: 'chip', text: '{{item.name}}', selected: '{{item.on}}',
            action: upd({ groups: '{{item.g}}', models: '{{item.m}}' }),
          },
        });
      } else {
        kids.push({ type: 'text', text: '没有检测到可选模型。', style: 'caption', color: '$error', visible: '{{state.showModel}}' });
      }
      kids.push(gap(12));
      kids.push(btn('关闭', 'text', { type: 'close' }));

      return {
        gcui: 1, title: '编辑卡密',
        state: { showGroup: mode === 'group', showModel: mode === 'model', showNone: mode === 'all', gc: gc, mc: mc },
        root: { type: 'column', gap: 10, children: kids },
      };
    },
  });

  /* ★能力注册 (2026-10-07 深度改造): 让"卡密管理"成为可查询的能力,
   *  内核页就不必再写死插件名 'auth-cardkey' —— 任何插件提供同名能力都能顶上。
   *  只暴露只读的 listKeys + 动作面声明; 写操作仍走各插件自己的 /admin/ 端点(经声明式 plugin-call)。 */
  ctx.provideCapability('cardkey-admin', {
    listKeys: () => { try { return keys().map(k => ({ key: k.key, name: k.name, note: k.note, enable: k.enable !== false, quotaTokens: k.quotaTokens, usedTokens: usedOf(k) })); } catch (_) { return []; } },
    /** 动作路径声明(内核据此拼 adminApi, 不写死插件 id) */
    adminApi: () => ({ pluginId: ctx.id, list: '/admin/keys', update: '/admin/keys-update' }),
    /* ★api (2026-10-07): 可序列化端点说明 → 内核 bootstrap 下发 → **App 按能力名查端点**。
     *  以前 App 把 /plugins/auth-cardkey/admin/keys 写死在 Api.kt 里, 换插件实现 App 就断。
     *  ★路径是**相对插件**的(内核/App 拼上 /plugins/<pluginId> 前缀), 所以插件改名也不影响。 */
    api: () => ({
      endpoints: {
        list:   '/admin/keys',          // GET  列表
        create: '/admin/keys',          // POST 发卡
        update: '/admin/keys-update',   // POST 改卡
        remove: '/admin/keys',          // DELETE 删卡
      },
    }),
  });

  ctx.log('卡密认证已激活, 卡数:', keys().length, '· 已提供能力 cardkey-admin');
};
