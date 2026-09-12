'use strict';
                           
  
                                           
                                      
  
          
                                                                
                       
                                                              
  
                                                                  
   

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

module.exports.activate = (ctx) => {
  const cfg = ctx.config;
  if (!cfg.filters || typeof cfg.filters !== 'object') cfg.filters = {};

                                                 
                                             
                                                                                             
                                        
                                        
                                                        
     
  const DEFAULT_GROUP = 'Default';
  if (!Array.isArray(cfg.groups) || !cfg.groups.length) cfg.groups = [{ name: DEFAULT_GROUP, rate: 1 }];
  if (!cfg.groups.some(g => g && g.name === DEFAULT_GROUP)) cfg.groups.unshift({ name: DEFAULT_GROUP, rate: 1 });
  if (!cfg.modelMeta || typeof cfg.modelMeta !== 'object') cfg.modelMeta = {};
  const saveCfg = () => ctx.setPluginConfig(cfg);
                                                           
  const metaKey = (inst, ch, m) => [String(inst || ''), String(ch), String(m)].join('|');
  const metaOf = (inst, ch, m) => cfg.modelMeta[metaKey(inst, ch, m)] || null;
  const groupNameOf = (inst, ch, m) => (metaOf(inst, ch, m) || {}).group || DEFAULT_GROUP;
  const aliasOf = (inst, ch, m) => (metaOf(inst, ch, m) || {}).alias || '';
  const priceOf = (inst, ch, m) => (metaOf(inst, ch, m) || {}).price || null;
  const perCallOf = (inst, ch, m) => {
    const v = (metaOf(inst, ch, m) || {}).perCall;
    return (v === null || v === undefined || v === '') ? null : Number(v);
  };
  const groupNames = () => cfg.groups.map(g => g.name);

                                
  const fkey = (uk) => (uk && (uk.uid || uk.key)) || 'anon';

  const allFilter = () => ({ group: '', provider: '', ugroup: '' });
  const filterOf = (uk) => Object.assign(allFilter(), cfg.filters[fkey(uk)] || {});
  const saveFilter = (uk, patch) => {
    cfg.filters[fkey(uk)] = Object.assign(filterOf(uk), patch);
    ctx.setPluginConfig(cfg);
    return cfg.filters[fkey(uk)];
  };

                 
  const channels = () => {
    const seen = new Map();
    for (const pick of ctx.pickChannels()) {
      const ch = pick && pick.ch;
      if (ch && ch.name && !seen.has(ch.name)) seen.set(ch.name, ch);
    }
    return [...seen.values()];
  };

                                                  
  const namesOf = (ch) => {
    const mm = (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {};
    const set = new Set();
    for (const m of (Array.isArray(ch.models) ? ch.models : [])) if (m) set.add(String(m));
    for (const k of Object.keys(mm)) if (k) set.add(String(k));
    return [...set];
  };

                                                             
  const groupOfName = (name) => {
    const n = String(name || '').trim();
    const first = n.split(/[-_./: ]+/)[0];
    return first || n;
  };

  const modelsOf = (ch, instName) => {
    const mm = (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {};
    const groups = Array.isArray(ch.groups) ? ch.groups.map(String) : [];
    return namesOf(ch).map((n) => ({
      name: n,
                                     
      instance: instName || '',
      group: groupNameOf(instName, ch.name, n) || groupOfName(n),
      alias: aliasOf(instName, ch.name, n),
      display: aliasOf(instName, ch.name, n) || n,
      price: priceOf(instName, ch.name, n),
      perCall: perCallOf(instName, ch.name, n),
      upstream: mm[n] ? String(mm[n]) : '',
      channel: ch.name,
      type: ch.type || 'openai',
      groups,
    }));
  };

                           
                                              
                                                     
  const myInst = () => { try { return ctx.getInstanceConfig() || {}; } catch (_) { return {}; } };
  const myInstName = () => myInst().name || 'default';
  const listInstancesSafe = () => {
    try { return (ctx.gateway.listInstances() || []).filter(x => x && x.enabled !== false); }
    catch (_) { return []; }
  };
  const allModels = () => {
    const seen = new Map();
    const push = (m, instName) => {
      if (!m || !m.name) return;
      let e = seen.get(m.name);
      if (!e) {
        e = Object.assign({}, m, { instances: [], channels: [] });
        seen.set(m.name, e);
      }
      if (instName && !e.instances.includes(instName)) e.instances.push(instName);
      if (m.channel && !e.channels.includes(m.channel)) e.channels.push(m.channel);
      if (!e.alias && m.alias) e.alias = m.alias;
      if (!e.price && m.price) e.price = m.price;
    };
    const self = myInstName();
    for (const ch of channels()) for (const m of modelsOf(ch, self)) push(m, self);
    for (const inst of listInstancesSafe()) {
      if (String(inst.uid) === String(myInst().uid)) continue;
      let ic = null;
      try { ic = ctx.getInstanceConfig(inst.uid); } catch (_) {}
      if (!ic || !Array.isArray(ic.channels)) continue;
      for (const ch of ic.channels) {
        if (!ch || !ch.name) continue;
        const mm = (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {};
        const names = Array.isArray(ch.models) ? ch.models : [];
        for (const n of names) {
          push({
            name: n,
            instance: inst.name,
            group: groupNameOf(inst.name, ch.name, n) || groupOfName(n),
            alias: aliasOf(inst.name, ch.name, n),
            display: aliasOf(inst.name, ch.name, n) || n,
            price: priceOf(inst.name, ch.name, n),
            perCall: perCallOf(inst.name, ch.name, n),
            upstream: mm[n] ? String(mm[n]) : '', channel: ch.name,
            type: ch.type || 'openai',
            groups: Array.isArray(ch.groups) ? ch.groups.map(String) : [],
          }, inst.name);
        }
      }
    }
    return [...seen.values()];
  };

                                             
  const visibleToGroup = (m, g) => !g || !m.groups.length || m.groups.includes(g);

                                                
  const userOf = (uk) => {
    if (!uk || !uk.uid) return null;
    try {
      const c = ctx.getPluginConfig('auth-user');
      return ((c && c.users) || []).find(x => x && x.uid === uk.uid) || null;
    } catch (_) { return null; }
  };
  const groupsList = () => {
    try {
      const c = ctx.getPluginConfig('auth-user');
      if (c && Array.isArray(c.groups) && c.groups.length) return c.groups.map(String);
      if (c && c.defaultGroup) return [String(c.defaultGroup)];
    } catch (_) { }
    return ['默认'];                                 
  };
  const myGroup = (uk) => {
    const u = userOf(uk);
    if (u && u.group) return String(u.group);
    const gs = groupsList();
    return gs.length ? gs[0] : '';
  };

                                     
  const chip = (label, selected, facet, value) => ({
    type: 'chip',
    text: label,
    selected: !!selected,
    action: { type: 'intent', endpoint: './intent/square/filter', body: { facet, value }, then: 'reload' },
  });

  const typeTone = (t) => (t === 'claude' ? 'tertiary' : t === 'gemini' ? 'primary' : 'success');

  const buildPage = (uk) => {
    const f = filterOf(uk);
    const chs = channels();
    const models = allModels();
    const my = myGroup(uk);
    const ug = f.ugroup;                  

                                                
    const declared = groupNames();
    const derived = [...new Set(models.map(m => m.group))].filter(g => !declared.includes(g)).sort();
    const groups = declared.concat(derived);
    const providers = [...new Set(allModels().map(m => m.channel).filter(Boolean))].sort();
    const ugroups = groupsList();

    const shown = models.filter(m =>
      (!f.group || m.group === f.group) &&
      (!f.provider || m.channel === f.provider) &&
      visibleToGroup(m, ug)
    );

                               
    const countFor = (patch) => models.filter(m =>
      (!(patch.group !== undefined ? patch.group : f.group) || m.group === (patch.group !== undefined ? patch.group : f.group)) &&
      (!(patch.provider !== undefined ? patch.provider : f.provider) || m.channel === (patch.provider !== undefined ? patch.provider : f.provider)) &&
      visibleToGroup(m, (patch.ugroup !== undefined ? patch.ugroup : ug))
    ).length;

    const children = [];

            
    const active = [];
    if (f.group) active.push('分组 ' + f.group);
    if (f.provider) active.push('提供商 ' + f.provider);
    if (ug) active.push('用户分组 ' + ug);
    children.push({
      type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 12, children: [
        { type: 'row', gap: 14, children: [
          { type: 'avatar', text: '模', size: 52 },
          { type: 'column', weight: 1, gap: 6, children: [
            { type: 'text', text: '模型广场', style: 'title3' },
            { type: 'text', text: '共 ' + models.length + ' 个模型 · 当前显示 ' + shown.length + ' 个', style: 'caption' },
          ] },
        ] },
        { type: 'kv', label: '筛选', value: active.length ? active.join(' · ') : '未筛选' },
        { type: 'kv', label: '我的分组', value: my || '（未启用用户体系）' },
      ],
    });

            
    children.push({
      type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 8, children: [
        { type: 'text', text: '分组', style: 'title4' },
        { type: 'text', text: '按模型系列分组；渠道配了 modelMap 时，别名本身就是一个分组', style: 'caption' },
        { type: 'hscroll', gap: 8, children: [
          chip('全部 (' + countFor({ group: '' }) + ')', !f.group, 'group', ''),
          ...groups.map(g => chip(g + ' (' + countFor({ group: g }) + ')', f.group === g, 'group', g)),
        ] },
      ],
    });

             
    children.push({
      type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 8, children: [
        { type: 'text', text: '提供商', style: 'title4' },
        { type: 'text', text: '模型来自哪个渠道', style: 'caption' },
        { type: 'hscroll', gap: 8, children: [
          chip('全部 (' + countFor({ provider: '' }) + ')', !f.provider, 'provider', ''),
          ...providers.map(p => chip(p + ' (' + countFor({ provider: p }) + ')', f.provider === p, 'provider', p)),
        ] },
      ],
    });

              
    if (ugroups.length) {
      children.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 8, children: [
          { type: 'text', text: '用户分组', style: 'title4' },
          { type: 'text', text: '只看某个分组能用的模型；渠道没配分组白名单 = 所有分组都能用', style: 'caption' },
          { type: 'hscroll', gap: 8, children: [
            chip('不限 (' + countFor({ ugroup: '' }) + ')', !ug, 'ugroup', ''),
            ...ugroups.map(g => chip(g + ' (' + countFor({ ugroup: g }) + ')', ug === g, 'ugroup', g)),
          ] },
        ],
      });
    }

              
    if (!shown.length) {
      children.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', children: [
          { type: 'text', text: '没有符合条件的模型', style: 'body' },
          { type: 'text', text: '换个筛选条件试试；或者在管理端「模型列表」里同步上游模型。', style: 'caption' },
        ],
      });
    } else {
      const max = 150;
      for (const m of shown.slice(0, max)) {
        const badges = [
          { type: 'badge', text: m.channel, tone: typeTone(m.type) },
          { type: 'badge', text: '分组 ' + m.group, tone: 'neutral' },
        ];
        if (m.upstream) badges.push({ type: 'badge', text: '→ ' + m.upstream, tone: 'tertiary' });
        if (m.groups.length) badges.push({ type: 'badge', text: '限 ' + m.groups.join('/'), tone: 'warning' });
        children.push({
          type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: [
            { type: 'row', gap: 12, children: [
              { type: 'avatar', text: String(m.name).slice(0, 1).toUpperCase(), size: 40 },
              { type: 'column', weight: 1, gap: 6, children: [
                { type: 'text', text: (m.alias ? (m.alias + '  →  ' + m.name) : m.name), style: 'title4' },
                { type: 'text', text: '可用实例: ' + ((m.instances || []).join(' / ') || '—'), style: 'label3' },
                { type: 'row', gap: 6, children: badges },
              ] },
              { type: 'iconButton', icon: 'msym:copy', container: 'outlined', size: 40,
                desc: '复制模型名', action: { type: 'copy', text: m.name, toast: '已复制 ' + m.name } },
            ] },
          ],
        });
      }
      if (shown.length > max) {
        children.push({
          type: 'card', variant: 'outlined', shape: 'extraLarge', children: [
            { type: 'text', text: '只显示了前 ' + max + ' 个（共 ' + shown.length + ' 个）', style: 'caption' },
            { type: 'text', text: '用上面的筛选缩小范围', style: 'caption' },
          ],
        });
      }
    }

    return { gcui: 1, title: '模型广场', root: { type: 'column', gap: 12, children } };
  };

                                
                                                  
  const apis = () => ctx.gateway.authApis();
  const ukOf = (p) => {
    const t = (p && p.token) || '';
    if (!t || !apis().findKey) return null;
    let uk = null;
    try { uk = apis().findKey(null, t); } catch (_) { uk = null; }
    return (uk && uk.enable !== false) ? uk : null;
  };

  ctx.registerRoute('GET', '/ui/square', (req, res, p) => {
    const uk = ukOf(p);
    if (!uk) return jsonRes(res, 401, { error: '需要卡密登录' });
    jsonRes(res, 200, buildPage(uk));
  });

                                     
  ctx.registerRoute('GET', '/data/square', (req, res, p) => {
    const uk = ukOf(p);
    const models = allModels();
    jsonRes(res, 200, {
      ok: true,
      myGroup: uk ? myGroup(uk) : '',
      groups: [...new Set(models.map(m => m.group))].sort(),
      providers: [...new Set(allModels().map(m => m.channel).filter(Boolean))].sort(),
      ugroups: groupsList(),
      models,
    });
  });

                                                                 

                                           
  ctx.registerRoute('GET', '/admin/groups', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const self = myInstName();
    const insts = [];
              
    insts.push({
      name: self, uid: myInst().uid, current: true,
      channels: channels().map(ch => ({
        name: ch.name, type: ch.type || 'openai',
        models: modelsOf(ch, self).map(m => ({ name: m.name, group: m.group, alias: m.alias, price: m.price, perCall: m.perCall })),
      })),
    });
              
    for (const inst of listInstancesSafe()) {
      if (String(inst.uid) === String(myInst().uid)) continue;
      let ic = null;
      try { ic = ctx.getInstanceConfig(inst.uid); } catch (_) {}
      if (!ic || !Array.isArray(ic.channels)) continue;
      const chs = ic.channels.filter(ch => ch && ch.name).map(ch => ({
        name: ch.name, type: ch.type || 'openai',
        models: (Array.isArray(ch.models) ? ch.models : []).map(n => ({
          name: n,
          group: groupNameOf(inst.name, ch.name, n) || groupOfName(n),
          alias: aliasOf(inst.name, ch.name, n),
          price: priceOf(inst.name, ch.name, n),
          perCall: perCallOf(inst.name, ch.name, n),
        })),
      }));
      if (chs.length) insts.push({ name: inst.name, uid: inst.uid, current: false, channels: chs });
    }
    const counts = {};
    for (const g of cfg.groups) counts[g.name] = 0;
    for (const it of insts) for (const c of it.channels) for (const m of c.models) counts[m.group] = (counts[m.group] || 0) + 1;
    jsonRes(res, 200, {
      ok: true,
      defaultGroup: DEFAULT_GROUP,
      groups: cfg.groups.map(g => ({ name: g.name, rate: Number(g.rate) || 1 })),
      counts,
      instances: insts,
      channels: insts[0] ? insts[0].channels : [],
    });
  });

                                  
  ctx.registerRoute('POST', '/admin/groups', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const j = p.body || {};
    const act = String(j.action || '');
    const ok = () => jsonRes(res, 200, { ok: true, groups: cfg.groups.map(g => ({ name: g.name, rate: Number(g.rate) || 1 })) });

    if (act === 'addGroup') {
      const name = String(j.name || '').trim().slice(0, 32);
      if (!name) return jsonRes(res, 400, { error: '分组名不能为空' });
      if (cfg.groups.some(g => g.name === name)) return jsonRes(res, 409, { error: '分组已存在' });
      cfg.groups.push({ name, rate: Number(j.rate) || 1 });
      saveCfg(); return ok();
    }
    if (act === 'renameGroup') {
      const name = String(j.name || '').trim(), nn = String(j.newName || '').trim().slice(0, 32);
      if (!nn) return jsonRes(res, 400, { error: '新名称不能为空' });
      if (name === DEFAULT_GROUP) return jsonRes(res, 400, { error: 'Default 分组不能改名' });
      if (cfg.groups.some(g => g.name === nn)) return jsonRes(res, 409, { error: '新名称已存在' });
      const g = cfg.groups.find(x => x.name === name); if (!g) return jsonRes(res, 404, { error: '分组不存在' });
      g.name = nn;
      for (const k of Object.keys(cfg.modelMeta)) if (cfg.modelMeta[k].group === name) cfg.modelMeta[k].group = nn;
      saveCfg(); return ok();
    }
    if (act === 'removeGroup') {
      const name = String(j.name || '').trim();
      if (name === DEFAULT_GROUP) return jsonRes(res, 400, { error: 'Default 分组不能删除' });
      const before = cfg.groups.length;
      cfg.groups = cfg.groups.filter(g => g.name !== name);
      if (cfg.groups.length === before) return jsonRes(res, 404, { error: '分组不存在' });
      let moved = 0;
      for (const k of Object.keys(cfg.modelMeta)) if (cfg.modelMeta[k].group === name) { cfg.modelMeta[k].group = DEFAULT_GROUP; moved++; }
      saveCfg(); return jsonRes(res, 200, { ok: true, moved, groups: cfg.groups });
    }
    if (act === 'setGroupRate') {
      const g = cfg.groups.find(x => x.name === String(j.name || ''));
      if (!g) return jsonRes(res, 404, { error: '分组不存在' });
      const r = Number(j.rate);
      if (!(r >= 0)) return jsonRes(res, 400, { error: '倍率无效' });
      g.rate = r; saveCfg(); return ok();
    }
                                                                  
    if (act === 'setModel') {
      const ch = String(j.channel || ''), m = String(j.model || '');
      const inst = String(j.instance || myInstName());
      if (!ch || !m) return jsonRes(res, 400, { error: '缺少 channel / model' });
      const k = metaKey(inst, ch, m);
      const cur = cfg.modelMeta[k] || {};
      if (j.group !== undefined) cur.group = String(j.group);
      if (j.alias !== undefined) cur.alias = String(j.alias).slice(0, 96);
      if (j.price !== undefined && j.price !== null) {
        const pr = j.price || {};
        cur.price = {
          in: Number(pr['in']) || 0, out: Number(pr.out) || 0,
          cacheWrite: Number(pr.cacheWrite) || 0, cacheRead: Number(pr.cacheRead) || 0,
        };
      }
      if (j.perCall !== undefined) cur.perCall = (j.perCall === null || j.perCall === '') ? null : Number(j.perCall);
      if (!cur.group) cur.group = DEFAULT_GROUP;
      cfg.modelMeta[k] = cur; saveCfg();
      return jsonRes(res, 200, { ok: true, meta: Object.assign({ key: k }, cur) });
    }
                                                                          
    if (act === 'bulk') {
      const items = Array.isArray(j.items) ? j.items : [];
      if (!items.length) return jsonRes(res, 400, { error: '没有选中模型' });
      let n = 0;
      for (const it of items) {
        const ch = String((it && it.channel) || ''), m = String((it && it.model) || '');
        const inst = String((it && it.instance) || j.instance || myInstName());
        if (!ch || !m) continue;
        const k = metaKey(inst, ch, m);
        const cur = cfg.modelMeta[k] || {};
        if (j.group !== undefined) cur.group = String(j.group);
        if (j.alias !== undefined) cur.alias = String(j.alias).slice(0, 96);
        if (j.price !== undefined && j.price !== null) {
          const pr = j.price || {};
          cur.price = {
            in: Number(pr['in']) || 0, out: Number(pr.out) || 0,
            cacheWrite: Number(pr.cacheWrite) || 0, cacheRead: Number(pr.cacheRead) || 0,
          };
        }
        if (j.perCall !== undefined) cur.perCall = (j.perCall === null || j.perCall === '') ? null : Number(j.perCall);
        if (!cur.group) cur.group = DEFAULT_GROUP;
        cfg.modelMeta[k] = cur; n++;
      }
      saveCfg();
      return jsonRes(res, 200, { ok: true, updated: n });
    }
    return jsonRes(res, 400, { error: '未知操作: ' + act });
  });

  ctx.registerRoute('POST', '/intent/square/filter', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: '需要登录' };
    const b = p.body || {};
    const facet = String(b.facet || '');
    if (!['group', 'provider', 'ugroup'].includes(facet)) return { ok: false, error: '未知筛选项: ' + facet };
    saveFilter(uk, { [facet]: String(b.value == null ? '' : b.value) });
    return { ok: true, ui: buildPage(uk) };
  }));

  ctx.log('模型广场已激活 (bottomBar 页面 ui=/ui/square)');
};
