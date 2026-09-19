
'use strict';
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const { Gateway } = require('../src/core');

let passed = 0, failed = 0; const failures = [];
function T(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); }).catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  ✗ ' + name + ' - ' + e.message); }); }

function jreq(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, json: j, text: d }); });
    });
    req.on('error', reject); req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    if (data) req.write(data); req.end();
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agwcore-umgmt-'));
  const gw = new Gateway(dir, { log: () => {} });
  const ADMIN = 'adm', port = 18097;
  gw.store.createInstance('default', {
    listen: { port }, adminKey: ADMIN,
    channels: [{ name: 'c', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'x', default: true }],
    plugins: [
      { id: 'auth-cardkey', enable: true, config: {} },
      { id: 'auth-user', enable: true, config: { registration: { enable: true, minPasswordLen: 8, emailVerify: { enable: false } } } },
    ],
  });
  
  gw.store.createInstance('bs2', {
    adminKey: ADMIN,
    channels: [{ name: 'c', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'x', default: true }],
    plugins: [
      { id: 'auth-cardkey', enable: true, config: {} },
      { id: 'auth-user', enable: true, config: { registration: { enable: true, defaultQuota: 5000, minPasswordLen: 8 } } },
    ],
  });
  await gw.start();
  await new Promise(r => setTimeout(r, 400));
  const A = { 'x-admin-key': ADMIN };
  const g = (p, h) => jreq(port, 'GET', p, { headers: h || A });
  const post = (p, b, h) => jreq(port, 'POST', p, { headers: h || A, body: b });
  const U = '/plugins/auth-user/admin/users';

  console.log('[U] 管理端');
  await T('建用户', async () => {
    const r = await post(U, { uid: 'tester', password: 'pass12345', name: '测试员', email: 't@x.com' });
    if (r.status !== 200) throw new Error(r.text);
  });
  await T('用户列表含 email/banned/keyCount', async () => {
    const r = await g(U);
    const u = (r.json.users || []).find(x => x.uid === 'tester');
    if (!u) throw new Error('列表无 tester');
    if (u.email !== 't@x.com') throw new Error('email 缺失');
    if (u.banned !== false) throw new Error('banned 应为 false');
    if (typeof u.keyCount !== 'number') throw new Error('keyCount 缺失');
  });
  await T('编辑资料 update', async () => {
    await post(U, { action: 'update', uid: 'tester', nickname: '小测', email: 'new@x.com' });
    const u = (await g(U)).json.users.find(x => x.uid === 'tester');
    if (u.nickname !== '小测' || u.email !== 'new@x.com') throw new Error('资料未更新');
  });

  console.log('[B] 封禁');
  await T('封禁后登录 403+banned+原因', async () => {
    await post(U, { action: 'ban', uid: 'tester', reason: '违规操作' });
    const r = await jreq(port, 'POST', '/auth/login', { body: { uid: 'tester', password: 'pass12345' } });
    if (r.status !== 403 || !r.json.banned) throw new Error('应 403+banned: ' + r.text);
    if (!String(r.json.error).includes('违规')) throw new Error('封禁原因未返回');
  });
  await T('解封后登录恢复', async () => {
    await post(U, { action: 'unban', uid: 'tester' });
    const r = await jreq(port, 'POST', '/auth/login', { body: { uid: 'tester', password: 'pass12345' } });
    if (r.status !== 200 || !r.json.ok) throw new Error(r.text);
  });

  console.log('[P] 改密码');
  let userToken = '';
  await T('发卡并登录拿凭证', async () => {
    const r = await post('/plugins/auth-cardkey/admin/keys', { name: 'tester卡', uid: 'tester' });
    if (r.status !== 200) throw new Error(r.text);
    const login = await jreq(port, 'POST', '/auth/login', { body: { uid: 'tester', password: 'pass12345' } });
    userToken = login.json.keys[0].key;
  });
  await T('原密码错误 403', async () => {
    const r = await jreq(port, 'POST', '/auth/password', { headers: { Authorization: 'Bearer ' + userToken }, body: { oldPassword: 'wrong', newPassword: 'newpass123' } });
    if (r.status !== 403) throw new Error('应403: ' + r.text);
  });
  await T('改密码成功后新密码可登录', async () => {
    const r = await jreq(port, 'POST', '/auth/password', { headers: { Authorization: 'Bearer ' + userToken }, body: { oldPassword: 'pass12345', newPassword: 'newpass123' } });
    if (!r.json.ok) throw new Error(r.text);
    const login = await jreq(port, 'POST', '/auth/login', { body: { uid: 'tester', password: 'newpass123' } });
    if (login.status !== 200) throw new Error('新密码登录失败');
  });
  await T('新密码太短 400', async () => {
    const r = await jreq(port, 'POST', '/auth/password', { headers: { Authorization: 'Bearer ' + userToken }, body: { oldPassword: 'newpass123', newPassword: 'ab' } });
    if (r.status !== 400) throw new Error('应400: ' + r.text);
  });

  console.log('[D] 删用户');
  await T('删用户连带删卡(卡立即失效)', async () => {
    await post(U, { action: 'delete', uid: 'tester' });
    const r = await g('/credits', { Authorization: 'Bearer ' + userToken });
    if (r.status !== 401) throw new Error('卡应已失效: ' + r.text);
    const users = (await g(U)).json.users;
    if (users.some(x => x.uid === 'tester')) throw new Error('用户未删');
  });

  console.log('[R] 注册');
  await T('开放注册: 注册成功自动发主卡可用', async () => {
    const r = await jreq(port, 'POST', '/auth/register', { body: { uid: 'newbie', password: 'pass12345' } });
    if (r.status !== 200 || !r.json.key) throw new Error(r.text);
    const c = await jreq(port, 'GET', '/credits', { headers: { Authorization: 'Bearer ' + r.json.key } });
    if (c.status !== 200) throw new Error('注册的卡不可用');
  });

  console.log('[Q] 零额度体系 (defaultQuota 未设 → -1)');
  let zeroKey = '';
  await T('默认注册: 主卡为零额度(显示0, 非不限)', async () => {
    const r = await jreq(port, 'POST', '/auth/register', { body: { uid: 'zero1', password: 'pass12345' } });
    if (r.status !== 200 || !r.json.key) throw new Error(r.text);
    zeroKey = r.json.key;
    const c = await jreq(port, 'GET', '/credits', { headers: { Authorization: 'Bearer ' + zeroKey } });
    if (c.json.unlimited !== false) throw new Error('不应为不限: ' + c.text);
    if (c.json.remainingTokens !== 0) throw new Error('剩余应为0: ' + c.text);
  });
  await T('零额度卡调用 API → 429', async () => {
    const r = await jreq(port, 'POST', '/v1/chat/completions', { headers: { Authorization: 'Bearer ' + zeroKey }, body: { model: 'x', messages: [] } });
    if (r.status !== 429) throw new Error('应429: ' + r.status + ' ' + r.text);
  });
  await T('零额度主卡发子卡 → 403', async () => {
    const r = await jreq(port, 'POST', '/auth/mykeys', { headers: { Authorization: 'Bearer ' + zeroKey }, body: { name: '子卡' } });
    if (r.status !== 403) throw new Error('应403: ' + r.status + ' ' + r.text);
  });
  await T('充值后从零起充并可用', async () => {
    const r = await post('/plugins/auth-cardkey/admin/keys-update', { key: zeroKey, addQuota: 5000 });
    if (r.status !== 200) throw new Error(r.text);
    const c = await jreq(port, 'GET', '/credits', { headers: { Authorization: 'Bearer ' + zeroKey } });
    if (c.json.quotaTokens !== 5000 || c.json.remainingTokens !== 5000) throw new Error('充值异常: ' + c.text);
  });
  await T('keys-update quotaTokens=-1 可设回零额度', async () => {
    await post('/plugins/auth-cardkey/admin/keys-update', { key: zeroKey, quotaTokens: -1 });
    const c = await jreq(port, 'GET', '/credits', { headers: { Authorization: 'Bearer ' + zeroKey } });
    if (c.json.remainingTokens !== 0 || c.json.unlimited !== false) throw new Error('应回零额度: ' + c.text);
  });
  await T('defaultQuota=5000 实例: 注册自动带额度', async () => {
    const r = await jreq(port, 'POST', '/bs2/auth/register', { body: { uid: 'rich1', password: 'pass12345' } });
    if (r.status !== 200 || !r.json.key) throw new Error(r.text);
    const c = await jreq(port, 'GET', '/bs2/credits', { headers: { Authorization: 'Bearer ' + r.json.key } });
    if (c.json.quotaTokens !== 5000 || c.json.remainingTokens !== 5000 || c.json.unlimited) throw new Error('应为5000额度: ' + c.text);
  });

  console.log('[W] /user 页面 UI');
  await T('含注册tab/发码/账号设置控件', async () => {
    const r = await jreq(port, 'GET', '/user');
    const t = r.text;
    for (const k of ['id="tabReg"', 'btnSendCode', 'btnRegister', 'btnChangePw', 'btnSaveProfile', 'acctSettings'])
      if (!t.includes(k)) throw new Error('缺 ' + k);
  });

  console.log('[M] 市场分组');
  await T('管理面板含内置/外部/市场分组标题+卸载警告', async () => {
    const r = await jreq(port, 'GET', '/admin/');
    for (const k of ['内置插件 (随内核分发, 不可卸载)', '外部安装 (可卸载, 卸载将清除全部配置与数据)', '市场可安装', '不可恢复'])
      if (!r.text.includes(k)) throw new Error('缺 ' + k);
  });
  await T('插件列表 API 返回 builtin 字段', async () => {
    const r = await g('/admin/api/plugins/1');
    const arr = r.json.plugins || r.json || [];
    const ck = (Array.isArray(arr) ? arr : []).find(p => p.id === 'auth-cardkey');
    if (!ck) throw new Error('缺 auth-cardkey');
    if (ck.builtin !== true) throw new Error('builtin 字段错误: ' + JSON.stringify(ck.builtin));
  });

  try { gw.close(); } catch (_) {}
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n通过 ' + passed + '/' + (passed + failed));
  if (failed) { console.log('失败:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
