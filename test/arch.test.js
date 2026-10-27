'use strict';
/* 深度改造验证 (2026-10-07): 能力注册表 + 声明式 adminApi
 * 目标: 证明"内核不再需要知道插件名"这个命题成立。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PluginManager } = require(path.join(__dirname, '..', 'src', 'plugins.js'));

/** 剥掉 JS 注释后再断言 —— 否则"我改了代码但注释里还留着旧名字"会误报 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释(避开 http://)
}

let pass = 0, fail = 0;
function T(n, fn) { try { fn(); console.log('  ✓ ' + n); pass++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + e.message); fail++; } }

/* 用临时目录, 绝不碰线上 data/ */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-arch-'));
const store = {
  dir: tmp,
  pluginsDir: path.join(tmp, 'plugins'),
  pluginsDataDir: path.join(tmp, 'plugins-data'),
  index: { instances: [] },
  getPluginConfig: () => null,
  pluginEnableList: () => [],
  loadInstance: () => null,
};
fs.mkdirSync(store.pluginsDir, { recursive: true });
fs.mkdirSync(store.pluginsDataDir, { recursive: true });

const pm = new PluginManager(store, { log: () => {} });

console.log('\n[1] 能力注册表 (Capability Registry)');
T('注册能力后能取回实现', () => {
  pm.provideCapability(1, 'model-pricing', { priceOf: () => 42 }, 'model-square');
  const cap = pm.requireCapability(1, 'model-pricing');
  assert(cap && cap.priceOf() === 42, '应能取回实现');
});
T('能力缺席返回 null (不抛异常 = Forge LazyOptional 语义)', () => {
  assert.strictEqual(pm.requireCapability(1, 'no-such-cap'), null);
  assert.strictEqual(pm.requireCapability(999, 'model-pricing'), null, '别的实例不该看到');
});
T('★换一个插件提供同一能力: 消费方完全无感', () => {
  pm.provideCapability(1, 'model-pricing', { priceOf: () => 99 }, 'some-other-plugin');
  assert.strictEqual(pm.requireCapability(1, 'model-pricing').priceOf(), 99, '后注册者优先');
});
T('listCapabilities 只按能力名+提供者列出', () => {
  const l = pm.listCapabilities(1);
  assert(l.some(c => c.name === 'model-pricing' && c.pluginId === 'some-other-plugin'), '应含新提供者');
});
T('能力按实例隔离', () => {
  pm.provideCapability(2, 'model-pricing', { priceOf: () => 7 }, 'p2');
  assert.strictEqual(pm.requireCapability(2, 'model-pricing').priceOf(), 7);
  assert.strictEqual(pm.requireCapability(1, 'model-pricing').priceOf(), 99, '实例1不受影响');
});
T('空实现被拒绝 (防静默注册了个空能力)', () => {
  assert.throws(() => pm.provideCapability(1, 'bad-cap', null));
  assert.throws(() => pm.provideCapability(1, '', {}));
});

console.log('\n[2] 声明式 adminApi (内核去硬编码)');
T('★内核源码里已无任何插件名白名单常量', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8'));
  assert(!/PLUGIN_CALL_OK/.test(src), 'PLUGIN_CALL_OK 常量应已删除');
  const m = /'auth-user':\s*1/.exec(src);
  assert(!m, "core.js 不应再有 'auth-user': 1 这类插件名表");
});
T('未声明 adminApi 的插件 → 禁止代调 (null)', () => {
  pm.installed.set('no-decl', { manifest: { id: 'no-decl' }, dir: '/x' });
  assert.strictEqual(pm.adminApiDecl('no-decl', 1), null);
});
T('声明了 → 返回前缀数组', () => {
  pm.installed.set('decl-ok', { manifest: { id: 'decl-ok', adminApi: ['/admin/keys'] }, dir: '/x' });
  const d = pm.adminApiDecl('decl-ok', 1);
  assert.deepStrictEqual(d, ['/admin/keys']);
});
T('声明空数组 → 仍禁止 (等价未声明)', () => {
  pm.installed.set('decl-empty', { manifest: { id: 'decl-empty', adminApi: [] }, dir: '/x' });
  assert.deepStrictEqual(pm.adminApiDecl('decl-empty', 1), [], '返回空数组');
});
T('未安装的插件 → 禁止', () => {
  assert.strictEqual(pm.adminApiDecl('ghost-plugin', 1), null);
});

console.log('\n[3] 9 个内置插件 manifest 的声明与实际调用点一致');
const REAL_CALLS = {
  'auth-cardkey': ['/admin/keys', '/admin/keys-update'],
  'auth-user':    ['/admin/users'],
  'model-square': ['/admin/groups'],
  'model-sync':   ['/admin/run'],
  'billing':      ['/admin/rules'],
  'vault':        ['/admin/unlock', '/admin/lock', '/admin/encrypt-all', '/admin/clean-backups'],
};
for (const [pid, want] of Object.entries(REAL_CALLS)) {
  T(pid + ' 声明覆盖全部真实调用点', () => {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins', pid, 'manifest.json'), 'utf8'));
    assert(Array.isArray(m.adminApi), 'adminApi 必须是数组');
    for (const w of want) assert(m.adminApi.includes(w), '缺声明: ' + w);
  });
}

console.log('\n[4] 内置插件确实注册了能力 (防"改了但没生效")');
const PROVIDERS = {
  'model-square': 'model-pricing',
  'auth-user':    'user-groups',
  'auth-cardkey': 'cardkey-admin',
};
for (const [pid, cap] of Object.entries(PROVIDERS)) {
  T(pid + ' 源码里确实 provideCapability(' + cap + ')', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', pid, 'server.js'), 'utf8');
    assert(src.indexOf("provideCapability('" + cap + "'") >= 0, pid + ' 缺 ' + cap + ' 注册');
    assert(/ctx\.log\([^)]*已激活/.test(src), '激活日志应提到已提供能力');
  });
}
T('auth-user 还注册了 user-admin(内核「用户」页数据源)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'auth-user', 'server.js'), 'utf8');
  assert(src.indexOf("provideCapability('user-admin'") >= 0);
});

console.log('\n[5] billing 不再硬编码插件 id');
T('billing/server.js 不再读 model-square 配置', () => {
  const s = stripComments(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'billing', 'server.js'), 'utf8'));
  assert(!/getPluginConfig\('model-square'/.test(s), '应改用 requireCapability');
  assert(!/getPluginConfig\('auth-user'/.test(s), '应改用 requireCapability');
  assert(/requireCapability\('model-pricing'\)/.test(s), '应查 model-pricing 能力');
  assert(/requireCapability\('user-groups'\)/.test(s), '应查 user-groups 能力');
});
T('model-square 注册 model-pricing, auth-user 注册 user-groups', () => {
  const ms = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'model-square', 'server.js'), 'utf8');
  const au = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'auth-user', 'server.js'), 'utf8');
  assert(/provideCapability\('model-pricing'/.test(ms));
  assert(/provideCapability\('user-groups'/.test(au));
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
console.log('\n' + (fail ? '❌ ' : '✅ ') + '结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
