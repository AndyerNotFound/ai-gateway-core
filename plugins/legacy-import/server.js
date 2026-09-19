'use strict';










const path = require('path');
const os = require('os');
const net = require('net');

const CRYPT = path.join(__dirname, '..', '..', 'src', 'crypt.js');


const CH_FIELDS = ['name', 'type', 'baseUrl', 'apiKey', 'default', 'proxy', 'insecure',
  'models', 'modelMap', 'delayMs', 'addUsage', 'anthropicVersion', 'useResponses'];

function tryRequireCrypt() {
  try { return require(CRYPT); } catch (_) { return null; }
}


function portInUse(port) {
  return new Promise(resolve => {
    if (!port || port <= 0) return resolve(false);
    const s = new net.Socket();
    s.setTimeout(1200);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.connect(port, '127.0.0.1');
  });
}


function parseOldConfig(text, pass) {
  const t = String(text || '').trim();
  if (!t) throw new Error('配置内容为空');
  
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.parse(t); } catch (_) {  }
  }
  const crypt = tryRequireCrypt();
  if (!crypt) throw new Error('配置是加密的(AGWENC1) 但内核 crypt 模块不可用');
  if (!crypt.isEncText(t)) throw new Error('配置既非合法 JSON 也非 AGWENC1 加密文本');
  let p = pass;
  if (!p) {
    try { p = crypt.loadPass(path.join(os.homedir(), 'ai-gateway')); } catch (_) { p = ''; }
  }
  if (!p) throw new Error('配置已加密但未提供密码, 且 ~/.ai-gateway/.agwkey 不存在');
  const dec = crypt.decryptText(t, p);
  try { return JSON.parse(dec); }
  catch (_) { throw new Error('解密成功但内容不是合法 JSON (密码可能不对)'); }
}


function convert(old, opts, usedPorts) {
  opts = opts || {};
  const name = String(opts.name || old._name || old.name || 'imported').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('实例名非法 (仅字母数字下划线连字符): ' + name);
  if (name === 'default') throw new Error('不能创建名为 default 的实例');

  const keepPort = !!opts.keepPort;
  const oldPort = old.listen && Number(old.listen.port);
  let port = 0;
  if (keepPort && oldPort > 0) {
    if (usedPorts && usedPorts.includes(oldPort))
      throw new Error('端口 ' + oldPort + ' 与现有 core 实例冲突, 取消"保留原端口"或改端口');
    port = oldPort;
  }

  const channels = (old.channels || []).map(ch => {
    const o = {};
    for (const k of CH_FIELDS) if (ch[k] !== undefined) o[k] = ch[k];
    
    if (o.proxy && !(old.proxies && old.proxies[o.proxy])) o.proxy = null;
    return o;
  });

  const cfg = {
    listen: { port, host: (old.listen && old.listen.host) || '0.0.0.0' },
  };
  if (old.adminKey) cfg.adminKey = old.adminKey;
  if (old.gatewayKey) cfg.gatewayKey = old.gatewayKey;
  if (old.tls && old.tls.enable) cfg.tls = old.tls; 
  if (channels.length) cfg.channels = channels;
  if (old.proxies && Object.keys(old.proxies).length) cfg.proxies = old.proxies;

  const summary = {
    name,
    channels: channels.length,
    proxies: cfg.proxies ? Object.keys(cfg.proxies).length : 0,
    tls: !!(cfg.tls && cfg.tls.enable),
    port: port || '前缀路由(/' + name + '/)',
    adminKey: !!cfg.adminKey,
    gatewayKey: !!cfg.gatewayKey,
    skipped: [], 
  };
  if (old.apiKeys && old.apiKeys.length) summary.skipped.push('apiKeys(' + old.apiKeys.length + ', 旧版多用户密钥 → 用卡密系统)');
  if (old.users && old.users.length) summary.skipped.push('users(' + old.users.length + ', 旧版用户 → 用用户体系插件)');
  for (const k of ['modelMap', 'models', 'routing', 'redact', 'modelSync', 'openaiExtras']) {
    if (old[k] !== undefined) summary.skipped.push(k + ' (旧版插件配置 → core 用独立插件)');
  }
  return { name, config: cfg, summary };
}

module.exports = {
  async activate(ctx) {
    const send = (res, code, obj) => {
      try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); } catch (_) {}
    };
    const usedPorts = () => {
      try { return ctx.gateway.listInstances().map(i => i.port).filter(p => p > 0); }
      catch (_) { return []; }
    };

    
    ctx.registerRoute('POST', '/admin/convert', (req, res, p) => {
      const a = p.authAdmin ? p.authAdmin() : { ok: false };
      if (!a.ok) return send(res, 401, { ok: false, error: '需要管理员密钥' });
      let j;
      try { j = typeof p.body === 'object' ? p.body : JSON.parse(p.body || '{}'); }
      catch (_) { return send(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
      let old;
      try { old = parseOldConfig(j.text, j.pass); }
      catch (e) { return send(res, 400, { ok: false, error: '解析失败: ' + e.message }); }
      let r;
      try { r = convert(old, { name: j.name, keepPort: j.keepPort }, usedPorts()); }
      catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      
      const port = r.config.listen.port;
      if (port > 0) {
        portInUse(port).then(busy => {
          send(res, 200, { ok: true, name: r.name, config: r.config, summary: r.summary, portBusy: busy });
        });
      } else {
        send(res, 200, { ok: true, name: r.name, config: r.config, summary: r.summary });
      }
    });

    ctx.log('legacy-import 插件已激活');
  }
};
