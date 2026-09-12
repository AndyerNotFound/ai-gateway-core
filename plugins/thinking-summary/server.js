'use strict';
                                                  
                                                                                                                  
                                                                                        
   
module.exports.activate = (ctx) => {
  const tsCfg = ctx.config;
  tsCfg.enable = !!tsCfg.enable;
  tsCfg.mode = tsCfg.mode === 'summarize' ? 'summarize' : 'truncate';
  tsCfg.maxCharsPerSegment = Math.max(10, Number(tsCfg.maxCharsPerSegment) || 80);
  tsCfg.maxSegments = Math.max(1, Number(tsCfg.maxSegments) || 12);
  if (!tsCfg.summarizePrompt) tsCfg.summarizePrompt = '用一句话中文概括以下思考片段:';

                             
  function truncateReasoning(text, maxChars) {
    if (!text) return '';
    const out = [];
    for (const rawLine of String(text).split('\n')) {
      if (!rawLine.trim()) continue;
      if (rawLine.length <= maxChars) { out.push(rawLine); continue; }
      const step = maxChars * 2;
      for (let i = 0; i < rawLine.length && out.length < 60; i += step) {
        const c = rawLine.slice(i, i + maxChars);
        out.push(c + (i + maxChars < rawLine.length ? '…' : ''));
      }
    }
    return out.join('\n');
  }
  function normalizeSummarizeUrl(baseUrl) {
    let u = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (/\/chat\/completions$/.test(u)) return u;
    if (/\/v1$/.test(u)) return u + '/chat/completions';
    return u + '/v1/chat/completions';
  }
                                       
  function callUpstreamText(baseUrl, apiKey, model, prompt) {
    return new Promise((resolve) => {
      const url = normalizeSummarizeUrl(baseUrl);
      if (!url || !model || !prompt) return resolve(null);
      if (apiKey && !/^[\x09\x20-\x7e]*$/.test(apiKey)) return resolve(null);
      const bodyBuf = Buffer.from(JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }] }));
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        ctx.upstreamRequest({
          url, headers: { authorization: 'Bearer ' + (apiKey || '') }, body: bodyBuf, method: 'POST',
          ch: { proxy: null, insecure: false },
          cb: (err, upRes) => {
            if (err) return finish(null);
            const chunks = [];
            upRes.on('data', c => chunks.push(c));
            upRes.on('end', () => {
              if (upRes.statusCode >= 400) return finish(null);
              let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return finish(null); }
              try { const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content; finish(typeof c === 'string' ? c : ''); }
              catch (e) { finish(null); }
            });
            upRes.on('error', () => finish(null));
          },
        });
      } catch (e) { finish(null); }
    });
  }
  async function summarizeReasoningText(reasoning) {
    if (!reasoning) return '';
    const baseUrl = String(tsCfg.summarizeBaseUrl || '').trim();
    const apiKey = String(tsCfg.summarizeApiKey || '').trim();
    const model = String(tsCfg.summarizeModel || '').trim();
    if (!baseUrl || !model) return truncateReasoning(reasoning, tsCfg.maxCharsPerSegment);
    const segs = String(reasoning).split('\n').map(s => s.trim()).filter(Boolean);
    const merged = [];
    let cur = '';
    for (const s of segs) {
      if ((cur ? cur.length + 1 + s.length : s.length) < 200) cur = cur ? cur + '\n' + s : s;
      else { if (cur) merged.push(cur); cur = s; }
    }
    if (cur) merged.push(cur);
    const list = merged.slice(0, tsCfg.maxSegments);
    if (!list.length) return '';
    const results = await Promise.all(list.map(seg => callUpstreamText(baseUrl, apiKey, model, tsCfg.summarizePrompt + '\n\n' + seg).catch(() => '')));
    return results.filter(Boolean).map(s => '• ' + String(s).trim()).join('\n');
  }
  async function summarizeOneSegment(text) {
    const baseUrl = String(tsCfg.summarizeBaseUrl || '').trim();
    const apiKey = String(tsCfg.summarizeApiKey || '').trim();
    const model = String(tsCfg.summarizeModel || '').trim();
    const maxChars = tsCfg.maxCharsPerSegment;
    if (!baseUrl || !model || !text) return null;
    const fallbackText = text.slice(0, maxChars).replace(/\n+/g, ' ').trim();
    const fallback = fallbackText ? '• ' + fallbackText + '\n' : null;
    try {
      const s = await callUpstreamText(baseUrl, apiKey, model, tsCfg.summarizePrompt + '\n\n' + text);
      if (s && String(s).trim()) return '• ' + String(s).trim() + '\n';
      ctx.log('[thinkingSummary] 模型返回空, 回退截断(' + text.length + '字)');
      return fallback || null;
    } catch (e) {
      ctx.log('[thinkingSummary] 单段总结失败, 回退截断:', e.message);
      return fallback || null;
    }
  }

                              
  function wrapTS(writer) {
    if (!tsCfg.enable) return writer;
    const mode = tsCfg.mode;
    const maxChars = tsCfg.maxCharsPerSegment;

    if (mode === 'truncate') {
      let lineBuf = '', saw = false, done = false, needSep = false;
      const emit = (t) => { if (needSep) writer.onEvent({ type: 'reasoning', t: '\n\n' }); writer.onEvent({ type: 'reasoning', t }); needSep = true; };
      const emitSeg = (line) => {
        line = line || '';
        if (!line.trim()) return;
        if (line.length <= maxChars) { emit(line); return; }
        const step = maxChars * 2;
        for (let i = 0; i < line.length; i += step) {
          const c = line.slice(i, i + maxChars);
          emit(c + (i + maxChars < line.length ? '…' : ''));
        }
      };
      return {
        onEvent(ev) {
          if (ev.type === 'reasoning') {
            saw = true;
            lineBuf += ev.t;
            const lines = lineBuf.split('\n');
            lineBuf = lines.pop();
            for (const ln of lines) emitSeg(ln);
          } else {
            if (saw && !done) { done = true; if (lineBuf) emitSeg(lineBuf); lineBuf = ''; }
            writer.onEvent(ev);
          }
        },
      };
    }

                                                             
    let buf = '', saw = false, closed = false, reasoningClosed = false, textFlushed = false;
    let pending = 0, pendingEnd = null, textQ = null;
    const flushEnd = () => { if (pendingEnd && pending === 0) { const e = pendingEnd; pendingEnd = null; closed = true; writer.onEvent(e); } };
    const releaseText = () => { if (!textQ) return; const q = textQ; textQ = null; textFlushed = true; for (const e of q) writer.onEvent(e); };
    const dispatch = (seg) => {
      pending++;
      summarizeOneSegment(seg).then(s => {
        if (s && !closed && !textFlushed) writer.onEvent({ type: 'reasoning', t: s });
      }).catch(() => {}).then(() => { pending--; if (pending === 0) releaseText(); flushEnd(); });
    };
    return {
      onEvent(ev) {
        if (ev.type === 'reasoning') {
          if (reasoningClosed) { if (textQ) textQ.push(ev); else writer.onEvent(ev); return; }
          saw = true;
          buf += ev.t;
          while (buf.length >= 200) { const seg = buf.slice(0, 200); buf = buf.slice(200); dispatch(seg); }
        } else if (ev.type === 'text') {
          if (saw && buf && !reasoningClosed) { const tail = buf; buf = ''; reasoningClosed = true; dispatch(tail); }
          else if (!saw) reasoningClosed = true;
          if (textQ) textQ.push(ev);
          else if (pending > 0 && !textFlushed) { textQ = [ev]; setTimeout(releaseText, 10000); }
          else writer.onEvent(ev);
        } else if (ev.type === 'end') {
          if (textQ) textQ.push(ev);
          else { pendingEnd = ev; flushEnd(); }
        } else writer.onEvent(ev);
      },
    };
  }

                         
  ctx.hook('needConvert', () => tsCfg.enable);
  ctx.hook('wrapWriter', (writer) => wrapTS(writer));
  ctx.hook('processCanonicalResp', (cresp, c) => {
    if (!tsCfg.enable || !cresp.reasoning) return;
    if (tsCfg.mode === 'summarize') {
      return summarizeReasoningText(cresp.reasoning).then(r2 => { cresp.reasoning = r2; });
    }
    cresp.reasoning = truncateReasoning(cresp.reasoning, tsCfg.maxCharsPerSegment);
  });

  ctx.log('思考链精简已激活:', tsCfg.enable ? tsCfg.mode : '关');
};
