
'use strict';
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const zlib = require('zlib'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Gateway } = require('../src/core');
const assert = require('assert');

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


function tarEntry(name, content) {
  const buf = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(buf.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136); header.write('0', 156);
  header.write('ustar\0', 257); header.write('00', 263);
  let sum = 0; for (let i = 0; i < 512; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (buf.length % 512)) % 512);
  return Buffer.concat([header, buf, pad]);
}
function makePluginPkg(id, extraFiles = {}) {
  const manifest = JSON.stringify({ id, name: '测试市场插件', version: '1.2.3', description: '市场测试用', hasServer: true, icon: '🧪', configSchema: [{ key: 'greeting', label: '问候语', type: 'string', default: 'hi' }] });
  const server = `exports.activate = function(ctx){ ctx.registerRoute('GET','/hello',(req,res,p)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({msg:(ctx.config.greeting||'hi')+' from '+ctx.id}))}); };`;
  const parts = [tarEntry('manifest.json', manifest), tarEntry('server.js', server)];
  for (const [n, c] of Object.entries(extraFiles)) parts.push(tarEntry(n, c));
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

async function main() {
  console.log('插件市场测试\n');
  const pkg = makePluginPkg('mkt-demo');
  const pkgSha = crypto.createHash('sha256').update(pkg).digest('hex');

  
  const idxSrv = http.createServer((req, res) => {
    if (req.url === '/index.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: '测试索引', plugins: [{ id: 'mkt-demo', name: '测试市场插件', version: '1.2.3', description: '市场测试用', author: 'tester', type: 'business', icon: '🧪', url: 'PKGURL', sha256: pkgSha, size: pkg.length }] }));
    } else if (req.url === '/pkg.tar.gz') { res.writeHead(200); res.end(pkg); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => idxSrv.listen(0, '127.0.0.1', r));
  const idxPort = idxSrv.address().port;
  const INDEX = 'http://127.0.0.1:' + idxPort + '/index.json';

  
  const idxSrv2 = idxSrv; 
  idxSrv2.removeAllListeners('request');
  idxSrv2.on('request', (req, res) => {
    if (req.url === '/index.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: '测试索引', plugins: [{ id: 'mkt-demo', name: '测试市场插件', version: '1.2.3', description: '市场测试用', author: 'tester', type: 'business', icon: '🧪', url: 'http://127.0.0.1:' + idxPort + '/pkg.tar.gz', sha256: pkgSha, size: pkg.length }] }));
    } else if (req.url === '/pkg.tar.gz') { res.writeHead(200); res.end(pkg); }
    else { res.writeHead(404); res.end(); }
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-mkt-'));
  const gw = new Gateway(dir, { log: () => {} });
  const ADMIN = 'adm', port = 18096;
  const uid = gw.store.createInstance('default', { listen: { port }, adminKey: ADMIN, channels: [{ name: 'c', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'x', default: true }] });
  await gw.start();
  await new Promise(r => setTimeout(r, 400));
  const AH = { 'x-admin-key': ADMIN };
  
  await jreq(port, 'POST', '/admin/api/market/test-mode', { headers: AH, body: { enable: true } });

  console.log('[M] 市场 API');
  await T('初始索引为空', async () => {
    const r = await jreq(port, 'GET', '/admin/api/market/indexes', { headers: AH });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.json.indexes, []);
  });
  await T('添加索引 + 去重 409', async () => {
    const r = await jreq(port, 'POST', '/admin/api/market/indexes', { headers: AH, body: { url: INDEX } });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.json.indexes, [INDEX]);
    const r2 = await jreq(port, 'POST', '/admin/api/market/indexes', { headers: AH, body: { url: INDEX } });
    assert.strictEqual(r2.status, 409);
    const bad = await jreq(port, 'POST', '/admin/api/market/indexes', { headers: AH, body: { url: 'ftp://x' } });
    assert.strictEqual(bad.status, 400);
  });
  await T('浏览市场: 聚合插件列表+安装状态', async () => {
    const r = await jreq(port, 'GET', '/admin/api/market/plugins', { headers: AH });
    assert.strictEqual(r.status, 200);
    const p = r.json.plugins.find(x => x.id === 'mkt-demo');
    assert.ok(p, '应含 mkt-demo'); assert.strictEqual(p.installed, false); assert.strictEqual(p.indexName, '测试索引');
    assert.strictEqual(p.sha256, pkgSha);
  });
  await T('安装插件(sha256 校验通过)', async () => {
    const r = await jreq(port, 'POST', '/admin/api/market/install', { headers: AH, body: { url: 'http://127.0.0.1:' + idxPort + '/pkg.tar.gz', sha256: pkgSha } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.id, 'mkt-demo');
    assert.ok(fs.existsSync(path.join(dir, 'plugins', 'mkt-demo', 'manifest.json')), '插件目录应存在');
  });
  await T('sha256 不匹配拒绝安装', async () => {
    const r = await jreq(port, 'POST', '/admin/api/market/install', { headers: AH, body: { url: 'http://127.0.0.1:' + idxPort + '/pkg.tar.gz', sha256: 'deadbeef' } });
    assert.strictEqual(r.status, 400); assert.ok(r.json.error.includes('SHA256'), '应报 SHA256 不匹配');
  });
  await T('重复安装报已存在', async () => {
    const r = await jreq(port, 'POST', '/admin/api/market/install', { headers: AH, body: { url: 'http://127.0.0.1:' + idxPort + '/pkg.tar.gz' } });
    assert.strictEqual(r.status, 400); assert.ok(r.json.error.includes('已存在'));
  });
  await T('安装后出现在插件列表(未启用)', async () => {
    const r = await jreq(port, 'GET', '/admin/api/plugins/' + uid, { headers: AH });
    const p = r.json.plugins.find(x => x.id === 'mkt-demo');
    assert.ok(p, '应出现在列表'); assert.strictEqual(p.enable, false); assert.strictEqual(p.running, false);
    assert.strictEqual(p.builtin, false); 
    assert.ok(Array.isArray(p.schema) && p.schema.length === 1, 'schema 应可读');
  });
  await T('启用后插件路由工作', async () => {
    await jreq(port, 'POST', '/admin/api/config/' + uid, { headers: AH, body: { listen: { port }, adminKey: ADMIN, channels: [{ name: 'c', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'x', default: true }], plugins: [{ id: 'mkt-demo', enable: true, config: { greeting: 'yo' } }] } });
    await new Promise(r => setTimeout(r, 300));
    const r = await jreq(port, 'GET', '/plugins/mkt-demo/hello');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.msg, 'yo from mkt-demo');
  });
  await T('浏览市场显示已安装', async () => {
    const r = await jreq(port, 'GET', '/admin/api/market/plugins', { headers: AH });
    const p = r.json.plugins.find(x => x.id === 'mkt-demo');
    assert.ok(p.installed && !p.builtin && p.installedVersion === '1.2.3');
  });
  await T('卸载插件(目录+配置清除)', async () => {
    const r = await jreq(port, 'POST', '/admin/api/market/uninstall', { headers: AH, body: { id: 'mkt-demo' } });
    assert.strictEqual(r.status, 200);
    assert.ok(!fs.existsSync(path.join(dir, 'plugins', 'mkt-demo')), '目录应删除');
    const r2 = await jreq(port, 'GET', '/plugins/mkt-demo/hello');
    assert.strictEqual(r2.status, 404, '路由应失效');
  });
  await T('内置插件禁止卸载', async () => {
    const r = await jreq(port, 'POST', '/admin/api/market/uninstall', { headers: AH, body: { id: 'auth-cardkey' } });
    assert.strictEqual(r.status, 403);
  });
  await T('删除索引', async () => {
    const r = await jreq(port, 'POST', '/admin/api/market/indexes-delete', { headers: AH, body: { url: INDEX } });
    assert.deepStrictEqual(r.json.indexes, []);
  });

  console.log('[C] CLI');
  await T('CLI plugin-install (本地路径)', async () => {
    const pkgFile = path.join(dir, 'pkg.tar.gz');
    fs.writeFileSync(pkgFile, pkg);
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'agw-core.js'), 'plugin-install', pkgFile, '--dir', dir], { encoding: 'utf8' });
    assert.ok(out.includes('已安装') && out.includes('mkt-demo'), out);
  });
  await T('CLI plugin-list', async () => {
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'agw-core.js'), 'plugin-list', '--dir', dir], { encoding: 'utf8' });
    assert.ok(out.includes('mkt-demo') && out.includes('auth-cardkey'), out);
  });
  await T('CLI plugin-remove', async () => {
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'agw-core.js'), 'plugin-remove', 'mkt-demo', '--dir', dir], { encoding: 'utf8' });
    assert.ok(out.includes('已卸载'), out);
  });
  await T('CLI plugin-remove 内置拒绝', async () => {
    try {
      execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'agw-core.js'), 'plugin-remove', 'auth-cardkey', '--dir', dir], { encoding: 'utf8', stdio: 'pipe' });
      throw new Error('应该失败');
    } catch (e) { assert.ok(String(e.stderr).includes('内置插件不可卸载')); }
  });

  console.log('\n=== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ===');
  if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
  try { gw.close(); } catch (_) {}
  idxSrv.close();
  setTimeout(() => process.exit(failed ? 1 : 0), 500);
}
main().catch(e => { console.error('测试运行崩溃:', e); process.exit(1); });
