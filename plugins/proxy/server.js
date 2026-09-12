                                         
                                       
                                                                       
   
module.exports = {
  activate(ctx) {
  const net = require('net');

  const readList = () => {
    const c = ctx.config || {};
    const l = c.proxies;
    return Array.isArray(l) ? l : [];
  };
  const saveList = (l) => {
    ctx.config.proxies = l;
    ctx.setPluginConfig(ctx.config);
                            
    const obj = {};
    for (const p of l) {
      if (!p || !p.name) continue;
      const o = { type: (p.type || 'socks5').toLowerCase(), host: String(p.host || ''), port: Number(p.port) || 0 };
      if (p.username) o.username = String(p.username);
      if (p.password) o.password = String(p.password);
      obj[p.name] = o;
    }
    try {
      ctx.gateway.saveInstanceConfig((cfg) => { cfg.proxies = obj; return cfg; });
    } catch (e) { ctx.log('镜像到实例配置失败:', e.message); }
  };

  const ok = (res, extra) => res.writeHead(200, { 'content-type': 'application/json' });
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  ctx.registerRoute('GET', '/admin/list', (req, res, p) => {
    const a = p.authAdmin ? p.authAdmin() : { ok: false };
    if (!a.ok) return send(res, 401, { error: '需要管理员密钥' });
    const list = readList();
    const cfg = ctx.getInstanceConfig() || {};
    const usedBy = {};
    for (const ch of (cfg.channels || [])) if (ch && ch.proxy) (usedBy[ch.proxy] = usedBy[ch.proxy] || []).push(ch.name);
    send(res, 200, { ok: true, proxies: list, usedBy });
  });

  ctx.registerRoute('POST', '/admin/save', (req, res, p) => {
    const a = p.authAdmin ? p.authAdmin() : { ok: false };
    if (!a.ok) return send(res, 401, { error: '需要管理员密钥' });
    const b = p.body || {};
    const list = readList();
    const act = String(b.action || '');
    if (act === 'delete') {
      const nm = String(b.name || '');
      const idx = list.findIndex(x => x.name === nm);
      if (idx < 0) return send(res, 404, { error: '代理不存在: ' + nm });
      list.splice(idx, 1);
                      
      try {
        ctx.gateway.saveInstanceConfig((cfg) => {
          for (const ch of (cfg.channels || [])) if (ch && ch.proxy === nm) delete ch.proxy;
          return cfg;
        });
      } catch (_) {}
      saveList(list);
      return send(res, 200, { ok: true, proxies: list });
    }
    const name = String(b.name || '').trim();
    if (!name) return send(res, 400, { error: '名字不能为空' });
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(name)) return send(res, 400, { error: '名字只能用字母数字._- （32 字内）' });
    const type = (String(b.type || 'socks5').toLowerCase() === 'http') ? 'http' : 'socks5';
    const host = String(b.host || '').trim();
    const port = Number(b.port) || 0;
    if (!host || !(port > 0 && port < 65536)) return send(res, 400, { error: '主机 / 端口不合法' });
    const obj = { name, type, host, port };
    if (b.username) obj.username = String(b.username);
    if (b.password) obj.password = String(b.password);
    const idx = list.findIndex(x => x.name === name);
    if (idx >= 0) {
                        
      if (b.password === undefined || b.password === null || b.password === '') {
        if (list[idx].password) obj.password = list[idx].password;
      }
      list[idx] = obj;
    } else list.push(obj);
    saveList(list);
    send(res, 200, { ok: true, proxies: list });
  });

                         
  ctx.registerRoute('POST', '/admin/test', (req, res, p) => {
    const a = p.authAdmin ? p.authAdmin() : { ok: false };
    if (!a.ok) return send(res, 401, { error: '需要管理员密钥' });
    const nm = String((p.body || {}).name || '');
    const item = readList().find(x => x.name === nm);
    if (!item) return send(res, 404, { error: '代理不存在: ' + nm });
    const t0 = Date.now();
    const sock = net.connect({ host: item.host, port: Number(item.port) });
    let done = false;
    const finish = (okFlag, msg) => {
      if (done) return; done = true;
      try { sock.destroy(); } catch (_) {}
      send(res, 200, { ok: true, reachable: okFlag, ms: Date.now() - t0, message: msg });
    };
    sock.setTimeout(5000, () => finish(false, '连接超时(5s)'));
    sock.once('connect', () => finish(true, 'TCP 可达'));
    sock.once('error', (e) => finish(false, String(e && e.message || e)));
  });

  ctx.log('代理设置插件已加载 (config 名单: ' + readList().length + ' 个)');
  },
};
