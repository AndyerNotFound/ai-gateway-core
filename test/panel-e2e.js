
'use strict';
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const { Gateway } = require('../src/core');

const assert = require('assert');
let passed = 0, failed = 0; const failures = [];
function T(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); }).catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  ✗ ' + name + ' - ' + e.message); }); }

function jreq(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, json: j, text: d, headers: res.headers }); });
    });
    req.on('error', reject); req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    if (data) req.write(data); req.end();
  });
}
function mockUpstream() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/v1/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      } else { res.writeHead(404); res.end('{}'); }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function main() {
  console.log('面板+插件配置 API 测试\n');
  const mock = await mockUpstream();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-panel-'));
  const gw = new Gateway(dir, { log: () => {} });
  const ADMIN = 'adm-key';
  const port = 18095;
  const uid = gw.store.createInstance('default', {
    listen: { port }, adminKey: ADMIN,
    channels: [{ name: 'mock', type: 'openai', baseUrl: 'http://127.0.0.1:' + mock.port, apiKey: 'sk-mock', default: true }],
  });
  await gw.start();
  await new Promise(r => setTimeout(r, 400));
  const AH = { 'x-admin-key': ADMIN };

  
  console.log('[A] plugin-config API');
  await T('启用 auth-cardkey (POST config)', async () => {
    const r = await jreq(port, 'POST', '/admin/api/config/' + uid, { headers: AH, body: { listen: { port }, adminKey: ADMIN, channels: [{ name: 'mock', type: 'openai', baseUrl: 'http://127.0.0.1:' + mock.port, apiKey: 'sk-mock', default: true }], plugins: [{ id: 'auth-cardkey', enable: true }] } });
    assert.strictEqual(r.status, 200);
    await new Promise(r2 => setTimeout(r2, 300));
  });
  await T('GET plugin-config 返回 schema+config', async () => {
    const r = await jreq(port, 'GET', '/admin/api/plugin-config/' + uid + '/auth-cardkey', { headers: AH });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.ok && Array.isArray(r.json.schema), '应有 schema');
    assert.ok(r.json.schema.some(f => f.key === 'keyLength'), 'schema 应含 keyLength');
    assert.ok(r.json.config && typeof r.json.config === 'object', '应有 config');
  });
  await T('POST plugin-config 保存并热重载', async () => {
    const r = await jreq(port, 'POST', '/admin/api/plugin-config/' + uid + '/auth-cardkey', { headers: AH, body: { keyLength: 40 } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.ok && r.json.reloaded, '应已重载');
    const g = await jreq(port, 'GET', '/admin/api/plugin-config/' + uid + '/auth-cardkey', { headers: AH });
    assert.strictEqual(g.json.config.keyLength, 40, '配置应持久化');
  });
  await T('新配置生效: 发卡长度=40', async () => {
    const r = await jreq(port, 'POST', '/plugins/auth-cardkey/admin/keys', { headers: AH, body: { name: 'len-test' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.key.key.length, 3 + 40, 'sk- + 40 字符');
  });
  await T('无管理密钥访问 plugin-config 401', async () => {
    const r = await jreq(port, 'GET', '/admin/api/plugin-config/' + uid + '/auth-cardkey');
    assert.strictEqual(r.status, 401);
  });

  
  console.log('[B] 插件 adminPage');
  await T('GET /plugins/auth-cardkey/pages/admin.html 200 HTML', async () => {
    const r = await jreq(port, 'GET', '/plugins/auth-cardkey/pages/admin.html', { headers: AH });
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('卡密管理'), '应是卡密管理页');
    assert.ok((r.headers['content-type'] || '').includes('text/html'), 'content-type html');
  });
  await T('路径穿越被拒绝', async () => {
    const r = await jreq(port, 'GET', '/plugins/auth-cardkey/..%2F..%2Fsrc%2Fcore.js', { headers: AH });
    assert.ok(r.status === 403 || r.status === 404, '应 403/404, 实际 ' + r.status);
  });

  
  console.log('[C] 面板');
  await T('GET /admin 200 且为 m3 面板', async () => {
    const r = await jreq(port, 'GET', '/admin');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('--md-sys-color-primary'), '应含 MD3 令牌');
    assert.ok(r.text.includes('navbar'), '应有底栏导航');
    assert.ok(r.text.includes('plugin-config'), '应含插件配置逻辑');
    assert.ok(r.text.includes('mw-v2.js'), '应引用 Material Web 组件库');
  });
  await T('GET /admin/assets/mw-v2.js 200', async () => {
    const r = await jreq(port, 'GET', '/admin/assets/mw-v2.js');
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers['content-type'] || '').includes('javascript'), 'content-type js');
    assert.ok(r.text.length > 100000, '组件库应完整, 实际 ' + r.text.length);
  });
  await T('GET /admin/assets/ 字体可访问', async () => {
    const r = await jreq(port, 'GET', '/admin/assets/material-symbols-outlined.woff2');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'font/woff2');
  });
  await T('assets 路径穿越被拒绝', async () => {
    const r = await jreq(port, 'GET', '/admin/assets/..%2F..%2Fsrc%2Fcore.js');
    assert.strictEqual(r.status, 404);
  });
  await T('GET /user 用户中心 200', async () => {
    const r = await jreq(port, 'GET', '/user');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('用户中心') && r.text.includes('credits'), '应含用户中心结构');
  });
  await T('分支前缀下 /user 也可用', async () => {
    const r = await jreq(port, 'GET', '/default/user');
    assert.strictEqual(r.status, 200);
  });
  await T('插件列表含 adminPage/schema 字段', async () => {
    const r = await jreq(port, 'GET', '/admin/api/plugins/' + uid, { headers: AH });
    const ck = r.json.plugins.find(p => p.id === 'auth-cardkey');
    assert.ok(ck && ck.hasAdminPage === true && ck.adminPage === 'pages/admin.html', 'cardkey 应有 adminPage');
    assert.ok(Array.isArray(ck.schema) && ck.schema.length > 0, 'cardkey 应有 schema');
    assert.ok(ck.enable && ck.running, 'cardkey 应启用运行中');
  });

  console.log('\n=== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ===');
  if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
  try { gw.close(); } catch (_) {}
  mock.srv.close();
  setTimeout(() => process.exit(failed ? 1 : 0), 500);
}
main().catch(e => { console.error('测试运行崩溃:', e); process.exit(1); });
