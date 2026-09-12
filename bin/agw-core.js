#!/usr/bin/env node
'use strict';
                
                                                  
                                     
                                                                
                                         
                                                   
                                      
                                         
                                                                                        
                                                
   
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { Gateway, Store, VERSION } = require('../src/index');
const { log, logErr } = require('../src/util');

const args = process.argv.slice(2);
const cmd = args[0] || 'start';
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) ? args[i + 1] : dflt;
}
const DIR = path.resolve(opt('dir', process.env.AGW_DIR || path.join(process.cwd(), 'data')));

async function main() {
  if (cmd === 'start') {
    const gw = new Gateway(DIR, { port: opt('port') });
    process.on('unhandledRejection', e => logErr('unhandledRejection:', (e && e.message) || e));
    process.on('uncaughtException', e => logErr('uncaughtException:', (e && e.message) || e));
    process.on('SIGTERM', () => { try { gw.close(); } catch (_) {} process.exit(0); });
    process.on('SIGINT', () => { try { gw.close(); } catch (_) {} process.exit(0); });
    await gw.start();
    return;
  }

  if (cmd === 'list') {
    const store = new Store(DIR);
    console.log('数据目录: ' + DIR);
    console.log('setupMode: ' + store.isSetupMode());
    for (const m of store.index.instances)
      console.log(`  uid=${m.uid}  ${m.name}${m.name === 'default' ? ' (主)' : ''}  port=${m.port || '-'}  ${m.enabled === false ? '已停用' : '启用'}`);
    return;
  }

  if (cmd === 'plugin-list') {
    const { PluginManager } = require('../src/plugins');
    const pm = new PluginManager(new Store(DIR), { log: () => {} });
    pm.scanInstalled();
    if (!pm.installed.size) { console.log('(没有已安装插件)'); return; }
    for (const [id, inst] of pm.installed)
      console.log(`  ${id}  v${inst.manifest.version || '?'}  ${inst.manifest.name || id}  [${inst.manifest.type || 'business'}]${inst.manifest._builtin ? ' (内置)' : ''}\n      ${inst.manifest.description || ''}`);
    return;
  }

  if (cmd === 'plugin-install') {
    const src = args[1];
    if (!src) { console.error('用法: agw-core plugin-install <url|本地路径> [--sha256 X] [--proxy http://127.0.0.1:7890]'); process.exit(1); }
    const { PluginManager } = require('../src/plugins');
    const pm = new PluginManager(new Store(DIR), { log: (...a) => console.log(...a) });
    const sha = opt('sha256', null), proxy = opt('proxy', null);
    try {
      let r;
      if (/^https?:\/\//.test(src)) {
        console.log('下载: ' + src + (proxy ? ' (经代理 ' + proxy + ')' : ''));
        r = await pm.installFromUrl(src, sha, proxy);
      } else {
        const buf = fs.readFileSync(path.resolve(src));
        r = pm.installPackage(buf, sha);
      }
      console.log(`✓ 已安装: ${r.id} v${r.manifest.version || '?'} (${r.manifest.name || r.id})`);
      console.log('  sha256: ' + r.sha256);
      console.log('  默认未启用——到面板插件页打开开关, 或配置实例 plugins 数组加 {"id":"' + r.id + '","enable":true}');
      console.log('  注意: 网关运行中需在面板操作或重启后插件才会加载');
    } catch (e) { console.error('✗ 安装失败: ' + e.message); process.exit(1); }
    return;
  }

  if (cmd === 'plugin-remove') {
    const id = args[1];
    if (!id) { console.error('用法: agw-core plugin-remove <插件id>'); process.exit(1); }
    const { PluginManager } = require('../src/plugins');
    const pm = new PluginManager(new Store(DIR), { log: () => {} });
    pm.scanInstalled();
    const inst = pm.installed.get(id);
    if (!inst) { console.error('插件未安装: ' + id); process.exit(1); }
    if (inst.manifest._builtin) { console.error('内置插件不可卸载(随内核分发), 只能禁用: ' + id); process.exit(1); }
    pm.removePlugin(id, false);
    console.log('✓ 已卸载: ' + id + ' (配置与数据已清除)');
    return;
  }

  if (cmd === 'status') {
    const store = new Store(DIR);
    const target = args[1];
    if (!target) {
      for (const m of store.index.instances) {
        const full = store.instanceFull(m.uid);
        console.log(`\n=== uid=${m.uid} ${m.name} ===`);
        console.log('端口: ' + (full.config.listen ? full.config.listen.port : '-'));
        console.log('渠道: ' + (full.config.channels || []).length + ' 个');
        console.log('插件配置: ' + (Object.keys(full.pluginConfigs).join(', ') || '(无)'));
      }
      return;
    }
    const uid = store.uidOf(target);
    if (uid == null) { console.error('实例不存在: ' + target); process.exit(1); }
    console.log(JSON.stringify(store.instanceFull(uid), null, 2));
    return;
  }

  if (cmd === 'migrate') {
    const store = new Store(DIR);
    const from = path.resolve(opt('from', DIR));
    if (args.includes('--verify')) {
      const report = store.verifyMigration(from);
      let bad = 0;
      for (const r of report) {
        if (r.ok) console.log('OK  ' + r.name + ' uid=' + r.uid + ' 渠道' + r.channels + ' 端口' + r.port);
        else { bad++; console.log('BAD ' + (r.name || r.file) + ': ' + r.reason); }
      }
      process.exit(bad ? 1 : 0);
      return;
    }
    if (args.includes('--rollback')) {
                                      
      const files = fs.readdirSync(from).filter(f => f.endsWith('.json.bak-migrate'));
      for (const f of files) fs.renameSync(path.join(from, f), path.join(from, f.replace(/\.bak-migrate$/, '')));
      console.log('已恢复 ' + files.length + ' 个旧配置文件。新存储(instances.json/instances/)请手动确认后删除。');
      return;
    }
    console.log('从 ' + from + ' 迁移到 ' + DIR + ' ...');
    const res = store.migrate(from, { log: (...a) => console.log(...a) });
    console.log(`迁移完成: ${res.migrated.length} 成功, ${res.skipped.length} 跳过, ${res.errors.length} 失败`);
    for (const m of res.migrated) console.log('  + ' + m.name + ' → uid ' + m.uid);
    for (const s of res.skipped) console.log('  - ' + s.name + ' 跳过(' + s.reason + ')');
    for (const e of res.errors) console.log('  x ' + e.file + ': ' + e.error);
    if (res.migrated.length) console.log('\n校验: agw-core migrate --verify' + (from !== DIR ? ' --from ' + from : ''));
    return;
  }

  if (cmd === 'uid-reset') {
    const store = new Store(DIR);
    const uid = store.uidOf(args[1]);
    if (uid == null) { console.error('实例不存在: ' + args[1]); process.exit(1); }
    const meta = store.meta(uid);
    console.error(`⚠️  重置 UID 会断开实例 "${meta.name}" 的所有插件配置关联!`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise(r => rl.question('输入实例名确认: ', r));
    rl.close();
    if (ans !== meta.name) { console.log('已取消'); return; }
    meta.uid = store.index.nextUid || 1;
    store.index.nextUid = meta.uid + 1;
    meta.file = 'instances/' + meta.uid + '.json';
                 
    const oldFile = path.join(DIR, 'instances', uid + '.json');
    const newFile = path.join(DIR, 'instances', meta.uid + '.json');
    if (fs.existsSync(oldFile)) fs.renameSync(oldFile, newFile);
    store.saveIndex();
    console.log('已重置: uid ' + uid + ' → ' + meta.uid);
    return;
  }

  console.log('ai-gateway-core v' + VERSION);
  console.log('用法: agw-core start|list|status|migrate|uid-reset (见 README.md)');
}

main().catch(e => { logErr(e.message); process.exit(1); });
