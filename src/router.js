'use strict';
/* router.js - 渠道路由 + 故障切换 + 重试 (内核职责, 文档 §2.1)
 * pickChannels(modelMap→models→default→round-robin) + buildRequestForChannel + upstreamRequest
 * + handleChat(多渠道尝试/connRetry 同渠道重试/HTML 冒充检测/RETRYABLE 切换)
 * 可拆功能(卡密白名单/redact/替换/thinkingSummary/记录)全部走 hooks 注入, 内核只做转发。
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

/* ★HTTP 响应头值只能是 Latin-1。渠道名可能是中文(如 "Guili公益")，直接写进
 *  X-AI-Gateway-Channel 会让 res.writeHead() 抛 ERR_INVALID_CHAR；而这里原本用
 *  `catch (_) { return; }` 把异常吞掉了 → 该请求既不回客户端、也不读上游响应，
 *  永久悬挂(2026-09-18 实测：App 一直转圈、日志无一行错误)。统一做百分号编码保证
 *  ASCII 安全，前端可 decodeURIComponent() 还原。 */
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
// 可重试的上游错误: 鉴权失败(换 key 重试)/限流/服务端错误/超时
const RETRYABLE = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504, 529]);

/* ---- 转发 hooks: 全部由插件注册, 内核默认空操作 (文档 §7) ----
 * onRequestBody(body, ctx)→body        请求体过滤 (redact/replace.out 插件)
 * onChatAuth(info)→null|{status,message} 授权检查 (卡密白名单插件)
 * onQuotaEstimate(info)→number|null    预授权估算: token → 额度 (billing 插件; null=估不出来)
 * needConvert(cfg, ch)→bool            强制走 canonical 中枢 (thinkingSummary 插件)
 * wrapWriter(writer, ctx)→writer       流式 writer 包装 (thinkingSummary 插件)
 * processCanonicalResp(cresp, ctx)     非流式 canonical 后处理 (异步)
 * onResponseEvent(ev, ctx)→?false      SSE 事件级处理, 返回 false 丢弃 (replace.inc 插件)
 * onResponseLine(line, ctx)→line       直通模式行级处理
 * onResponseBody(out, ctx)             非流式响应体处理
 * sanitizeText(s, ctx)→s               错误消息脱敏
 * onUsage({input,output,cacheRead,cacheWrite,charged,detail,model}, ctx)  用量统计/扣费 (卡密插件)
 * billing(usage, ctx)→number|{charged,detail}|null   动态计费 (billing 插件; null=按老口径 input+output)
 * onChatDone(rec, ctx)                 请求完成 (record 插件)
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

/* 用量写回 (含缓存字段) —— usageCapture 是**所有结算路径**的唯一来源。
 * 以前 4 处结算点各写 input/output 两行, 加一个字段要改 4 个地方且容易漏；
 * 统一走这里, 缓存字段(deepseek/claude/gemini 各有各的名字, 见 canonical.pickCache)才不会漏采。 */
function putUsage(cap, u) {
  cap.input = (u && u.input) || 0;
  cap.output = (u && u.output) || 0;
  cap.cacheRead = (u && u.cacheRead) || 0;
  cap.cacheWrite = (u && u.cacheWrite) || 0;
}

// OpenAI 渠道是否用 Responses API 上游 (渠道级 useResponses 覆盖全局 cfg.upstreamResponses)
function chUsesResponses(cfg, ch) {
  if (ch.type !== 'openai') return false;
  return ch.useResponses !== undefined ? !!ch.useResponses : !!cfg.upstreamResponses;
}

