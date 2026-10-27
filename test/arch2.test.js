'use strict';
/** deep refactor, second validation batch (2026-10-07): A capability registration / B depends topology / C capability negotiation */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PluginManager } = require(path.join(__dirname, '..', 'src', 'plugins.js'));
const adminUi = require(path.join(__dirname, '..', 'src', 'admin-ui.js'));

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
let pass = 0, fail = 0;
const _queue = [];
/** supports async cases: sync ones run immediately, async ones queue (awaited together at the end) */
function T(n, fn) {
  if (fn && fn.constructor && fn.constructor.name === 'AsyncFunction') {
    _queue.push(async () => {
      try { await fn(); console.log('  ✓ ' + n); pass++; }
      catch (e) { console.log('  ✗ ' + n + '\n      ' + e.message); fail++; }
    });
    return;
  }
  try { fn(); console.log('  ✓ ' + n); pass++; }
  catch (e) { console.log('  ✗ ' + n + '\n      ' + e.message); fail++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-arch2-'));
const store = {
  dir: tmp, pluginsDir: path.join(tmp, 'plugins'), pluginsDataDir: path.join(tmp, 'plugins-data'),
  index: { instances: [] }, getPluginConfig: () => null, pluginEnableList: () => [], loadInstance: () => null,
};
fs.mkdirSync(store.pluginsDir, { recursive: true });
fs.mkdirSync(store.pluginsDataDir, { recursive: true });
const pm = new PluginManager(store, { log: () => {} });

console.log('\n[A] 注册配置能力化 (内核不再点名 auth-user)');
T('core.js 不再读 auth-user 的注册配置', () => {
  const s = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8'));
  assert(!/getPluginConfig\('auth-user'/.test(s), '应改用 requireCapability');
  assert(/requireCapability\(uid, 'user-registration'\)/.test(s), '应查 user-registration 能力');
});
T('auth-user 注册了 user-registration 且字段形状不变', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'auth-user', 'server.js'), 'utf8');
  assert(/provideCapability\('user-registration'/.test(s));
  for (const f of ['enable', 'minPasswordLen', 'captchaProvider', 'captchaSiteKey', 'emailVerify']) {
    assert(s.indexOf(f) >= 0, '缺字段: ' + f);
  }
});

console.log('\n[B] depends 拓扑排序');
function mk(id, deps) { return [{ id }, { manifest: { id, depends: deps } }]; }
T('被依赖者先加载 (billing 依赖 model-square)', () => {
  const r = pm._topoSort([mk('billing', ['model-square']), mk('model-square', [])]);
  assert.deepStrictEqual(r.order.map(e => e[0].id), ['model-square', 'billing']);
});
T('缺失依赖被记录(不再静默)', () => {
  const r = pm._topoSort([mk('billing', ['model-square'])]);
  assert.strictEqual(r.missing.length, 1);
  assert.strictEqual(r.missing[0].dep, 'model-square');
});
T('★成环被检测(不死循环)', () => {
  const r = pm._topoSort([mk('a', ['b']), mk('b', ['a'])]);
  assert(r.cycles.length > 0, '应报环');
  assert.strictEqual(r.order.length, 2, '仍应给出顺序(不丢插件)');
});
T('无依赖时保持声明顺序', () => {
  const r = pm._topoSort([mk('x', []), mk('y', []), mk('z', [])]);
  assert.deepStrictEqual(r.order.map(e => e[0].id), ['x', 'y', 'z']);
});
T('billing 的 depends 声明真实存在', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'billing', 'manifest.json'), 'utf8'));
  assert(Array.isArray(m.depends) && m.depends.includes('model-square'));
});

