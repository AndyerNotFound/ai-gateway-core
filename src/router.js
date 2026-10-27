'use strict';
/** router.js - channel routing + failover + retry (kernel responsibility, doc §2.1)
 * pickChannels(modelMap→models→default→round-robin) + buildRequestForChannel + upstreamRequest
   * + handleChat (multi-channel attempts / connRetry same-channel retries / HTML-faked-success detection / RETRYABLE switching)
   * detachable features (card whitelists/redact/replacement/thinkingSummary/recording) are all injected via hooks; the kernel only forwards.
 */
const http = require('http');
const https = require('https');
const { log, logErr, safeParse, randId, utf8, keyIdOf, keyNameOf } = require('./util');
const { getAgents, makeFreshAgents, isConnErr } = require('./proxy');
const C = require('./canonical');
const modelref = require('./modelref');   /* 「实例:渠道:模型」模型引用 (2026-09-18) */
const usageHist = require('./usage-history');  /* 使用统计历史: 小时桶永久 + 10 分钟桶 30 天 (2026-09-18) */
const {
  responsesToCanonical, responsesRespToCanonical, canonicalToResponsesBody, canonicalToResponsesResp,
  openaiToCanonical, claudeToCanonical, geminiToCanonical,
  canonicalToOpenAIBody, canonicalToClaudeBody, canonicalToGeminiBody,
  openaiRespToCanonical, claudeRespToCanonical, geminiRespToCanonical,
  canonicalToOpenAIResp, canonicalToClaudeResp, canonicalToGeminiResp,
  makeWriter, makeResponsesWriter, SSEDecoder, UpstreamStreamParser, ResponsesStreamParser,
} = C;

/** *HTTP header values must be Latin-1. A channel name may contain CJK (e.g. a Chinese relay's name); writing it directly
   *  X-AI-Gateway-Channel makes res.writeHead() throw ERR_INVALID_CHAR; this code used to
   *  swallow the throw with `catch (_) { return; }` -> the request neither answered the client nor read the upstream response,
   *  hanging forever (measured 2026-09-18: the App spun endlessly with zero error lines in the log). Percent-encoding uniformly guarantees
   *  ASCII-safe; the frontend can restore it with decodeURIComponent(). */
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
//// retryable upstream errors: auth failure (retry with another key)/rate limit/server error/timeout
const RETRYABLE = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** ---- forwarding hooks: all registered by plugins; the kernel defaults to no-ops (doc §7) ----
   * onRequestBody(body, ctx) -> body        request-body filtering (redact/replace.out plugins)
   * onChatAuth(info) -> null|{status,message} authorization check (card-whitelist plugins)
   * onQuotaEstimate(info) -> number|null    pre-auth estimate: tokens -> quota (billing plugin; null = no estimate)
   * needConvert(cfg, ch) -> bool            force the canonical hub (thinkingSummary plugin)
   * wrapWriter(writer, ctx) -> writer       streaming writer wrapping (thinkingSummary plugin)
   * processCanonicalResp(cresp, ctx)     non-streaming canonical post-processing (async)
   * onResponseEvent(ev, ctx) -> ?false      SSE event-level handling; return false to drop (replace.inc plugin)
   * onResponseLine(line, ctx) -> line       passthrough-mode line-level handling
   * onResponseBody(out, ctx)             non-streaming response body handling
   * sanitizeText(s, ctx) -> s               error message redaction
   * onUsage({input,output,cacheRead,cacheWrite,charged,detail,model}, ctx)  usage accounting/billing (card plugins)
   * billing(usage, ctx) -> number|{charged,detail}|null   dynamic billing (billing plugin; null = legacy input+output convention)
   * onChatDone(rec, ctx)                 request complete (record plugin)
 */
const NO_HOOKS = {
  onRequestBody: (body) => body,
  onChatAuth: () => null,
  onQuotaEstimate: () => null,
  needConvert: () => false,
  wrapWriter: (w) => w,
  sanitizeText: (s) => s,
};
function normHooks(h) { return h ? Object.assign({}, NO_HOOKS, h) : NO_HOOKS; }

/** Usage write-back (cache fields included) -- usageCapture is the **single source** for every settlement path.
   * the 4 settlement sites each wrote their own input/output pair; adding a field meant 4 edits and easy misses;
   * everything funnels through here so cache fields (deepseek/claude/gemini each name their own; see canonical.pickCache) are never missed. */
function putUsage(cap, u) {
  cap.input = (u && u.input) || 0;
  cap.output = (u && u.output) || 0;
  cap.cacheRead = (u && u.cacheRead) || 0;
  cap.cacheWrite = (u && u.cacheWrite) || 0;
}

//// whether OpenAI channels use the Responses API upstream (channel-level useResponses overrides global cfg.upstreamResponses)
function chUsesResponses(cfg, ch) {
  if (ch.type !== 'openai') return false;
  return ch.useResponses !== undefined ? !!ch.useResponses : !!cfg.upstreamResponses;
}

