'use strict';























const { spawn, execSync } = require('child_process');
const fs = require('fs');


const RETRY_BASE_MS = 3000;
const MAX_RETRY_ALLOWED = 6;

const RESERVED_SUBDOMAINS = new Set([
  'api', 'update', 'www', 'help', 'developers', 'blog', 'docs', 'support',
  'region1', 'region2', 'h2', 'v2', 'cftunnel', 'tunnel', 'trycloudflare',
]);
const URL_RE = /https:\/\/([a-z0-9][a-z0-9-]*)\.trycloudflare\.com/gi;
const REGISTER_RE = /Registered tunnel connection/;
const CONN_LOST_RE = /Failed to dial|Retrying connection|Connection terminated|no more connections active/;

function jsonRes(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); }


const G = globalThis.__agwTunnel = globalThis.__agwTunnel || { proc: null, url: '', log: [] };

G.log = G.log || []; G.url = G.url || '';
if (typeof G.attempt !== 'number') G.attempt = 0;
if (typeof G.desired !== 'boolean') G.desired = false;
if (!('retryTimer' in G)) G.retryTimer = null;
if (!('watchdogTimer' in G)) G.watchdogTimer = null;
if (!('connected' in G)) G.connected = false;
if (!('phase' in G)) G.phase = 'idle';
if (!('suppressExit' in G)) G.suppressExit = false;
if (!('strategy' in G)) G.strategy = '';
if (!('location' in G)) G.location = '';
if (!('protocol' in G)) G.protocol = '';
if (!('lastExit' in G)) G.lastExit = null;
if (!('plan' in G)) G.plan = null;

const pushLog = (s) => { G.log.push(String(s).slice(0, 300)); if (G.log.length > 50) G.log.shift(); };


function num(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max == null ? n : max, Math.max(min == null ? n : min, n));
}
function buildPlan(rawCfg) {
  const raw = (rawCfg && typeof rawCfg === 'object') ? rawCfg : {};
  
  let protos = String(raw.protocolOrder == null ? 'http2,quic' : raw.protocolOrder)
    .split(',').map(s => s.trim().toLowerCase()).filter(p => p === 'http2' || p === 'quic');
  if (!protos.length) protos = ['http2', 'quic'];
  protos = [...new Set(protos)];
  const ipv = String(raw.edgeIpVersion == null ? '4' : raw.edgeIpVersion).trim();
  const firstIp = (ipv === '4' || ipv === '6') ? ipv : 'auto';
  const argsFor = (p, ip) => {
    const a = [];
    if (p === 'http2') a.push('--protocol', 'http2');
    if (ip !== 'auto') a.push('--edge-ip-version', ip);
    return a;
  };
  const strategies = [];
  for (const p of protos) strategies.push({ name: p + '+IPv' + firstIp, args: argsFor(p, firstIp) });
  if (firstIp !== 'auto') for (const p of protos) strategies.push({ name: p + '+auto', args: argsFor(p, 'auto') });
  const retries = Math.round(num(raw.maxRetries, 3, 0, MAX_RETRY_ALLOWED));
  const retryDelays = [];
  for (let i = 0; i < retries; i++) retryDelays.push(RETRY_BASE_MS * Math.pow(2, i));
  const envW = Number(process.env.AGW_TUNNEL_WATCHDOG_MS);
  const watchdogMs = (Number.isFinite(envW) && envW > 0)
    ? envW
    : Math.round(num(raw.watchdogSec, 20, 5, 300) * 1000);
  return { protos, firstIp, strategies, retryDelays, watchdogMs, raw };
}


function cloudflaredPids() {
  try {
    const out = execSync('pgrep -x cloudflared', { encoding: 'utf8', timeout: 3000 });
    return out.trim().split('\n').filter(Boolean).filter(pid => {
      try {
        const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        return st.slice(st.lastIndexOf(')') + 2).charAt(0) !== 'Z';
      } catch (_) { return false; }
    });
  } catch (_) { return []; }
}


