'use strict';





const http = require('http');
const https = require('https');
const { log, logErr, safeParse, randId, utf8, keyIdOf, keyNameOf } = require('./util');
const { getAgents, makeFreshAgents, isConnErr } = require('./proxy');
const C = require('./canonical');
const modelref = require('./modelref');   
const usageHist = require('./usage-history');  
const {
  responsesToCanonical, responsesRespToCanonical, canonicalToResponsesBody, canonicalToResponsesResp,
  openaiToCanonical, claudeToCanonical, geminiToCanonical,
  canonicalToOpenAIBody, canonicalToClaudeBody, canonicalToGeminiBody,
  openaiRespToCanonical, claudeRespToCanonical, geminiRespToCanonical,
  canonicalToOpenAIResp, canonicalToClaudeResp, canonicalToGeminiResp,
  makeWriter, makeResponsesWriter, SSEDecoder, UpstreamStreamParser, ResponsesStreamParser,
} = C;






function hdrName(s) {
  const t = String(s == null ? '' : s);
  let out = '';
  for (const ch of t) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && cp <= 0x7e) { out += ch; continue; }
    let b;
    if (cp < 0x800) b = [0xc0 | (cp >> 6), 0x80 | (cp & 63)];
    else if (cp < 0x10000) b = [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    else b = [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    for (const x of b) out += '%' + x.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

const CORE_VERSION = require('../package.json').version;
const TO_CANON = { openai: openaiToCanonical, claude: claudeToCanonical, gemini: geminiToCanonical };
const UP_RESP = { openai: openaiRespToCanonical, claude: claudeRespToCanonical, gemini: geminiRespToCanonical };
const BUILD_BODY = { openai: canonicalToOpenAIBody, claude: canonicalToClaudeBody, gemini: canonicalToGeminiBody };

const RETRYABLE = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504, 529]);
















const NO_HOOKS = {
  onRequestBody: (body) => body,
  onChatAuth: () => null,
  onQuotaEstimate: () => null,
  needConvert: () => false,
  wrapWriter: (w) => w,
  sanitizeText: (s) => s,
};
function normHooks(h) { return h ? Object.assign({}, NO_HOOKS, h) : NO_HOOKS; }




function putUsage(cap, u) {
  cap.input = (u && u.input) || 0;
  cap.output = (u && u.output) || 0;
  cap.cacheRead = (u && u.cacheRead) || 0;
  cap.cacheWrite = (u && u.cacheWrite) || 0;
}


function chUsesResponses(cfg, ch) {
  if (ch.type !== 'openai') return false;
  return ch.useResponses !== undefined ? !!ch.useResponses : !!cfg.upstreamResponses;
}

function pickChannels(cfg, model, preferChannel) {
  const chs = cfg.channels || [];
  


  let pool = chs;
  if (preferChannel) {
    pool = chs.filter(ch => ch && ch.name && modelref.channelMatch(preferChannel, ch.name));
    if (!pool.length) return [];
  }
  const candidates = [];
  if (model) {
    
    for (const ch of pool) {
      if (ch.modelMap && Object.prototype.hasOwnProperty.call(ch.modelMap, model)) {
        candidates.push({ ch, upstreamModel: String(ch.modelMap[model]) });
      }
    }
    
    if (!candidates.length) {
      for (const ch of pool) {
        if (ch.models && ch.models.includes(model)) candidates.push({ ch, upstreamModel: model });
      }
    }
  }
  
  if (!candidates.length) {
    if (preferChannel) return [];
    const defs = chs.filter(c => c.default);
    const pool2 = defs.length ? defs : chs;
    for (const ch of pool2) candidates.push({ ch, upstreamModel: model || '' });
  }
  if (!candidates.length) return [];
  
  if (!cfg._rr) cfg._rr = {};
  const key = model || '__nomodel__';
  cfg._rr[key] = ((cfg._rr[key] || 0) + 1) % candidates.length;
  const rot = cfg._rr[key];
  return candidates.slice(rot).concat(candidates.slice(0, rot));
}


