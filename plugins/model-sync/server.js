'use strict';
/** the model-sync plugin v1.1.1 - automatic model list sync
   * periodically pull upstream /models, merge into the channel's models list (add-only), update the instance config and hot-reload
   * config: { enable, intervalHours: 24 }
   * endpoints:
 *   GET  /plugins/model-sync/models        each channel's current models + last sync result (admin)
 *   POST /plugins/model-sync/run           sync now; body { channel?: 'name' } syncs only that channel (admin)
 *   ★GET /admin/models  POST /admin/run  aliases of the same implementation (2026-09-19)
 *     Why: the SDUI admin page's adminApi can only hit the core's /admin/*; plugin endpoints must go through
 *     /admin/api/plugin-call proxy calls, and that proxy **only forwards the plugin's /admin/ sub-paths** -- so
 *     for the "model groups" SDUI page's "sync now" button to work, an /admin/ path is required.
 *     /admin/run adds an 8-second soft timeout: on expiry it returns pending (the sync keeps running in the background),
 *     avoiding the 502 that plugin-call's 10-second self-request timeout would cause.
 */
const { joinUrl, upstreamRequest } = require('../../src/router.js');

function jsonRes(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); }

module.exports.activate = (ctx) => {
  const cfg = ctx.config;
  let lastRun = ctx.data.get('lastRun') || null;

  /* fetch a channel's upstream model list */
  const fetchModels = (ch) => new Promise((resolve, reject) => {
    const base = String(ch.baseUrl || '').replace(/\/+$/, '');
    if (!base) return reject(new Error('渠道未配置 Base URL'));
    let url; const headers = {};
    if (ch.type === 'openai') { url = joinUrl(base, '/v1/models'); if (ch.apiKey) headers.authorization = 'Bearer ' + ch.apiKey; }
    else if (ch.type === 'claude') { url = joinUrl(base, '/v1/models'); if (ch.apiKey) { headers['x-api-key'] = ch.apiKey; headers['anthropic-version'] = ch.anthropicVersion || '2023-06-01'; } }
    else if (ch.type === 'gemini') { url = joinUrl(base, '/v1beta/models'); if (ch.apiKey) headers['x-goog-api-key'] = ch.apiKey; }
    else return reject(new Error('未知渠道类型: ' + ch.type));
    if (ch.apiKey && !/^[\x09\x20-\x7e]*$/.test(ch.apiKey)) return reject(new Error('apiKey 含非 ASCII 字符'));
    upstreamRequest({ responseTimeout: 20000, proxies: {} }, ch, url, headers, Buffer.alloc(0), (err, upRes) => {
      if (err) return reject(new Error('连接上游失败: ' + err.message));
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (upRes.statusCode >= 400) return reject(new Error('上游返回 ' + upRes.statusCode));
        let ids = [];
        try {
          const j = JSON.parse(txt);
          if (Array.isArray(j.data)) ids = j.data.map(x => x && (x.id || x.name)).filter(Boolean);
          else if (Array.isArray(j.models)) ids = j.models.map(x => String(x.name || x.id || '').replace(/^models\//, '')).filter(Boolean);
          else if (Array.isArray(j)) ids = j.map(x => typeof x === 'string' ? x : (x && (x.id || x.name))).filter(Boolean);
          else throw new Error('无法识别的返回格式');
        } catch (e) { return reject(new Error('解析模型列表失败: ' + e.message)); }
        resolve([...new Set(ids.map(String))]);
      });
      upRes.on('error', e => reject(new Error('读取响应失败: ' + e.message)));
    }, 'GET');
  });

  /* sync one round: when only is a channel name, sync just that channel; merge models (add-only) -> persist + hot reload */
  const syncAll = async (only) => {
    const results = {};
    let changed = false;
    const allCh = (ctx.gateway && ctx.gateway.instanceChannels) ? ctx.gateway.instanceChannels() : [];
    const seen = new Set();
    for (const ch of allCh) {
      if (!ch) continue;
      if (only && ch.name !== only) continue;
      if (seen.has(ch.name)) continue;
      seen.add(ch.name);
      try {
        const ids = await fetchModels(ch);
        const cur = Array.isArray(ch.models) ? ch.models : [];
        const add = ids.filter(m => !cur.includes(m));
        if (add.length) { ch.models = cur.concat(add); changed = true; }
        results[ch.name] = { ok: true, total: ids.length, added: add.length };
      } catch (e) {
        results[ch.name] = { ok: false, error: e.message };
      }
    }
    if (changed) {
      ctx.gateway.saveInstanceConfig((c) => {
        for (const ch of allCh) {
          const target = (c.channels || []).find(x => x.name === ch.name);
          if (target && Array.isArray(ch.models)) target.models = ch.models.slice();
        }
      });
    }
    lastRun = { at: new Date().toISOString(), only: only || null, results };
    ctx.data.set('lastRun', lastRun);
    return results;
  };

  if (cfg.enable) {
    const iv = Math.max(1, Number(cfg.intervalHours) || 24) * 3600000;
    ctx.cron('model-sync', iv, () => { syncAll().catch(e => ctx.log('[model-sync]', e.message)); });
  }

  /* query: each channel's current models + group + last sync result (the App uses it for the model overview) */
  const hGetModels = (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const list = (ctx.gateway && ctx.gateway.instanceChannels) ? ctx.gateway.instanceChannels() : ctx.pickChannels().map(x => x.ch);
    const channels = list.map(ch => ({
      name: ch.name,
      type: ch.type,
      baseUrl: ch.baseUrl || '',
      models: Array.isArray(ch.models) ? ch.models : [],
      modelMap: ch.modelMap || {},
      default: !!ch.default,
    }));
    jsonRes(res, 200, { ok: true, channels, lastRun });
  };
  ctx.registerRoute('GET', '/models', hGetModels);
  ctx.registerRoute('GET', '/admin/models', hGetModels);

  /** Sync result -> one human-readable sentence (for the admin toast) */
  const summarize = (only, results) => {
    const names = Object.keys(results || {});
    let okN = 0, addN = 0; const bad = [];
    for (const n of names) {
      const r = results[n] || {};
      if (r.ok) { okN++; addN += Number(r.added) || 0; } else bad.push(n + ': ' + (r.error || '失败'));
    }
    let msg = (only ? ('渠道「' + only + '」') : (okN + ' 个渠道')) + ' 同步完成，共新增 ' + addN + ' 个模型';
    if (bad.length) msg += '；失败 ' + bad.length + ' 个 → ' + bad.join(' | ');
    return msg.slice(0, 300);
  };

  const hRun = async (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const only = p.body && p.body.channel ? String(p.body.channel) : null;
    try {
      const job = syncAll(only);
      /* *8s soft timeout: single-channel sync usually takes 1-2s; a full sync may take longer -- on timeout let it keep running in the background,
       *   reply pending first -- otherwise the kernel plugin-call's 10s self-request timeout turns it into a 502 (the admin page just sees an error). */
      const pending = await Promise.race([job.then(r => ({ results: r })), new Promise(r => setTimeout(() => r(null), 8000))]);
      if (!pending) {
        job.catch(e => ctx.log('[model-sync]', '后台同步失败: ' + e.message));
        return jsonRes(res, 200, { ok: true, channel: only, pending: true, toast: '同步已在后台进行（超过 8 秒），稍后重进本页看新增模型' });
      }
      jsonRes(res, 200, { ok: true, channel: only, results: pending.results, toast: summarize(only, pending.results) });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
  };
  ctx.registerRoute('POST', '/run', hRun);
  ctx.registerRoute('POST', '/admin/run', hRun);

  ctx.log('模型同步已激活:', cfg.enable ? ('间隔 ' + (cfg.intervalHours || 24) + 'h') : '关(仅手动)');
};