function killAllCloudflared(waitMs) {
  try { execSync('pkill -x cloudflared', { timeout: 3000 }); } catch (_) {}
  const deadline = Date.now() + (waitMs == null ? 1500 : waitMs);
  while (Date.now() < deadline) {
    if (cloudflaredPids().length === 0) return true;
    try { execSync('sleep 0.2', { timeout: 2000 }); } catch (_) {}
  }
  if (cloudflaredPids().length === 0) return true;
  try { execSync('pkill -9 -x cloudflared', { timeout: 3000 }); } catch (_) {}
  try { execSync('sleep 0.3', { timeout: 2000 }); } catch (_) {}
  return cloudflaredPids().length === 0;
}


function pickTunnelUrl(text) {
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text))) {
    const host = String(m[1] || '').toLowerCase();
    if (RESERVED_SUBDOMAINS.has(host)) continue;
    if (host.length < 6) continue;
    return 'https://' + host + '.trycloudflare.com';
  }
  return '';
}






function buildUiPage(isAdmin, st) {
  if (!isAdmin) {
    return {
      gcui: 1, title: '公网隧道',
      root: {
        type: 'column', gap: 12, children: [{
          type: 'card', variant: 'outlined', gap: 8, children: [
            { type: 'text', text: '仅管理员可用', style: 'title3' },
            { type: 'text', text: '公网隧道会把本机网关暴露到互联网，因此只对管理员开放。请用管理端密钥或管理员账号登录后再打开本页。', style: 'caption', color: '$onSurfaceVariant' },
          ],
        }],
      },
    };
  }
  const tone = st.connected ? 'success' : (st.procAlive ? 'warning' : 'neutral');
  const children = [];

  
  const statusCard = {
    type: 'card', variant: 'outlined', gap: 8, children: [
      { type: 'row', gap: 10, children: [
        { type: 'icon', name: 'msym:send', size: 22 },
        { type: 'column', gap: 2, weight: 1, children: [
          { type: 'text', text: 'Cloudflare 公网隧道', style: 'title3' },
          { type: 'text', text: '把本机网关临时暴露到公网（免费临时域名）', style: 'caption', color: '$onSurfaceVariant' },
        ] },
        { type: 'badge', text: st.stateText, tone: tone },
      ] },
      { type: 'kv', label: '阶段', value: st.phaseText },
      { type: 'kv', label: '策略', value: st.strategy || '-' },
      { type: 'kv', label: '协议 / 节点', value: st.protoText },
    ],
  };
  if (st.hasUrl) {
    statusCard.children.push({ type: 'divider' });
    statusCard.children.push({ type: 'row', gap: 8, children: [
      { type: 'text', text: st.url, style: 'mono', weight: 1, maxLines: 1 },
      { type: 'button', icon: 'msym:copy', shape: 'pill', size: 36, style: 'tonal',
        action: { type: 'copy', text: st.url, toast: '已复制域名' } },
    ] });
  }
  if (st.pendingUrl && !st.hasUrl) {
    statusCard.children.push({ type: 'text', text: '⚠ 域名已取得但连接未注册成功，外部暂时打不开：' + st.pendingUrl, style: 'caption', color: '$error', maxLines: 2 });
  }
  if (st.hint) {
    statusCard.children.push({ type: 'text', text: st.hint, style: 'caption', color: '$onSurfaceVariant', maxLines: 3 });
  }
  statusCard.children.push({
    type: 'row', gap: 8, children: [
      { type: 'button', text: '启动', style: 'filled', shape: 'pill', icon: 'msym:check',
        action: { type: 'intent', endpoint: 'intent/start', then: 'reload' } },
      { type: 'button', text: '停止', style: 'outlined', shape: 'pill', icon: 'msym:block',
        action: { type: 'intent', endpoint: 'intent/stop', then: 'reload', confirm: '确定停止公网隧道？外部将无法访问。' } },
    ],
  });
  children.push(statusCard);

  
  const logText = (st.log && st.log.length) ? st.log.slice(-10).join('\n') : '(空)';
  children.push({
    type: 'card', variant: 'outlined', gap: 6, children: [
      { type: 'text', text: 'cloudflared 日志', style: 'title3' },
      { type: 'text', text: logText, style: 'mono', color: '$onSurfaceVariant', maxLines: 12 },
    ],
  });

  
  children.push({
    type: 'card', variant: 'outlined', gap: 6, children: [
      { type: 'text', text: '关于直连被阻断', style: 'title3' },
      { type: 'text', text: '本机实测：直连 Cloudflare 约 40% 时间不通（ICMP 通、TCP 443 被掐），走本地代理则稳定。cloudflared 不读 HTTP(S)_PROXY 环境变量，需在代理 App 里把 Termux 纳入接管范围，隧道才会走代理。', style: 'caption', color: '$onSurfaceVariant' },
    ],
  });

  return { gcui: 1, title: '公网隧道', root: { type: 'column', gap: 12, children } };
}