function pickChannel(cfg, model, preferChannel) {
  const cs = pickChannels(cfg, model, preferChannel);
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











function streamGuardOpt(cfg) {
  const sg = (cfg && cfg.streamGuard);
  if (sg === false || (sg && sg.enable === false)) return { enable: false, beatSec: 15 };
  return { enable: true, beatSec: Math.max(3, Number(sg && sg.beatSec) || 15) };
}


function writeTerminalSSE(res, clientFormat, clientApi) {
  if (clientFormat === 'openai') {
    if (clientApi === 'responses') {
      res.write('data: ' + JSON.stringify({ type: 'response.completed', response: { id: randId('resp_'), object: 'response', status: 'completed', output: [] } }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ id: randId('chatcmpl-'), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: '', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
    }
  } else if (clientFormat === 'claude') {
    res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }) + '\n\n');
    res.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
  } else {
    res.write('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }] }) + '\n\n');
  }
}

function makeStreamGuard(res, isSse, opt, ctx, chName, endFn) {
  if (!opt.enable || !isSse) return { touch() {}, stop() {}, abort() {}, finish() {} };
  let last = Date.now(), beats = 0, stopped = false;
  let sawData = false, atLineEnd = true;   
  const tm = setInterval(() => {                       
    if (stopped) return;
    const idle = Date.now() - last;
    if (idle < opt.beatSec * 1000) return;
    


    if (!atLineEnd) return;
    try { res.write(': keep-alive ' + Math.round(idle / 1000) + 's\n\n'); } catch (_) {}
    if (!beats) log('[stream] 上游静默 ' + Math.round(idle / 1000) + 's → 已向下游发心跳', ctx.logMeta, 'ch=' + chName);
    beats++; last = Date.now();
  }, 2000);
  if (tm.unref) tm.unref();
  const stop = () => { stopped = true; try { clearInterval(tm); } catch (_) {} };
  const fire = (why) => {
    

    if (!sawData) { log('[stream] ' + why + ' → 上游未产出任何数据，不补结束事件（保持失败语义）', ctx.logMeta, 'ch=' + chName); return; }
    log('[stream] ' + why + ' → 已向客户端补结束事件', ctx.logMeta, 'ch=' + chName);
    try { endFn(); } catch (e) { logErr('[stream] 补结束事件失败:', e.message); }
  };
  return {
    touch(c) {
      last = Date.now(); sawData = true;
      if (c != null) { const t = String(c); atLineEnd = t.endsWith('\n'); }
    },
    stop,
    abort(err) { stop(); fire('上游中断(' + ((err && err.message) || err || '未知') + ')'); },
    finish(hasMarker) { stop(); if (!hasMarker) fire('上游结束但没给结束标记'); },
  };
}


function handleUpstreamResponse(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req, res, upRes, built, ctx, retryHook, hooks) {
  const { direct, stream, upApi } = built;
  const { usageCapture, stats } = ctx;
  const isResponsesUp = ch.type === 'openai' && upApi === 'responses';

  if (direct) {
    const ct = upRes.headers['content-type'] || (stream ? 'text/event-stream' : 'application/json');
    try {
      res.writeHead(upRes.statusCode, { 'Content-Type': ct, 'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    } catch (e) {
      


      logErr('[resp] 响应头下发失败, 已中断该请求:', e.message);
      try {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"gateway: 响应头下发失败","type":"gateway_error"}}'); }
        else res.destroy();
      } catch (_) { try { res.destroy(); } catch (_) {} }
      try { upRes.resume(); } catch (_) {}
      return;
    }
    if (stream) {
      const parser = isResponsesUp ? new ResponsesStreamParser(() => {}) : new UpstreamStreamParser(ch.type, () => {});
      const dec = new SSEDecoder((data) => { try { if (data !== '[DONE]') parser.handle(JSON.parse(data)); } catch (_) {} });
      const u8 = utf8();   
      const g = makeStreamGuard(res, /text\/event-stream/i.test(String(ct)), streamGuardOpt(cfg), ctx, ch.name,
        () => writeTerminalSSE(res, clientFormat, clientApi));
      ctx._parser = parser; ctx._guard = g;   
      upRes.on('data', c => { try { const s2 = u8(c); g.touch(s2); dec.push(s2); } catch (_) {} });
      upRes.on('end', () => {
        dec.end(); parser.finish(); putUsage(usageCapture, parser.usage);
        g.finish(!!parser.finishReason);
        ctx.logDone(upRes.statusCode);
      });
      
      upRes.on('error', (e) => { g.abort(e); try { res.end(); } catch (_) {} if (ctx.abort) ctx.abort(e); });
      upRes.on('aborted', () => { if (ctx.abort) ctx.abort('aborted'); });
      upRes.on('close', () => { if (!upRes.complete && ctx.abort) ctx.abort('上游连接未完成即关闭'); });
    } else {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const j = safeParse(Buffer.concat(chunks).toString('utf8'));
        if (j) { const cr = isResponsesUp ? responsesRespToCanonical(j) : UP_RESP[ch.type](j); putUsage(usageCapture, cr.usage); }
        ctx.logDone(upRes.statusCode);
      });
      upRes.on('error', () => { try { res.end(); } catch (_) {} if (ctx.abort) ctx.abort('上游中断(非流式)'); });
      upRes.on('close', () => { if (!upRes.complete && ctx.abort) ctx.abort('上游连接未完成即关闭(非流式)'); });
    }
    if (hooks.onResponseLine) {
      
      let buf = '';
      const u8 = utf8();   
      upRes.on('data', c => {
        try {
          buf += u8(c);
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
        'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*',
      });
    } catch (e) {
      


      logErr('[resp] 响应头下发失败, 已中断该请求:', e.message);
      try {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"gateway: 响应头下发失败","type":"gateway_error"}}'); }
        else res.destroy();
      } catch (_) { try { res.destroy(); } catch (_) {} }
      try { upRes.resume(); } catch (_) {}
      return;
    }
    let writer = (clientFormat === 'openai' && clientApi === 'responses') ? makeResponsesWriter(res, canonical.model) : makeWriter(clientFormat, res, canonical.model, { geminiArray: isArrayStream });
    writer = hooks.wrapWriter(writer, { format: clientFormat, clientApi, ch, cfg, model: canonical.model, urlInfo });
    let writerEnded = false;
    const onEv = (ev) => {
      try {
        if (hooks.onResponseEvent && hooks.onResponseEvent(ev, ctx) === false) return;
        if (ev.type === 'end') writerEnded = true;
        writer.onEvent(ev);
      } catch (e) { logErr('writer error:', e.message); }
    };
    const parser = isResponsesUp ? new ResponsesStreamParser(onEv) : new UpstreamStreamParser(ch.type, onEv);
    const dec = new SSEDecoder((data) => {
      if (data === '[DONE]') { parser.finish(); return; }
      try { parser.handle(JSON.parse(data)); } catch (e) { logErr('bad SSE data (first 200 chars):', String(data).slice(0, 200)); }
    });
    const u8 = utf8();   
    const g = makeStreamGuard(res, !isArrayStream, streamGuardOpt(cfg), ctx, ch.name,
      () => { if (!writerEnded) onEv({ type: 'end', finish_reason: 'stop' }); });   
    ctx._parser = parser; ctx._guard = g;   
    upRes.on('data', c => { try { const s2 = u8(c); g.touch(s2); dec.push(s2); } catch (_) {} });
    upRes.on('end', () => {
      dec.end(); parser.finish();
      g.finish(true);                                  
      putUsage(usageCapture, parser.usage);
      ctx.logDone(200);
    });
    upRes.on('error', (e) => { logErr('upstream stream error:', e.message); g.abort(e); try { res.end(); } catch (_) {} if (ctx.abort) ctx.abort(e); });
    upRes.on('aborted', () => { if (ctx.abort) ctx.abort('aborted'); });
    upRes.on('close', () => { if (!upRes.complete && ctx.abort) ctx.abort('上游连接未完成即关闭(转换流)'); });
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
      putUsage(usageCapture, cresp.usage);
      if (hooks.processCanonicalResp) {
        try { await hooks.processCanonicalResp(cresp, { ch, cfg, canonical, urlInfo }); } catch (e) { logErr('[hooks] processCanonicalResp:', e.message); }
      }
      let out;
      if (clientFormat === 'openai') out = clientApi === 'responses' ? canonicalToResponsesResp(cresp, canonical.model) : canonicalToOpenAIResp(cresp, canonical.model);
      else if (clientFormat === 'claude') out = canonicalToClaudeResp(cresp, canonical.model);
      else out = canonicalToGeminiResp(cresp, canonical.model);
      if (hooks.onResponseBody) { try { hooks.onResponseBody(out, ctx); } catch (e) { logErr('[hooks] onResponseBody:', e.message); } }
      try {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(out));
      } catch (e) { logErr('[resp] 响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
      ctx.logDone(200);
    });
    upRes.on('error', () => { try { res.end(); } catch (_) {} if (ctx.abort) ctx.abort('上游中断(转换/非流式)'); });
    upRes.on('close', () => { if (!upRes.complete && ctx.abort) ctx.abort('上游连接未完成即关闭(转换/非流式)'); });
  }
}





