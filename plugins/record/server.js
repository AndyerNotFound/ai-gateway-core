'use strict';








const fs = require('fs');
const path = require('path');

function jsonRes(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); }

module.exports.activate = (ctx) => {
  const cfg = ctx.config;
  const dir = path.join(ctx.dataDir, 'records');
  const fileOf = () => path.join(dir, ctx.uid + '-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.jsonl');

  if (cfg.enable) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    ctx.hook('onChatDone', (rec) => {
      try {
        const row = {
          t: new Date().toISOString(), model: rec.model, ch: rec.channel,
          pt: rec.inputTokens || 0, ct: rec.outputTokens || 0,
          ms: rec.duration || 0, status: rec.status, format: rec.format,
          keyName: (rec.userKey && (rec.userKey.name || (rec.userKey.key || '').slice(0, 24)) || '').toString().slice(0, 24),
          
          keyId: rec.keyId || '',
        };
        fs.appendFile(fileOf(), JSON.stringify(row) + '\n', () => {});
      } catch (_) {}
    });
    
    const prune = () => {
      try {
        const keep = Number(cfg.keepDays) || 0;
        if (!(keep > 0)) return;
        const cutoff = Date.now() - keep * 86400000;
        for (const f of fs.readdirSync(dir)) {
          const m = f.match(/-(\d{8})\.jsonl$/);
          if (m && new Date(m[1].slice(0, 4) + '-' + m[1].slice(4, 6) + '-' + m[1].slice(6, 8)).getTime() < cutoff) {
            try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
          }
        }
      } catch (_) {}
    };
    

    ctx.cron(6 * 3600 * 1000, prune);
    prune();
  }

  const readToday = () => {
    try { return fs.readFileSync(fileOf(), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); }
    catch (_) { return []; }
  };

  ctx.registerRoute('GET', '/today', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const recs = readToday();
    const byCh = {};
    let pt = 0, ct = 0;
    for (const r of recs) {
      byCh[r.ch] = byCh[r.ch] || { n: 0, pt: 0, ct: 0 };
      byCh[r.ch].n++; byCh[r.ch].pt += r.pt; byCh[r.ch].ct += r.ct;
      pt += r.pt; ct += r.ct;
    }
    jsonRes(res, 200, { enable: !!cfg.enable, count: recs.length, inputTokens: pt, outputTokens: ct, byChannel: byCh });
  });
  ctx.registerRoute('GET', '/recent', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const n = Math.min(200, Math.max(1, Number(p.query.n) || 20));
    jsonRes(res, 200, { records: readToday().slice(-n).reverse() });
  });

  ctx.log('请求记录插件已激活:', cfg.enable ? '开' : '关');
};