module.exports.activate = (ctx) => {
  const adminOnly = (p, res) => { const a = p.authAdmin(); if (!a.ok) { jsonRes(res, a.status || 401, { error: a.error }); return false; } return true; };
  const isAdmin = (p) => { try { return !!p.authAdmin().ok; } catch (_) { return false; } };

  
  G.plan = buildPlan(ctx.config);

  
  const readLastUrl = () => { try { return String(ctx.data.get('lastUrl') || ''); } catch (_) { return ''; } };
  const readLastUrlAt = () => { try { return ctx.data.get('lastUrlAt') || null; } catch (_) { return null; } };
  const persistUrl = (url) => { try { ctx.data.set('lastUrl', url); ctx.data.set('lastUrlAt', Date.now()); } catch (_) {} };

  
  function resolveTargetPort() {
    let list = [];
    try { list = ctx.gateway.listInstances() || []; } catch (_) { list = []; }
    const self = list.find(i => i.uid === ctx.uid);
    if (self && self.port) return self.port;
    const main = list.find(i => i.port);
    return main ? main.port : null;
  }

  function clearRetry() { if (G.retryTimer) { clearTimeout(G.retryTimer); G.retryTimer = null; } }
  function clearWatchdog() { if (G.watchdogTimer) { clearTimeout(G.watchdogTimer); G.watchdogTimer = null; } }
  function killTrackedProc() {
    if (G.proc) { G.suppressExit = true; try { G.proc.kill(); } catch (_) {} G.proc = null; }
  }

  
  function snapshot() {
    const pids = cloudflaredPids();
    const sysRunning = pids.length > 0;
    const tracked = !!G.proc && !G.proc.killed;
    const procAlive = sysRunning || tracked;
    const connected = !!G.connected && !!G.url;
    const orphaned = sysRunning && !tracked;
    const phaseText = ({
      idle: '未启动', starting: '正在启动', registering: '域名已取得，等待连接注册',
      connected: '连接已注册', 'waiting-retry': '失败，等待换策略重试', failed: '已失败',
    })[G.phase] || G.phase;
    let hint = '';
    if (orphaned) hint = '隧道进程在运行但网关重启后丢失了上下文。点「停止」再「启动」可恢复。';
    else if (G.retryTimer) hint = '上次策略未成功，正在自动换策略重试…';
    else if (procAlive && !connected) hint = '进程在跑但连接未注册成功（外部打不开），watchdog 会自动换策略重建。';
    else if (!procAlive && readLastUrl()) hint = '上次的免费临时域名已失效（重启隧道即变），重新启动可得新域名。';
    return {
      procAlive, connected, orphaned, pidCount: pids.length,
      hasUrl: connected,                    
      phase: G.phase, phaseText, strategy: G.strategy,
      protocol: G.protocol, location: G.location,
      protoText: (G.protocol || '-') + (G.location ? ' @ ' + G.location : ''),
      url: connected ? G.url : '',
      pendingUrl: (!connected && G.url) ? G.url : '',
      attempt: G.attempt, retrying: !!G.retryTimer,
      watchdogMs: (G.plan && G.plan.watchdogMs) || 20000,
      lastUrl: readLastUrl(), lastUrlAt: readLastUrlAt(),
      lastExit: G.lastExit, log: G.log.slice(-12), hint,
    };
  }

  
  function failover(reason) {
    clearWatchdog(); clearRetry();
    if (!G.desired) return;
    const delays = (G.plan && G.plan.retryDelays) || [];
    if (G.attempt < delays.length) {
      const delay = delays[G.attempt];
      G.attempt += 1;
      const strat = (G.plan.strategies)[Math.min(G.attempt, G.plan.strategies.length - 1)];
      pushLog(`✗ ${reason} → ${delay / 1000}s 后换策略重试 (${G.attempt}/${delays.length}) 改用 ${strat.name}`);
      G.phase = 'waiting-retry';
      G.retryTimer = setTimeout(() => { G.retryTimer = null; if (G.desired) spawnOnce(G.attempt); }, delay);
      if (G.retryTimer.unref) G.retryTimer.unref();
    } else {
      pushLog('✗ 所有策略都失败。当前网络很可能在阻断 Cloudflare（实测本机直连约 40% 失败）。');
      pushLog('  建议：在代理 App 里把 Termux 纳入接管范围（分应用/全局 TUN）。注意 cloudflared 不认 HTTP(S)_PROXY。');
      G.desired = false; G.phase = 'failed';
    }
  }

  
  function spawnOnce(attempt) {
    const plan = G.plan || buildPlan({});
    const strat = plan.strategies[Math.min(attempt, plan.strategies.length - 1)];
    const port = resolveTargetPort();
    if (port == null) {
      pushLog('✗ 找不到可用监听端口, 已放弃启动(避免误指向旧版网关 16384)');
      G.desired = false; G.phase = 'failed';
      return;
    }
    const args = ['tunnel', '--url', 'http://127.0.0.1:' + port, '--no-autoupdate', ...strat.args];
    pushLog(`启动 cloudflared → 127.0.0.1:${port} [${strat.name}] (第 ${attempt + 1} 次)`);

    let proc;
    try {
      proc = spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      pushLog('✗ cloudflared 启动失败(未安装?): ' + e.message);
      G.proc = null; G.desired = false; G.phase = 'failed';
      return;
    }
    G.proc = proc; G.url = ''; G.connected = false;
    G.protocol = ''; G.location = ''; G.strategy = strat.name; G.phase = 'starting';

    const onData = (buf) => {
      const line = buf.toString();
      pushLog(line.trim());
      if (!G.url) {
        const url = pickTunnelUrl(line);
        if (url) {
          G.url = url; persistUrl(url); G.phase = 'registering';
          pushLog('✓ 域名已取得: ' + url + '  (只代表拿到域名, 还要等连接注册成功)');
        } else if (/https:\/\/api\.trycloudflare\.com/.test(line)) {
          pushLog('(忽略: api.trycloudflare.com 是申请接口地址, 不是隧道域名)');
        }
      }
      if (REGISTER_RE.test(line)) {
        G.connected = true; G.phase = 'connected'; G.attempt = 0;
        const mp = /protocol=([a-z0-9]+)/i.exec(line);
        const ml = /location=([a-z0-9-]+)/i.exec(line);
        if (mp) G.protocol = mp[1];
        if (ml) G.location = ml[1];
        pushLog(`✅ 连接已注册 (protocol=${G.protocol || '?'} location=${G.location || '?'}) —— 域名现在对外可用`);
      } else if (CONN_LOST_RE.test(line)) {
        if (G.connected) pushLog('⚠ 连接已断开, 等待重连…');
        G.connected = false;
        if (G.phase === 'connected') G.phase = 'registering';
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => { pushLog('✗ 隧道错误: ' + e.message); G.proc = null; });

    proc.on('exit', (code, signal) => {
      const suppressed = G.suppressExit; G.suppressExit = false;
      const wasConnected = G.connected;
      pushLog('隧道退出 code=' + code + (signal ? ' signal=' + signal : ''));
      G.lastExit = { code: code, signal: signal || null, at: Date.now() };
      G.proc = null; G.url = ''; G.connected = false;
      clearWatchdog();
      if (suppressed) return;
      if (!G.desired) return;
      if (wasConnected) { pushLog('隧道已断开(曾注册成功), 不自动重试'); G.desired = false; G.phase = 'failed'; return; }
      failover('未拿到域名(退出码 ' + code + ')');
    });

    
    clearWatchdog();
    G.watchdogTimer = setTimeout(() => {
      G.watchdogTimer = null;
      if (!G.desired || G.connected) return;
      pushLog(`⚠ 启动 ${plan.watchdogMs / 1000}s 仍未注册成功${G.url ? '(域名已打印但外部打不开)' : ''} → 切换策略重建`);
      killTrackedProc();
      failover('未注册成功');
    }, plan.watchdogMs);
    if (G.watchdogTimer.unref) G.watchdogTimer.unref();
  }

  
  function beginStart() {
    clearRetry(); clearWatchdog();
    const oldPids = cloudflaredPids();
    if (oldPids.length > 0) {
      const clean = killAllCloudflared(1500);
      pushLog('清理了 ' + oldPids.length + ' 个旧/孤儿隧道进程' + (clean ? '' : '(仍有残留)'));
    }
    G.attempt = 0; G.url = ''; G.connected = false; G.desired = true; G.phase = 'starting';
    spawnOnce(0);
  }

  
  ctx.registerRoute('GET', '/status', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    const s = snapshot();
    

    jsonRes(res, 200, Object.assign({ running: s.connected }, s));
  });

  ctx.registerRoute('POST', '/start', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    
    if (G.proc && !G.proc.killed && G.connected) {
      return jsonRes(res, 200, { ok: true, url: G.url, running: true, connected: true, already: true });
    }
    const wasAlive = !!G.proc || cloudflaredPids().length > 0;
    killTrackedProc();
    beginStart();
    const plan = G.plan || buildPlan({});
    jsonRes(res, 200, {
      ok: true,
      restarted: wasAlive,
      msg: `隧道启动中(策略 ${plan.strategies[0].name}, 未连上会自动换策略重试 ${plan.retryDelays.length} 次), 几秒后查 /status`,
    });
  });

  ctx.registerRoute('POST', '/stop', (req, res, p) => {
    if (!adminOnly(p, res)) return;
    G.desired = false; clearRetry(); clearWatchdog();
    killTrackedProc();
    const pids = cloudflaredPids();
    const clean = killAllCloudflared(1500);
    if (pids.length > 0) pushLog('杀掉 ' + pids.length + ' 个 cloudflared 进程');
    const rest = clean ? 0 : cloudflaredPids().length;
    if (rest > 0) pushLog('⚠ 仍有 ' + rest + ' 个 cloudflared 进程未退出');
    const old = G.url; G.url = ''; G.attempt = 0; G.connected = false; G.phase = 'idle';
    jsonRes(res, 200, { ok: true, stopped: old || null, killed: pids.length, restPids: rest });
  });

  
  ctx.registerRoute('GET', '/ui/tunnel', (req, res, p) => {
    jsonRes(res, 200, buildUiPage(isAdmin(p), snapshot()));
  });

  
  ctx.registerRoute('POST', '/intent/start', (req, res, p) =>
    ctx.security.guard(req, p, res, () => {
      if (!isAdmin(p)) return { ok: false, error: '需要管理员权限（请用管理端密钥或管理员账号登录）' };
      if (G.proc && !G.proc.killed && G.connected) {
        return { ok: true, toast: '隧道已在运行', nav: 'replace', ui: buildUiPage(true, snapshot()) };
      }
      killTrackedProc();
      beginStart();
      return { ok: true, toast: '正在启动隧道…', nav: 'replace', ui: buildUiPage(true, snapshot()) };
    })
  );

  ctx.registerRoute('POST', '/intent/stop', (req, res, p) =>
    ctx.security.guard(req, p, res, () => {
      if (!isAdmin(p)) return { ok: false, error: '需要管理员权限' };
      G.desired = false; clearRetry(); clearWatchdog();
      killTrackedProc();
      const pids = cloudflaredPids();
      killAllCloudflared(1500);
      if (pids.length > 0) pushLog('杀掉 ' + pids.length + ' 个 cloudflared 进程');
      const old = G.url; G.url = ''; G.attempt = 0; G.connected = false; G.phase = 'idle';
      return { ok: true, toast: old ? '隧道已停止' : '隧道本来就未运行', nav: 'replace', ui: buildUiPage(true, snapshot()) };
    })
  );

  ctx.log('隧道插件已激活 v1.4.0');
};
