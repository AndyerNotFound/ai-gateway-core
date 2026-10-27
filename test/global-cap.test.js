'use strict';
/** verify: the global capability layer + groupIndex via capabilities (no real gateway; stubs only) */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PluginManager } = require(path.join(__dirname,'..','src','plugins.js'));
const mg = require(path.join(__dirname,'..','src','modelgroups.js'));

let pass = 0, fail = 0;
function T(n, fn) { try { fn(); console.log('  ✓ ' + n); pass++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + e.message); fail++; } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-glob-'));
const store = {
  dir: tmp, pluginsDir: path.join(tmp, 'plugins'), pluginsDataDir: path.join(tmp, 'plugins-data'),
  index: { instances: [] }, getPluginConfig: () => null, pluginEnableList: () => [], loadInstance: () => null,
};
fs.mkdirSync(store.pluginsDir, { recursive: true });
fs.mkdirSync(store.pluginsDataDir, { recursive: true });
const pm = new PluginManager(store, { log: () => {} });

console.log('\n[全局能力层]');
T('global 能力注册后, uid=0 也能查到', () => {
  pm.provideCapability(1, 'model-pricing', { allMeta: () => ({}), groups: () => [] }, 'p', true);
  assert(pm.requireCapability(0, 'model-pricing'), 'uid=0 应能拿到 global 能力');
  assert(pm.requireCapability(1, 'model-pricing'), '实例层也应在');
});
T('非 global 能力不会泄漏到 uid=0', () => {
  pm.provideCapability(2, 'instance-only', { x: 1 }, 'p2', false);
  assert.strictEqual(pm.requireCapability(0, 'instance-only'), null);
});
T('★实例查不到时回退全局层(消费方无感)', () => {
  assert(pm.requireCapability(999, 'model-pricing'), '别的实例应回退到全局能力');
});

console.log('\n[modelgroups 走能力源]');
T('传能力对象时不再读 store(内核不点名 model-square)', () => {
  const cap = {
    allMeta: () => ({ 'inst|ch|gpt-4o': { group: '高级' } }),
    groups: () => [{ name: '高级', rate: 2 }],
  };
  const idx = mg.buildIndex(null, cap);   // ★null store passed in: proves independence from store
  assert(idx.declared.includes('高级'), '应读到能力声明的分组');
  assert(idx.groupsOf('gpt-4o').includes('高级'), '模型应落在能力给的分组里');
});
T('不传能力源时回退旧路径(向后兼容)', () => {
  const fakeStore = { getPluginConfig: (id, uid) => (id === 'model-square' ? { groups: [{ name: 'X' }], modelMeta: {} } : null) };
  const idx = mg.buildIndex(fakeStore);
  assert(idx.declared.includes('X'), '旧路径仍应工作');
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
console.log('\n' + (fail ? '❌ ' : '✅ ') + '结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