function pickChannels(cfg, model, preferChannel) {
  const chs = cfg.channels || [];
  /* *when a model reference "instance:channel:model" names a channel, search **that channel only** (2026-09-18).
*  Named but cannot serve the model -> return empty candidates (upper layer answers 503), **never silently switch to another channel** --
   *  otherwise "target a source exactly" loses its point. */
  let pool = chs;
  if (preferChannel) {
    pool = chs.filter(ch => ch && ch.name && modelref.channelMatch(preferChannel, ch.name));
    if (!pool.length) return [];
  }
  const candidates = [];
  if (model) {
    // 1) exact hit in modelMap
    for (const ch of pool) {
      if (ch.modelMap && Object.prototype.hasOwnProperty.call(ch.modelMap, model)) {
        candidates.push({ ch, upstreamModel: String(ch.modelMap[model]) });
      }
    }
    // 2) hit in the models list (avoids adding the same channel twice via modelMap)
    if (!candidates.length) {
      for (const ch of pool) {
        if (ch.models && ch.models.includes(model)) candidates.push({ ch, upstreamModel: model });
      }
    }
  }
// 3) No exact hit at all -> fall back to default channels (may be several) or all channels
  if (!candidates.length) {
    if (preferChannel) return [];
    const defs = chs.filter(c => c.default);
    const pool2 = defs.length ? defs : chs;
    for (const ch of pool2) candidates.push({ ch, upstreamModel: model || '' });
  }
  if (!candidates.length) return [];
// round-robin: a per-model counter decides the starting offset
  if (!cfg._rr) cfg._rr = {};
  const key = model || '__nomodel__';
  cfg._rr[key] = ((cfg._rr[key] || 0) + 1) % candidates.length;
  const rot = cfg._rr[key];
  return candidates.slice(rot).concat(candidates.slice(0, rot));
}

//// backward compatibility: return the first candidate
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

/** ================= Success-rate probing (probe) =================
   * cfg.probe = { enable:false, intervalMin:10, mode:'models'|'chat' }; channel-level: ch.probe=true
   * mode=models probes for free; mode=chat spends tokens; results in cfg._stats.probe */

