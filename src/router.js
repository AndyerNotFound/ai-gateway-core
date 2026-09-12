'use strict';
                                               
                                                                                               
                                                             
                                                                
   
const http = require('http');
const https = require('https');
const { log, logErr, safeParse, randId } = require('./util');
const { getAgents, makeFreshAgents, isConnErr } = require('./proxy');
const C = require('./canonical');
const {
  responsesToCanonical, responsesRespToCanonical, canonicalToResponsesBody, canonicalToResponsesResp,
  openaiToCanonical, claudeToCanonical, geminiToCanonical,
  canonicalToOpenAIBody, canonicalToClaudeBody, canonicalToGeminiBody,
  openaiRespToCanonical, claudeRespToCanonical, geminiRespToCanonical,
  canonicalToOpenAIResp, canonicalToClaudeResp, canonicalToGeminiResp,
  makeWriter, makeResponsesWriter, SSEDecoder, UpstreamStreamParser, ResponsesStreamParser,
} = C;

const CORE_VERSION = require('../package.json').version;
const TO_CANON = { openai: openaiToCanonical, claude: claudeToCanonical, gemini: geminiToCanonical };
const UP_RESP = { openai: openaiRespToCanonical, claude: claudeRespToCanonical, gemini: geminiRespToCanonical };
const BUILD_BODY = { openai: canonicalToOpenAIBody, claude: canonicalToClaudeBody, gemini: canonicalToGeminiBody };
                                       
const RETRYABLE = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504, 529]);

                                               
                                                                     
                                                        
                                                                             
                                                                         
                                                              
                                                                               
                                                
                                                
                                              
                                                   
                                                        
   
const NO_HOOKS = {
  onRequestBody: (body) => body,
  onChatAuth: () => null,
  needConvert: () => false,
  wrapWriter: (w) => w,
  sanitizeText: (s) => s,
};
function normHooks(h) { return h ? Object.assign({}, NO_HOOKS, h) : NO_HOOKS; }

                                                                              
function chUsesResponses(cfg, ch) {
  if (ch.type !== 'openai') return false;
  return ch.useResponses !== undefined ? !!ch.useResponses : !!cfg.upstreamResponses;
}

function pickChannels(cfg, model) {
  const chs = cfg.channels || [];
  const candidates = [];
  if (model) {
                       
    for (const ch of chs) {
      if (ch.modelMap && Object.prototype.hasOwnProperty.call(ch.modelMap, model)) {
        candidates.push({ ch, upstreamModel: String(ch.modelMap[model]) });
      }
    }
                                             
    if (!candidates.length) {
      for (const ch of chs) {
        if (ch.models && ch.models.includes(model)) candidates.push({ ch, upstreamModel: model });
      }
    }
  }
                                             
  if (!candidates.length) {
    const defs = chs.filter(c => c.default);
    const pool = defs.length ? defs : chs;
    for (const ch of pool) candidates.push({ ch, upstreamModel: model || '' });
  }
  if (!candidates.length) return [];
                                          
  if (!cfg._rr) cfg._rr = {};
  const key = model || '__nomodel__';
  cfg._rr[key] = ((cfg._rr[key] || 0) + 1) % candidates.length;
  const rot = cfg._rr[key];
  return candidates.slice(rot).concat(candidates.slice(0, rot));
}

                
function pickChannel(cfg, model) {
  const cs = pickChannels(cfg, model);
  return cs.length ? cs[0] : null;
}

function joinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  if (suffix.startsWith('/v1beta/') && /\/v1beta$/.test(b)) return b + suffix.slice(7);
  if (suffix.startsWith('/v1/') && /\/v1$/.test(b)) return b + suffix.slice(3);
  return b + suffix;
}

function upstreamRequest(cfg, ch, urlStr, headers, bodyBuf, cb, method, agentsOverride) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const agents = agentsOverride || getAgents(cfg, ch);
  const mod = isHttps ? https : http;
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    method: method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': bodyBuf ? bodyBuf.length : 0,
      'User-Agent': 'ai-gateway-core/' + CORE_VERSION,
      ...headers,
    },
    agent: isHttps ? agents.https : agents.http,
  };
  let settled = false;
  const req = mod.request(opts, (upRes) => { if (!settled) { settled = true; cb(null, upRes, req); } });
  req.setTimeout(cfg.responseTimeout, () => req.destroy(new Error('upstream idle timeout (' + Math.round(cfg.responseTimeout / 1000) + 's)')));
  req.once('error', (e) => { if (!settled) { settled = true; cb(e, null, req); } });
  if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
  req.end();
  return req;
}

                                                   
                                                                                         
                                                              