function pickChannels(cfg, model, preferChannel) {
  const chs = cfg.channels || [];
  /* ★模型引用「实例:渠道:模型」里点名了渠道时，只在**该渠道**里找（2026-09-18）。
   *  点名了却提供不了该模型 → 返回空候选（上层报 503），**绝不偷偷换到别的渠道** ——
   *  否则"精确指定来源"就失去意义了。 */
  let pool = chs;
  if (preferChannel) {
    pool = chs.filter(ch => ch && ch.name && modelref.channelMatch(preferChannel, ch.name));
    if (!pool.length) return [];
  }
  const candidates = [];
  if (model) {
    // 1) modelMap 精确命中
    for (const ch of pool) {
      if (ch.modelMap && Object.prototype.hasOwnProperty.call(ch.modelMap, model)) {
        candidates.push({ ch, upstreamModel: String(ch.modelMap[model]) });
      }
    }
    // 2) models 列表命中 (避免和 modelMap 重复加入同一渠道)
    if (!candidates.length) {
      for (const ch of pool) {
        if (ch.models && ch.models.includes(model)) candidates.push({ ch, upstreamModel: model });
      }
    }
  }
  // 3) 没有任何精确命中 → 用 default 渠道 (可多个) 或全部渠道兜底
  if (!candidates.length) {
    if (preferChannel) return [];
    const defs = chs.filter(c => c.default);
    const pool2 = defs.length ? defs : chs;
    for (const ch of pool2) candidates.push({ ch, upstreamModel: model || '' });
  }
  if (!candidates.length) return [];
  // round-robin: 用 model 做 key 的计数器决定起始偏移
  if (!cfg._rr) cfg._rr = {};
  const key = model || '__nomodel__';
  cfg._rr[key] = ((cfg._rr[key] || 0) + 1) % candidates.length;
  const rot = cfg._rr[key];
  return candidates.slice(rot).concat(candidates.slice(0, rot));
}

// 向后兼容: 返回第一个候选
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

/* ================= 成功率探测(probe) =================
 * cfg.probe = { enable:false, intervalMin:10, mode:'models'|'chat' }; 渠道级: ch.probe=true
 * mode=models 免费探活; mode=chat 花token; 结果在 cfg._stats.probe */

