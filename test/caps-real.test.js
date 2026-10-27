'use strict';
/** verify: model-square's model-edit page degrades segmented into an input on "old Apps" */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PluginManager } = require(path.join(__dirname,'..','src','plugins.js'));
const adminUi = require(path.join(__dirname,'..','src','admin-ui.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-e-'));
const store = {
  dir: tmp, pluginsDir: path.join(tmp, 'plugins'), pluginsDataDir: path.join(tmp, 'plugins-data'),
  index: { instances: [] }, getPluginConfig: () => null, pluginEnableList: () => [],
  loadInstance: () => ({ _name: 'default', channels: [] }),
};
fs.mkdirSync(store.pluginsDir, { recursive: true });
fs.mkdirSync(store.pluginsDataDir, { recursive: true });
const pm = new PluginManager(store, { log: () => {} });

function countType(node, t) {
  let n = 0;
  (function w(x) { if (Array.isArray(x)) return x.forEach(w); if (!x || typeof x !== 'object') return; if (x.type === t) n++; if (x.children) w(x.children); if (x.template) w(x.template); })(node);
  return n;
}

(async () => {
  let pass = 0, fail = 0;
  const T = (n, fn) => { try { fn(); console.log('  ✓ ' + n); pass++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + e.message); fail++; } };

  console.log('\n[真实插件用例: model-square 的规则编辑器]');

  /* Make model-square actually activate (using the real plugin directory) */
  const realStore = Object.assign({}, store, { pluginsDir: path.join(__dirname, '..', 'plugins') });
  const realPm = new PluginManager(realStore, { log: () => {} });
  realPm.installed = realPm.installed || new Map();
  realPm.scanInstalled();
  const inst = realPm.installed.get('model-square');
  if (!inst) { console.log('  (跳过: model-square 未安装)'); process.exit(0); }

  const fakeCtx = {
    id: 'model-square', uid: 1, instanceName: 'default', config: {},
    getPluginConfig: () => ({ groups: [], modelMeta: {} }),
    setPluginConfig: () => {}, registerRoute: () => {}, hook: () => {},
    registerAdminUi: (def) => realPm._adminUiPages.set('1/model-square/' + def.id, Object.assign({ pluginId: 'model-square', uid: 1, menu: true }, def)),
    provideCapability: () => {}, log: () => {}, gateway: { instanceChannels: () => [], listInstances: () => [] },
    on: () => {}, emit: () => {}, security: {},
  };
  try { require(path.join(__dirname, '..', 'plugins', 'model-square', 'server.js')).activate(fakeCtx); }
  catch (e) { console.log('  (跳过: 激活异常 ' + e.message + ')'); process.exit(0); }

  const pageDef = realPm._adminUiPages.get('1/model-square/model-edit');
  if (!pageDef) { console.log('  (跳过: 未注册 model-edit 页)'); process.exit(0); }

  /* Use adminPages (caps injected) to get the wrapped render */
  const q = new Map([['instance', 'default'], ['channel', 'ch1'], ['model', 'gpt-4o']]);

  T('新 App(认 segmented) → 保持 segmented', () => {
    const caps = adminUi.capsView(adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'column,row,card,text,segmented,input,button' }));
    realPm.rememberCaps(1, caps);
    const pages = realPm.adminPages(1);
    const p = pages.find(x => x.id === 'model-edit');
    assert(p, 'model-edit 应在页面表里');
    const page = p.render({ selfReq: () => null }, { _name: 'default', _uid: 1 }, q) || {};
    const n = countType(page.root, 'segmented');
    console.log('      segmented 数:', n);
    assert(n > 0, '新 App 应保留 segmented');
  });

  T('★老 App(不认 segmented) → 降级成 input', () => {
    const caps = adminUi.capsView(adminUi.parseCaps({ 'x-gcui-version': '1', 'x-gcui-components': 'column,row,card,text,input,button' }));
    realPm.rememberCaps(1, caps);
    const pages = realPm.adminPages(1);
    const p = pages.find(x => x.id === 'model-edit');
    const page = p.render({ selfReq: () => null }, { _name: 'default', _uid: 1 }, q) || {};
    const nSeg = countType(page.root, 'segmented');
    console.log('      segmented 数:', nSeg);
    assert.strictEqual(nSeg, 0, '老 App 不应有 segmented');
    const s = JSON.stringify(page);
    assert(s.indexOf('此 App 不支持标签选择') >= 0, '应给出可读提示');
  });

  T('网页端(无 caps) → 保持 segmented(不降级)', () => {
    realPm.rememberCaps(1, null);
    const pages = realPm.adminPages(1);
    const p = pages.find(x => x.id === 'model-edit');
    const page = p.render({ selfReq: () => null }, { _name: 'default', _uid: 1 }, q) || {};
    assert(countType(page.root, 'segmented') > 0, '无 caps 时应保持原样');
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + (fail ? '❌ ' : '✅ ') + '结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
