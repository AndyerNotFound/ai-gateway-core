'use strict';
                                       
                                                                        
                                
   
const { spawn } = require('child_process');

function jsonRes(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); }

                        
const G = globalThis.__agwTunnel = globalThis.__agwTunnel || { proc: null, url: '', log: [] };
const pushLog = (s) => { G.log.push(s); if (G.log.length > 50) G.log.shift(); };

module.exports.activate = (ctx) => {
  const adminOnly = (p, res) => { const a = p.authAdmin(); if (!a.ok) { jsonRes(res, a.status || 401, { error: a.error }); return false; } return true; };

  ctx.registerRoute('GET', '/status', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    jsonRes(res, 200, { running: !!G.proc, url: G.url, log: G.log.slice(-12) });
  });

  ctx.registerRoute('POST', '/start', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    if (G.proc) return jsonRes(res, 200, { ok: true, url: G.url, running: true, already: true });
    const mainPort = (ctx.gateway.listInstances().find(i => i.uid === ctx.uid) || {}).port || 16384;
    try {
      G.proc = spawn('cloudflared', ['tunnel', '--url', 'http://127.0.0.1:' + mainPort, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { G.proc = null; return jsonRes(res, 500, { error: 'cloudflared 启动失败(未安装?): ' + e.message }); }
    G.url = '';
    const onData = (buf) => {
      const line = buf.toString();
      pushLog(line.trim().slice(0, 300));
      const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !G.url) { G.url = m[0]; pushLog('隧道地址: ' + G.url); }
    };
    G.proc.stdout.on('data', onData);
    G.proc.stderr.on('data', onData);
    G.proc.on('exit', (code) => { pushLog('隧道退出 code=' + code); G.proc = null; G.url = ''; });
    G.proc.on('error', (e) => { pushLog('隧道错误: ' + e.message); G.proc = null; });
    jsonRes(res, 200, { ok: true, msg: '隧道启动中, 几秒后查 /plugins/tunnel/status 获取地址' });
  });

  ctx.registerRoute('POST', '/stop', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    if (G.proc) { try { G.proc.kill(); } catch (_) {} G.proc = null; }
    const old = G.url; G.url = '';
    jsonRes(res, 200, { ok: true, stopped: old || null });
  });

  ctx.log('隧道插件已激活');
};
