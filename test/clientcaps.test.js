'use strict';
/* 插件自检能力验证 (2026-10-07): ctx.clientCaps() / render 第4参数 / capsView */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PluginManager } = require(path.join(__dirname, '..', 'src', 'plugins.js'));
const adminUi = require(path.join(__dirname, '..', 'src', 'admin-ui.js'));

let pass = 0, fail = 0;
const _q = [];
function T(n, fn) {
  if (fn && fn.constructor && fn.constructor.name === 'AsyncFunction') {
    _q.push(async () => { try { await fn(); console.log('  ✓ ' + n); pass++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + e.message); fail++; } });
    return;
  }
  try { fn(); console.log('  ✓ ' + n); pass++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + e.message); fail++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-caps-'));
const store = {
  dir: tmp, pluginsDir: path.join(tmp, 'plugins'), pluginsDataDir: path.join(tmp, 'plugins-data'),
  index: { instances: [] }, getPluginConfig: () => null, pluginEnableList: () => [], loadInstance: () => null,
};
fs.mkdirSync(store.pluginsDir, { recursive: true });
fs.mkdirSync(store.pluginsDataDir, { recursive: true });
const pm = new PluginManager(store, { log: () => {} });

console.log('\n[capsView] 插件自检视图');
T('无头 → null(插件应回退保守写法)', () => {
  assert.strictEqual(adminUi.capsView(adminUi.parseCaps({})), null);
  assert.strictEqual(adminUi.capsView(null), null);
});
T('hasComponent/hasIcon/hasNav 三个判定', () => {
  const v = adminUi.capsView(adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'column,text', 'x-gcui-icons': 'home', 'x-gcui-nav': 'push' }));
  assert.strictEqual(v.hasComponent('column'), true);
  assert.strictEqual(v.hasComponent('chart'), false);
  assert.strictEqual(v.hasIcon('msym:home'), true, '应自动去 msym: 前缀');
  assert.strictEqual(v.hasIcon('msym:wallet'), false);
  assert.strictEqual(v.hasNav('push'), true);
  assert.strictEqual(v.hasNav('replace'), false);
});
T('未上报具体清单 → 一律 true(不做限制)', () => {
  const v = adminUi.capsView(adminUi.parseCaps({ 'x-gcui-version': '1' }));
  assert.strictEqual(v.hasComponent('任意组件'), true);
  assert.strictEqual(v.hasIcon('任意图标'), true);
  assert.strictEqual(v.components, null);
});
T('pick() 从候选里挑出本 App 认识的', () => {
  const v = adminUi.capsView(adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'column,card,text' }));
  assert.deepStrictEqual(v.pick(['column', 'chart', 'card', 'segmented']), ['column', 'card']);
});

console.log('\n[rememberCaps + ctx.clientCaps]');
T('rememberCaps 记录后 clientCaps 可读', () => {
  const caps = adminUi.capsView(adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'column' }));
  pm.rememberCaps(1, caps);
  assert(pm._lastCaps.get('1'), '应记录');
  assert.strictEqual(pm._lastCaps.get('1').hasComponent('column'), true);
});
T('传 null → 清除记录(网页端应回退保守)', () => {
  pm.rememberCaps(1, null);
  assert.strictEqual(pm._lastCaps.get('1'), undefined);
});
T('能力按实例隔离', () => {
  const c1 = adminUi.capsView(adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'column' }));
  const c2 = adminUi.capsView(adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'chart' }));
  pm.rememberCaps(1, c1); pm.rememberCaps(2, c2);
  assert.strictEqual(pm._lastCaps.get('1').hasComponent('chart'), false);
  assert.strictEqual(pm._lastCaps.get('2').hasComponent('chart'), true);
});

console.log('\n[插件页 render 第4参数]');
T('★registerAdminUi 的 render 能拿到 caps 作为第4参数', () => {
  /* 模拟插件注册一页, 检查内核注入 */
  pm._adminUiPages.set('1/demo/page', {
    id: 'page', title: 'Demo', pluginId: 'demo', uid: 1, menu: true,
    render: (gw, cfg, q, caps) => ({ gotCaps: !!caps, canChart: caps ? caps.hasComponent('chart') : null }),
  });
  const caps = adminUi.capsView(adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'column,text' }));
  pm.rememberCaps(1, caps);
  const pages = pm.adminPages(1);
  const p = pages.find(x => x.id === 'page');
  assert(p, '页面应在表里');
  const out = p.render({}, {}, new Map());
  assert.strictEqual(out.gotCaps, true, 'render 第4参数应是 caps 视图');
  assert.strictEqual(out.canChart, false, '应能判断出本 App 不支持 chart');
});
T('没记录 caps 时 render 第4参数为 null(不崩)', () => {
  pm.rememberCaps(1, null);
  const pages = pm.adminPages(1);
  const p = pages.find(x => x.id === 'page');
  const out = p.render({}, {}, new Map());
  assert.strictEqual(out.gotCaps, false);
  assert.strictEqual(out.canChart, null);
});
T('未注册 render 的页面定义不被破坏', () => {
  pm._adminUiPages.set('1/demo/noRender', { id: 'noRender', title: 'X', pluginId: 'demo', uid: 1 });
  const p = pm.adminPages(1).find(x => x.id === 'noRender');
  assert(p && typeof p.render !== 'function', '原样返回');
});

console.log('\n[集成] rememberCaps 存的必须是 capsView 视图(踩过的坑)');
T('★core.js 传入的是 capsView 而不是原始 parseCaps(否则插件报 hasComponent is not a function)', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8');
  const hits = s.match(/rememberCaps\(cfg\._uid, adminUi\.capsView\(caps\)\)/g) || [];
  assert(hits.length >= 2, '两处页面路由都应传 capsView, 实际 ' + hits.length + ' 处');
  assert(!/rememberCaps\(cfg\._uid, caps\)/.test(s), '不应直接传原始 caps');
});
T('capsView 结果确实带 hasComponent 等方法', () => {
  const v = adminUi.capsView(adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'column' }));
  assert.strictEqual(typeof v.hasComponent, 'function');
  assert.strictEqual(typeof v.hasIcon, 'function');
  assert.strictEqual(typeof v.pick, 'function');
});

console.log('\n[集成] 插件源码确实能用这套');
T('ctx.clientCaps 已挂在插件上下文', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'plugins.js'), 'utf8');
  assert(/clientCaps\(\) \{ return self\._lastCaps\.get\(String\(uid\)\)/.test(s), 'ctx 应有 clientCaps()');
});
T('插件路由 params 带 clientCaps', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'plugins.js'), 'utf8');
  assert(/clientCaps: \(\(\) => \{/.test(s), 'params 应带 clientCaps');
});

(async () => {
  for (const q of _q) await q();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + (fail ? '❌ ' : '✅ ') + '结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
