'use strict';
/** the auth-cardkey plugin (type:auth) - key-card authentication system
   * config plugins-config/auth-cardkey.json[<uid>]: { apiKeys: [...], keyLength: 24 }
   * data plugins-data/<uid>/auth-cardkey.json: { usage: { "<key>": usedTokens } }
   * endpoints: GET /credits (top-level) + /plugins/auth-cardkey/admin/keys* (admin)
 */
const crypto = require('crypto');

/** pre-auth freezing is an in-process concurrency gate, not the final bill.
   * freezes clear naturally on gateway restart; real usedTokens are still settled by onUsage from the upstream usage.
   * *units (2026-09-18): frozen amounts = **quota** (the same unit as settlement: raw/1e6 x multiplier, magnitude 1e-3),
 *   not token counts. The conversion is provided by billing's onQuotaEstimate; the token convention is only the fallback when no estimate is possible. */
const quotaFrozen = new Map(); // key -> estimated quota currently in flight

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

module.exports.activate = (ctx) => {
  /* *multi-instance consistency: this plugin's config (the card table) is globally shared, but each instance holds its own memory copy.
   * Invalidation checks use the config version handed over by the core -- after any instance changes config, other instances automatically re-read disk here,
   * otherwise new card keys would 401 invalid key on the other instances. */
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
  /* Quota formatting: at most 6 decimals, trailing zeros trimmed (quota is decimal; error messages must not sprawl) */
  const fmtAmt = (v) => {
    const x = Number(v);
    if (!isFinite(x)) return '0';
    return String(Math.round(x * 1e6) / 1e6);
  };
  const setUsed = (k, v) => {
    /* *decimals must survive: dynamic billing yields weighted quota (a 0.5 weight, money-mode fractions),
     *  Math.round-ing to integers here would flatten small deductions to 0 (= free usage by the back door),
     *  and "what was deducted" would disagree with billing's ledger (reconciliation would break).
     *  6 decimals is plenty; integer-valued existing data behaves exactly as before. */
    const u = usage();
    const x = Number(v);
    u[k.key] = isFinite(x) ? Math.max(0, Math.round(x * 1e6) / 1e6) : (u[k.key] || 0);
    ctx.data.set('usage', u);
  };
  const save = () => ctx.setPluginConfig(cfgLive());
  /* Card-key generation: base64url randomness + liveness uniqueness check (regenerate on collision).
   *  24-char base64url ~ 144 bits of entropy; collision odds ~2^-72 (safe for billions of cards);
   *  This adds one more guard against "duplicates within the same instance", driving practically triggerable collisions to zero. */
  const genKey = () => {
    const live = keys();
    let k;
    do { k = 'sk-' + crypto.randomBytes(Math.ceil(keyLength() * 3 / 4) + 2).toString('base64url').slice(0, keyLength()); }
    while (live.some(x => x && x.key === k));
    return k;
  };

  const creditsJSON = (uk) => {
    const qt = Number(uk.quotaTokens);
    const zeroLimited = qt === 0; /* 0 = zero quota (unusable) */
    const unlimited = qt === -1; /* -1 = unlimited */
    const quota = (zeroLimited || unlimited) ? 0 : Math.max(0, qt);
    const used = usedOf(uk);
    return {
      name: uk.name || '', uid: uk.uid || '', quotaTokens: quota, usedTokens: used,
      /* *quota always shows 6 decimals: dynamic billing produces fractional usage (e.g. a 0.5 weight).
       *  the App used to render integers, so decimals showed as 0 -> users believed nothing was deducted. */
      usedTokensDisplay: Math.round(used * 1e6) / 1e6,
      remainingTokens: zeroLimited ? 0 : (unlimited ? null : Math.max(0, quota - used - frozenOf(uk))),
      reservedTokens: unlimited ? 0 : Math.round(frozenOf(uk) * 1e6) / 1e6,
      unlimited, zeroLimited,
      expiresAt: uk.expiresAt || '', models: uk.models || [], groups: uk.groups || [], branches: uk.branches || [],
    };
  };

  /* 1) auth strategy: look up the card -> disabled/expired/quota checks */
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
        /* zero quota: block money-costing inference; self-service/read-only endpoints pass -- users can still check accounts and browse models.
 * allow: /auth/* /credits /v1/models /v1/models/xxx (read-only metadata, never hits the upstream) */
        const p = (req && req.url || '').split('?')[0];
        /* zero-quota allowlist: self-service/read-only endpoints -- users can check accounts, browse models, use plugin UIs
         *  (including self-service intents like "save profile" / "check in" -- these never hit the upstream or cost money).
         *  note: (1) a plugin's /admin/* admin endpoints are **not** allowed here (separate admin-key check);
         *        (2) requests that actually cost money (/v1/chat/completions etc.) are still blocked. */
        const selfServe = /(^|\/)auth\//.test(p)
          || /\/credits$/.test(p)
          || /\/v1\/models(\/[^\/]+)?$/.test(p)
          || /\/v1\/branches$/.test(p)
          || /\/plugins\/[^\/]+\/(ui|intent|data)(\/|$)/.test(p);
        /* zero quota = out of balance; block only **inference requests that cost money**; self-service (login/card issuing/permissions/model browsing) always passes */
        if (!selfServe) return { ok: false, status: 429, error: '余额不足：当前额度为 0，无法调用模型（请联系管理员充值）' };
      }
      if (uk.quotaTokens > 0 && used >= uk.quotaTokens)
        return { ok: false, status: 429, error: '余额不足：额度已用尽 (' + fmtAmt(used) + '/' + fmtAmt(uk.quotaTokens) + ')，无法调用模型（请联系管理员充值）' };
      return { ok: true, userKey: Object.assign({}, uk, { usedTokens: used }) };
    },
  });

  /* 2) global branch whitelist (blocks keyless bypass of the target instance) */
  const syncGlobal = () => { for (const k of keys()) if (k && k.key) ctx.gateway.registerGlobalKey(k.key, k.branches || []); };
  syncGlobal();

  /* 3) model whitelist + group whitelist (the branch whitelist is covered by the kernel's global check)
   *    - models[]  exact model-name whitelist (empty = unrestricted)
   *    - groups[]  the model group whitelist (empty = unrestricted); groups come from model-square's "quick groups" definitions,
   *                when undefined, infer from the name prefix (gpt-4o -> gpt)
   *    when both are non-empty = intersection (both must hold). */
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
    /* pre-auth only freezes, never counting into usedTokens. The estimate runs only after the router confirms a usable channel exists. */
    return { quota: {
      reserve: ({ canonical, cfg, estimateCharge, ch }) => {
        const qt = Number(userKey.quotaTokens);
        if (qt === -1) return { release: () => {} };
        const promptEstimate = Math.ceil(JSON.stringify(body || {}).length / 2);
        let maxOut = Math.max(1, Math.min(1000000, Number(
          body && (body.max_tokens ?? body.max_completion_tokens ?? (body.generationConfig && body.generationConfig.maxOutputTokens))
        ) || 4096));
        /* *pre-authorization freezes only a fraction of the output: clients often set max_tokens very high (e.g. 32768),
         *  a plain "hello" would freeze 32k -- real generation is usually tens of tokens; true usage is settled by
         *  onUsage with the upstream usage. Over-freezing causes: quotas overstated as deducted,
         *  even 429-rejecting requests that would have succeeded. The 4096 cap is plenty against overspend. */
        maxOut = Math.min(maxOut, 4096);
        const tokens = promptEstimate + maxOut;
        /* *unit convention (2026-09-18): frozen amounts must share the **settlement** unit.
         *  settlement uses billing's weighted quota (raw/1e6 x multiplier, magnitude 1e-3), while this originally took
         *  freezing raw token counts as quota (magnitude 1e3) -> a million-fold error: a card with 99.97 quota got
         *  "this request pre-authorizes about 13209" and 429-rejected, while that request actually deducted 0.01.
         *  so first ask billing to convert tokens into quota (the kernel-provided estimateCharge callback ->
         *  onQuotaEstimate); **no estimate available** (billing absent / model unpriced -> settlement also uses
         *  legacy 1 token = 1 quota) fall back to the token convention -- each convention is self-consistent. */
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

  /* 4) usage accumulation -- *the only integration point of dynamic billing (the billing plugin)
   *  the kernel states "how much weighted quota this should deduct" in usage.charged:
   *    - charged is set -> deduct it (may be fractional, e.g. a 0.5 weight; 0 = free, a legal value)
   *    - charged is null (billing absent / the model has neither a price nor a matching rule) -> fall back to legacy input+output
   *  This keeps deduction for "models never configured for billing" **byte-for-byte identical** to the pre-refactor behavior; issued card quotas need zero migration.
   *  the check must use `!= null`: `if (charged)` misreads 0 (a free rule) as "no value" and deducts again via the legacy convention. */
  ctx.hook('onUsage', (usage, c) => {
    const uk = c.urlInfo && c.urlInfo.userKey;
    if (!uk || !uk.key || !usage) return;
    const legacy = (Number(usage.input) || 0) + (Number(usage.output) || 0);
    const charged = (usage.charged != null) ? Number(usage.charged) : legacy;
    if (!isFinite(charged)) return;
    setUsed(uk, usedOf(uk) + charged);
  });

  /* 5) expose APIs to other plugins (check-in / top-up / user system) */
  ctx.bindAuthApis({
    findKey: (cfg2, token) => { const k = keys().find(x => x && x.key === token); return k ? Object.assign({}, k, { usedTokens: usedOf(k) }) : null; },
    /** checkable option list (for editing card permissions). scope = a parent card clips to its whitelist; null = everything */
    accessOptions: (scope) => optionsJSON(scope || null),
    grantQuota: (cfg2, keyId, tokens) => { const k = keys().find(x => x && x.key === keyId); if (!k || !(tokens > 0)) return false; setUsed(k, usedOf(k) - tokens); return true; },
    listKeys: () => keys().map(k => Object.assign({}, k, { usedTokens: usedOf(k) })),
    addKey: (k) => { keys().push(k); save(); syncGlobal(); return k; },
    updateKey: (key, patch) => { const k = keys().find(x => x && x.key === key); if (!k) return false; Object.assign(k, patch); save(); syncGlobal(); return true; },
    deleteKey: (key) => { const i = keys().findIndex(x => x && x.key === key); if (i < 0) return false; const k = keys()[i]; keys().splice(i, 1); save(); ctx.gateway.unregisterGlobalKey(k.key); return true; },
    deleteKeysOf: (uid) => { const list = keys().filter(x => x && x.uid === uid); for (const k of list) { const i = keys().indexOf(k); if (i >= 0) keys().splice(i, 1); ctx.gateway.unregisterGlobalKey(k.key); } if (list.length) save(); return list.length; },
    creditsJSON, genKey,
  });

  /* 6) the GET /credits top-level route (user-side balance check) */
  ctx.registerTopRoute('GET', '/credits', ({ res, auth }) => {
    const r = auth();
    if (!r.ok) return jsonRes(res, r.status || 401, { error: r.error || 'invalid key' });
    if (r.userKey) return jsonRes(res, 200, creditsJSON(r.userKey));
    return jsonRes(res, 200, { admin: true, unlimited: true });
  });

  /* 7) admin endpoints /plugins/auth-cardkey/admin/* */
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
      /* -1 = unlimited quota (must not be eaten by Math.max(0,..), or unlimited cards cannot be issued) */
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
    if (j.quotaTokens !== undefined) k.quotaTokens = Math.max(-1, Number(j.quotaTokens) || 0); /* -1 = zero quota */
    /* top-up / deduct: **positive adds, negative deducts** (users asked for manual balance deduction).
     *  unlimited (-1) stays untouched (top-up/deduct are meaningless, and it must not degrade to a finite quota);
     *  deductions floor at 0 (0 meaning "zero quota, unusable"). */
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

  /* 8) the checkable option list (for the key card "access permissions" multi-select panel)
   *    returns: all groups / all models (with group + owning instance) / all instances
   *    scope: when a key card is passed, clip to that card's parent's limits (used when users edit their sub-cards).
   *           pass null = no trimming (admin side). */
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

  /* User side: checkable list when editing one's own child card (trimmed by the parent whitelist) */
  ctx.registerTopRoute('GET', '/auth/access-options', ({ res, auth }) => {
    const r = auth();
    if (!r.ok) return jsonRes(res, r.status || 401, { error: r.error || 'invalid key' });
    jsonRes(res, 200, optionsJSON(r.userKey || null));
  });

  /* ===== (9) the admin "edit key card" SDUI page (2026-09-17) =====
   * contributed by registerAdminUi (menu:false sub-page). Opened from the App admin's card-key card "edit" button:
   *   /admin/ui/key-edit?key=<key card>
   * Contents: card info + a basic-info form (name/quota/expiry/note) + access permissions (mode chips + multi-select group/model grid).
   *
   * ★Stateless design (crucial): at render time **the full post-tap whitelist is precomputed for every candidate**,
   *   into that chip's action.body ({{item.g}} / {{item.m}}). The App binds {{item.*}} at render time into
   *   a real JSON array (Template.bindJsonKeep supports List->JsonArray); a tap submits the complete result via adminApi.
   *   benefits: no temp state, no signed intents; after submit, then:'reload' refreshes the same URL in place
   *   (SduiController uses refreshInto), **so it never pushes -> nested opens are cured at the root**.
   *
   * ★The mode is "pure UI state" (second revision, 2026-09-17): it was first inferred from data (non-empty groups = group mode ...),
   *   so "by model" was **untappable** when models was empty (submitting [] -> no change -> back to unrestricted),
   *   admins could not even start choosing models. Now: mode chips use setState to toggle local visibility only (showGroup/showModel),
   *   the real permissions are decided by what the grid submits -- from any state you can reach any mode's candidate list.
   *   both grids' candidates are **precomputed**, and each submit clears the other dimension (the modes are mutually exclusive, never stacked). */
  /* ---- key-create sub-page: admin issues a card (user/quota/name) -- the cards tab entry of the App's "Users" page ---- */
  ctx.registerAdminUi({
    id: 'key-create', menu: false,
    render(gw, _cfg, q, caps) {
      const get = (k) => { try { return String((q && q.get) ? q.get(k) || '' : ''); } catch (_) { return ''; } };
      const txt = (text, style, color) => { const o = { type: 'text', text }; if (style) o.style = style; if (color) o.color = color; return o; };
      const act = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
        body: { plugin: 'auth-cardkey', path: '/admin/keys', method: 'POST', body } });
      /* user candidates (for uid autocomplete) -- fetched via capability, never hardcoded to auth-user */
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
      /* two candidate grids (each precomputes the full whitelist "after tapping it"; submitting clears the other dimension) */
      const gc = allGroups.map(g => {
        const on = groups.indexOf(g) >= 0;
        return { name: g, on: on, g: (on ? groups.filter(x => x !== g) : groups.concat([g])), m: [] };
      });
      const mc = allModels.map(m => {
        const on = models.indexOf(m) >= 0;
        return { name: m, on: on, g: [], m: (on ? models.filter(x => x !== m) : models.concat([m])) };
      });

      /* ---- Key card info ---- */
      kids.push(txt(k.name || '(未命名)', 'title3'));
      kids.push(txt('卡号 ' + key.slice(0, 8) + '\u2026' + key.slice(-4) + (k.enable === false ? ' \u00b7 已禁用' : ''), 'caption', '$onSurfaceVariant'));
      kids.push(txt('额度 ' + (quota === -1 ? '不限' : String(quota)) + ' \u00b7 已用 ' + used, 'caption', '$onSurfaceVariant'));
      kids.push(gap(10));

      /* ---- Basic info form (submits exactly these fields; whitelists untouched) ---- */
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

      /* ---- Access permissions ---- */
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

      /* group grid */
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

      /* model grid */
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

  /* *capability registration (2026-10-07 deep refactor): making "card management" a queryable capability,
   *  the core page no longer hard-codes the plugin name 'auth-cardkey' -- any plugin offering the same capability can take over.
   *  exposes only read-only listKeys + an action-surface declaration; writes still go through each plugin's own /admin/ endpoints (via declarative plugin-call). */
  ctx.provideCapability('cardkey-admin', {
    listKeys: () => { try { return keys().map(k => ({ key: k.key, name: k.name, note: k.note, enable: k.enable !== false, quotaTokens: k.quotaTokens, usedTokens: usedOf(k) })); } catch (_) { return []; } },
    /** action path declaration (the kernel assembles adminApi from it, never hardcoding plugin ids) */
    adminApi: () => ({ pluginId: ctx.id, list: '/admin/keys', update: '/admin/keys-update' }),
    /* *api (2026-10-07): serializable endpoint descriptions -> shipped via kernel bootstrap -> **the App looks endpoints up by capability name**.
     *  the App used to hardcode /plugins/auth-cardkey/admin/keys in Api.kt; a different plugin implementation would break it.
     *  *paths are **plugin-relative** (the kernel/App prepend /plugins/<pluginId>), so plugin renames do not affect them. */
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