function buildRequestForChannel(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req, opts = {}) {
  // forceConvert(如思考链精简插件要求)时, 即使同格式也走 canonical 转换路径(否则直通管道会绕过插件);
  // 客户端 API(chat/responses) 与上游 API(chat/responses) 不一致时也必须走转换中枢
  const upApi = chUsesResponses(cfg, ch) ? 'responses' : 'chat';
  const direct = clientFormat === ch.type && clientApi === upApi && !opts.forceConvert;
  const stream = canonical.stream;
  const upstreamModel = canonical.model; // 已被调用方改写为该渠道的上游模型名
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


/* ================= ★流收尾保护 (2026-09-18) =================
 * 用户报「有时候很久等不到模型返回结束正文的参数」「思考开始/结束不太正常」。
 * 实测：上游中转站会长时间静默，或干脆不给结束标记；内核 idle 超时(默认 180s)一到就掐断
 * 连接 —— 客户端于是"永远转圈"。这里给下游补三档保护（**只对真 SSE 生效**）：
 *   ① 上游静默 >= beatSec → 向下游写 SSE 注释心跳（不改内容，只保连接/防中间层超时）；
 *   ② 上游异常中断 → 先补一个规范的结束事件，再关流（客户端能正常收尾）；
 *   ③ 上游正常结束但没给结束标记(finish_reason/[DONE]) → 同样补上（客户端靠它知道"说完了"）。
 * 配置：cfg.streamGuard = false 关闭；{ beatSec } 调心跳阈值（默认 15 秒）。
 * 注：注释行(`: ...`)是所有 SSE 客户端都会忽略的，不会污染正文。 */
function streamGuardOpt(cfg) {
  const sg = (cfg && cfg.streamGuard);
  if (sg === false || (sg && sg.enable === false)) return { enable: false, beatSec: 15 };
  return { enable: true, beatSec: Math.max(3, Number(sg && sg.beatSec) || 15) };
}

/* 直通路径的"规范收尾"（按客户端格式写） */
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

/* ===== 上游"参数不受支持"自适应降级 (2026-10-01) =====
 * 背景：部分上游对不认识的参数会直接拒绝 —— 有的回 400（body 里点名 Unsupported parameter(s): X），
 *       有的回 200 却在流里塞 {"error":{... internal_server_error ...}}。
 * ★铁律：**默认一律原样转发，绝不预先剥参** —— 上游支持时这个能力必须照常生效。
 *   只有"真的被上游拒了"之后，才把该参数记进**本进程内存**的渠道级名单，剔除后重试一次；
 *   名单不落盘 → 网关重启即忘，上游哪天支持了会自动恢复传参，不会变成永久禁用。 */
const PARAM_REJECT = new Map();      /* key='uid|实例|渠道' → Set<参数名> */
/* 流内报错时无从得知是哪个参数被拒 → 用这份"可疑名单"做一次性降级试探（同样只在失败后才用） */
const FALLBACK_SUSPECT = ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens'];
function rejectKeyOf(cfg, ch) { return String(cfg._uid) + '|' + cfg._name + '|' + (ch && ch.name); }
function rejectedOf(cfg, ch) {
  const k = rejectKeyOf(cfg, ch);
  let s = PARAM_REJECT.get(k);
  if (!s) { s = new Set(); PARAM_REJECT.set(k, s); }
  return s;
}
/* 从上游错误文本里提取被点名的参数（兼容 "Unsupported parameter(s): `a`, `b`" 等写法） */
function parseRejectedParams(txt) {
  const m = /unsupported parameter\(?s?\)?\s*[:：]\s*([^\n]{1,300})/i.exec(String(txt || ''));
  if (!m) return [];
  return m[1].split(/[^A-Za-z0-9_]+/).filter(n => n.length > 1 && n.length < 60);
}
/* 剔除该渠道"已被上游拒过"的参数；没有可剔的 → 原样返回（零拷贝） */
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
/* 首条 SSE data 事件是不是"错误事件"（严格解析 JSON，避免正文里出现 error 字样被误判） */
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
  let last = Date.now(), beats = 0, stopped = false, disarmed = false;   /* disarmed: 上层已接管(降级重试)，禁止再补"结束事件" */
  let sawData = false, atLineEnd = true;   /* ★边界保护(2026-09-18)：见下方两处注释 */
  const tm = setInterval(() => {                       /* 心跳检测（注释行，客户端会忽略） */
    if (stopped) return;
    const idle = Date.now() - last;
    if (idle < opt.beatSec * 1000) return;
    /* ★边界保护 1：上游一个事件可能被 TCP 分成两包。若在"半行"里插注释行，会把
     *  `data: {"半截…: keep-alive 15s` 拼成同一行 → 客户端该事件 JSON 解析失败（**丢事件**）。
     *  所以只在**上一个分块以换行结尾**（= 处于行边界）时才发心跳，否则等下一轮再试。 */
    if (!atLineEnd) return;
    try { res.write(': keep-alive ' + Math.round(idle / 1000) + 's\n\n'); } catch (_) {}
    if (!beats) log('[stream] 上游静默 ' + Math.round(idle / 1000) + 's → 已向下游发心跳', ctx.logMeta, 'ch=' + chName);
    beats++; last = Date.now();
  }, 2000);
  if (tm.unref) tm.unref();
  const stop = () => { stopped = true; try { clearInterval(tm); } catch (_) {} };
  const fire = (why) => {
    /* ★已由上层接管（参数降级重试）→ 绝不能补结束事件，否则客户端先收到一个"假成功"收尾 */
    if (disarmed) return;
    /* ★边界保护 2：上游**一个字节都没产出**就断了 → **不补结束事件**，保持"失败"语义。
     *  否则客户端会把"什么都没收到"显示成"正常结束的空回答"，把真失败伪装成成功。 */
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
    /* ★disarm(2026-10-01)：上层判定"这条流不作数"（要降级重试）时调用 —— 之后 fire() 全部静默，
     *  避免把真失败收尾成"正常结束"。 */
    disarm() { disarmed = true; stop(); },
  };
}

