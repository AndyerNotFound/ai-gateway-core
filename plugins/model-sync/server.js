'use strict';
                                  
                                                 
                                    
      
                                                           
                                                                                
   
const { joinUrl, upstreamRequest } = require('../../src/router.js');

function jsonRes(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); }

module.exports.activate = (ctx) => {
  const cfg = ctx.config;
  let lastRun = ctx.data.get('lastRun') || null;

                 
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

                                                        
  const syncAll = async (only) => {
    const results = {};
    let changed = false;
    for (const pick of ctx.pickChannels()) {
      const ch = pick.ch;
      if (!ch) continue;
      if (only && ch.name !== only) continue;
      if (results[ch.name] !== undefined) continue;
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
        for (const pick of ctx.pickChannels()) {
          const ch = pick.ch;
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

                                                
  ctx.registerRoute('GET', '/models', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const channels = ctx.pickChannels().map(x => ({
      name: x.ch.name,
      type: x.ch.type,
      baseUrl: x.ch.baseUrl || '',
      models: Array.isArray(x.ch.models) ? x.ch.models : [],
      modelMap: x.ch.modelMap || {},
      default: !!x.ch.default,
    }));
    jsonRes(res, 200, { ok: true, channels, lastRun });
  });

  ctx.registerRoute('POST', '/run', async (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const only = p.body && p.body.channel ? String(p.body.channel) : null;
    try { jsonRes(res, 200, { ok: true, channel: only, results: await syncAll(only) }); }
    catch (e) { jsonRes(res, 500, { error: e.message }); }
  });

  ctx.log('模型同步已激活:', cfg.enable ? ('间隔 ' + (cfg.intervalHours || 24) + 'h') : '关(仅手动)');
};
