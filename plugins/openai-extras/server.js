'use strict';





const { joinUrl, upstreamRequest, isConnErr, RETRYABLE } = require('../../src/router.js');

const ENDPOINTS = [
  '/v1/images/generations', '/v1/images/edits', '/v1/images/variations',
  '/v1/embeddings',
  '/v1/audio/speech', '/v1/audio/transcriptions', '/v1/audio/translations',
  '/v1/completions', '/v1/moderations',
];

function sendErr(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: { message: msg, type: 'error' } }));
}

module.exports.activate = (ctx) => {
  if (!ctx.config.enable) { ctx.log('扩展端点未启用'); return; }

  const handle = (pathname) => ({ cfg, res, body, contentType }) => {
    const stats = cfg._stats || { requests: 0, errors: 0, byChannel: {} };
    let model = '';
    let parsed = null;
    if (contentType && contentType.startsWith('application/json')) {
      try { parsed = JSON.parse(body.toString('utf8')); model = (parsed && parsed.model) || ''; } catch (_) {}
    }
    const candidates = ctx.pickChannels(model || undefined).filter(c => c.ch.type === 'openai');
    if (!candidates.length) {
      stats.errors++;
      return sendErr(res, 503, 'no openai channel for extended endpoint ' + pathname + ' (扩展端点只支持 openai 类型渠道)');
    }
    stats.requests++;
    let attempt = 0, lastErr = '';
    const tryNext = () => {
      if (attempt >= candidates.length) { stats.errors++; return sendErr(res, 502, lastErr || ('all ' + candidates.length + ' channels failed')); }
      const pick = candidates[attempt];
      const ch = pick.ch;
      attempt++;
      const headers = { authorization: 'Bearer ' + ch.apiKey };
      if (contentType) headers['Content-Type'] = contentType;
      for (const [hk, hv] of Object.entries(headers)) {
        if (typeof hv === 'string' && !/^[\x09\x20-\x7e]*$/.test(hv)) {
          stats.errors++;
          return sendErr(res, 500, `渠道 "${ch.name}" 的请求头 ${hk} 含非 ASCII 字符, 请检查 apiKey`);
        }
      }
      let outBody = body;
      if (parsed && pick.upstreamModel && parsed.model !== undefined && parsed.model !== pick.upstreamModel) {
        parsed.model = pick.upstreamModel;
        outBody = Buffer.from(JSON.stringify(parsed));
      }
      stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
      stats.byChannel[ch.name].requests++;
      ctx.log('[extra]', pathname, 'model=' + (model || '-'), 'ch=' + ch.name);
      let connRetries = 0;
      const maxConnRetry = Math.max(0, Number(cfg.connRetry) || 0);
      const doSend = () => upstreamRequest(cfg, ch, joinUrl(ch.baseUrl, pathname), headers, outBody, (err, upRes) => {
        if (err) {
          lastErr = 'upstream request failed: ' + err.message;
          if (isConnErr(err) && connRetries < maxConnRetry) {
            connRetries++;
            return setTimeout(doSend, 400 * connRetries);
          }
          if (attempt < candidates.length) return tryNext();
          stats.errors++;
          return sendErr(res, 502, lastErr);
        }
        if (upRes.statusCode >= 400 && RETRYABLE.has(upRes.statusCode) && attempt < candidates.length) {
          const sc = upRes.statusCode;
          const chunks = [];
          upRes.on('data', c => chunks.push(c));
          upRes.on('end', () => { lastErr = '渠道 ' + ch.name + ' 返回 ' + sc + ': ' + Buffer.concat(chunks).toString('utf8').slice(0, 300); tryNext(); });
          upRes.on('error', () => tryNext());
          return;
        }
        
        res.writeHead(upRes.statusCode, {
          'Content-Type': upRes.headers['content-type'] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        });
        upRes.pipe(res);
      }, body.length ? 'POST' : 'POST');
      doSend();
    };
    tryNext();
  };

  for (const ep of ENDPOINTS) ctx.registerExtraEndpoint('POST', ep, handle(ep));
  ctx.log('扩展端点已启用:', ENDPOINTS.length, '个');
};