function buildRequestForChannel(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req, opts = {}) {
                                                                    
                                                                 
  const upApi = chUsesResponses(cfg, ch) ? 'responses' : 'chat';
  const direct = clientFormat === ch.type && clientApi === upApi && !opts.forceConvert;
  const stream = canonical.stream;
  const upstreamModel = canonical.model;                     
  let url, headers = {}, bodyBuf;
  if (direct) {
    if (ch.type === 'openai') {
      url = joinUrl(ch.baseUrl, upApi === 'responses' ? '/v1/responses' : '/v1/chat/completions');
      body.model = upstreamModel;
      headers.authorization = 'Bearer ' + ch.apiKey;
    } else if (ch.type === 'claude') {
      url = joinUrl(ch.baseUrl, '/v1/messages');
      body.model = upstreamModel;
      headers['x-api-key'] = ch.apiKey;
      headers['anthropic-version'] = ch.anthropicVersion || req.headers['anthropic-version'] || '2023-06-01';
    } else {
      const action = stream ? 'streamGenerateContent' : 'generateContent';
      url = joinUrl(ch.baseUrl, '/v1beta/models/' + encodeURIComponent(upstreamModel) + ':' + action) + (stream && urlInfo.altSse ? '?alt=sse' : '');
      headers['x-goog-api-key'] = ch.apiKey;
    }
    bodyBuf = Buffer.from(JSON.stringify(body));
  } else {
    const uc = { ...canonical, model: upstreamModel };
    if (ch.type === 'openai') {
      url = joinUrl(ch.baseUrl, upApi === 'responses' ? '/v1/responses' : '/v1/chat/completions');
      bodyBuf = Buffer.from(JSON.stringify(upApi === 'responses' ? canonicalToResponsesBody(uc) : BUILD_BODY.openai(uc, { addUsage: ch.addUsage })));
      headers.authorization = 'Bearer ' + ch.apiKey;
    } else if (ch.type === 'claude') {
      url = joinUrl(ch.baseUrl, '/v1/messages');
      bodyBuf = Buffer.from(JSON.stringify(BUILD_BODY.claude(uc)));
      headers['x-api-key'] = ch.apiKey;
      headers['anthropic-version'] = ch.anthropicVersion || '2023-06-01';
    } else {
      const action = stream ? 'streamGenerateContent' : 'generateContent';
      url = joinUrl(ch.baseUrl, '/v1beta/models/' + encodeURIComponent(upstreamModel) + ':' + action) + (stream ? '?alt=sse' : '');
      bodyBuf = Buffer.from(JSON.stringify(BUILD_BODY.gemini(uc)));
      headers['x-goog-api-key'] = ch.apiKey;
    }
  }
  if (stream) headers.accept = 'text/event-stream';
  return { url, headers, bodyBuf, direct, stream, upApi };
}


                                                     
function handleUpstreamResponse(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req, res, upRes, built, ctx, retryHook, hooks) {
  const { direct, stream, upApi } = built;
  const { usageCapture, stats } = ctx;
  const isResponsesUp = ch.type === 'openai' && upApi === 'responses';

  if (direct) {
    const ct = upRes.headers['content-type'] || (stream ? 'text/event-stream' : 'application/json');
    try {
      res.writeHead(upRes.statusCode, { 'Content-Type': ct, 'X-AI-Gateway-Channel': ch.name, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    } catch (_) { return; }
    if (stream) {
      const parser = isResponsesUp ? new ResponsesStreamParser(() => {}) : new UpstreamStreamParser(ch.type, () => {});
      const dec = new SSEDecoder((data) => { try { if (data !== '[DONE]') parser.handle(JSON.parse(data)); } catch (_) {} });
      upRes.on('data', c => { try { dec.push(c.toString('utf8')); } catch (_) {} });
      upRes.on('end', () => { dec.end(); parser.finish(); usageCapture.input = parser.usage ? parser.usage.input : 0; usageCapture.output = parser.usage ? parser.usage.output : 0; ctx.logDone(upRes.statusCode); });
      upRes.on('error', () => { try { res.end(); } catch (_) {} });
    } else {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const j = safeParse(Buffer.concat(chunks).toString('utf8'));
        if (j) { const cr = isResponsesUp ? responsesRespToCanonical(j) : UP_RESP[ch.type](j); usageCapture.input = cr.usage.input; usageCapture.output = cr.usage.output; }
        ctx.logDone(upRes.statusCode);
      });
      upRes.on('error', () => { try { res.end(); } catch (_) {} });
    }
    if (hooks.onResponseLine) {
                                             
      let buf = '';
      upRes.on('data', c => {
        try {
          buf += c.toString('utf8');
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) res.write(hooks.onResponseLine(line, ctx) + '\n');
        } catch (_) {}
      });
      upRes.on('end', () => { try { if (buf) res.write(hooks.onResponseLine(buf, ctx)); res.end(); } catch (_) {} });
      upRes.on('error', () => { try { res.end(); } catch (_) {} });
    } else {
      upRes.pipe(res);
    }
    return;
  }

          
  if (stream) {
    const isArrayStream = clientFormat === 'gemini' && !urlInfo.altSse;
    try {
      res.writeHead(200, {
        'Content-Type': isArrayStream ? 'application/json' : 'text/event-stream',
        'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
        'X-AI-Gateway-Channel': ch.name, 'Access-Control-Allow-Origin': '*',
      });
    } catch (_) { return; }
    let writer = (clientFormat === 'openai' && clientApi === 'responses') ? makeResponsesWriter(res, canonical.model) : makeWriter(clientFormat, res, canonical.model, { geminiArray: isArrayStream });
    writer = hooks.wrapWriter(writer, { format: clientFormat, clientApi, ch, cfg, model: canonical.model, urlInfo });
    const onEv = (ev) => {
      try {
        if (hooks.onResponseEvent && hooks.onResponseEvent(ev, ctx) === false) return;
        writer.onEvent(ev);
      } catch (e) { logErr('writer error:', e.message); }
    };
    const parser = isResponsesUp ? new ResponsesStreamParser(onEv) : new UpstreamStreamParser(ch.type, onEv);
    const dec = new SSEDecoder((data) => {
      if (data === '[DONE]') { parser.finish(); return; }
      try { parser.handle(JSON.parse(data)); } catch (e) { logErr('bad SSE data (first 200 chars):', String(data).slice(0, 200)); }
    });
    upRes.on('data', c => { try { dec.push(c.toString('utf8')); } catch (_) {} });
    upRes.on('end', () => {
      dec.end(); parser.finish();
      usageCapture.input = parser.usage ? parser.usage.input : 0;
      usageCapture.output = parser.usage ? parser.usage.output : 0;
      ctx.logDone(200);
    });
    upRes.on('error', (e) => { logErr('upstream stream error:', e.message); try { res.end(); } catch (_) {} });
  } else {
    const chunks = [];
    upRes.on('data', c => chunks.push(c));
    upRes.on('end', async () => {
      const txt = Buffer.concat(chunks).toString('utf8');
      const j = safeParse(txt);
      if (!j) {
                                                                      
        const why = 'upstream returned non-JSON: ' + hooks.sanitizeText(txt.slice(0, 200), ctx);
        if (retryHook && retryHook(why)) return;
        stats.errors++;
        return sendError(clientFormat, res, 502, why);
      }
      const cresp = isResponsesUp ? responsesRespToCanonical(j) : UP_RESP[ch.type](j);
      usageCapture.input = cresp.usage.input;
      usageCapture.output = cresp.usage.output;
      if (hooks.processCanonicalResp) {
        try { await hooks.processCanonicalResp(cresp, { ch, cfg, canonical, urlInfo }); } catch (e) { logErr('[hooks] processCanonicalResp:', e.message); }
      }
      let out;
      if (clientFormat === 'openai') out = clientApi === 'responses' ? canonicalToResponsesResp(cresp, canonical.model) : canonicalToOpenAIResp(cresp, canonical.model);
      else if (clientFormat === 'claude') out = canonicalToClaudeResp(cresp, canonical.model);
      else out = canonicalToGeminiResp(cresp, canonical.model);
      if (hooks.onResponseBody) { try { hooks.onResponseBody(out, ctx); } catch (e) { logErr('[hooks] onResponseBody:', e.message); } }
      try {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-AI-Gateway-Channel': ch.name, 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(out));
      } catch (_) {}
      ctx.logDone(200);
    });
    upRes.on('error', () => { try { res.end(); } catch (_) {} });
  }
}

                                                                 
                                                                          
                                                                                         
                                                   
