'use strict';




const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { Gateway } = require('../src/core');
const { Store } = require('../src/store');

let passed = 0, failed = 0; const failures = [];
async function T(name, fn) { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; failures.push(name + ': ' + e.message); console.log('  ✗', name, '-', e.message); } }
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agw-pe-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function jreq(port, method, p, { headers = {}, body, branch } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port, path: (branch ? '/' + branch : '') + p, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers, data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}


let lastUpstreamBody = null;
function mockUpstream() {
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      let j = {}; try { j = JSON.parse(bodyStr || '{}'); } catch (_) {}
      lastUpstreamBody = bodyStr;
      if (req.url.includes('/embeddings')) {
        return res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }], model: j.model || 'emb', usage: { prompt_tokens: 3, total_tokens: 3 } }));
      }
      if (j.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const long = '这是一段非常长的思考内容用来测试截断功能是否正常工作每段二十字';
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: long + '\n第二段思考也是非常长的内容用来测试截断效果好不好' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '正文回答' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\n');
        return res.end('data: [DONE]\n\n');
      }
      res.end(JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion', created: 1700000000, model: j.model || 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: 'mock回复', reasoning_content: 'x'.repeat(500) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

async function main() {
  console.log('ai-gateway-core 插件集成测试\n');
  const mock = await mockUpstream();
  const dir = tmpdir();
  const gw = new Gateway(dir, {});
  const store = gw.store;
  const ADMIN = 'adm-test-key';
  const port = 18091, port2 = 18092;
  
  for (const pt of [port, port2]) {
    const busy = await new Promise(r => { const c = http.get('http://127.0.0.1:' + pt + '/health', res => { res.resume(); r(true); }); c.on('error', () => r(false)); c.setTimeout(800, () => { c.destroy(); r(false); }); });
    if (busy) throw new Error('端口 ' + pt + ' 被占用(可能有上次测试残留进程), 先 pkill -f "plugins-e2e[.]js"');
  }
  const uid = store.createInstance('default', {
    listen: { port }, adminKey: ADMIN,
    channels: [{ name: 'mock', type: 'openai', baseUrl: 'http://127.0.0.1:' + mock.port, apiKey: 'sk-mock', default: true }],
  });
  const uid2 = store.createInstance('second', {
    listen: { port: port2 }, adminKey: ADMIN,
    channels: [{ name: 'mock', type: 'openai', baseUrl: 'http://127.0.0.1:' + mock.port, apiKey: 'sk-mock', default: true }],
  });
  await gw.start();
  await sleep(300);
  const AH = { 'x-admin-key': ADMIN };
  const baseCfg = (pt) => ({ listen: { port: pt }, adminKey: ADMIN, channels: [{ name: 'mock', type: 'openai', baseUrl: 'http://127.0.0.1:' + mock.port, apiKey: 'sk-mock', default: true }] });

  
  console.log('[P1] auth-cardkey 卡密');
  let cardKey = '';

  await T('启用 auth-cardkey 插件(经实例配置热重载)', async () => {
    const r = await jreq(port, 'POST', '/admin/api/config/' + uid, {
      headers: AH, body: Object.assign(baseCfg(port), { plugins: [{ id: 'auth-cardkey', enable: true }] }),
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    await sleep(200);
    const list = await jreq(port, 'GET', '/admin/api/plugins/' + uid, { headers: AH });
    const ck = (list.json.plugins || []).find(p => p.id === 'auth-cardkey');
    assert(ck && ck.running, 'auth-cardkey 应已激活: ' + JSON.stringify(list.json));
  });

  await T('管理端发卡', async () => {
    const r = await jreq(port, 'POST', '/plugins/auth-cardkey/admin/keys', {
      headers: AH, body: { name: '测试卡', quotaTokens: 1000 },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert(r.json.key && r.json.key.key.startsWith('sk-'), '应返回 sk- 卡密');
    cardKey = r.json.key.key;
  });

  await T('无 key 请求被拒绝 401', async () => {
    const r = await jreq(port, 'POST', '/v1/chat/completions', { body: { model: 'mock', messages: [{ role: 'user', content: 'hi' }] } });
    assert.strictEqual(r.status, 401, JSON.stringify(r.json));
  });

  await T('用卡请求成功 + 用量累计', async () => {
    const r = await jreq(port, 'POST', '/v1/chat/completions', {
      headers: { authorization: 'Bearer ' + cardKey },
      body: { model: 'mock', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json).slice(0, 200));
    const cr = await jreq(port, 'GET', '/credits', { headers: { authorization: 'Bearer ' + cardKey } });
    assert.strictEqual(cr.status, 200);
    assert.strictEqual(cr.json.usedTokens, 15, '用量应为 15 (10+5): ' + JSON.stringify(cr.json));
    assert.strictEqual(cr.json.remainingTokens, 985);
  });

  await T('错误 key 401 / 禁用卡 401', async () => {
    const bad = await jreq(port, 'POST', '/v1/chat/completions', { headers: { authorization: 'Bearer sk-wrong' }, body: { model: 'mock', messages: [] } });
    assert.strictEqual(bad.status, 401);
    await jreq(port, 'POST', '/plugins/auth-cardkey/admin/keys-update', { headers: AH, body: { key: cardKey, enable: false } });
    const dis = await jreq(port, 'POST', '/v1/chat/completions', { headers: { authorization: 'Bearer ' + cardKey }, body: { model: 'mock', messages: [] } });
    assert.strictEqual(dis.status, 401);
    await jreq(port, 'POST', '/plugins/auth-cardkey/admin/keys-update', { headers: AH, body: { key: cardKey, enable: true } });
  });

  await T('模型白名单拦截 403', async () => {
    const r = await jreq(port, 'POST', '/plugins/auth-cardkey/admin/keys', { headers: AH, body: { name: '限模卡', models: ['gpt-x'] } });
    const k = r.json.key.key;
    const rr = await jreq(port, 'POST', '/v1/chat/completions', { headers: { authorization: 'Bearer ' + k }, body: { model: 'mock', messages: [] } });
    assert.strictEqual(rr.status, 403, JSON.stringify(rr.json));
  });

  await T('全局分支白名单: 卡限 default 实例, 访问 second 实例 403', async () => {
    const r = await jreq(port, 'POST', '/plugins/auth-cardkey/admin/keys', { headers: AH, body: { name: '限分支卡', branches: ['default'] } });
    const k = r.json.key.key;
    const okR = await jreq(port, 'POST', '/v1/chat/completions', { headers: { authorization: 'Bearer ' + k }, body: { model: 'mock', messages: [] } });
    assert.strictEqual(okR.status, 200);
    const denyR = await jreq(port2, 'POST', '/v1/chat/completions', { headers: { authorization: 'Bearer ' + k }, body: { model: 'mock', messages: [] } });
    assert.strictEqual(denyR.status, 403, 'second 实例应拒绝: ' + JSON.stringify(denyR.json));
  });

  
  console.log('[P2] auth-user 用户体系');
  let userKey = '';

  await T('启用 auth-user + 注册', async () => {
    const r = await jreq(port, 'POST', '/admin/api/config/' + uid, {
      headers: AH, body: Object.assign(baseCfg(port), { plugins: [{ id: 'auth-cardkey', enable: true }, { id: 'auth-user', enable: true, config: { registration: { enable: true, defaultQuota: 5000 } } }] }),
    });
    assert.strictEqual(r.status, 200);
    await sleep(200);
    const reg = await jreq(port, 'POST', '/auth/register', { body: { uid: 'tester1', password: 'password123' } });
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
    assert(reg.json.key && reg.json.key.startsWith('sk-'), '注册应返回主卡');
    userKey = reg.json.key;
  });

  await T('账密登录返回卡密', async () => {
    const r = await jreq(port, 'POST', '/auth/login', { body: { uid: 'tester1', password: 'password123' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.uid, 'tester1');
    assert(r.json.keys.length >= 1 && r.json.keys[0].key === userKey);
    const bad = await jreq(port, 'POST', '/auth/login', { body: { uid: 'tester1', password: 'wrong' } });
    assert.strictEqual(bad.status, 401);
  });

  await T('GET /auth/me + 自助发子卡(额度截断)', async () => {
    const me = await jreq(port, 'GET', '/auth/me', { headers: { authorization: 'Bearer ' + userKey } });
    assert.strictEqual(me.status, 200, JSON.stringify(me.json));
    assert.strictEqual(me.json.uid, 'tester1');
    const sub = await jreq(port, 'POST', '/auth/mykeys', { headers: { authorization: 'Bearer ' + userKey }, body: { name: '子卡', quotaTokens: 999999 } });
    assert.strictEqual(sub.status, 200);
    assert(sub.json.key.quotaTokens <= 5000, '子卡额度应截断到父卡剩余: ' + sub.json.key.quotaTokens);
  });

  await T('重复注册 409 / 未开放注册 403', async () => {
    const dup = await jreq(port, 'POST', '/auth/register', { body: { uid: 'tester1', password: 'password123' } });
    assert.strictEqual(dup.status, 409);
    const off = await jreq(port2, 'POST', '/auth/register', { body: { uid: 'x1', password: 'password123' } });
    assert(off.status === 403 || off.status === 404, 'second 实例未启用 auth-user 应 403/404: ' + off.status);
  });

  
  console.log('[P3] second-auth 第二验证');

  await T('配置第二密码后管理 API 需要 x-admin-key2', async () => {
    const r = await jreq(port, 'POST', '/admin/api/config/' + uid, {
      headers: AH, body: Object.assign(baseCfg(port), { plugins: [{ id: 'auth-cardkey', enable: true }, { id: 'auth-user', enable: true, config: { registration: { enable: true } } }, { id: 'second-auth', enable: true, config: { secondKey: 's2-key' } }] }),
    });
    assert.strictEqual(r.status, 200);
    await sleep(200);
    const noKey2 = await jreq(port, 'GET', '/admin/api/plugins/' + uid, { headers: AH });
    assert.strictEqual(noKey2.status, 401, '无第二密码应 401: ' + JSON.stringify(noKey2.json));
    const withKey2 = await jreq(port, 'GET', '/admin/api/plugins/' + uid, { headers: Object.assign({}, AH, { 'x-admin-key2': 's2-key' }) });
    assert.strictEqual(withKey2.status, 200);
  });

  
  console.log('[P4] redact 隐私过滤');

  await T('redact 脱敏请求体中的密钥', async () => {
    await jreq(port, 'POST', '/admin/api/config/' + uid, {
      headers: Object.assign({}, AH, { 'x-admin-key2': 's2-key' }),
      body: Object.assign(baseCfg(port), { plugins: [{ id: 'auth-cardkey', enable: true }, { id: 'second-auth', enable: true, config: { secondKey: 's2-key' } }, { id: 'redact', enable: true, config: { enable: true } }] }),
    });
    await sleep(200);
    lastUpstreamBody = null;
    const r = await jreq(port, 'POST', '/v1/chat/completions', {
      headers: { authorization: 'Bearer ' + cardKey },
      body: { model: 'mock', messages: [{ role: 'user', content: '我的key是 sk-ant-abcdefghijklmnop123456 别泄露' }] },
    });
    assert.strictEqual(r.status, 200);
    assert(lastUpstreamBody && !lastUpstreamBody.includes('sk-ant-abcdefghijklmnop123456'), '上游不应看到明文 key: ' + (lastUpstreamBody || '').slice(0, 200));
  });

  
  console.log('[P5] thinking-summary 思考链精简');

  await T('truncate 模式流式截断 reasoning', async () => {
    await jreq(port, 'POST', '/admin/api/config/' + uid, {
      headers: Object.assign({}, AH, { 'x-admin-key2': 's2-key' }),
      body: Object.assign(baseCfg(port), { plugins: [{ id: 'auth-cardkey', enable: true }, { id: 'second-auth', enable: true, config: { secondKey: 's2-key' } }, { id: 'thinking-summary', enable: true, config: { enable: true, mode: 'truncate', maxCharsPerSegment: 20 } }] }),
    });
    await sleep(200);
    const text = await new Promise((resolve, reject) => {
      const r = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + cardKey } }, (res) => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
      });
      r.on('error', reject);
      r.end(JSON.stringify({ model: 'mock', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    });
    const reasoning = (text.match(/"reasoning_content":"([^"]*)"/g) || []).join('');
    assert(text.includes('正文回答'), '应包含正文: ' + text.slice(0, 300));
    assert(!text.includes('用来测试截断功能是否正常工作每段二十字'), 'reasoning 长段应被截断: ' + reasoning.slice(0, 200));
    assert(text.includes('…'), '应有省略号标记截断');
  });

  await T('非流式 reasoning 也被精简(500字→截断)', async () => {
    const r = await jreq(port, 'POST', '/v1/chat/completions', {
      headers: { authorization: 'Bearer ' + cardKey },
      body: { model: 'mock', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.strictEqual(r.status, 200);
    const rc = r.json.choices[0].message.reasoning_content || '';
    assert(rc.length < 500 && rc.includes('…'), 'reasoning 应被精简(单行500字按步长切块各取20字): 实际 ' + rc.length + ' 字');
  });

  
  console.log('[P6] openai-extras 扩展端点');

  await T('/v1/embeddings 转发 mock 上游', async () => {
    await jreq(port, 'POST', '/admin/api/config/' + uid, {
      headers: Object.assign({}, AH, { 'x-admin-key2': 's2-key' }),
      body: Object.assign(baseCfg(port), { plugins: [{ id: 'auth-cardkey', enable: true }, { id: 'second-auth', enable: true, config: { secondKey: 's2-key' } }, { id: 'openai-extras', enable: true, config: { enable: true } }] }),
    });
    await sleep(200);
    const r = await jreq(port, 'POST', '/v1/embeddings', {
      headers: { authorization: 'Bearer ' + cardKey },
      body: { model: 'emb', input: 'test' },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json).slice(0, 200));
    assert(r.json.data && r.json.data[0].embedding, '应返回 embedding');
    const nf = await jreq(port2, 'POST', '/v1/embeddings', { body: { model: 'emb', input: 't' } });
    assert.strictEqual(nf.status, 404, 'second 实例未启用 extras 应 404: ' + nf.status);
  });

  
  await T('回归: 卡密请求仍正常', async () => {
    const r = await jreq(port, 'POST', '/v1/chat/completions', {
      headers: { authorization: 'Bearer ' + cardKey },
      body: { model: 'mock', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.strictEqual(r.status, 200);
  });

  
  console.log('[P7] auth-user 邮箱验证 + SMTP');
  
  try {
    const h = await jreq(port, 'GET', '/health');
    console.log('  [debug] P7 前 health:', h.status);
  } catch (e) { console.log('  [debug] P7 前 health 失败:', e.message); }
  
  const net = require('net');
  const smtpState = { lastMail: '', lastTo: '' };
  const smtpSrv = net.createServer(sock => {
    let step = 0, inData = false, dataBuf = '';
    sock.write('220 fake-smtp ready\r\n');
    sock.on('data', chunk => {
      const lines = chunk.toString('utf8').split('\r\n').filter(l => l !== '');
      for (const line of lines) {
        if (inData) {
          if (line === '.') { inData = false; smtpState.lastMail = dataBuf; sock.write('250 OK queued\r\n'); }
          else dataBuf += line + '\n';
          continue;
        }
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (cmd === 'AUTH') sock.write('334 ' + Buffer.from('Username').toString('base64') + '\r\n');
        else if (cmd === 'MAIL') sock.write('250 OK\r\n');
        else if (cmd === 'RCPT') { smtpState.lastTo = line; sock.write('250 OK\r\n'); }
        else if (cmd === 'DATA') { inData = true; dataBuf = ''; sock.write('354 End with .\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
        else if (/^[A-Za-z0-9+\/=]+$/.test(line) && step < 2) { step++; sock.write(step === 1 ? '334 ' + Buffer.from('Password').toString('base64') + '\r\n' : '235 OK\r\n'); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  await new Promise(r => smtpSrv.listen(0, '127.0.0.1', r));
  const smtpPort = smtpSrv.address().port;

  await T('开启 emailVerify + 配置 SMTP', async () => {
    const AH2 = Object.assign({}, AH, { 'x-admin-key2': 's2-key' });
    const r = await jreq(port, 'POST', '/admin/api/config/' + uid, { headers: AH2, body: Object.assign(baseCfg(port), { plugins: [{ id: 'auth-cardkey', enable: true }, { id: 'auth-user', enable: true }] }) });
    assert.strictEqual(r.status, 200);
    
    const r2 = await jreq(port, 'POST', '/admin/api/plugin-config/' + uid + '/auth-user', { headers: AH2, body: { registration: { enable: true, emailVerify: { enable: true, smtpUrl: 'smtp://user:pass@127.0.0.1:' + smtpPort } } } });
    assert.strictEqual(r2.status, 200);
    await new Promise(r3 => setTimeout(r3, 300));
    const g = await jreq(port, 'GET', '/auth/register');
    assert.strictEqual(g.json.emailVerify, true, 'GET /auth/register 应报告 emailVerify');
  });
  await T('发验证码 → SMTP 收到含验证码邮件', async () => {
    const r = await jreq(port, 'POST', '/auth/email-code', { body: { email: 'test@example.com' } });
    assert.strictEqual(r.status, 200);
    assert.ok(smtpState.lastMail.includes('test@example.com') || smtpState.lastTo.includes('test@example.com'), 'SMTP 应收到目标邮箱');
    const m = smtpState.lastMail.match(/验证码是: (\d{6})/);
    assert.ok(m, '邮件应含 6 位验证码, 内容: ' + smtpState.lastMail.slice(0, 120));
    global.__testEmailCode = m[1];
  });
  await T('错误验证码注册被拒', async () => {
    const r = await jreq(port, 'POST', '/auth/register', { body: { uid: 'evuser', password: 'password123', email: 'test@example.com', emailCode: '000000' } });
    assert.strictEqual(r.status, 400);
    assert.ok(r.json.error.includes('验证码'), r.json.error);
  });
  await T('正确验证码注册成功 + 邮箱入库', async () => {
    const r = await jreq(port, 'POST', '/auth/register', { body: { uid: 'evuser', password: 'password123', email: 'test@example.com', emailCode: global.__testEmailCode } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.key, '应返回主卡');
  });
  await T('同邮箱重复注册 409', async () => {
    await jreq(port, 'POST', '/auth/email-code', { body: { email: 'test@example.com' } }).catch(() => {});
    const m = smtpState.lastMail.match(/验证码是: (\d{6})/);
    const r = await jreq(port, 'POST', '/auth/register', { body: { uid: 'evuser2', password: 'password123', email: 'test@example.com', emailCode: m ? m[1] : '' } });
    assert.strictEqual(r.status, 409);
  });
  smtpSrv.close();

  console.log('\n=== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ===');
  if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('测试运行崩溃:', e); process.exit(1); });
