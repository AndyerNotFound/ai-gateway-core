'use strict';


const fs = require('fs');
const path = require('path');
const adminUi = require(path.join(__dirname, '..', 'src', 'admin-ui.js'));
const { validate } = require('/workspace/tunnel-verify/validate-gcui.js');

const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'instances.json'), 'utf8'));

const instances = new Map();
instances.set(1, { _name: 'default', _stats: { requests: 2048, errors: 12 } });
const gw = { store: { index: real }, pool: { instances: instances } };
const cfg = { _name: 'default', _uid: 1 };

const page = adminUi.render(gw, cfg, 'instances');
const errs = validate(page, 'instances(real)');
console.log('实例数:', page.state.count, '| 运行中:', page.state.running,
  '| 请求:', page.state.requests, '| 错误:', page.state.errors);
console.log('实例:', page.state.instances.map(i => i.name + '(' + i.statusText + (i.current ? ',当前' : '') + ')').join('  '));
console.log('校验错误:', errs.length === 0 ? '无 ✓' : errs.join('; '));
console.log('JSON 体积:', Buffer.byteLength(JSON.stringify(page)), 'bytes');
process.exit(errs.length === 0 ? 0 : 1);