function handleChat(cfg, clientFormat, clientApi, req, res, urlInfo, bodyStr, hooks, sendError) {
  hooks = normHooks(hooks);
  const stats = cfg._stats;
  let body;
  try { body = JSON.parse(bodyStr || '{}'); } catch (e) { return sendError(clientFormat, res, 400, 'invalid JSON body: ' + e.message); }
  if (!body || typeof body !== 'object') return sendError(clientFormat, res, 400, 'request body must be a JSON object');

                                        
  try { body = hooks.onRequestBody(body, { cfg, urlInfo, clientFormat, clientApi }) || body; }
  catch (e) { logErr('[hooks] onRequestBody:', e.message); }

  const canonical = (clientApi === 'responses') ? responsesToCanonical(body, urlInfo.model) : TO_CANON[clientFormat](body, urlInfo.model);
  if (urlInfo.stream) canonical.stream = true;                         
  if (!canonical.model) return sendError(clientFormat, res, 400, 'missing "model"');

                              
  const deny = hooks.onChatAuth({ userKey: urlInfo.userKey, model: canonical.model, instance: cfg._name, uid: cfg._uid, cfg });
  if (deny) return sendError(clientFormat, res, deny.status || 403, deny.message || 'forbidden');

  const candidates = pickChannels(cfg, canonical.model);
  if (!candidates.length) return sendError(clientFormat, res, 503, 'no channel configured for model: ' + canonical.model);

  stats.requests++;
  const reqId = randId('req');
  const stream = canonical.stream;
  const t0 = Date.now();
  const usageCapture = { input: 0, output: 0 };
  const recordReq = (status, chName, inT, outT) => {
    stats.recent.push({ id: reqId, time: new Date().toISOString().slice(0, 19).replace('T', ' '), model: canonical.model, channel: chName || '', status, duration: Date.now() - t0, inputTokens: inT || 0, outputTokens: outT || 0, keyName: urlInfo.userKey ? (urlInfo.userKey.name || (urlInfo.userKey.key || '').slice(0, 12)) : undefined });
    if (stats.recent.length > 200) stats.recent.shift();
    if (hooks.onChatDone) {
      try { hooks.onChatDone({ id: reqId, time: new Date().toISOString(), instance: cfg._name, uid: cfg._uid, format: clientFormat, model: canonical.model, channel: chName || '', status, duration: Date.now() - t0, inputTokens: inT || 0, outputTokens: outT || 0, userKey: urlInfo.userKey }, { cfg }); } catch (e) { logErr('[hooks] onChatDone:', e.message); }
    }
  };

  let attempt = 0;
  let lastErrStatus = 0;
  let lastErrMsg = '';

                                                             
  const tryNext = () => {
    if (attempt >= candidates.length) {
      stats.errors++;
      recordReq(lastErrStatus || 502, '', 0, 0);
      const msg = lastErrMsg || ('all ' + candidates.length + ' channels failed');
      return sendError(clientFormat, res, lastErrStatus || 502, msg);
    }
    const pick = candidates[attempt];
    const ch = pick.ch;
    const myCanonical = { ...canonical, model: pick.upstreamModel || canonical.model };
    const forceConvert = !!hooks.needConvert(cfg, ch);
    const built = buildRequestForChannel(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req, { forceConvert });
    attempt++;

                                                     
    for (const [hk, hv] of Object.entries(built.headers)) {
      if (typeof hv === 'string' && !/^[\x09\x20-\x7e]*$/.test(hv)) {
        return sendError(clientFormat, res, 500, `渠道 "${ch.name}" 的请求头 ${hk} 含非 ASCII 字符(可能是 apiKey 里残留了中文占位符), 请检查配置`);
      }
    }

    const ctx = {
      t0, usageCapture, stats,
      logMeta: [clientFormat + '>' + ch.type, 'model=' + canonical.model, 'ch=' + ch.name, 'proxy=' + (ch.proxy || '-'), stream ? 'stream' : 'block'].join(' '),
      logDone(status) {
        log(ctx.logMeta, 'status=' + status, 'in=' + usageCapture.input, 'out=' + usageCapture.output, 'ms=' + (Date.now() - t0));
        stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
        stats.byChannel[ch.name].inputTokens += usageCapture.input;
        stats.byChannel[ch.name].outputTokens += usageCapture.output;
        if (hooks.onUsage) { try { hooks.onUsage({ input: usageCapture.input, output: usageCapture.output }, { cfg, ch, urlInfo, stats }); } catch (e) { logErr('[hooks] onUsage:', e.message); } }
        recordReq(status, ch.name, usageCapture.input, usageCapture.output);
      },
    };
    stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
    stats.byChannel[ch.name].requests++;

                                                        
    const delayMs = Math.min(120000, Number(ch.delayMs) || 0);
                                                        
    let connRetries = 0;
    const maxConnRetry = Math.max(0, Number(cfg.connRetry) || 0);
    const retrySameOrNext = (why) => {
      if (connRetries < maxConnRetry) {
        connRetries++;
        log('RETRY', ctx.logMeta, why, '→ 同渠道重试 (' + connRetries + '/' + maxConnRetry + ')');
        setTimeout(() => doSend(true), 400 * connRetries);
        return true;
      }
      if (attempt < candidates.length) {
        log('ERR', ctx.logMeta, why, '→ 切换渠道');
        tryNext();
        return true;
      }
      return false;
    };
    const doSend = (fresh) => upstreamRequest(cfg, ch, built.url, built.headers, built.bodyBuf, (err, upRes) => {
      if (err) {
        lastErrStatus = 502; lastErrMsg = 'upstream request failed: ' + err.message;
        if (isConnErr(err)) {
          if (retrySameOrNext(err.message)) return;
        } else {
          log('ERR', ctx.logMeta, err.message, attempt < candidates.length ? '→ 切换渠道' : '→ 无更多渠道');
          if (attempt < candidates.length) return tryNext();
        }
        stats.errors++;
        recordReq(502, ch.name, 0, 0);
        return sendError(clientFormat, res, 502, lastErrMsg);
      }

                                                             
      const upCt = String(upRes.headers['content-type'] || '');
      if (upRes.statusCode < 400 && /text\/html/i.test(upCt)) {
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          lastErrStatus = 502;
          lastErrMsg = '渠道 ' + ch.name + ' 返回了 HTML 网页而非数据(content-type: ' + upCt + '): ' + hooks.sanitizeText(Buffer.concat(chunks).toString('utf8'), ctx).slice(0, 200);
          if (retrySameOrNext('upstream returned HTML (content-type: ' + upCt + ')')) return;
          stats.errors++;
          recordReq(502, ch.name, 0, 0);
          return sendError(clientFormat, res, 502, lastErrMsg);
        });
        upRes.on('error', () => {
          if (retrySameOrNext('read HTML response failed')) return;
          stats.errors++;
          recordReq(502, ch.name, 0, 0);
          try { sendError(clientFormat, res, 502, lastErrMsg || 'upstream HTML response read failed'); } catch (_) {}
        });
        return;
      }

      if (upRes.statusCode >= 400 && RETRYABLE.has(upRes.statusCode) && attempt < candidates.length) {
        const sc = upRes.statusCode;
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          lastErrStatus = sc;
          lastErrMsg = `渠道 ${ch.name} 返回 ${sc}: ` + hooks.sanitizeText(Buffer.concat(chunks).toString('utf8'), ctx).slice(0, 300);
          log('RETRY', ctx.logMeta, 'status=' + sc, '→ 切换渠道 (' + (candidates.length - attempt) + ' 个剩余)');
          tryNext();
        });
        upRes.on('error', () => { tryNext(); });
        return;
      }

      if (upRes.statusCode >= 400) {
                                         
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          stats.errors++;
          recordReq(upRes.statusCode, ch.name, 0, 0);
          log('UPERR', ctx.logMeta, 'status=' + upRes.statusCode, attempt > 1 ? '(已尝试 ' + attempt + ' 个渠道)' : '');
          try {
            res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || 'application/json', 'X-AI-Gateway-Channel': ch.name, 'Access-Control-Allow-Origin': '*' });
            res.end(Buffer.concat(chunks));
          } catch (_) {}
        });
        upRes.on('error', () => { try { res.end(); } catch (_) {} });
        return;
      }

                                                          
      handleUpstreamResponse(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req, res, upRes, built, ctx, (why) => {
        lastErrStatus = 502; lastErrMsg = why;
        return retrySameOrNext(why);
      }, hooks);
    }, undefined, fresh ? makeFreshAgents(cfg, ch) : undefined);
    if (delayMs > 0) {
      ch._gate = (ch._gate || Promise.resolve()).catch(() => {}).then(() => new Promise(r => setTimeout(r, delayMs)));
      ch._gate.then(() => { try { doSend(); } catch (e) { try { sendError(clientFormat, res, 500, 'upstream dispatch failed: ' + e.message); } catch (_) {} } });
    } else {
      doSend();
    }
  };
  tryNext();
}

module.exports = {
  RETRYABLE, NO_HOOKS, normHooks, chUsesResponses, isConnErr,
  pickChannels, pickChannel, joinUrl, upstreamRequest, buildRequestForChannel,
  handleUpstreamResponse, handleChat,
};