// 处理上游成功响应(2xx): 直通或跨格式转换. hook 化版(原 handleChat 提取).
function handleUpstreamResponse(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req, res, upRes, built, ctx, retryHook, hooks) {
  const { direct, stream, upApi } = built;
  const { usageCapture, stats } = ctx;
  const isResponsesUp = ch.type === 'openai' && upApi === 'responses';

  if (direct) {
    const ct = upRes.headers['content-type'] || (stream ? 'text/event-stream' : 'application/json');
    try {
      /* ★参数降级重试会在同一个 res 上二次进入（首段守卫发现流内错误）→ 报头已发过就跳过，不能重发 */
      if (!res.headersSent) res.writeHead(upRes.statusCode, { 'Content-Type': ct, 'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    } catch (e) {
      /* ★绝不能静默 return：报头下发失败(典型：渠道名含非 ASCII)时，客户端收不到任何
       *  东西、上游响应也无人读取，这个请求会永久悬挂(2026-09-18 实测)。这里改为
       *  明确报错 + 释放上游连接。 */
      logErr('[resp] 响应头下发失败, 已中断该请求:', e.message);
      try {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"gateway: 响应头下发失败","type":"gateway_error"}}'); }
        else res.destroy();
      } catch (_) { try { res.destroy(); } catch (_) {} }
      try { upRes.resume(); } catch (_) {}
      return;
    }
    /* ================= ★首段守卫 + 流内错误降级 (2026-10-01) =================
     * 上游可能"HTTP 200 却在流里先回一条错误事件"（实测 NVIDIA NIM 中转会回
     *   data: {"error":{"message":"Internal server error","type":"internal_server_error","code":500}}
     * 老行为：原样透传，再补一个 finish_reason:"stop" → 把真失败伪装成正常结束。
     * 新行为：在**向客户端写出任何字节之前**先缓冲首个 SSE 事件 ——
     *   ① 是错误事件 → 本条流作废（g.disarm() 不补结束事件），剔除"可疑参数"后重试本渠道；
     *   ② 是正常内容 → 立即放行，之后按老逻辑直通（已写出内容后绝不中途换台）。 */
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
      /* 无法降级 → 明确告知失败（不再伪装成"正常结束"的空回答） */
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
      const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
      const g = makeStreamGuard(res, /text\/event-stream/i.test(String(ct)), streamGuardOpt(cfg), ctx, ch.name,
        () => writeTerminalSSE(res, clientFormat, clientApi));
      ctx._parser = parser; ctx._guard = g;   /* ★交给兜底结算：中断时把已解析到的用量记上 */
      upRes.on('data', c => { try { const s2 = u8(c); g.touch(s2); dec.push(s2); } catch (_) {} });
      upRes.on('end', () => {
        dec.end(); parser.finish(); putUsage(usageCapture, parser.usage);
        if (streamBad) return;                      /* ★已交给降级重试，别再收尾 */
        g.finish(!!parser.finishReason);
        ctx.logDone(upRes.statusCode);
      });
      /* ★收尾丢失的形态不止一种：error / aborted / 连接没结束就 close —— 全部要结算 */
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
      // 直通模式行级处理(保持原始 SSE 结构; 按行匹配, 跨行规则不生效)
      let buf = '';
      const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
      upRes.on('data', c => {
        try {
          buf += u8(c);
          if (!headPassed) {                       /* ★首段守卫：先攒够首个事件再决定是否放行 */
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
      /* ★direct+stream 且无行级 hook：自行转发（同样过首段守卫，并负责 res.end()） */
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

  // 跨格式转换
  if (stream) {
    const isArrayStream = clientFormat === 'gemini' && !urlInfo.altSse;
    try {
      res.writeHead(200, {
        'Content-Type': isArrayStream ? 'application/json' : 'text/event-stream',
        'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
        'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*',
      });
    } catch (e) {
      /* ★绝不能静默 return：报头下发失败(典型：渠道名含非 ASCII)时，客户端收不到任何
       *  东西、上游响应也无人读取，这个请求会永久悬挂(2026-09-18 实测)。这里改为
       *  明确报错 + 释放上游连接。 */
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
    const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
    const g = makeStreamGuard(res, !isArrayStream, streamGuardOpt(cfg), ctx, ch.name,
      () => { if (!writerEnded) onEv({ type: 'end', finish_reason: 'stop' }); });   /* 收尾交回 writer（各格式事件不同） */
    ctx._parser = parser; ctx._guard = g;   /* ★交给兜底结算 */
    upRes.on('data', c => { try { const s2 = u8(c); g.touch(s2); dec.push(s2); } catch (_) {} });
    upRes.on('end', () => {
      dec.end(); parser.finish();
      g.finish(true);                                  /* 转换路径由 parser.finish() 发 end 事件，视为已有标记 */
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
        // 上游 200 但正文不是 JSON(HTML 错误页等, content-type 也可能伪装成 json): 可重试
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

/* 主转发入口: 客户端 chat/messages/generateContent/responses → 渠道路由 → 上游
 * clientFormat: 'openai'|'claude'|'gemini'; clientApi: 'chat'|'responses'
 * urlInfo: {model?, stream?, altSse?, userKey?}  (userKey 由认证插件挂在 checkAuth 返回值里, 内核不解释)
 * hooks: 见 NO_HOOKS; sendError: core 注入的格式化错误输出 */
function handleChat(cfg, clientFormat, clientApi, req, res, urlInfo, bodyStr, hooks, sendError) {
  hooks = normHooks(hooks);
  const stats = cfg._stats;
  /* ★按用户隔离统计（2026-09-18）：卡密身份 = 绑定用户 uid 或卡密哈希（见 util.keyIdOf）。
   *   它同时进：① recent 每条记录（页面按用户过滤）；② stats.byKey[<keyId>]（按用户累计）；
   *   ③ usage-history 的 per-key 桶（按用户的历史曲线）。免密请求 keyId='' → 只进实例级账本。 */
  const keyId = keyIdOf(urlInfo.userKey);
  const keyName = keyNameOf(urlInfo.userKey);
  let body;
  try { body = JSON.parse(bodyStr || '{}'); } catch (e) { return sendError(clientFormat, res, 400, 'invalid JSON body: ' + e.message); }
  if (!body || typeof body !== 'object') return sendError(clientFormat, res, 400, 'request body must be a JSON object');

  // hook: 请求体过滤 (redact/replace.out 插件)
  try { body = hooks.onRequestBody(body, { cfg, urlInfo, clientFormat, clientApi }) || body; }
  catch (e) { logErr('[hooks] onRequestBody:', e.message); }

  const canonical = (clientApi === 'responses') ? responsesToCanonical(body, urlInfo.model) : TO_CANON[clientFormat](body, urlInfo.model);
  /* ★模型引用（实例:渠道:模型）在 core 里已解析：这里把 canonical.model 换回**真名** ——
   *  计费(billing 按 渠道+模型名 查价)、分组鉴权、日志统计一律用真名；原始字符串留在 rawModel 备查。 */
  if (urlInfo.modelOverride) { canonical.rawModel = canonical.model; canonical.model = String(urlInfo.modelOverride); }
  if (urlInfo.stream) canonical.stream = true; // gemini: 流式标志在 URL 路径里
  if (!canonical.model) return sendError(clientFormat, res, 400, 'missing "model"');

  // hook: 授权检查 (卡密白名单: 模型/分支)
  const authDecision = hooks.onChatAuth({ userKey: urlInfo.userKey, model: canonical.model, instance: cfg._name, uid: cfg._uid, cfg, body, canonical });
  if (authDecision && (authDecision.status || authDecision.message))
    return sendError(clientFormat, res, authDecision.status || 403, authDecision.message || 'forbidden');

  const candidates = pickChannels(cfg, canonical.model, urlInfo.forceChannel);
  if (!candidates.length) return sendError(clientFormat, res, 503, 'no channel configured for model: ' + canonical.model);

  /* 预授权放在“确认有渠道”之后：冻结失败立即拒绝；冻结成功后无论成功、失败、断开，
   * 都由 releaseQuota 释放。真正的 usedTokens 仍只在 ctx.logDone() 的 onUsage 中增加。
   * ★口径统一 (2026-09-18)：冻结值必须是**额度**，不能是 token 数 —— 结算走 billing
   *  （charged = raw/1e6 × 倍率，量级 1e-3），若预授权按 token 冻结（量级 1e3）就大
   *  100 万倍：额度 99.97 的卡会因「本次请求预授权需要约 13209」被 429 拒掉，而那次
   *  实际只扣 0.01。换算只能由「价格唯一真相」的 billing 做（onQuotaEstimate），
   *  所以这里把换算做成回调传下去：认证插件估 token，需要换额度时问它；拿不到估算值
   *  （未装 billing / 模型未定价）→ 认证插件回退 token 口径，与老口径结算严格一致。 */
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

  /* ================= ★收尾兜底（2026-09-18）=================
   * 事故：流式请求的"收尾事件"一旦丢失（上游中断 / 报错 / 静默超时 / 客户端断开），旧代码只在
   * upRes 的 error 分支给下游补个结束标记就 return —— 不调 logDone、不计 errors，于是统计里
   * 永久留下「1 次请求 / 0 token / 最近请求为空 / 错误 0」的幽灵记录（用户实测：上游 18:27:06
   * 已 200 完成，core 侧 9 分钟不结算，使用页显示 0 / 0）。
   * 现在：任何非正常收尾都**恰好结算一次**，并尽量把已解析到的用量记上。
   * 计费口径（用户 2026-09-18 定）：能解析到用量就按用量扣，零用量只计错误。
   * ========================================================= */
  let settled = false;        /* 结算开关：end / error / close / 硬超时 只允许第一个生效 */
  let currentCtx = null;      /* 当前候选渠道的 ctx（挂着 _parser / _guard / _upReq） */
  let hardTimer = null;       /* 硬上限定时器（见下方 maxStreamSec） */
  const settleAbnormal = (status, why, countErr) => {
    if (settled) return;
    const c = currentCtx;
    if (!c) { settled = true; return; }   /* 还没进入转发阶段（授权被拒等）→ 本就不该产生统计 */
    const p = c._parser;
    try { if (p && p.usage) putUsage(usageCapture, p.usage); } catch (_) {}
    if (countErr) stats.errors++;
    log('ABORT', c.logMeta, why, 'status=' + status,
      'in=' + usageCapture.input, 'out=' + usageCapture.output);
    c.logDone(status);
  };
  /* 客户端断开、上游异常等不一定能走正常响应路径，close 是最后保险；幂等释放 + 兜底结算
   * （★结算不能漏：否则该请求在统计里永不落账，使用页「最近请求」永远空着）。 */
  res.once('close', () => {
    releaseQuotaOnce();
    if (!settled) settleAbnormal(499, '客户端提前断开', false);
  });

  /* ★硬上限：上游"永不结束"（不给结束标记、连接又一直有活动 → socket idle 超时不会触发）时
   * 不能无限悬挂。到点：给下游补结束标记 → 结算(504, 计错误) → 断开上游。
   * cfg.maxStreamSec 设 0 可关闭。 */
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
  /* u 可以是老的 (inT, outT) 数字对, 也可以是 logDone 传的完整 usage 对象(推荐) */
  const recordReq = (status, chName, u, outTArg) => {
    settled = true;   /* 其它结算口(错误透传 / 重试耗尽)也算"已落账"，避免 close/硬超时再补一次 */
    if (hardTimer) { try { clearTimeout(hardTimer); } catch (_) {} }
    releaseQuotaOnce();
    /* ★注意: 这是箭头函数, 没有自己的 arguments —— 老调用的第4个参数必须走形参 outTArg,
     *  写 arguments[3] 会取到 handleChat 的 arguments(踩过的坑)。 */
    const o = (u && typeof u === 'object') ? u : { input: u || 0, output: outTArg || 0 };
    const inT = o.input || 0, outT = o.output || 0;
    stats.recent.push({
      id: reqId, time: new Date().toISOString().slice(0, 19).replace('T', ' '), model: canonical.model, channel: chName || '', status,
      duration: Date.now() - t0, inputTokens: inT, outputTokens: outT,
      cacheReadTokens: o.cacheRead || 0, cacheWriteTokens: o.cacheWrite || 0,
      chargedTokens: o.charged != null ? o.charged : undefined,
      keyName: keyName || undefined,
      /* ★按用户隔离用：keyId=用户uid/卡密哈希（''=免密请求）。keyName 只能当展示名，
       *   过滤必须以 keyId 为准（卡密可重名、可改名）。 */
      keyId: keyId || undefined,
    });
    if (stats.recent.length > 200) stats.recent.shift();
    /* ★按用户累计（2026-09-18）：实例级 byChannel 之外再来一份 per-key 的，
     *   让用户端「使用」页能看到**自己的**请求数/错误/token/计费量与渠道排行。
     *   内存对象，重启归零（与实例级 byChannel 语义一致）；历史曲线走 usage-history 的 per-key 桶。 */
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
    /* ★使用统计历史(2026-09-18): 内存 recent 只有 200 条且重启归零,
     *  「使用」页要按"任意时段 / 折点密度"看统计就必须有持久历史 —— 这里只把刚落账的
     *  这条记录累加进内存桶(极轻量), 落盘由内核 60s 定时 flush 负责(见 usage-history.js)。
     *  ★2026-09-18 加第三参 keyId：同时累加一份 per-key 桶（按用户隔离的历史曲线）。 */
    try { usageHist.bump(cfg._uid, stats.recent[stats.recent.length - 1], keyId); } catch (_) {}
    if (hooks.onChatDone) {
      try {
        hooks.onChatDone({
          id: reqId, time: new Date().toISOString(), instance: cfg._name, uid: cfg._uid, format: clientFormat,
          model: canonical.model, channel: chName || '', status, duration: Date.now() - t0,
          inputTokens: inT, outputTokens: outT,
          cacheReadTokens: o.cacheRead || 0, cacheWriteTokens: o.cacheWrite || 0,
          /* charged = 实际从卡密额度扣掉的加权 token 数(null=按老口径 input+output) */
          chargedTokens: o.charged != null ? o.charged : null,
          billDetail: o.detail || null,
          /* ★按用户隔离（2026-09-18）：keyId=用户uid/卡密哈希、keyName=卡密名 —— 插件（record/billing）
           *   可用它把自己记账的明细也按用户分开，不用再自己解析密钥。 */
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

  /* ★参数降级重试（2026-10-01）：只在"被上游明确拒绝"后调用，绝不预先剥参。
   *   剔除 → 记入本渠道内存名单 → 重跑当前这个渠道（attempt 已自增，先退回一格）。 */
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

  // 逐个候选渠道尝试, 连接失败或可重试的 HTTP 错误 → 切下一个; 不可重试错误(如 400) → 直接透传
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
    const effBody = bodyWithoutRejected(cfg, ch, body);   /* ★只剔"已被本渠道拒过"的参数（无则零拷贝原样） */
    const built = buildRequestForChannel(cfg, ch, clientFormat, clientApi, myCanonical, effBody, urlInfo, req, { forceConvert });
    attempt++;

    // HTTP 头只允许 ASCII, 中文/全角字符的 apiKey 会让 node 抛内部错误
    for (const [hk, hv] of Object.entries(built.headers)) {
      if (typeof hv === 'string' && !/^[\x09\x20-\x7e]*$/.test(hv)) {
        return sendError(clientFormat, res, 500, `渠道 "${ch.name}" 的请求头 ${hk} 含非 ASCII 字符(可能是 apiKey 里残留了中文占位符), 请检查配置`);
      }
    }

    const ctx = {
      t0, usageCapture, stats,
      logMeta: [clientFormat + '>' + ch.type, 'model=' + canonical.model, 'ch=' + ch.name, 'proxy=' + (ch.proxy || '-'), stream ? 'stream' : 'block'].join(' '),
      /* ★兜底结算入口（实现见 handleChat 顶部的 settleAbnormal）：上游中断 / 硬超时 / 客户端断开时调用 */
      abort: (e) => settleAbnormal(502, '上游中断(' + ((e && e.message) || e || '未知') + ')', true),
      logDone(status) {
        if (settled) return;   /* ★幂等：end / error / close / 硬超时 都可能来，只结算一次 */
        settled = true;
        if (hardTimer) { try { clearTimeout(hardTimer); } catch (_) {} }
        /* ★用量对象：**一次性组装好**再交给 billing / onUsage / onChatDone。
         * 以前 onUsage 只收到 {input,output} —— 连模型名都没有，按模型定价无从谈起；
         * 缓存量也拿不到。现在把计费需要的一切都放进来（额外字段，老插件读 input/output 不受影响）。 */
        const usage = {
          input: usageCapture.input, output: usageCapture.output,
          cacheRead: usageCapture.cacheRead || 0, cacheWrite: usageCapture.cacheWrite || 0,
          model: canonical.model, channel: ch.name, format: clientFormat,
          t0, at: Date.now(),
        };
        /* 动态计费：插件(通常是 billing)在这里算出「应扣多少」。
         * · 返回数字 或 {charged, detail} → 计费插件按 charged 扣（可自由定义加权口径）
         * · 返回 null / 未装动态计费插件 → charged 保持 null → 卡密插件回退老口径 input+output
         *   （★这就是向后兼容的关键：没装 billing 时扣费与今天完全一致） */
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
        /* 缓存量单独累计(不影响老字段) —— 使用页/成本核算要看缓存命中率 */
        if (usage.cacheRead) stats.byChannel[ch.name].cacheReadTokens = (stats.byChannel[ch.name].cacheReadTokens || 0) + usage.cacheRead;
        if (usage.cacheWrite) stats.byChannel[ch.name].cacheWriteTokens = (stats.byChannel[ch.name].cacheWriteTokens || 0) + usage.cacheWrite;
        if (charged != null) stats.chargedTokens = (stats.chargedTokens || 0) + charged;
        if (hooks.onUsage) { try { hooks.onUsage(usage, { cfg, ch, urlInfo, stats }); } catch (e) { logErr('[hooks] onUsage:', e.message); } }
        recordReq(status, ch.name, usage);
      },
    };
    currentCtx = ctx;   /* ★把本次尝试挂到兜底结算上（_parser/_guard/_upReq 由转发层填） */
    ctx.dropParamsAndRetry = dropParamsAndRetry;   /* ★供流内错误守卫调用（handleUpstreamResponse） */
    stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
    stats.byChannel[ch.name].requests++;

    // 渠道级排队延迟(delayMs): 并发请求经 _gate 链按间隔串行发出, 缓解 429 限流
    const delayMs = Math.min(120000, Number(ch.delayMs) || 0);
    // 连接级错误 / HTML 冒充成功的同渠道重试(cfg.connRetry 次, 每次换全新连接)
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
      /* ★保留上游连接的引用：硬上限到点要能强制断开它（否则请求永远悬挂） */
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

      // 上游拿 HTML 网页冒充成功(CDN 验证页/中转站故障页): 视为可重试错误, 先重试本渠道再换渠道
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
        // 不可重试错误(如 400) 或已是最后候选 → 原样透传错误
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          /* ★上游点名"不支持的参数" → 记入本渠道内存名单、剔除后重试本渠道（默认并不剥参） */
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
          /* 错误透传阶段读失败也要落账（否则又是一条"1 次请求 0 消耗"的幽灵记录） */
          stats.errors++;
          recordReq(502, ch.name, 0, 0);
          try { res.end(); } catch (_) {}
        });
        return;
      }

      // 成功(2xx) → 正常处理, 从此不可回退(正文非 JSON 冒充成功时仍可经 hook 重试)
      handleUpstreamResponse(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req, res, upRes, built, ctx, (why) => {
        lastErrStatus = 502; lastErrMsg = why;
        return retrySameOrNext(why);
      }, hooks);
      }, undefined, fresh ? makeFreshAgents(cfg, ch) : undefined);
      ctx._upReq = upReq;   /* 挂到 ctx：硬超时 / 兜底结算要能拿到 */
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