function buildRequestForChannel(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req, opts = {}) {
// On forceConvert (e.g. demanded by a thinking-trim plugin), take the canonical conversion path even for the same format (otherwise the passthrough pipe bypasses the plugin);
// Mismatched client API (chat/responses) vs upstream API (chat/responses) must also go through the conversion hub
  const upApi = chUsesResponses(cfg, ch) ? 'responses' : 'chat';
  const direct = clientFormat === ch.type && clientApi === upApi && !opts.forceConvert;
  const stream = canonical.stream;
const upstreamModel = canonical.model; // already rewritten by the caller to the channel's upstream model name
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


/** ================= *Stream finalization protection (2026-09-18) =================
   * users report "sometimes waiting ages for the model's final content params" and "thinking start/end behaving oddly".
   * verified: upstream relays stay silent for long stretches, or never send an end marker; once the kernel idle timeout (default 180s) fires it cuts off
* connection -- so the client "spins forever". Three tiers of downstream protection here (**only for real SSE**):
*   (1) Upstream silent >= beatSec -> write an SSE comment heartbeat downstream (content unchanged; keeps the connection alive / defeats middle-layer timeouts);
*   (2) Upstream aborts abnormally -> emit a proper terminal event before closing the stream (the client can finish cleanly);
*   (3) Upstream ends normally but omits the terminal marker (finish_reason/[DONE]) -> add it too (the client relies on it to know "the answer is complete").
   * config: cfg.streamGuard = false disables it; { beatSec } tunes the heartbeat threshold (default 15s).
   * note: comment lines (`: ...`) are ignored by every SSE client; content stays clean. */
function streamGuardOpt(cfg) {
  const sg = (cfg && cfg.streamGuard);
  if (sg === false || (sg && sg.enable === false)) return { enable: false, beatSec: 15 };
  return { enable: true, beatSec: Math.max(3, Number(sg && sg.beatSec) || 15) };
}

/** the passthrough path's "canonical finalization" (written in the client's format) */
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

/** ===== upstream "unsupported parameter" adaptive downgrade (2026-10-01) =====
* Background: some upstreams reject unknown parameters outright -- some answer 400 (body naming Unsupported parameter(s): X),
*       others answer 200 but stuff {"error":{... internal_server_error ...}} into the stream.
* ★Iron rule: **forward everything verbatim by default, never pre-strip parameters** -- when the upstream supports a feature it must keep working.
*   Only after "the upstream really rejected it" does the parameter land on an **in-process-memory** channel-level list, stripped once for a single retry;
*   the list never touches disk -> forgotten on gateway restart; once the upstream adds support, forwarding resumes automatically -- never a permanent ban. */
const PARAM_REJECT = new Map();      /* key='uid|instance|channel' -> Set<param name> */
/** an in-stream error reveals nothing about which parameter was rejected -> this "suspect list" powers a one-shot downgrade probe (also used only after a failure) */
const FALLBACK_SUSPECT = ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens'];
function rejectKeyOf(cfg, ch) { return String(cfg._uid) + '|' + cfg._name + '|' + (ch && ch.name); }
function rejectedOf(cfg, ch) {
  const k = rejectKeyOf(cfg, ch);
  let s = PARAM_REJECT.get(k);
  if (!s) { s = new Set(); PARAM_REJECT.set(k, s); }
  return s;
}
/** extract the named parameters from upstream error text (handles forms like "Unsupported parameter(s): `a`, `b`") */
function parseRejectedParams(txt) {
  const m = /unsupported parameter\(?s?\)?\s*[:：]\s*([^\n]{1,300})/i.exec(String(txt || ''));
  if (!m) return [];
  return m[1].split(/[^A-Za-z0-9_]+/).filter(n => n.length > 1 && n.length < 60);
}
/** strip the params "this channel already had rejected"; nothing to strip -> return as-is (zero copy) */
function bodyWithoutRejected(cfg, ch, body) {
  const rej = PARAM_REJECT.get(rejectKeyOf(cfg, ch));
  if (!rej || !rej.size || !body || typeof body !== 'object') return body;
  let hit = false;
  for (const k of rej) if (Object.prototype.hasOwnProperty.call(body, k)) { hit = true; break; }
  if (!hit) return body;
  const out = Object.assign({}, body);
  for (const k of rej) delete out[k];
  return out;
}
/** whether the first SSE data event is an "error event" (strict JSON parsing, so the word error appearing in content is not misjudged) */
function firstEventIsStreamError(s) {
  const m = /(?:^|\n)data:\s*([^\n]+)/.exec(String(s || ''));
  if (!m) return false;
  try {
    const j = JSON.parse(m[1]);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return false;
    if (j.error) return true;
    return j.type === 'error' || j.object === 'error';
  } catch (_) { return false; }
}

function makeStreamGuard(res, isSse, opt, ctx, chName, endFn) {
  if (!opt.enable || !isSse) return { touch() {}, stop() {}, abort() {}, finish() {}, disarm() {} };
let last = Date.now(), beats = 0, stopped = false, disarmed = false;   /* disarmed: the upper layer took over (downgrade retry); no more terminal events may be appended */
let sawData = false, atLineEnd = true;   /* ★edge protection (2026-09-18): see the two comments below */
const tm = setInterval(() => {                       /* heartbeat check (a comment line; clients ignore it) */
    if (stopped) return;
    const idle = Date.now() - last;
    if (idle < opt.beatSec * 1000) return;
    /* *boundary guard 1: one upstream event may arrive split across two TCP packets. Injecting a comment line into a "half line" would
     *  `data: {"half...: keep-alive 15s` glued into one line -> the client's JSON parse of that event fails (**event lost**).
     *  so the heartbeat is sent only when the **previous chunk ended with a newline** (= at a line boundary); otherwise wait for the next round. */
    if (!atLineEnd) return;
    try { res.write(': keep-alive ' + Math.round(idle / 1000) + 's\n\n'); } catch (_) {}
    if (!beats) log('[stream] 上游静默 ' + Math.round(idle / 1000) + 's → 已向下游发心跳', ctx.logMeta, 'ch=' + chName);
    beats++; last = Date.now();
  }, 2000);
  if (tm.unref) tm.unref();
  const stop = () => { stopped = true; try { clearInterval(tm); } catch (_) {} };
  const fire = (why) => {
    /* *already taken over by an upper layer (param-downgrade retry) -> never append an end event, or the client gets a "fake success" finale first */
    if (disarmed) return;
    /* *boundary guard 2: the upstream broke off **without producing a single byte** -> **do not append an end event**; preserve the "failure" semantics.
     *  otherwise the client displays "received nothing" as a normal, empty answer -- dressing a real failure up as success. */
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
/* ★disarm (2026-10-01): called when the upper layer decides "this stream does not count" (downgrade retry) -- from then on fire() stays fully silent,
     *  so a real failure is never finalized as a "normal end". */
    disarm() { disarmed = true; stop(); },
  };
}

//// handle a successful upstream response (2xx): passthrough or cross-format conversion. The hook-based version (extracted from the original handleChat).
function handleUpstreamResponse(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req, res, upRes, built, ctx, retryHook, hooks) {
  const { direct, stream, upApi } = built;
  const { usageCapture, stats } = ctx;
  const isResponsesUp = ch.type === 'openai' && upApi === 'responses';

  if (direct) {
    const ct = upRes.headers['content-type'] || (stream ? 'text/event-stream' : 'application/json');
    try {
      /* *param-downgrade retry re-enters on the same res (the head guard saw an in-stream error) -> skip headers if already sent; never resend */
      if (!res.headersSent) res.writeHead(upRes.statusCode, { 'Content-Type': ct, 'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    } catch (e) {
      /* *never return silently: when writing headers fails (typically a non-ASCII channel name), the client receives nothing
       *  and nobody reads the upstream response -- the request hangs forever (observed 2026-09-18). This now
       *  error clearly + release the upstream connection. */
      logErr('[resp] 响应头下发失败, 已中断该请求:', e.message);
      try {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"gateway: 响应头下发失败","type":"gateway_error"}}'); }
        else res.destroy();
      } catch (_) { try { res.destroy(); } catch (_) {} }
      try { upRes.resume(); } catch (_) {}
      return;
    }
    /* ================= *Head guard + in-stream error downgrade (2026-10-01) =================
     * upstreams may return "HTTP 200 but send an error event first inside the stream" (verified: NVIDIA NIM relays send
     *   data: {"error":{"message":"Internal server error","type":"internal_server_error","code":500}}
* Old behavior: pass through verbatim, then append finish_reason:"stop" -- disguising real failures as normal ends.
* New behavior: buffer the first SSE event **before any byte is written to the client** --
     *   (1) an error event -> this stream is void (g.disarm() skips the end event); strip the "suspect params" and retry the channel;
     *   (2) normal content -> release immediately, then passthrough as before (never switch channels mid-stream once bytes went out). */
    let headPassed = false, streamBad = false;
    const upstreamBad = (why) => {
      if (streamBad) return;
      streamBad = true;
      try { if (ctx._guard) ctx._guard.disarm(); } catch (_) {}
      try { upRes.destroy(); } catch (_) {}
      const rej = rejectedOf(cfg, ch);
      const add = FALLBACK_SUSPECT.filter(p => !rej.has(p) && body && Object.prototype.hasOwnProperty.call(body, p));
      if (add.length && typeof ctx.dropParamsAndRetry === 'function' && ctx.dropParamsAndRetry(add)) {
        log('UPERR-STREAM', ctx.logMeta, '上游在流内报错(' + why + ') → 已降级重试', 'ch=' + ch.name);
        return;
      }
      /* cannot degrade -> report the failure clearly (no more blank answers posing as a normal end) */
      log('UPERR-STREAM', ctx.logMeta, '上游在流内报错且无可降级参数(' + why + ')', 'ch=' + ch.name);
      stats.errors++;
      recordReq(502, ch.name, 0, 0);
      try {
        if (!res.writableEnded) {
          if (stream) {
            res.write('data: ' + JSON.stringify({ error: { message: 'upstream stream error', type: 'upstream_error', code: 'STREAM_ERROR' } }) + '\n\n');
            res.write('data: [DONE]\n\n');
          }
          res.end();
        }
      } catch (_) {}
    };

    if (stream) {
      const parser = isResponsesUp ? new ResponsesStreamParser(() => {}) : new UpstreamStreamParser(ch.type, () => {});
      const dec = new SSEDecoder((data) => { try { if (data !== '[DONE]') parser.handle(JSON.parse(data)); } catch (_) {} });
          const u8 = utf8();   /* *chunk-safe decoding (2026-09-18) */
      const g = makeStreamGuard(res, /text\/event-stream/i.test(String(ct)), streamGuardOpt(cfg), ctx, ch.name,
        () => writeTerminalSSE(res, clientFormat, clientApi));
      ctx._parser = parser; ctx._guard = g;   /* *handed to fallback settlement: record whatever usage was parsed when interrupted */
      upRes.on('data', c => { try { const s2 = u8(c); g.touch(s2); dec.push(s2); } catch (_) {} });
      upRes.on('end', () => {
        dec.end(); parser.finish(); putUsage(usageCapture, parser.usage);
        if (streamBad) return;                      /* *handed to the downgrade retry; do not finalize again */
        g.finish(!!parser.finishReason);
        ctx.logDone(upRes.statusCode);
      });
      /* *finalization can be lost in more ways than one: error / aborted / close without end -- all must settle */
      upRes.on('error', (e) => { if (streamBad) return; g.abort(e); try { res.end(); } catch (_) {} if (ctx.abort) ctx.abort(e); });
      upRes.on('aborted', () => { if (streamBad) return; if (ctx.abort) ctx.abort('aborted'); });
      upRes.on('close', () => { if (streamBad) return; if (!upRes.complete && ctx.abort) ctx.abort('上游连接未完成即关闭'); });
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
      // passthrough-mode line-level handling (keeps raw SSE structure; per-line matching; cross-line rules do not apply)
      let buf = '';
          const u8 = utf8();   /* *chunk-safe decoding (2026-09-18) */
      upRes.on('data', c => {
        try {
          buf += u8(c);
          if (!headPassed) {                       /* *head guard: buffer the first event before deciding whether to release */
            if (firstEventIsStreamError(buf)) { upstreamBad('stream-error-first-event'); return; }
            if (buf.length < 4096 && !/\n\n/.test(buf)) return;
            headPassed = true;
          }
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) res.write(hooks.onResponseLine(line, ctx) + '\n');
        } catch (_) {}
      });
      upRes.on('end', () => { if (streamBad) return; try { if (buf) res.write(hooks.onResponseLine(buf, ctx)); res.end(); } catch (_) {} });
      upRes.on('error', () => { if (streamBad) return; try { res.end(); } catch (_) {} });
    } else if (!stream) {
      upRes.pipe(res);
    } else {
      /* *direct+stream with no row-level hook: forward it yourself (through the same head guard, and own res.end()) */
      let buf = '';
      const u8 = utf8();
      upRes.on('data', c => {
        try {
          const s2 = u8(c);
          if (!headPassed) {
            buf += s2;
            if (firstEventIsStreamError(buf)) { upstreamBad('stream-error-first-event'); return; }
            if (buf.length < 4096 && !/\n\n/.test(buf)) return;
            headPassed = true;
          }
          if (buf) { try { res.write(buf); } catch (_) {} buf = ''; }
          try { res.write(c); } catch (_) {}
        } catch (_) {}
      });
      upRes.on('end', () => { if (streamBad) return; try { if (buf) res.write(buf); res.end(); } catch (_) {} });
      upRes.on('error', () => { if (streamBad) return; try { res.end(); } catch (_) {} });
    }
    return;
  }

// Cross-format conversion
  if (stream) {
    const isArrayStream = clientFormat === 'gemini' && !urlInfo.altSse;
    try {
      res.writeHead(200, {
        'Content-Type': isArrayStream ? 'application/json' : 'text/event-stream',
        'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
        'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*',
      });
    } catch (e) {
      /* *never return silently: when writing headers fails (typically a non-ASCII channel name), the client receives nothing
       *  and nobody reads the upstream response -- the request hangs forever (observed 2026-09-18). This now
       *  error clearly + release the upstream connection. */
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
          const u8 = utf8();   /* *chunk-safe decoding (2026-09-18) */
    const g = makeStreamGuard(res, !isArrayStream, streamGuardOpt(cfg), ctx, ch.name,
      () => { if (!writerEnded) onEv({ type: 'end', finish_reason: 'stop' }); });   /* 收尾交回 writer（各格式事件不同） */
    ctx._parser = parser; ctx._guard = g;   /* *handed to fallback settlement */
    upRes.on('data', c => { try { const s2 = u8(c); g.touch(s2); dec.push(s2); } catch (_) {} });
    upRes.on('end', () => {
      dec.end(); parser.finish();
      g.finish(true);                                  /* on the conversion path parser.finish() emits end; treat the marker as present */
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
        // upstream 200 with a non-JSON body (HTML error pages etc.; content-type may even fake json): retryable
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

/** the main forwarding entry: client chat/messages/generateContent/responses -> channel routing -> upstream
 * clientFormat: 'openai'|'claude'|'gemini'; clientApi: 'chat'|'responses'
   * urlInfo: {model?, stream?, altSse?, userKey?}  (userKey is attached by auth plugins to the checkAuth return value; the kernel does not interpret it)
   * hooks: see NO_HOOKS; sendError: core-injected formatted error output */
function handleChat(cfg, clientFormat, clientApi, req, res, urlInfo, bodyStr, hooks, sendError) {
  hooks = normHooks(hooks);
  const stats = cfg._stats;
  /* *per-user stats isolation (2026-09-18): the card identity = the bound user's uid or the card hash (see util.keyIdOf).
   *   it feeds both: (1) each recent record (pages filter per user); (2) stats.byKey[<keyId>] (per-user totals);
   *   (3) usage-history's per-key buckets (per-user history curves). Keyless requests with keyId='' -> instance-level ledger only. */
  const keyId = keyIdOf(urlInfo.userKey);
  const keyName = keyNameOf(urlInfo.userKey);
  let body;
  try { body = JSON.parse(bodyStr || '{}'); } catch (e) { return sendError(clientFormat, res, 400, 'invalid JSON body: ' + e.message); }
  if (!body || typeof body !== 'object') return sendError(clientFormat, res, 400, 'request body must be a JSON object');

// hook: request-body filtering (redact/replace.out plugins)
  try { body = hooks.onRequestBody(body, { cfg, urlInfo, clientFormat, clientApi }) || body; }
  catch (e) { logErr('[hooks] onRequestBody:', e.message); }

  const canonical = (clientApi === 'responses') ? responsesToCanonical(body, urlInfo.model) : TO_CANON[clientFormat](body, urlInfo.model);
/* ★The model reference (instance:channel:model) was already resolved in core: swap canonical.model back to the **real name** --
*  billing (price lookup by channel+model name), group auth, and log stats all use the real name; the raw string stays in rawModel for reference. */
  if (urlInfo.modelOverride) { canonical.rawModel = canonical.model; canonical.model = String(urlInfo.modelOverride); }
if (urlInfo.stream) canonical.stream = true; // gemini: the stream flag rides in the URL path
  if (!canonical.model) return sendError(clientFormat, res, 400, 'missing "model"');

// hook: authorization check (card-key whitelist: models/branches)
  const authDecision = hooks.onChatAuth({ userKey: urlInfo.userKey, model: canonical.model, instance: cfg._name, uid: cfg._uid, cfg, body, canonical });
  if (authDecision && (authDecision.status || authDecision.message))
    return sendError(clientFormat, res, authDecision.status || 403, authDecision.message || 'forbidden');

  const candidates = pickChannels(cfg, canonical.model, urlInfo.forceChannel);
  if (!candidates.length) return sendError(clientFormat, res, 503, 'no channel configured for model: ' + canonical.model);

/* Pre-authorization sits after "a channel is confirmed": a failed freeze rejects immediately; once frozen, success, failure, or disconnect alike
* is released by releaseQuota. Actual usedTokens still increase only in ctx.logDone()'s onUsage.
* ★Unified units (2026-09-18): the frozen value must be **quota**, never token count -- settlement goes through billing
*  (charged = raw/1e6 x multiplier, magnitude 1e-3); freezing by token count (magnitude 1e3) would overshoot badly.
   *  a million-fold error: a card with 99.97 quota got 429-rejected for "this request pre-authorizes about 13209", while that
   *  actually deducting 0.01. Only billing (the single pricing truth) can do the conversion (onQuotaEstimate),
   *  so the conversion is passed down as a callback: the auth plugin estimates tokens; ask it when a quota figure is needed; without an estimate
*  (billing absent / model unpriced) -> the auth plugin falls back to the token unit, settling exactly like the old unit. */
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

  /* ================= *finalization fallback (2026-09-18) =================
   * Incident: when a streamed request loses its "terminal event" (upstream abort / error / silent timeout / client disconnect), the old code only
   * appended a terminal marker downstream in upRes's error branch and returned -- no logDone, no error count, so the stats were left with a ghost
   * record of "1 request / 0 tokens / empty recent list / 0 errors" forever (user-observed: upstream finished 200 at 18:27:06
   * while core settled nothing for 9 minutes; the usage page showed 0 / 0).
   * Now: every abnormal ending settles **exactly once**, recording whatever usage could be parsed.
   * Billing rule (set by the user 2026-09-18): charge by parsed usage when available; zero usage counts only as an error.
   * ========================================================= */
  let settled = false;        /* settlement gate: end / error / close / hard timeout -- only the first one may fire */
  let currentCtx = null;      /* ctx of the current candidate channel (holding _parser / _guard / _upReq) */
  let hardTimer = null;       /* hard-cap timer (see maxStreamSec below) */
  const settleAbnormal = (status, why, countErr) => {
    if (settled) return;
    const c = currentCtx;
    if (!c) { settled = true; return; }   /* never reached forwarding (auth rejected etc.) -> no stats were ever due */
    const p = c._parser;
    try { if (p && p.usage) putUsage(usageCapture, p.usage); } catch (_) {}
    if (countErr) stats.errors++;
    log('ABORT', c.logMeta, why, 'status=' + status,
      'in=' + usageCapture.input, 'out=' + usageCapture.output);
    c.logDone(status);
  };
  /* client disconnects / upstream faults may never reach the normal response path; close is the last safety net; idempotent release + fallback settlement
   * (★settlement must never be skipped: otherwise the request never lands in the stats and the usage page's "recent requests" stays empty forever). */
  res.once('close', () => {
    releaseQuotaOnce();
    if (!settled) settleAbnormal(499, '客户端提前断开', false);
  });

  /* *hard cap: when the upstream "never ends" (no end marker while the connection stays active -> the socket idle timeout never fires)
   * must not hang forever. At the deadline: append a terminal marker downstream -> settle (504, count as error) -> disconnect upstream.
   * Set cfg.maxStreamSec to 0 to disable. */
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
  /* u may be the old (inT, outT) numeric pair, or the full usage object passed by logDone (preferred) */
  const recordReq = (status, chName, u, outTArg) => {
    settled = true;   /* other settlement exits (error passthrough / retries exhausted) also count as "settled", so close/hard timeout cannot settle twice */
    if (hardTimer) { try { clearTimeout(hardTimer); } catch (_) {} }
    releaseQuotaOnce();
    /* ★Note: this is an arrow function with no arguments of its own -- legacy callers pass the 4th argument, received via the outTArg parameter,
     *  writing arguments[3] would grab handleChat's arguments (been there). */
    const o = (u && typeof u === 'object') ? u : { input: u || 0, output: outTArg || 0 };
    const inT = o.input || 0, outT = o.output || 0;
    stats.recent.push({
      id: reqId, time: new Date().toISOString().slice(0, 19).replace('T', ' '), model: canonical.model, channel: chName || '', status,
      duration: Date.now() - t0, inputTokens: inT, outputTokens: outT,
      cacheReadTokens: o.cacheRead || 0, cacheWriteTokens: o.cacheWrite || 0,
      chargedTokens: o.charged != null ? o.charged : undefined,
      keyName: keyName || undefined,
      /* *for per-user isolation: keyId = user uid/card hash ('' = keyless request). keyName is display-only,
       *   filtering must key on keyId (cards can share names and be renamed). */
      keyId: keyId || undefined,
    });
    if (stats.recent.length > 200) stats.recent.shift();
    /* *per-user accumulation (2026-09-18): alongside the instance-level byChannel, a per-key copy,
     *   letting the user "Usage" page show **their own** request/error/token/billing totals and channel ranking.
     *   in-memory object, reset on restart (same semantics as instance-level byChannel); history curves use usage-history's per-key buckets. */
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
    /* *usage-stats history (2026-09-18): in-memory recent holds only 200 entries and resets on restart,
     *  the "Usage" page needs persistent history for arbitrary spans / break granularity -- this only appends the just-settled
     *  this record accumulates into in-memory buckets (very cheap); flushing is the kernel's 60s timer (see usage-history.js).
     *  *added 2026-09-18, third arg keyId: also accumulate a per-key bucket (per-user history curves). */
    try { usageHist.bump(cfg._uid, stats.recent[stats.recent.length - 1], keyId); } catch (_) {}
    if (hooks.onChatDone) {
      try {
        hooks.onChatDone({
          id: reqId, time: new Date().toISOString(), instance: cfg._name, uid: cfg._uid, format: clientFormat,
          model: canonical.model, channel: chName || '', status, duration: Date.now() - t0,
          inputTokens: inT, outputTokens: outT,
          cacheReadTokens: o.cacheRead || 0, cacheWriteTokens: o.cacheWrite || 0,
          /* charged = the weighted token amount actually deducted from the key card quota (null = legacy input+output convention) */
          chargedTokens: o.charged != null ? o.charged : null,
          billDetail: o.detail || null,
          /* *per-user isolation (2026-09-18): keyId = user uid/card hash, keyName = card name -- plugins (record/billing)
           *   use it to split their own ledgers per user instead of parsing keys themselves. */
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

  /* *param-downgrade retry (2026-10-01): invoked only after "the upstream explicitly rejected"; params are never stripped preemptively.
   *   strip -> record in this channel's in-memory list -> rerun the same channel (attempt already incremented, so step back one). */
  let curCh = null, paramRetries = 0;
  const dropParamsAndRetry = (names) => {
    const rej = rejectedOf(cfg, curCh);
    const add = (names || []).filter(n => !rej.has(n) && body && Object.prototype.hasOwnProperty.call(body, n));
    if (!add.length || paramRetries >= 3) return false;
    paramRetries++;
    add.forEach(n => rej.add(n));
    log('PARAM-DROP', 'model=' + (canonical && canonical.model), '上游不支持参数 ' + add.join(',') + ' → 已剔除并重试本渠道', 'ch=' + (curCh && curCh.name));
    if (attempt > 0) attempt--;
    tryNext();
    return true;
  };

  // Try candidate channels one by one; connection failure or retryable HTTP error -> next channel; non-retryable (e.g. 400) -> pass through as-is
  const tryNext = () => {
    if (attempt >= candidates.length) {
      stats.errors++;
      recordReq(lastErrStatus || 502, '', 0, 0);
      const msg = lastErrMsg || ('all ' + candidates.length + ' channels failed');
      return sendError(clientFormat, res, lastErrStatus || 502, msg);
    }
    const pick = candidates[attempt];
    const ch = pick.ch;
    curCh = ch;
    const myCanonical = { ...canonical, model: pick.upstreamModel || canonical.model };
    const forceConvert = !!hooks.needConvert(cfg, ch);
    const effBody = bodyWithoutRejected(cfg, ch, body);   /* *strip only params "this channel already rejected" (zero-copy passthrough when none) */
    const built = buildRequestForChannel(cfg, ch, clientFormat, clientApi, myCanonical, effBody, urlInfo, req, { forceConvert });
    attempt++;

    // HTTP headers allow ASCII only; an apiKey with CJK/full-width characters makes node throw internally
    for (const [hk, hv] of Object.entries(built.headers)) {
      if (typeof hv === 'string' && !/^[\x09\x20-\x7e]*$/.test(hv)) {
        return sendError(clientFormat, res, 500, `渠道 "${ch.name}" 的请求头 ${hk} 含非 ASCII 字符(可能是 apiKey 里残留了中文占位符), 请检查配置`);
      }
    }

    const ctx = {
      t0, usageCapture, stats,
      logMeta: [clientFormat + '>' + ch.type, 'model=' + canonical.model, 'ch=' + ch.name, 'proxy=' + (ch.proxy || '-'), stream ? 'stream' : 'block'].join(' '),
      /* *fallback settlement entry (implemented as settleAbnormal at the top of handleChat): called on upstream interruption / hard timeout / client disconnect */
      abort: (e) => settleAbnormal(502, '上游中断(' + ((e && e.message) || e || '未知') + ')', true),
      logDone(status) {
        if (settled) return;   /* *idempotent: end / error / close / hard timeout may all arrive; settle exactly once */
        settled = true;
        if (hardTimer) { try { clearTimeout(hardTimer); } catch (_) {} }
        /* *usage object: **assemble once** before handing to billing / onUsage / onChatDone.
         * onUsage used to receive only {input,output} -- not even a model name, so per-model pricing was impossible;
 * cache counts were unreachable too. Everything billing needs now rides along (extra fields; older plugins reading input/output are unaffected). */
        const usage = {
          input: usageCapture.input, output: usageCapture.output,
          cacheRead: usageCapture.cacheRead || 0, cacheWrite: usageCapture.cacheWrite || 0,
          model: canonical.model, channel: ch.name, format: clientFormat,
          t0, at: Date.now(),
        };
        /* Dynamic billing: the plugin (usually billing) computes "how much to deduct" here.
         * · returns a number or {charged, detail} -> the billing plugin deducts charged (weighting convention is its own choice)
         * · returns null / dynamic-billing plugin absent -> charged stays null -> the card plugin falls back to legacy input+output
         *   (*this is the backward-compatibility key: without billing, deductions are byte-identical to today) */
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
        /* cache counts tracked separately (old fields untouched) -- the usage page / cost accounting need hit rates */
        if (usage.cacheRead) stats.byChannel[ch.name].cacheReadTokens = (stats.byChannel[ch.name].cacheReadTokens || 0) + usage.cacheRead;
        if (usage.cacheWrite) stats.byChannel[ch.name].cacheWriteTokens = (stats.byChannel[ch.name].cacheWriteTokens || 0) + usage.cacheWrite;
        if (charged != null) stats.chargedTokens = (stats.chargedTokens || 0) + charged;
        if (hooks.onUsage) { try { hooks.onUsage(usage, { cfg, ch, urlInfo, stats }); } catch (e) { logErr('[hooks] onUsage:', e.message); } }
        recordReq(status, ch.name, usage);
      },
    };
    currentCtx = ctx;   /* *attach this attempt to fallback settlement (_parser/_guard/_upReq are filled by the forwarding layer) */
    ctx.dropParamsAndRetry = dropParamsAndRetry;   /* *called by the in-stream error guard (handleUpstreamResponse) */
    stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
    stats.byChannel[ch.name].requests++;

    // channel-level queueing delay (delayMs): concurrent requests serialize through the _gate chain at intervals, easing 429 rate limits
    const delayMs = Math.min(120000, Number(ch.delayMs) || 0);
    // same-channel retries for connection-level errors / HTML-faked success (cfg.connRetry times, a fresh connection each time)
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
      /* *keep a reference to the upstream connection: the hard cap must be able to force-disconnect it (otherwise the request hangs forever) */
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

      // upstream fakes success with an HTML page (CDN challenge / relay failure page): retryable; retry the channel first, then switch
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
        // non-retryable (e.g. 400) or last candidate -> pass the error through unchanged
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          /* ★Upstream names an "unsupported parameter" -> put it on this channel's in-memory list, strip it, retry the same channel (nothing is stripped by default) */
          try {
            const named = parseRejectedParams(Buffer.concat(chunks).toString('utf8'));
            if (named.length && dropParamsAndRetry(named)) return;
          } catch (_) {}
          stats.errors++;
          recordReq(upRes.statusCode, ch.name, 0, 0);
          log('UPERR', ctx.logMeta, 'status=' + upRes.statusCode, attempt > 1 ? '(已尝试 ' + attempt + ' 个渠道)' : '');
          try {
            res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*' });
            res.end(Buffer.concat(chunks));
          } catch (e) { logErr('[resp] 错误透传响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
        });
        upRes.on('error', () => {
          /* settle even when reading fails during error passthrough (otherwise another ghost "1 request / 0 usage" record) */
          stats.errors++;
          recordReq(502, ch.name, 0, 0);
          try { res.end(); } catch (_) {}
        });
        return;
      }

      // success (2xx) -> normal handling; no fallback from here (a non-JSON body faking success can still retry via hooks)
      handleUpstreamResponse(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req, res, upRes, built, ctx, (why) => {
        lastErrStatus = 502; lastErrMsg = why;
        return retrySameOrNext(why);
      }, hooks);
      }, undefined, fresh ? makeFreshAgents(cfg, ch) : undefined);
      ctx._upReq = upReq;   /* attached to ctx: hard timeout / fallback settlement need it */
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
