'use strict';
/* record 插件 - 请求记录(JSONL)
 * 配置: { enable, keepDays }   ← keepDays=0（默认）= **永久保留**；>0 才按天滚动删除
 * 输出: plugins/record/records/<uid>-YYYYMMDD.jsonl (每日一个文件)
 * 端点: /plugins/record/today (查今日聚合) /plugins/record/recent?n=20
 * ★2026-09-18 修两处：① 清理原本只在 activate 里跑一次（不重启网关就**永不清理**，与 usage-history
 *   同族缺陷）→ 改 `ctx.cron` 定时 + 激活时整理一次；② 删掉**从未被代码使用**的 `maxChars`
 *   字段（schema 写着"正文记录上限"，实际正文压根不记录，留着只会误导）。
 */
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
          /* ★按用户区分（内核 v0.7.0 起 onChatDone 载荷自带）：keyId = 用户 uid 或卡密哈希（不含明文卡密） */
          keyId: rec.keyId || '',
        };
        fs.appendFile(fileOf(), JSON.stringify(row) + '\n', () => {});
      } catch (_) {}
    });
    /* 清理超期文件：keepDays = 0（默认）→ **永久保留**，不删；>0 才按天滚动删除 */
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
    /* ★定时清理（每 6 小时）+ 激活时整理一次 ——
     *  以前只在 activate 里清一次，网关长期不重启就等于"保留 7 天"的承诺不成立。 */
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
