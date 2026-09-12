'use strict';
                     
                                                         
                                                                          
                                                     
   
function jsonRes(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); }

module.exports.activate = (ctx) => {
  const cfg = ctx.config;
  const data = () => ctx.data.get('probe') || {};
  const setData = (d) => ctx.data.set('probe', d);

  const probeOnce = (ch) => {
    const d = data();
    const rec = d[ch.name] = d[ch.name] || { total: 0, ok: 0, lastAt: '', lastOk: '', lastErr: '' };
    rec.total++;
    rec.lastAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const done = (ok_, err) => {
      if (ok_) { rec.ok++; rec.lastOk = rec.lastAt; rec.lastErr = ''; }
      else rec.lastErr = String(err || 'failed').slice(0, 120);
      setData(d);
    };
    const { joinUrl } = require('../../src/router.js');
    try {
      if (cfg.mode === 'chat') {
        const model = (ch.models && ch.models[0]) || 'default';
        const body = Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }));
        ctx.upstreamRequest({ ch, url: joinUrl(ch.baseUrl, '/chat/completions'), body, cb: (err, upRes) => {
          if (err) return done(false, err.message);
          upRes.resume();
          done(upRes.statusCode < 500, 'HTTP ' + upRes.statusCode);
        } });
      } else {
        ctx.upstreamRequest({ ch, url: joinUrl(ch.baseUrl, '/models'), method: 'GET', cb: (err, upRes) => {
          if (err) return done(false, err.message);
          upRes.resume();
          done(upRes.statusCode < 500, 'HTTP ' + upRes.statusCode);
        } });
      }
    } catch (e) { done(false, e.message); }
  };

  const probeRound = () => {
    const inst = ctx.gateway.listInstances().find(i => i.uid === ctx.uid);
    if (!inst || !inst.enabled) return;
    const seen = new Set();
    for (const pick of ctx.pickChannels()) {
      const ch = pick.ch;
      if (!ch || !ch.probe || seen.has(ch.name)) continue;
      seen.add(ch.name);
      try { probeOnce(ch); } catch (_) {}
    }
  };

  if (cfg.enable) {
    const iv = Math.max(1, Number(cfg.intervalMin) || 10) * 60000;
    ctx.cron('probe-round', iv, probeRound);
    setTimeout(probeRound, 20000).unref();               
  }

  ctx.registerRoute('GET', '/status', (req, res) => {
    const d = data();
    const out = {};
    for (const [k, v] of Object.entries(d)) out[k] = { rate: v.total ? Math.round(v.ok / v.total * 100) : null, total: v.total, lastOk: v.lastOk, lastErr: v.lastErr };
    jsonRes(res, 200, { enable: !!cfg.enable, mode: cfg.mode || 'models', channels: out });
  });
  ctx.registerRoute('POST', '/run', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    probeRound();
    jsonRes(res, 200, { ok: true, msg: '已触发一轮探测' });
  });

  ctx.log('探测插件已激活:', cfg.enable ? ('间隔 ' + (cfg.intervalMin || 10) + 'min ' + (cfg.mode || 'models')) : '关');
};