function handleChat(cfg, clientFormat, clientApi, req, res, urlInfo, bodyStr, hooks, sendError) {
  hooks = normHooks(hooks);
  const stats = cfg._stats;
  


  const keyId = keyIdOf(urlInfo.userKey);
  const keyName = keyNameOf(urlInfo.userKey);
  let body;
  try { body = JSON.parse(bodyStr || '{}'); } catch (e) { return sendError(clientFormat, res, 400, 'invalid JSON body: ' + e.message); }
  if (!body || typeof body !== 'object') return sendError(clientFormat, res, 400, 'request body must be a JSON object');

  
  try { body = hooks.onRequestBody(body, { cfg, urlInfo, clientFormat, clientApi }) || body; }
  catch (e) { logErr('[hooks] onRequestBody:', e.message); }

  const canonical = (clientApi === 'responses') ? responsesToCanonical(body, urlInfo.model) : TO_CANON[clientFormat](body, urlInfo.model);
  

  if (urlInfo.modelOverride) { canonical.rawModel = canonical.model; canonical.model = String(urlInfo.modelOverride); }
  if (urlInfo.stream) canonical.stream = true; 
  if (!canonical.model) return sendError(clientFormat, res, 400, 'missing "model"');

  
  const authDecision = hooks.onChatAuth({ userKey: urlInfo.userKey, model: canonical.model, instance: cfg._name, uid: cfg._uid, cfg, body, canonical });
  if (authDecision && (authDecision.status || authDecision.message))
    return sendError(clientFormat, res, authDecision.status || 403, authDecision.message || 'forbidden');

  const candidates = pickChannels(cfg, canonical.model, urlInfo.forceChannel);
  if (!candidates.length) return sendError(clientFormat, res, 503, 'no channel configured for model: ' + canonical.model);

  







  const estimateCharge = (u) => {
    try {
      if (!hooks.onQuotaEstimate) return null;
      const v = hooks.onQuotaEstimate(Object.assign({ cfg }, u || {}));
      return (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? null : Number(v);
    } catch (e) { logErr('[quota] estimate:', e.message); return null; }
  };
  let releaseQuota = null;
  if (authDecision && authDecision.quota && typeof authDecision.quota.reserve === 'function') {
    const reserved = authDecision.quota.reserve({
      body, canonical, cfg, urlInfo, estimateCharge,
      ch: (candidates[0] && candidates[0].ch && candidates[0].ch.name) || '',
    });
    if (reserved && reserved.error) return sendError(clientFormat, res, reserved.status || 429, reserved.error);
    if (reserved && typeof reserved.release === 'function') releaseQuota = reserved.release;
  }

  stats.requests++;
  const reqId = randId('req');
  const stream = canonical.stream;
  const t0 = Date.now();
  const usageCapture = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let quotaReleased = false;
  const releaseQuotaOnce = () => {
    if (quotaReleased) return;
    quotaReleased = true;
    try { if (releaseQuota) releaseQuota(); } catch (e) { logErr('[quota] release:', e.message); }
  };

  







  let settled = false;        
  let currentCtx = null;      
  let hardTimer = null;       
  const settleAbnormal = (status, why, countErr) => {
    if (settled) return;
    const c = currentCtx;
    if (!c) { settled = true; return; }   
    const p = c._parser;
    try { if (p && p.usage) putUsage(usageCapture, p.usage); } catch (_) {}
    if (countErr) stats.errors++;
    log('ABORT', c.logMeta, why, 'status=' + status,
      'in=' + usageCapture.input, 'out=' + usageCapture.output);
    c.logDone(status);
  };
  

  res.once('close', () => {
    releaseQuotaOnce();
    if (!settled) settleAbnormal(499, '客户端提前断开', false);
  });

  


  const maxStreamSec = Math.max(0, Number(cfg.maxStreamSec == null ? 600 : cfg.maxStreamSec));
  if (maxStreamSec > 0) {
    hardTimer = setTimeout(() => {
      if (settled) return;
      log('TIMEOUT', '请求超过硬上限 ' + maxStreamSec + 's，强制收尾', currentCtx ? currentCtx.logMeta : '');
      try { if (currentCtx && currentCtx._guard) currentCtx._guard.finish(false); } catch (_) {}
      settleAbnormal(504, '超过硬上限(maxStreamSec=' + maxStreamSec + 's)', true);
      try { if (currentCtx && currentCtx._upReq) currentCtx._upReq.destroy(new Error('hard limit ' + maxStreamSec + 's')); } catch (_) {}
    }, maxStreamSec * 1000);
    if (hardTimer.unref) hardTimer.unref();
  }
  
  const recordReq = (status, chName, u, outTArg) => {
    settled = true;   
    if (hardTimer) { try { clearTimeout(hardTimer); } catch (_) {} }
    releaseQuotaOnce();
    

    const o = (u && typeof u === 'object') ? u : { input: u || 0, output: outTArg || 0 };
    const inT = o.input || 0, outT = o.output || 0;
    stats.recent.push({
      id: reqId, time: new Date().toISOString().slice(0, 19).replace('T', ' '), model: canonical.model, channel: chName || '', status,
      duration: Date.now() - t0, inputTokens: inT, outputTokens: outT,
      cacheReadTokens: o.cacheRead || 0, cacheWriteTokens: o.cacheWrite || 0,
      chargedTokens: o.charged != null ? o.charged : undefined,
      keyName: keyName || undefined,
      

      keyId: keyId || undefined,
    });
    if (stats.recent.length > 200) stats.recent.shift();
    


    if (keyId) {
      try {
        const bk = stats.byKey || (stats.byKey = {});
        const e = bk[keyId] || (bk[keyId] = { name: keyName || '', requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, chargedTokens: 0, byChannel: {}, startedAt: new Date().toISOString() });
        if (!e.name && keyName) e.name = keyName;
        e.requests++;
        if (Number(status) >= 400 || !chName) e.errors++;
        e.inputTokens += inT; e.outputTokens += outT;
        e.cacheReadTokens += (o.cacheRead || 0); e.cacheWriteTokens += (o.cacheWrite || 0);
        if (o.charged != null) e.chargedTokens += Number(o.charged) || 0;
        if (chName) {
          const c = e.byChannel[chName] || (e.byChannel[chName] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
          c.requests++; c.inputTokens += inT; c.outputTokens += outT;
          c.cacheReadTokens += (o.cacheRead || 0); c.cacheWriteTokens += (o.cacheWrite || 0);
        }
      } catch (_) {}
    }
    



    try { usageHist.bump(cfg._uid, stats.recent[stats.recent.length - 1], keyId); } catch (_) {}
    if (hooks.onChatDone) {
      try {
        hooks.onChatDone({
          id: reqId, time: new Date().toISOString(), instance: cfg._name, uid: cfg._uid, format: clientFormat,
          model: canonical.model, channel: chName || '', status, duration: Date.now() - t0,
          inputTokens: inT, outputTokens: outT,
          cacheReadTokens: o.cacheRead || 0, cacheWriteTokens: o.cacheWrite || 0,
          
          chargedTokens: o.charged != null ? o.charged : null,
          billDetail: o.detail || null,
          

          keyId: keyId || null,
          keyName: keyName || null,
          userKey: urlInfo.userKey,
        }, { cfg });
      } catch (e) { logErr('[hooks] onChatDone:', e.message); }
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
      
      abort: (e) => settleAbnormal(502, '上游中断(' + ((e && e.message) || e || '未知') + ')', true),
      logDone(status) {
        if (settled) return;   
        settled = true;
        if (hardTimer) { try { clearTimeout(hardTimer); } catch (_) {} }
        


        const usage = {
          input: usageCapture.input, output: usageCapture.output,
          cacheRead: usageCapture.cacheRead || 0, cacheWrite: usageCapture.cacheWrite || 0,
          model: canonical.model, channel: ch.name, format: clientFormat,
          t0, at: Date.now(),
        };
        



        let charged = null, detail = null;
        if (hooks.billing) {
          try {
            const b = hooks.billing(usage, { cfg, ch, urlInfo, stats });
            if (b && b.charged != null && isFinite(Number(b.charged))) {
              charged = Math.max(0, Number(b.charged));
              detail = b.detail || null;
            }
          } catch (e) { logErr('[hooks] billing:', e.message); }
        }
        usage.charged = charged;
        usage.detail = detail;
        log(ctx.logMeta, 'status=' + status, 'in=' + usage.input, 'out=' + usage.output,
          (usage.cacheRead || usage.cacheWrite) ? ('cache=' + usage.cacheRead + '/' + usage.cacheWrite) : '',
          charged != null ? ('charged=' + charged) : '', 'ms=' + (Date.now() - t0));
        stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
        stats.byChannel[ch.name].inputTokens += usage.input;
        stats.byChannel[ch.name].outputTokens += usage.output;
        
        if (usage.cacheRead) stats.byChannel[ch.name].cacheReadTokens = (stats.byChannel[ch.name].cacheReadTokens || 0) + usage.cacheRead;
        if (usage.cacheWrite) stats.byChannel[ch.name].cacheWriteTokens = (stats.byChannel[ch.name].cacheWriteTokens || 0) + usage.cacheWrite;
        if (charged != null) stats.chargedTokens = (stats.chargedTokens || 0) + charged;
        if (hooks.onUsage) { try { hooks.onUsage(usage, { cfg, ch, urlInfo, stats }); } catch (e) { logErr('[hooks] onUsage:', e.message); } }
        recordReq(status, ch.name, usage);
      },
    };
    currentCtx = ctx;   
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
    const doSend = (fresh) => {
      
      const upReq = upstreamRequest(cfg, ch, built.url, built.headers, built.bodyBuf, (err, upRes) => {
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
            res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*' });
            res.end(Buffer.concat(chunks));
          } catch (e) { logErr('[resp] 错误透传响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
        });
        upRes.on('error', () => {
          
          stats.errors++;
          recordReq(502, ch.name, 0, 0);
          try { res.end(); } catch (_) {}
        });
        return;
      }

      
      handleUpstreamResponse(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req, res, upRes, built, ctx, (why) => {
        lastErrStatus = 502; lastErrMsg = why;
        return retrySameOrNext(why);
      }, hooks);
      }, undefined, fresh ? makeFreshAgents(cfg, ch) : undefined);
      ctx._upReq = upReq;   
      return upReq;
    };
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
