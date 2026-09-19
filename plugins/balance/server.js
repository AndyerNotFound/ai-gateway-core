'use strict';





const { upstreamRequest } = require('../../src/router.js');

const PRESETS = {
  deepseek: { url: '/user/balance', path: 'balance_infos.0.total_balance', unit: 'CNY' },
  siliconflow: { url: '/v1/user/info', path: 'data.balance', unit: 'CNY' },
  openai: { url: '/dashboard/billing/credit_grants', path: 'total_available', unit: 'USD' },
  bigmodel: { url: '/user/balance', path: 'balance_infos.0.total_balance', unit: 'CNY' },
};

function jsonRes(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); }
function dig(obj, dotPath) {
  let cur = obj;
  for (const k of String(dotPath || '').split('.')) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

module.exports.activate = (ctx) => {
  ctx.registerRoute('GET', '/query', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const chName = String(p.query.ch || '');
    const ch = (ctx.gateway && ctx.gateway.instanceChannels ? ctx.gateway.instanceChannels() : []).find(x => x.name === chName);
    if (!ch) return jsonRes(res, 404, { error: '渠道不存在: ' + chName });
    const preset = PRESETS[chName.toLowerCase()] || PRESETS[(ch.type || '').toLowerCase()];
    const url = ch.balanceUrl || (preset && preset.url);
    const jpath = ch.balancePath || (preset && preset.path);
    const unit = ch.balanceUnit || (preset && preset.unit) || '';
    if (!url || !jpath) return jsonRes(res, 400, { error: '该渠道无余额接口预设, 请在渠道配置填 balanceUrl + balancePath(点路径)' });
    const full = /^https?:\/\//.test(url) ? url : ch.baseUrl.replace(/\/+$/, '') + (url.startsWith('/') ? url : '/' + url);
    upstreamRequest({ responseTimeout: 15000, proxies: {} }, ch, full, { authorization: 'Bearer ' + (ch.apiKey || '') }, Buffer.alloc(0), (err, upRes) => {
      if (err) return jsonRes(res, 502, { error: '连接失败: ' + err.message });
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (upRes.statusCode >= 400) return jsonRes(res, 502, { error: '上游返回 ' + upRes.statusCode + ': ' + txt.slice(0, 200) });
        let j; try { j = JSON.parse(txt); } catch (e) { return jsonRes(res, 502, { error: '响应非 JSON' }); }
        const v = dig(j, jpath);
        if (v === undefined) return jsonRes(res, 502, { error: '路径 ' + jpath + ' 取不到值', raw: txt.slice(0, 300) });
        jsonRes(res, 200, { ok: true, channel: ch.name, balance: v, unit });
      });
      upRes.on('error', e => jsonRes(res, 502, { error: e.message }));
    }, 'GET');
  });

  ctx.log('余额代查插件已激活');
};