console.log('\n[C] App 能力协商 (X-GCUI-* 终于有人读了)');
T('parseCaps: 无头 → null(不裁剪, 向后兼容)', () => {
  assert.strictEqual(adminUi.parseCaps({}), null);
  assert.strictEqual(adminUi.parseCaps(null), null);
});
T('只上报版本号(无组件清单) → 不裁剪', () => {
  const c = adminUi.parseCaps({ 'x-gcui-version': '1' });
  assert.strictEqual(c.version, 1);
  assert.strictEqual(c.components, null, '未上报清单 = 不裁剪');
  const page = { root: { type: 'column', children: [{ type: 'chart' }] } };
  assert.strictEqual(adminUi.negotiate(page, c).root.children[0].type, 'chart', '不应降级');
});
T('parseCaps: 有头 → 解析出组件/图标/nav 清单', () => {
  const c = adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'column,row,card', 'x-gcui-icons': 'home,apps' });
  assert.strictEqual(c.version, 1);
  assert(c.components.has('card'));
  assert(c.icons.has('home'));
  assert(!c.components.has('chart'), '未上报的组件应不在集合里');
});
T('★未知组件被降级(不再是红色错误块)', () => {
  const caps = adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'column,row,text' });
  const page = { root: { type: 'column', children: [{ type: 'chart', items: '{{x}}' }] } };
  const out = adminUi.negotiate(page, caps);
  const child = out.root.children[0];
  assert.strictEqual(child.type, 'text', '未知组件应降级为 text');
  assert(child.text.indexOf('chart') >= 0, '提示里应说明是哪个组件');
});
T('已知组件保持原样', () => {
  const caps = adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'column,card' });
  const page = { root: { type: 'column', children: [{ type: 'card', children: [] }] } };
  const out = adminUi.negotiate(page, caps);
  assert.strictEqual(out.root.children[0].type, 'card');
});
T('★白名单外图标被换成通用图标(不再静默空白)', () => {
  const caps = adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-icons': 'home' });
  const page = { root: { type: 'column', children: [{ type: 'icon', icon: 'msym:wallet' }] } };
  const out = adminUi.negotiate(page, caps);
  assert.strictEqual(out.root.children[0].icon, 'apps');
});
T('不支持的 nav 被移除(旧 App 不会坏)', () => {
  const caps = adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-nav': 'push' });
  const page = { root: { type: 'column', children: [{ type: 'button', text: 'x', action: { type: 'open', target: 'page:a', nav: 'replace' } }] } };
  const out = adminUi.negotiate(page, caps);
  assert.strictEqual(out.root.children[0].action.nav, undefined);
});
T('降级会在页尾明确告知(不静默)', () => {
  const caps = adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'column,text' });
  const page = { root: { type: 'column', children: [{ type: 'chart' }] } };
  const out = adminUi.negotiate(page, caps);
  const last = out.root.children[out.root.children.length - 1];
  assert(last.text.indexOf('降级') >= 0, '应有降级说明');
});
T('caps 为 null 时页面零改动', () => {
  const page = { root: { type: 'column', children: [{ type: 'chart' }] } };
  const out = adminUi.negotiate(page, null);
  assert.strictEqual(out.root.children[0].type, 'chart', '不裁剪');
});
T('递归覆盖 template 内部(list 模板)', () => {
  const caps = adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'list,text' });
  const page = { root: { type: 'list', template: { type: 'chart' } } };
  const out = adminUi.negotiate(page, caps);
  assert.strictEqual(out.root.template.type, 'text', 'template 里的未知组件也应降级');
});

console.log('\n[C2] async 页面的能力协商 (踩过的坑)');
T('★async 页面(users)的协商不被 Promise 吞掉', async () => {
  /* regression: render used to negotiate(Promise) directly on an async build -> `!page.root` skipped negotiation, failing silently */
  const gw = { store: {}, pool: { instances: new Map() }, plugins: { requireCapability: () => null, listForInstance: () => [], adminPages: () => [] } };
  const cfg = { _uid: 1, _name: 'default' };
  const caps = adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'column,text,row' });
  const p = await adminUi.render(gw, cfg, 'users', new Map([['tab', 'users']]), [], { base: '/admin/ui/users', admin: true, caps });
  assert(p && p.root, 'async 页面应 resolve 出页面');
  const types = new Set();
  (function w(n) { if (Array.isArray(n)) return n.forEach(w); if (!n || typeof n !== 'object') return; if (n.type) types.add(n.type); if (n.children) w(n.children); if (n.template) w(n.template); })(p.root);
  assert(!types.has('segmented'), 'segmented 未上报 → 应被降级掉');
  assert(types.has('text'), '降级后应是 text');
  assert(JSON.stringify(p).indexOf('降级') >= 0, '应有降级说明');
});

(async () => {
  for (const q of _queue) await q();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + (fail ? '❌ ' : '✅ ') + '结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
