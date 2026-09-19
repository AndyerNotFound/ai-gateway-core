'use strict';




const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const assert = require('assert');

const CORE = require('../src/index');
const { Store, AuthChain, auth, crypt, canonical, router } = CORE;

let passed = 0, failed = 0;
const failures = [];
function T(name, fn) {
  try { const r = fn(); if (r && r.then) return r.then(() => { passed++; console.log('  ✅ ' + name); }).catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  ❌ ' + name + ' — ' + e.message); }); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; failures.push(name + ': ' + e.message); console.log('  ❌ ' + name + ' — ' + e.message); }
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agwcore-test-')); }


function req(port, method, p, { headers = {}, body, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body != null) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}


function mockUpstream(handler) {
  const srv = http.createServer(handler || ((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(b); } catch (_) {}
      const resp = { id: 'chatcmpl-mock', object: 'chat.completion', created: 1700000000, model: j.model || 'mock', choices: [{ index: 0, message: { role: 'assistant', content: '你好，我是mock' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resp));
    });
  }));
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

async function main() {
  console.log('=== ai-gateway-core 测试 ===\n[1] store 存储层');

  await T('UID 顺序分配', () => {
    const d = tmpdir();
    const s = new Store(d);
    const u1 = s.createInstance('default', { listen: { port: 16384 } });
    const u2 = s.createInstance('foo', { listen: { port: 16385 } });
    const u3 = s.createInstance('bar', { listen: { port: 16386 } });
    assert.strictEqual(u1, 1); assert.strictEqual(u2, 2); assert.strictEqual(u3, 3);
    assert.strictEqual(s.index.nextUid, 4);
  });

  await T('改名不动 UID', () => {
    const d = tmpdir();
    const s = new Store(d);
    s.createInstance('default', {});
    const u2 = s.createInstance('foo', {});
    s.renameInstance(u2, 'bar');
    assert.strictEqual(s.meta(u2).name, 'bar');
    assert.strictEqual(s.metaByName('foo'), null);
    assert.strictEqual(s.metaByName('bar').uid, u2);
  });

  await T('改名不允许撞名/保留字/default', () => {
    const d = tmpdir();
    const s = new Store(d);
    s.createInstance('default', {});
    const u2 = s.createInstance('foo', {});
    assert.throws(() => s.renameInstance(u2, 'default'), /已存在/);
    assert.throws(() => s.renameInstance(u2, 'v1'), /保留字/);
    assert.throws(() => s.renameInstance(1, 'x'), /不可改名/);
    assert.throws(() => s.createInstance('admin', {}), /保留字/);
  });

  await T('UID 重复自动重生', () => {
    const d = tmpdir();
    const s = new Store(d);
    s.createInstance('default', {});
    s.createInstance('foo', {});
    s.index.instances[1].uid = 1; 
    s.saveIndex();
    const s2 = new Store(d);
    const uids = s2.index.instances.map(m => m.uid);
    assert.strictEqual(new Set(uids).size, uids.length, 'UID 应唯一');
  });

  await T('字段级加密: 敏感字段加密, 非敏感明文', () => {
    const d = tmpdir();
    process.env.AGW_CRYPT_PASS = 'test-pass-123';
    const s = new Store(d);
    const uid = s.createInstance('default', { adminKey: 'secret-admin', channels: [{ name: 'c1', type: 'openai', baseUrl: 'http://x', apiKey: 'sk-real-key' }] });
    const raw = fs.readFileSync(path.join(d, 'instances', uid + '.json'), 'utf8');
    assert(raw.includes('AGWENC1:'), '应有密文');
    assert(!raw.includes('sk-real-key'), '明文密钥不应出现');
    assert(raw.includes('http://x'), 'baseUrl 应明文');
    delete process.env.AGW_CRYPT_PASS;
    const s2 = new Store(d); 
    const cfg = s2.loadInstance(uid);
    assert(cfg.channels[0].apiKey.startsWith('AGWENC1:'));
  });

  await T('字段级加密: 有口令可解开', () => {
    const d = tmpdir();
    process.env.AGW_CRYPT_PASS = 'test-pass-123';
    const s = new Store(d);
    const uid = s.createInstance('default', { adminKey: 'secret-admin', channels: [{ name: 'c1', type: 'openai', baseUrl: 'http://x', apiKey: 'sk-real-key' }] });
    const cfg = s.loadInstance(uid);
    assert.strictEqual(cfg.adminKey, 'secret-admin');
    assert.strictEqual(cfg.channels[0].apiKey, 'sk-real-key');
    delete process.env.AGW_CRYPT_PASS;
  });

  await T('插件配置 UID 引用 + 改名不断', () => {
    const d = tmpdir();
    const s = new Store(d);
    s.createInstance('default', {});
    const u2 = s.createInstance('foo', {});
    s.setPluginConfig('signin', u2, { rewardTokens: 1000 });
    s.renameInstance(u2, 'bar');
    assert.strictEqual(s.getPluginConfig('signin', u2).rewardTokens, 1000);
  });

  await T('迁移: 旧 config.<name>.json → instances/<uid>.json', () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ listen: { port: 16384 }, gatewayKey: 'gw1', channels: [{ name: 'a', type: 'openai', baseUrl: 'http://a', apiKey: 'k1' }] }));
    fs.writeFileSync(path.join(d, 'config.office.json'), JSON.stringify({ listen: { port: 16385 }, channels: [{ name: 'b', type: 'claude', baseUrl: 'http://b', apiKey: 'k2' }], plugins: [{ id: 'signin', enable: true, config: { rewardTokens: 500 } }] }));
    const s = new Store(d);
    const res = s.migrate(d, { log: () => {} });
    assert.strictEqual(res.migrated.length, 2);
    assert.strictEqual(res.errors.length, 0);
    assert(s.metaByName('default'));
    const office = s.metaByName('office');
    assert(office);
    assert.strictEqual(s.getPluginConfig('signin', office.uid).rewardTokens, 500, '插件配置应迁到 plugins-config');
    assert(fs.existsSync(path.join(d, 'config.json.bak-migrate')), '旧文件应留 .bak-migrate');
    const report = s.verifyMigration(d);
    assert(report.every(r => r.ok), '校验应全过: ' + JSON.stringify(report));
  });

  await T('迁移: 旧加密配置(整文件 AGWENC1)', () => {
    const d = tmpdir();
    process.env.AGW_CRYPT_PASS = 'old-pass';
    const plain = JSON.stringify({ listen: { port: 16390 }, adminKey: 'adm', channels: [{ name: 'a', type: 'openai', baseUrl: 'http://a', apiKey: 'sk-x' }] });
    fs.writeFileSync(path.join(d, 'config.json'), crypt.encryptText(plain, 'old-pass'));
    const s = new Store(d);
    const res = s.migrate(d, { log: () => {} });
    assert.strictEqual(res.migrated.length, 1);
    const cfg = s.loadInstance(s.metaByName('default').uid);
    assert.strictEqual(cfg.channels[0].apiKey, 'sk-x');
    delete process.env.AGW_CRYPT_PASS;
  });

  console.log('\n[2] auth 认证');
  await T('TOTP RFC6238 测试向量', () => {
    
    const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; 
    assert.strictEqual(auth.base32Decode(seed).toString(), '12345678901234567890');
    assert.strictEqual(auth.base32Encode(auth.base32Decode(seed)), seed);
  });

  await T('AuthChain: gatewayKey 默认实现', () => {
    const ac = new AuthChain();
    const cfg = { gatewayKey: 'gw-secret' };
    const req = { headers: { authorization: 'Bearer gw-secret' } };
    assert.strictEqual(ac.check(cfg, req, null).ok, true);
    assert.strictEqual(ac.check(cfg, req, null).admin, true);
    assert.strictEqual(ac.check(cfg, { headers: {} }, null).ok, false);
  });

  await T('AuthChain: 免密(无 gatewayKey 无策略)', () => {
    const ac = new AuthChain();
    assert.strictEqual(ac.check({ gatewayKey: '' }, { headers: {} }, null).ok, true);
  });

  await T('AuthChain: 策略链顺序 + null 继续', () => {
    const ac = new AuthChain();
    ac.registerAuth({ name: 's1', check: () => null });
    ac.registerAuth({ name: 's2', check: ({ token }) => token === 'card-1' ? { ok: true, userKey: { key: 'card-1' } } : null });
    const r = ac.check({ gatewayKey: '' }, { headers: { authorization: 'Bearer card-1' } }, null);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.userKey.key, 'card-1');
    assert.strictEqual(r.strategy, 's2');
  });

  await T('AuthChain: 策略异常不崩溃(500)', () => {
    const ac = new AuthChain();
    ac.registerAuth({ name: 'bad', check: () => { throw new Error('boom'); } });
    const r = ac.check({ gatewayKey: '' }, { headers: { authorization: 'Bearer x' } }, null);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 500);
  });

  await T('AuthChain: checkAdmin 需要 adminKey + 第二验证策略', () => {
    const ac = new AuthChain();
    ac.registerAuth({ name: 'totp', check: ({ req }) => req.headers['x-totp'] === '123456' ? null : { ok: false, status: 401, error: '需要 TOTP' } }, { admin: true });
    const cfg = { adminKey: 'adm-1' };
    assert.strictEqual(ac.checkAdmin(cfg, { headers: { authorization: 'Bearer wrong' } }, null).ok, false);
    assert.strictEqual(ac.checkAdmin(cfg, { headers: { authorization: 'Bearer adm-1' } }, null).ok, false); 
    assert.strictEqual(ac.checkAdmin(cfg, { headers: { authorization: 'Bearer adm-1', 'x-totp': '123456' } }, null).ok, true);
  });

  await T('hashPassword/verifyPassword', () => {
    const h = auth.hashPassword('my-password');
    assert(h.startsWith('scrypt:'));
    assert(auth.verifyPassword('my-password', h));
    assert(!auth.verifyPassword('wrong', h));
  });

  console.log('\n[3] canonical 转换');
  await T('openai→canonical→openai 往返', () => {
    const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 };
    const c = canonical.openaiToCanonical(body);
    assert.strictEqual(c.model, 'gpt-4');
    const back = canonical.canonicalToOpenAIBody(c);
    assert.strictEqual(back.model, 'gpt-4');
    assert.strictEqual(back.messages[0].content, 'hi');
  });

  await T('claude→canonical→gemini', () => {
    const body = { model: 'claude-3', max_tokens: 50, system: 'sys', messages: [{ role: 'user', content: 'hi' }] };
    const c = canonical.claudeToCanonical(body);
    assert.strictEqual(c.messages[0].role, 'system');
    const g = canonical.canonicalToGeminiBody(c);
    assert(g.systemInstruction || g.system_instruction, 'gemini 应有 system');
  });

  await T('responses→canonical→responses', () => {
    const body = { model: 'gpt-5', input: 'hello' };
    const c = canonical.responsesToCanonical(body);
    assert.strictEqual(c.messages[0].content, 'hello');
    const back = canonical.canonicalToResponsesBody(c);
    assert.strictEqual(back.model, 'gpt-5');
  });

  await T('gemini→canonical', () => {
    const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    const c = canonical.geminiToCanonical(body, 'gemini-pro');
    assert.strictEqual(c.model, 'gemini-pro');
    const txt = Array.isArray(c.messages[0].content) ? c.messages[0].content[0].text : c.messages[0].content;
    assert.strictEqual(txt, 'hi');
  });

  console.log('\n[4] E2E (Gateway + mock 上游)');
  const dir = tmpdir();
  process.env.AGW_DIR = dir;

  let mock, mockPort;
  let gw, mainPort;
  await T('启动: 首启进 setup 模式', async () => {
    mock = await mockUpstream();
    mockPort = mock.port;
    
    mainPort = await new Promise(r => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    gw = new CORE.Gateway(dir, { port: mainPort });
    await gw.start();
    assert.strictEqual(gw.store.index.instances.length, 1);
    assert.strictEqual(gw.store.isSetupMode(), true);
  });

  await T('setup 模式: 普通请求 403', async () => {
    const r = await req(mainPort, 'GET', '/status');
    assert.strictEqual(r.status, 403);
    assert(r.body.includes('setup'));
  });

  await T('setup 模式: POST /setup/admin 创建管理员', async () => {
    const r = await req(mainPort, 'POST', '/setup/admin', { body: { adminKey: 'admin-test-key' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(gw.store.isSetupMode(), false);
  });

  await T('配置渠道(经 store) + 热重载', async () => {
    const meta = gw.store.metaByName('default');
    const cfg = gw.store.loadInstance(meta.uid);
    cfg.channels = [{ name: 'mock', type: 'openai', baseUrl: 'http://127.0.0.1:' + mockPort, apiKey: 'sk-mock', models: ['gpt-4', 'gpt-3.5'] }];
    cfg.gatewayKey = 'gw-test';
    gw.store.saveInstance(meta.uid, cfg);
    gw.loadInstance(meta.uid);
    const r = await req(mainPort, 'GET', '/status');
    const j = JSON.parse(r.body);
    assert.strictEqual(j.channels.length, 1);
  });

  await T('/health', async () => {
    const r = await req(mainPort, 'GET', '/health');
    assert.strictEqual(JSON.parse(r.body).ok, true);
  });

  await T('鉴权: 无 key 401', async () => {
    const r = await req(mainPort, 'GET', '/v1/models');
    assert.strictEqual(r.status, 401);
  });

  await T('鉴权: gatewayKey 通过', async () => {
    const r = await req(mainPort, 'GET', '/v1/models', { headers: { authorization: 'Bearer gw-test' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert(j.data.some(m => m.id === 'gpt-4'));
  });

  await T('E2E: openai 直通转发', async () => {
    const r = await req(mainPort, 'POST', '/v1/chat/completions', { headers: { authorization: 'Bearer gw-test' }, body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.choices[0].message.content, '你好，我是mock');
    assert.strictEqual(r.headers['x-ai-gateway-channel'], 'mock');
  });

  await T('E2E: claude 格式进 → openai 渠道 (跨格式)', async () => {
    const r = await req(mainPort, 'POST', '/v1/messages', { headers: { 'x-api-key': 'gw-test' }, body: { model: 'gpt-4', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.type, 'message');
    assert.strictEqual(j.content[0].text, '你好，我是mock');
    assert.strictEqual(j.stop_reason, 'end_turn');
  });

  await T('E2E: gemini 格式进 → openai 渠道', async () => {
    const r = await req(mainPort, 'POST', '/v1beta/models/gpt-4:generateContent', { headers: { 'x-goog-api-key': 'gw-test' }, body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.candidates[0].content.parts[0].text, '你好，我是mock');
  });

  await T('E2E: /v1/responses 格式进', async () => {
    const r = await req(mainPort, 'POST', '/v1/responses', { headers: { authorization: 'Bearer gw-test' }, body: { model: 'gpt-4', input: 'hi' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert(j.output || j.choices, 'responses 格式输出');
  });

  await T('E2E: 流式 SSE', async () => {
    mock.srv.close();
    mock = await mockUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":"你"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"好"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 30);
    });
    mockPort = mock.port;
    const meta = gw.store.metaByName('default');
    const cfg = gw.store.loadInstance(meta.uid);
    cfg.channels[0].baseUrl = 'http://127.0.0.1:' + mockPort;
    gw.store.saveInstance(meta.uid, cfg);
    gw.loadInstance(meta.uid);
    const r = await req(mainPort, 'POST', '/v1/chat/completions', { headers: { authorization: 'Bearer gw-test' }, body: { model: 'gpt-4', stream: true, messages: [{ role: 'user', content: 'hi' }] } });
    assert.strictEqual(r.status, 200);
    assert(r.body.includes('"content":"你"'), '流式应有内容: ' + r.body);
    assert(r.body.includes('[DONE]'));
  });

  await T('E2E: 故障切换 (挂掉渠道→备用渠道)', async () => {
    const dead = 'http://127.0.0.1:1'; 
    const meta = gw.store.metaByName('default');
    const cfg = gw.store.loadInstance(meta.uid);
    cfg.channels = [
      { name: 'dead', type: 'openai', baseUrl: dead, apiKey: 'k', models: ['gpt-4'] },
      { name: 'mock2', type: 'openai', baseUrl: 'http://127.0.0.1:' + mockPort, apiKey: 'k', models: ['gpt-4'] },
    ];
    gw.store.saveInstance(meta.uid, cfg);
    gw.loadInstance(meta.uid);
    const r = await req(mainPort, 'POST', '/v1/chat/completions', { headers: { authorization: 'Bearer gw-test' }, body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['x-ai-gateway-channel'], 'mock2');
  });

  await T('E2E: 多实例 + /实例名/ 前缀路由', async () => {
    const uid2 = gw.store.createInstance('second', { listen: { port: 0 }, gatewayKey: 'gw2', channels: [{ name: 'm', type: 'openai', baseUrl: 'http://127.0.0.1:' + mockPort, apiKey: 'k', models: ['gpt-4'] }] });
    gw.loadInstance(uid2);
    const r = await req(mainPort, 'POST', '/second/v1/chat/completions', { headers: { authorization: 'Bearer gw2' }, body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] } });
    assert.strictEqual(r.status, 200);
    
    const r2 = await req(mainPort, 'POST', '/second/v1/chat/completions', { headers: { authorization: 'Bearer gw-test' }, body: { model: 'gpt-4', messages: [] } });
    assert.strictEqual(r2.status, 401);
  });

  await T('E2E: admin API 实例列表 (checkAdmin)', async () => {
    const r = await req(mainPort, 'GET', '/admin/api/status', { headers: { 'x-admin-key': 'admin-test-key' } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.instances.length, 2);
    const bad = await req(mainPort, 'GET', '/admin/api/status', { headers: { 'x-admin-key': 'wrong' } });
    assert.strictEqual(bad.status, 401);
  });

  await T('E2E: admin 改名不断插件配置', async () => {
    const uid2 = gw.store.uidOf('second');
    gw.store.setPluginConfig('signin', uid2, { rewardTokens: 777 });
    const r = await req(mainPort, 'POST', '/admin/api/instance/' + uid2 + '/rename', { headers: { 'x-admin-key': 'admin-test-key' }, body: { name: 'renamed' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(gw.store.getPluginConfig('signin', uid2).rewardTokens, 777);
    assert.strictEqual(gw.store.meta(uid2).name, 'renamed');
    
    const r2 = await req(mainPort, 'GET', '/renamed/health');
    assert.strictEqual(r2.status, 200);
    
    const r3 = await req(mainPort, 'GET', '/second/health');
    assert.strictEqual(r3.status, 404);
  });

  console.log('\n[5] plugins 插件系统');
  await T('插件: type=auth 先于 business 激活', async () => {
    const d = tmpdir();
    const s = new Store(d);
    const uid = s.createInstance('default', {});
    
    const pm = new CORE.PluginManager(s, { authChain: new AuthChain() });
    const mk = (id, type, code) => {
      const pd = path.join(d, 'plugins', id);
      fs.mkdirSync(pd, { recursive: true });
      fs.writeFileSync(path.join(pd, 'manifest.json'), JSON.stringify({ id, name: id, type, hasServer: true }));
      fs.writeFileSync(path.join(pd, 'server.js'), code);
    };
    const orderFile = path.join(d, 'order.txt');
    mk('myauth', 'auth', `module.exports.activate = (ctx) => { require('fs').appendFileSync(${JSON.stringify(orderFile)}, 'auth;'); };`);
    mk('mybiz', 'business', `module.exports.activate = (ctx) => { require('fs').appendFileSync(${JSON.stringify(orderFile)}, 'biz;'); };`);
    const cfg = s.loadInstance(uid);
    cfg.plugins = [{ id: 'mybiz', enable: true }, { id: 'myauth', enable: true }]; 
    const r = pm.activateInstance(uid, cfg);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fs.readFileSync(orderFile, 'utf8'), 'auth;biz;', 'auth 必须先加载');
  });

  await T('插件: 认证插件失败 fail-closed 阻断后续', async () => {
    const d = tmpdir();
    const s = new Store(d);
    const uid = s.createInstance('default', {});
    const pm = new CORE.PluginManager(s, { authChain: new AuthChain() });
    const mk = (id, type, code) => {
      const pd = path.join(d, 'plugins', id);
      fs.mkdirSync(pd, { recursive: true });
      fs.writeFileSync(path.join(pd, 'manifest.json'), JSON.stringify({ id, name: id, type, hasServer: true }));
      fs.writeFileSync(path.join(pd, 'server.js'), code);
    };
    mk('badauth', 'auth', `module.exports.activate = () => { throw new Error('auth broken'); };`);
    const bizMarker = path.join(d, 'biz-ran.txt');
    mk('somebiz', 'business', `module.exports.activate = () => { require('fs').writeFileSync(${JSON.stringify(bizMarker)}, 'ran'); };`);
    const cfg = s.loadInstance(uid);
    cfg.plugins = [{ id: 'badauth', enable: true }, { id: 'somebiz', enable: true }];
    const r = pm.activateInstance(uid, cfg);
    assert.strictEqual(r.ok, false);
    assert(!fs.existsSync(bizMarker), '业务插件不应被加载');
  });

  await T('插件: registerAuth 挂入 checkAuth 链', async () => {
    const d = tmpdir();
    const s = new Store(d);
    const uid = s.createInstance('default', {});
    const ac = new AuthChain();
    const pm = new CORE.PluginManager(s, { authChain: ac });
    const pd = path.join(d, 'plugins', 'cardauth');
    fs.mkdirSync(pd, { recursive: true });
    fs.writeFileSync(path.join(pd, 'manifest.json'), JSON.stringify({ id: 'cardauth', name: 'cardauth', type: 'auth', hasServer: true, permissions: ['auth:registerAuth'] }));
    fs.writeFileSync(path.join(pd, 'server.js'), `module.exports.activate = (ctx) => {
      ctx.registerAuth({ name: 'card', check: ({token}) => token === 'sk-card-1' ? { ok: true, userKey: { key: 'sk-card-1', name: '测试卡' } } : null });
    };`);
    const cfg = s.loadInstance(uid);
    cfg.plugins = [{ id: 'cardauth', enable: true }];
    pm.activateInstance(uid, cfg);
    const r = ac.check({ gatewayKey: '' }, { headers: { authorization: 'Bearer sk-card-1' } }, null);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.userKey.name, '测试卡');
    
    pm.deactivateInstance(uid);
    const r2 = ac.check({ gatewayKey: '' }, { headers: { authorization: 'Bearer sk-card-1' } }, null);
    assert.strictEqual(r2.ok, true); 
    assert(!r2.userKey);
  });

  await T('插件: business 插件 registerAuth 被拒', async () => {
    const d = tmpdir();
    const s = new Store(d);
    const uid = s.createInstance('default', {});
    const pm = new CORE.PluginManager(s, { authChain: new AuthChain() });
    const pd = path.join(d, 'plugins', 'evil');
    fs.mkdirSync(pd, { recursive: true });
    fs.writeFileSync(path.join(pd, 'manifest.json'), JSON.stringify({ id: 'evil', name: 'evil', type: 'business', hasServer: true, permissions: ['auth:registerAuth'] }));
    fs.writeFileSync(path.join(pd, 'server.js'), `module.exports.activate = (ctx) => { try { ctx.registerAuth({name:'x',check:()=>({ok:true,admin:true})}); } catch (e) { ctx.data.set('err', e.message); } };`);
    const cfg = s.loadInstance(uid);
    cfg.plugins = [{ id: 'evil', enable: true }];
    pm.activateInstance(uid, cfg);
    const st = pm.active.get(uid + '/evil');
    assert(st.data.err && st.data.err.includes('auth'), '应报 type 错误: ' + st.data.err);
  });

  await T('插件: hook 聚合 (onRequestBody 串联)', () => {
    const d = tmpdir();
    const s = new Store(d);
    const uid = s.createInstance('default', {});
    const pm = new CORE.PluginManager(s, {});
    const fakeState = (id, fns) => ({ uid, pluginId: id, hooks: fns, data: {}, timers: [], routes: new Map() });
    pm.active.set(uid + '/p1', fakeState('p1', { onRequestBody: [(b) => { b.x = 1; return b; }] }));
    pm.active.set(uid + '/p2', fakeState('p2', { onRequestBody: [(b) => { b.y = 2; return b; }] }));
    const hooks = pm.hooksFor(uid);
    const out = hooks.onRequestBody({}, {});
    assert.strictEqual(out.x, 1);
    assert.strictEqual(out.y, 2);
  });

  await T('插件: 数据按 UID 隔离', () => {
    const d = tmpdir();
    const s = new Store(d);
    const u1 = s.createInstance('default', {});
    const u2 = s.createInstance('foo', {});
    const pm = new CORE.PluginManager(s, {});
    const f1 = pm.dataFile(u1, 'signin');
    const f2 = pm.dataFile(u2, 'signin');
    assert(f1.includes('/1/'), f1);
    assert(f2.includes('/2/'), f2);
  });

  console.log('\n[6] crypt 字段级');
  await T('encryptFields/decryptFields 往返', () => {
    const obj = { name: 'x', apiKey: 'sk-secret', nested: { token: 'tok', list: [{ password: 'pw' }] } };
    const enc = crypt.encryptFields(obj, 'pass1');
    assert(enc.apiKey.startsWith('AGWENC1:'));
    assert.strictEqual(enc.name, 'x');
    const dec = crypt.decryptFields(enc, 'pass1');
    assert.deepStrictEqual(dec, obj);
  });

  await T('maskFields 打码', () => {
    const m = crypt.maskFields({ apiKey: 'sk-abcdefghijklmnop', port: 8080 });
    assert(m.apiKey.includes('****'));
    assert.strictEqual(m.port, 8080);
  });

  
  await T('清理: 关闭网关', async () => {
    gw.close();
    mock.srv.close();
  });

  console.log('\n=== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ===');
  if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('测试运行崩溃:', e); process.exit(1); });
