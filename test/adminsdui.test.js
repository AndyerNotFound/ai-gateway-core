'use strict';










const assert = require('assert');
const path = require('path');

const adminUi = require(path.join(__dirname, '..', 'src', 'admin-ui.js'));

let validate = () => [], GCUI_VERSION = 1, COMPONENTS = [];
try {
  const v = require(process.env.GCUI_VALIDATOR || '/workspace/tunnel-verify/validate-gcui.js');
  validate = v.validate; GCUI_VERSION = v.GCUI_VERSION; COMPONENTS = v.COMPONENTS || [];
} catch (_) {
  console.log('⚠️ 未找到 gcui 校验器（沙箱外属正常），本次跳过「App 能力校验」\n');
}

let passed = 0, failed = 0;
function T(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); failed++; }
}


function fakeGw() {
  const instances = new Map();   
  instances.set(2, {
    _name: 'AgnesAI',
    _stats: {
      requests: 120, errors: 3,
      startedAt: new Date(Date.now() - 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '),
      recent: [
        { time: new Date(Date.now() - 600 * 1000).toISOString().slice(0, 19).replace('T', ' '), status: 200, model: 'gpt-4o' },
        { time: new Date(Date.now() - 300 * 1000).toISOString().slice(0, 19).replace('T', ' '), status: 500, model: 'claude-sonnet' },
      ],
      byChannel: { main: { requests: 100, inputTokens: 5000, outputTokens: 7000 } },
    },
  });
  const store = {
    index: {
      instances: [
        { uid: 1, name: 'default', port: 16384, enabled: true },
        { uid: 2, name: 'AgnesAI', port: 16385, enabled: true },
        { uid: 3, name: 'old', port: 16386, enabled: false },
      ],
    },
    instanceFull: () => ({ meta: {}, config: { channels: [1, 2], adminKey: '****' } }),
    loadInstance: () => ({
      channels: [
        { name: 'main', type: 'openai', baseUrl: 'https://api.example.com/v1', models: ['m1', 'm2'], delayMs: 0, default: true, apiKey: 'sk-LEAKCANARY-1234567890' },
        { name: '备选渠道', type: 'claude', baseUrl: 'https://api2.example.com', models: ['c1'], delayMs: 120, insecure: true, apiKey: 'sk-LEAKCANARY-1234567890' },
      ],
      listen: { port: 16384, host: '0.0.0.0' },
      adminKey: 'ADMINKEY-LEAKCANARY-99',
    }),
  };
  return { store: store, pool: { instances: instances } };
}
const cfg = { _name: 'default', _uid: 1 };

console.log('管理端 SDUI 页面测试 (App 侧 gcui v' + GCUI_VERSION + ', 组件 ' + COMPONENTS.length + ' 种)\n');

let page;
T('render(instances) 返回页面', () => {
  page = adminUi.render(fakeGw(), cfg, 'instances');
  assert(page && typeof page === 'object', '页面为空');
  assert.strictEqual(page.gcui, 1, 'gcui 版本应为 1');
  assert(page.root, '缺少 root');
});

T('instances 页通过 App 能力校验（0 错误）', () => {
  const errs = validate(page, 'instances');
  assert.deepStrictEqual(errs, [], errs.join('; '));
});

T('数据正确：3 个实例 / 1 个运行中 / 请求汇总', () => {
  const st = page.state;
  assert.strictEqual(st.instances.length, 3);
  assert.strictEqual(st.count, 3);
  assert.strictEqual(st.running, 1, '运行中应为 1（只有 AgnesAI 在 pool 里）');
  assert.strictEqual(st.requests, 120);
  assert.strictEqual(st.errors, 3);
});

T('状态徽章与按钮可见性正确', () => {
  const def = page.state.instances[0], ag = page.state.instances[1], old = page.state.instances[2];
  assert.strictEqual(def.statusText, '未运行');
  assert.strictEqual(def.current, true, 'default 是当前实例');
  assert.strictEqual(def.canSwitch, false, '当前实例不该出现「用这个实例」');
  assert.strictEqual(ag.statusText, '运行中');
  assert.strictEqual(ag.statusTone, 'success');
  assert.strictEqual(ag.canStop, true);
  assert.strictEqual(ag.canStart, false);
  assert.strictEqual(old.statusText, '已停用');
});

T('写操作走 adminApi，本地状态走 client（并没用用户端 intent）', () => {
  const kinds = new Set();
  const walk = n => {
    if (n == null || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.action && n.action.type) kinds.add(n.action.type);
    for (const k of ['root', 'template', 'children', 'fields']) if (n[k]) walk(n[k]);
  };
  walk(page.root);
  assert(kinds.has('adminApi'), '缺少 adminApi 动作');
  assert(kinds.has('client'), '缺少 client 动作');
  assert(!kinds.has('intent'), '管理端页面不该用用户端 intent');
});

T('★阶段2 组件：instances 页用上 checkbox 多选 + {{selected}} 批量', () => {
  const s = JSON.stringify(page);
  assert(s.includes('"checkbox"'), '缺少 checkbox 组件');
  assert(s.includes('{{selected}}'), '缺少 {{selected}} 绑定（批量选中）');
  assert(s.includes('{{selectedCount}}'), '缺少选中计数');
});

T('render(usage) 返回页面并通过能力校验', () => {
  const p = adminUi.render(fakeGw(), { _name: 'AgnesAI', _uid: 2 }, 'usage');
  assert(p && p.root, '页面为空');
  const errs = validate(p, 'usage');
  assert.deepStrictEqual(errs, [], errs.join('; '));
  


  assert.ok(Array.isArray(p.state.series) && p.state.series.length > 0, '应有曲线序列 series');
  assert.strictEqual(p.state.gran, 'hour');
  assert.strictEqual(typeof p.state.req, 'number');
  assert.strictEqual(p.state.recent.length, 2);
  assert.strictEqual(p.state.recent[0].status, '500', '最近请求应新→旧');
  assert.strictEqual(p.state.recent[0].tone, 'error');
  assert.strictEqual(p.state.channels[0].name, 'main');
  
  const opens = [];
  (function w(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(w);
    if (n.action && n.action.type === 'open') opens.push(n.action.target);
    for (const k of ['root', 'template', 'children']) if (n[k]) w(n[k]);
  })(p.root);
  assert.ok(opens.length >= 3, '应有时段/粒度切换入口');
  assert.ok(opens.every(x => /^(page:|https?:\/\/)/.test(String(x))), opens.join('; '));
});

T('★阶段2 组件：usage 页用上 chart 图表', () => {
  const p = adminUi.render(fakeGw(), { _name: 'AgnesAI', _uid: 2 }, 'usage');
  const s = JSON.stringify(p);
  assert(s.includes('"chart"'), '缺少 chart 组件');
  assert(p.root.children.some(c => c.type === 'chart'), 'root 里没有 chart 节点');
});

T('usage 页：未运行的实例给提示 + 跳原生页入口', () => {
  const p = adminUi.render(fakeGw(), { _name: 'default', _uid: 99 }, 'usage');
  assert(p && p.root, '页面为空');
  const s = JSON.stringify(p);
  assert(s.includes('未运行'), '应提示实例未运行');
  assert(s.includes('openNative'), '应给出跳原生页的入口');
});

T('★阶段4：插件页渲染（插件系统缺席时也不崩）', () => {
  const p = adminUi.render(fakeGw(), cfg, 'plugins');
  assert(p && p.root, '页面为空');
  const errs = validate(p, 'plugins');
  assert.deepStrictEqual(errs, [], errs.join('; '));
});

T('★阶段4：插件列表 + schema 驱动的配置表单（含预填/默认值/布尔开关）', () => {
  const gw = fakeGw();
  gw.plugins = {
    listForInstance: () => ([
      {
        id: 'tunnel', name: '隧道', version: '1.4.0', type: 'business', description: '内网穿透',
        enable: true, running: true, builtin: false, hasAdminPage: true,
        provides: ['app-ui'], permissions: ['gateway:read'], sha256: 'abcdef1234567890',
        schema: [
          { key: 'watchdogSec', label: '连接超时(秒)', type: 'number', default: 20 },
          { key: 'protocolOrder', label: '协议优先级', type: 'string', default: 'http2,quic' },
          { key: 'autoRestart', label: '自动重启', type: 'boolean', default: false },
        ],
        config: { watchdogSec: 30 },
      },
      { id: 'auth-user', name: '用户体系', version: '1.2.0', type: 'auth', enable: false, builtin: true, schema: [] },
    ]),
  };
  const p = adminUi.render(gw, cfg, 'plugins');
  assert.strictEqual(p.state.plugins.length, 2);
  assert.deepStrictEqual(validate(p, 'plugins'), []);
  assert.strictEqual(p.state.plugins[1].stateText, '已停用');
  assert.strictEqual(p.state.plugins[0].detailUrl.indexOf('tunnel') > 0, true);

  const d = adminUi.render(gw, cfg, 'plugin', new Map([['pid', 'tunnel']]));
  assert(d && d.root, '详情页为空');
  assert.deepStrictEqual(validate(d, 'plugin'), []);
  const form = (d.root.children || []).find(c => c.type === 'form');
  assert(form, '缺少配置表单');
  assert.strictEqual(form.fields.length, 3, 'schema 3 项应生成 3 个字段');
  assert.strictEqual(form.fields.find(f => f.key === 'watchdogSec').value, '30', '应预填 config 里的值');
  assert.strictEqual(form.fields.find(f => f.key === 'protocolOrder').value, 'http2,quic', '未配置的项用 default');
  assert.strictEqual(form.fields.find(f => f.key === 'autoRestart').type, 'switch', 'boolean 应渲染成开关');
});

T('★阶段4：插件搜索按关键词过滤 + 找不到的插件给提示页', () => {
  const gw = fakeGw();
  gw.plugins = { listForInstance: () => ([
    { id: 'tunnel', name: '隧道', type: 'business', enable: true },
    { id: 'balance', name: '余额代查', type: 'business', enable: true },
  ]) };
  const hit = adminUi.render(gw, cfg, 'plugins', new Map([['q', '余额']]));
  assert.strictEqual(hit.state.plugins.length, 1);
  assert.strictEqual(hit.state.plugins[0].id, 'balance');
  const miss = adminUi.render(gw, cfg, 'plugin', new Map([['pid', 'nope']]));
  assert(JSON.stringify(miss).includes('不可用'), '应提示插件不可用');
});

T('★阶段4：公告页解析（时间线 / 定向 / 普通三种）', () => {
  const gw = fakeGw();
  gw.store.getServerInfo = () => ({ announcement: '[2026/09/16 00:20] 维护通知\n@u1 你的额度已重置\n普通公告' });
  const p = adminUi.render(gw, cfg, 'notice');
  assert(p && p.root, '页面为空');
  assert.strictEqual(p.state.notices.length, 3);
  assert.strictEqual(p.state.notices[0].timeText, '2026/09/16 00:20');
  assert.strictEqual(p.state.notices[1].targetText, '定向 @u1');
  assert.strictEqual(p.state.notices[2].targetText, '全站可见');
  assert.deepStrictEqual(validate(p, 'notice'), []);
});

T('★阶段4：公告子页（新增 / 编辑）渲染 + 校验', () => {
  const gw = fakeGw();
  gw.store.getServerInfo = () => ({ announcement: '第一条' });
  assert.deepStrictEqual(validate(adminUi.render(gw, cfg, 'notice-new'), 'notice-new'), []);
  assert.deepStrictEqual(validate(adminUi.render(gw, cfg, 'notice-edit', new Map([['i', '0']])), 'notice-edit'), []);
  const miss = adminUi.render(gw, cfg, 'notice-edit', new Map([['i', '9']]));
  assert(JSON.stringify(miss).includes('不存在'), '越界索引应给提示页');
});

T('★不泄密：所有页面都不含真实密钥值（不是只看字段名）', () => {
  const gw = fakeGw();
  for (const name of adminUi.pageIds()) {
    const p = adminUi.render(gw, cfg, name, new Map([['uid', '1'], ['name', 'main']]));
    const s = JSON.stringify(p);
    for (const secret of ['sk-LEAKCANARY', 'ADMINKEY-LEAKCANARY', 'Authorization']) {
      assert(!s.includes(secret), name + ' 页里泄漏了: ' + secret);
    }
  }
});

T('manifest() 声明可被 App 直接消费', () => {
  const m = adminUi.manifest();
  assert.strictEqual(m.version, 1);
  assert(m.pages.length >= 2);
  for (const p of m.pages) {
    assert(p.id && p.title && p.ui.startsWith('/admin/ui/'), '页面声明不完整: ' + JSON.stringify(p));
  }
  assert(m.pages.some(p => p.id === 'instances'), '缺少 instances 页声明');
  assert(m.pages.some(p => p.id === 'usage'), '缺少 usage 页声明');
});

T('★阶段3 补齐：实例子页（详情/改名/新建）都能渲染并通过校验', () => {
  const cases = [
    ['instance-detail', new Map([['uid', '2']])],
    ['instance-edit', new Map([['uid', '2']])],
    ['instance-new', new Map()],
  ];
  for (const [name, q] of cases) {
    const p = adminUi.render(fakeGw(), cfg, name, q);
    assert(p && p.root, name + ' 页面为空');
    const errs = validate(p, name);
    assert.deepStrictEqual(errs, [], name + ': ' + errs.join('; '));
  }
});

T('★阶段3 补齐：实例卡有 详情/改名/删除（阶段1 漏掉的操作）', () => {
  const s = JSON.stringify(page);
  assert(s.includes('instance-detail'), '缺少「详情」入口');
  assert(s.includes('instance-edit'), '缺少「改名」入口');
  assert(s.includes('"DELETE"'), '缺少「删除」动作');
  assert(s.includes('instance-new'), '缺少「新建实例」入口');
});

T('子页不进侧边栏（manifest 只下发菜单页）', () => {
  const ids = adminUi.manifest().pages.map(p => p.id);
  assert(ids.includes('instances') && ids.includes('usage'));
  for (const sub of ['instance-detail', 'instance-edit', 'instance-new']) {
    assert(!ids.includes(sub), sub + ' 不该作为菜单项下发: ' + ids.join(','));
  }
});

T('子页 uid 不存在时给提示页（不是 404，避免 App 白退原生）', () => {
  const p = adminUi.render(fakeGw(), cfg, 'instance-detail', new Map([['uid', '999']]));
  assert(p && p.root, '应返回提示页');
  assert(JSON.stringify(p).includes('不存在'), '应说明实例不存在');
});

T('未知页面返回 null（App 收到 404 会回退原生）', () => {
  assert.strictEqual(adminUi.render(fakeGw(), cfg, 'nope-not-exist'), null);
});


async function TA(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

(async () => {
  await TA('渠道页渲染 + 通过能力校验（含编辑/新增/删除入口）', async () => {
    const p = await adminUi.render(fakeGw(), cfg, 'channels');
    assert(p && p.root, '页面为空');
    const errs = validate(p, 'channels');
    assert.deepStrictEqual(errs, [], errs.join('; '));
    const s = JSON.stringify(p);
    assert(s.includes('channel-edit') && s.includes('channel-new'), '缺少编辑/新增入口');
    assert(s.includes('"DELETE"'), '缺少删除动作');
    assert(s.includes('channel-action'), '缺少 同步模型/查余额/探测 动作');
  });

  await TA('渠道名带中文时，编辑入口 URL 已在服务端编码（App 不会拼出非法地址）', async () => {
    const p = await adminUi.render(fakeGw(), cfg, 'channels');
    const s = JSON.stringify(p);
    assert(s.includes(encodeURIComponent('备选渠道')), '中文渠道名没有被 percent-encode');
    assert(p.state.channels.some(c => c.name === '备选渠道'), '中文渠道应在列表里');
  });

  await TA('渠道编辑 / 新增子页渲染 + 通过能力校验', async () => {
    const gw = fakeGw();
    const cases = [['channel-edit', new Map([['name', 'main']])], ['channel-new', new Map()]];
    for (const [nm, q] of cases) {
      const p = await adminUi.render(gw, cfg, nm, q);
      assert(p && p.root, nm + ' 页面为空');
      const errs = validate(p, nm);
      assert.deepStrictEqual(errs, [], nm + ': ' + errs.join('; '));
    }
  });

  await TA('渠道编辑页预填当前值（名称 / BaseURL / 延迟 / 开关）', async () => {
    const p = await adminUi.render(fakeGw(), cfg, 'channel-edit', new Map([['name', 'main']]));
    const form = (p.root.children || []).find(c => c.type === 'form');
    assert(form, '缺少 form');
    const g = k => (form.fields.find(f => f.key === k) || {}).value;
    assert.strictEqual(g('name'), 'main');
    assert.strictEqual(g('baseUrl'), 'https://api.example.com/v1');
    assert.strictEqual(g('delayMs'), '0');
    assert.strictEqual(form.fields.find(f => f.key === 'isDefault').checked, true);
  });

  await TA('渠道编辑页：找不到的渠道给提示页（不是 404）', async () => {
    const p = await adminUi.render(fakeGw(), cfg, 'channel-edit', new Map([['name', '不存在']]));
    assert(p && p.root, '应返回提示页');
    assert(JSON.stringify(p).includes('找不到'), '应说明找不到渠道');
  });

  await TA('★阶段4：用户页列出用户（封禁/解封按钮可见性正确）', async () => {
    const gw = fakeGw();
    gw.selfReq = async (c, m, path) => {
      if (path.indexOf('auth-user') >= 0) {
        return { users: [
          { uid: 'u1', nickname: '张三', email: 'a@b.c', banned: false },
          { uid: 'u2', nickname: '李四', banned: true, banReason: '滥用' },
        ] };
      }
      if (path.indexOf('auth-cardkey') >= 0) {
        return { keys: [{ key: 'gc-abcdefgh1234', name: '测试卡', enable: true, quotaTokens: 1000, usedTokens: 10 }] };
      }
      return null;
    };
    const p = await adminUi.render(gw, cfg, 'users', new Map([['tab', 'users']]));
    assert(p && p.root, '页面为空');
    assert.strictEqual(p.state.items.length, 2);
    assert.strictEqual(p.state.items[0].canBan, true);
    assert.strictEqual(p.state.items[1].canUnban, true);
    assert.strictEqual(p.state.items[1].stateText, '已封禁');
    assert.deepStrictEqual(validate(p, 'users'), []);

    const k = await adminUi.render(gw, cfg, 'users', new Map([['tab', 'keys']]));
    assert.strictEqual(k.state.items.length, 1);
    assert(k.state.items[0].sub.indexOf('1234') > 0, '卡密后缀应显示');
    assert(k.state.items[0].sub.indexOf('gc-abcdefgh1234') < 0, '卡密不应完整显示（必须打码）');
    assert.deepStrictEqual(validate(k, 'users'), []);
  });

  await TA('★阶段4：用户页搜索过滤 + 插件不可用时给空态（不崩）', async () => {
    const gw = fakeGw();
    gw.selfReq = async () => ({ users: [{ uid: 'u1', nickname: '张三' }, { uid: 'u2', nickname: '李四' }] });
    const p = await adminUi.render(gw, cfg, 'users', new Map([['q', '李四']]));
    assert.strictEqual(p.state.items.length, 1);
    assert.strictEqual(p.state.items[0].name, '李四');

    const empty = await adminUi.render(fakeGw(), cfg, 'users', new Map([['tab', 'users']]));
    assert(empty && empty.root, '插件缺席时应给空态而不是崩');
    assert.deepStrictEqual(validate(empty, 'users'), []);
  });

  const done = failed === 0 ? 'ALL PASS' : 'FAILED';
  console.log('\n' + done + '  (' + passed + ' 通过 / ' + failed + ' 失败)');
  process.exit(failed === 0 ? 0 : 1);
})();
