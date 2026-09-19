'use strict';













function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

module.exports.activate = (ctx) => {
  const cfg = ctx.config;   

  






  const DEFAULT_GROUP = 'Default';
  const normalize = () => {
    if (!cfg.filters || typeof cfg.filters !== 'object') cfg.filters = {};
    if (!Array.isArray(cfg.groups) || !cfg.groups.length) cfg.groups = [{ name: DEFAULT_GROUP, rate: 1 }];
    if (!cfg.groups.some(g => g && g.name === DEFAULT_GROUP)) cfg.groups.unshift({ name: DEFAULT_GROUP, rate: 1 });
    if (!cfg.modelMeta || typeof cfg.modelMeta !== 'object') cfg.modelMeta = {};
  };
  normalize();

  










  let cfgRevSeen = -1;
  const refreshCfg = () => {
    const r = ctx.configRev ? ctx.configRev() : 0;
    if (r !== cfgRevSeen) {
      let fresh = null;
      try { fresh = ctx.getPluginConfig ? ctx.getPluginConfig('model-square') : null; } catch (_) { fresh = null; }
      if (fresh && typeof fresh === 'object') {
        for (const k of Object.keys(cfg)) delete cfg[k];
        Object.assign(cfg, fresh);
        normalize();
      }
      cfgRevSeen = r;
    }
    return cfg;
  };
  
  const route = (method, p, handler) => ctx.registerRoute(method, p, (req, res, prm) => {
    refreshCfg();
    return handler(req, res, prm);
  });
  const saveCfg = () => ctx.setPluginConfig(cfg);
  
  const metaKey = (inst, ch, m) => [String(inst || ''), String(ch), String(m)].join('|');
  const metaOf = (inst, ch, m) => cfg.modelMeta[metaKey(inst, ch, m)] || null;
  

  const groupNameOf = (inst, ch, m) => (metaOf(inst, ch, m) || {}).group || '';
  const aliasOf = (inst, ch, m) => (metaOf(inst, ch, m) || {}).alias || '';
  const priceOf = (inst, ch, m) => (metaOf(inst, ch, m) || {}).price || null;
  const perCallOf = (inst, ch, m) => {
    const v = (metaOf(inst, ch, m) || {}).perCall;
    return (v === null || v === undefined || v === '') ? null : Number(v);
  };
  const groupNames = () => cfg.groups.map(g => g.name);

  
  const fkey = (uk) => (uk && (uk.uid || uk.key)) || 'anon';

  const allFilter = () => ({ group: '', provider: '', vendor: '', ugroup: '', q: '', sort: '', cols: 1, limit: 150 });
  const filterOf = (uk) => Object.assign(allFilter(), cfg.filters[fkey(uk)] || {});
  




  const qs = (f, ov) => {
    const o = Object.assign({}, f, ov || {});
    const P = [];
    const has = (k) => !!ov && Object.prototype.hasOwnProperty.call(ov, k);
    const put = (k, v) => P.push(k + '=' + encodeURIComponent(v === undefined || v === null ? '' : String(v)));
    if (o.view || has('view')) put('view', o.view);
    if (o.q || has('q')) put('q', o.q);
    if (o.sort || has('sort')) put('sort', o.sort);
    if (o.group || has('group')) put('group', o.group);
    if (o.provider || has('provider')) put('provider', o.provider);
    if (o.vendor || has('vendor')) put('vendor', o.vendor);
    if (o.ugroup || has('ugroup')) put('ugroup', o.ugroup);
    put('cols', Number(o.cols) === 2 ? 2 : 1);   
    put('limit', Math.max(1, Number(o.limit) || 150));   
    return P.join('&');
  };
  
  const qsCarry = (f) => {
    const P = [];
    if (f.sort) P.push('sort=' + f.sort);
    P.push('cols=' + (Number(f.cols) === 2 ? 2 : 1));   
    P.push('limit=' + Math.max(1, Number(f.limit) || 150));
    if (f.group) P.push('group=' + encodeURIComponent(f.group));
    if (f.provider) P.push('provider=' + encodeURIComponent(f.provider));
    if (f.vendor) P.push('vendor=' + encodeURIComponent(f.vendor));
    if (f.ugroup) P.push('ugroup=' + encodeURIComponent(f.ugroup));
    return P.join('&');
  };
  const parseQ = (req) => {
    const out = {};
    const seg = String((req.url || '').split('?')[1] || '');
    seg.split('&').forEach(pv => { if (!pv) return; const i = pv.indexOf('='); const k = i < 0 ? pv : pv.slice(0, i); out[k] = i < 0 ? '' : decodeURIComponent(pv.slice(i + 1)); });
    return out;
  };
  const saveFilter = (uk, patch) => {
    cfg.filters[fkey(uk)] = Object.assign(filterOf(uk), patch);
    ctx.setPluginConfig(cfg);
    return cfg.filters[fkey(uk)];
  };

  
  const channels = () => {
    const seen = new Map();
    const list = (ctx.gateway && ctx.gateway.instanceChannels) ? ctx.gateway.instanceChannels() : [];
    for (const ch of list) {
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

  





  const grCache = { mtime: 0, exact: {}, rules: [], mode: 'fallback', warn: '' };
  const groupRulesOf = () => {
    try {
      const fsx = require('fs');
      const p0 = require('path').join(__dirname, 'group-rules.txt');
      if (!fsx.existsSync(p0)) {
        if (grCache.mtime !== -1) { grCache.mtime = -1; grCache.exact = {}; grCache.rules = []; grCache.mode = 'fallback'; grCache.warn = ''; }
        return grCache;
      }
      const mt = fsx.statSync(p0).mtimeMs;
      if (mt === grCache.mtime) return grCache;
      const exact = {}, rules = [], warns = [];
      let mode = 'fallback';
      for (const line of String(fsx.readFileSync(p0, 'utf8') || '').split(/\r?\n/)) {
        const s0 = line.trim();
        if (!s0 || s0.startsWith('#') || s0.startsWith('//')) continue;
        const i = s0.indexOf('=');
        if (i < 0) { warns.push('缺少 "=": ' + s0.slice(0, 30)); continue; }
        const k = s0.slice(0, i).trim().replace(/^["']|["']$/g, '');
        const v = s0.slice(i + 1).trim().replace(/^["']|["']$/g, '');
        if (!k) continue;
        if (k.toLowerCase() === 'mode') { mode = (v.toLowerCase() === 'override') ? 'override' : 'fallback'; continue; }
        if (!v) continue;                        
        const kl = k.toLowerCase();
        
        if (kl.startsWith('*') && kl.endsWith('*') && kl.length > 2) rules.push({ kind: 'contains', stem: kl.slice(1, -1), group: v, raw: k });
        else if (kl.endsWith('*') && kl.length > 1) rules.push({ kind: 'prefix', stem: kl.slice(0, -1), group: v, raw: k });
        else if (kl.startsWith('*') && kl.length > 1) rules.push({ kind: 'suffix', stem: kl.slice(1), group: v, raw: k });
        else exact[kl] = v;
      }
      rules.sort((a, b) => b.stem.length - a.stem.length);   
      grCache.mtime = mt; grCache.exact = exact; grCache.rules = rules; grCache.mode = mode;
      grCache.warn = warns.join('; ');
      return grCache;
    } catch (e) { grCache.warn = e.message; return grCache; }
  };
  


  const groupByRules = (name) => {
    const r = groupRulesOf();
    const n = String(name || '').toLowerCase();
    if (!n) return '';
    if (Object.prototype.hasOwnProperty.call(r.exact, n)) return r.exact[n];
    const hit = (x) => x.kind === 'prefix' ? n.startsWith(x.stem)
      : x.kind === 'suffix' ? n.endsWith(x.stem)
        : n.includes(x.stem);
    for (const x of r.rules) if (hit(x)) return x.group;
    const toks = n.split(/[-_./\s]+/).filter(Boolean);
    if (toks.length > 1) {
      for (const x of r.rules) {
        if (x.kind === 'prefix' && toks.some(t => t.startsWith(x.stem))) return x.group;
      }
    }
    return '';
  };
  
  const groupFor = (inst, ch, n) => {
    const explicit = groupNameOf(inst, ch, n);
    const byRule = groupByRules(n);
    if (byRule && groupRulesOf().mode === 'override') return byRule;
    return explicit || byRule || groupOfName(n);
  };

  



  


  const AVATAR_MAP = [
    [/^agnes/, 'agnesai.svg'],
    [/^(gpt|o\d|chatgpt|dall|openai)/, 'dark-openai.png'],
    [/^nvidia|^nemotron/, 'nvidia-color.svg'],
    [/^claude/, 'claude-color.svg'],
    [/^gemini/, 'gemini-color.svg'],
    [/^gemma/, 'gemma.svg'],
    [/^deepseek/, 'deepseek-color.svg'],
    [/^qwen/, 'qwen-color.svg'],
    [/^grok/, 'dark-grok.png'],
    [/^kimi|^moonshot/, 'kimi-color.svg'],
    [/^doubao/, 'doubao-color.svg'],
    [/^minimax/, 'minimax-color.svg'],
    [/^hunyuan/, 'hunyuan-color.svg'],
    [/^glm|^chatglm/, 'chatglm-color.svg'],
    [/^llama/, 'meta.svg'],
    [/^mistral/, 'mistral.svg'],
    [/^ernie|^wenxin/, 'baidu.svg'],
  ];
  




  const ovrCache = { mtime: 0, map: {}, warn: '' };
  

  const parseOverrides = (txt) => {
    try {
      const o = JSON.parse(txt);
      return { map: (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}, warn: '' };
    } catch (e) {
      const out = {};
      const re = new RegExp('"((?:[^"\\\\]|\\\\.)*)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', 'g');
      let m;
      while ((m = re.exec(txt))) out[m[1]] = m[2];
      return { map: out, warn: 'JSON 语法错误(' + e.message + '), 已按行宽松解析' };
    }
  };

  

  const parseTxtOverrides = (txt) => {
    const out = {};
    for (const line of String(txt).split(/\r?\n/)) {
      const s0 = line.trim();
      if (!s0 || s0.startsWith('#') || s0.startsWith('//')) continue;
      const i = s0.indexOf('=');
      if (i < 0) continue;
      const k = s0.slice(0, i).trim().replace(/^["']|["']$/g, '').replace(/,$/, '').replace(/:$/, '');
      const v = s0.slice(i + 1).trim().replace(/^["']|["']$/g, '').replace(/,$/, '');
      if (k) out[k] = v;
    }
    return out;
  };
  const overridesOf = () => {
    try {
      const fs = require('fs');
      const fj0 = require('path').join(__dirname, 'avatar-overrides.json');
      const ft0 = require('path').join(__dirname, 'avatar-overrides.txt');
      let mt = 0;
      if (fs.existsSync(fj0)) mt += fs.statSync(fj0).mtimeMs;
      if (fs.existsSync(ft0)) mt += fs.statSync(ft0).mtimeMs;
      if (mt === 0) return {};
      const st = { mtimeMs: mt };
      if (st.mtimeMs !== ovrCache.mtime) {
        ovrCache.mtime = st.mtimeMs;
        const fj = require('path').join(__dirname, 'avatar-overrides.json');
        const ft = require('path').join(__dirname, 'avatar-overrides.txt');
        const merged = {};
        const warns = [];
        if (fs.existsSync(fj)) {
          const r = parseOverrides(fs.readFileSync(fj, 'utf8') || '{}');
          Object.assign(merged, r.map);
          if (r.warn) warns.push(r.warn);
        }
        if (fs.existsSync(ft)) Object.assign(merged, parseTxtOverrides(fs.readFileSync(ft, 'utf8')));
        ovrCache.map = merged;
        ovrCache.warn = warns.join('; ');
      }
      return ovrCache.map || {};
    } catch (_) { return {}; }
  };
  const iconUrl = (file, base) => base + '/plugins/model-square/icon?f=' + encodeURIComponent(file);
  



  const ruleHit = (ruleKey, name) => {
    const k = String(ruleKey == null ? '' : ruleKey).toLowerCase();
    const n = String(name == null ? '' : name).toLowerCase();
    if (!k || !n) return '';
    if (k === n) return 'exact';
    if (k.startsWith('*') && k.endsWith('*') && k.length > 2) return n.includes(k.slice(1, -1)) ? 'contains' : '';
    if (k.endsWith('*') && k.length > 1) return n.startsWith(k.slice(0, -1)) ? 'prefix' : '';
    if (k.startsWith('*') && k.length > 1) return n.endsWith(k.slice(1)) ? 'suffix' : '';
    return '';
  };
  
  const ovMatch = (cand) => {
    const ov = overridesOf();
    const keys = Object.keys(ov);
    for (const k of keys) if (String(k).toLowerCase() === cand) return { file: ov[k] };   
    let best = null;
    for (const k of keys) {
      if (!ruleHit(k, cand)) continue;
      if (best === null || String(k).length > String(best).length) best = k;             
    }
    return best === null ? null : { file: ov[best] };
  };
  const avatarOf = (name, base) => {
    const n = String(name || '').toLowerCase();
    const tail = n.includes('/') ? n.slice(n.lastIndexOf('/') + 1) : '';
    const toks = n.split(/[-_./\s]+/).filter(Boolean);
    



    const cands = [n, tail, ...toks];
    for (const c of cands) {
      if (!c) continue;
      const r = ovMatch(c);
      if (r) return r.file ? iconUrl(r.file, base) : '';
    }
    for (const c of cands) {
      if (!c) continue;
      for (const [re, file] of AVATAR_MAP) if (re.test(c)) return iconUrl(file, base);
    }
    return '';
  };
  
  route('GET', '/avatar-rules', (req, res, p) => {
    jsonRes(res, 200, {
      overrides: overridesOf(),
      warning: ovrCache.warn || '',
      builtIn: AVATAR_MAP.map(([re, file]) => [re.source, file]),
    });
  });

  
  route('GET', '/group-rules', (req, res, p) => {
    const r = groupRulesOf();
    jsonRes(res, 200, {
      file: require('path').join(__dirname, 'group-rules.txt'),
      mode: r.mode,
      exact: r.exact,
      rules: r.rules.map(x => x.raw + ' → ' + x.group),
      prefix: r.rules.filter(x => x.kind === 'prefix').map(x => x.raw + ' → ' + x.group),   
      warning: r.warn || '',
      note: 'fallback(默认): 只作用于"未在管理端配置分组"的模型; override: 规则优先。规则串支持 前缀* / *后缀 / *包含* / 精确名',
    });
  });

  const modelsOf = (ch, instName) => {
    const mm = (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {};
    const groups = Array.isArray(ch.groups) ? ch.groups.map(String) : [];
    return namesOf(ch).map((n) => ({
      name: n,
      
      instance: instName || '',
      group: groupFor(instName, ch.name, n),
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
    healOrphans();   
    







    const seen = new Map();
    const keyOf = (m) => String(m.group || '') + '\u0000' + String(m.name);
    const push = (m, instName) => {
      if (!m || !m.name) return;
      const k = keyOf(m);
      let e = seen.get(k);
      if (!e) {
        e = Object.assign({}, m, { instances: [], channels: [], sources: [] });
        seen.set(k, e);
      }
      if (instName && !e.instances.includes(instName)) e.instances.push(instName);
      if (m.channel && !e.channels.includes(m.channel)) e.channels.push(m.channel);
      if (!e.alias && m.alias) e.alias = m.alias;
      if (!e.price && m.price) e.price = m.price;
      


      const sig = JSON.stringify(m.price || null) + '|' + (m.perCall == null ? '' : m.perCall);
      const occ = instName || '';
      if (!e.sources.some(s => s.sig === sig && s.instance === occ && s.channel === (m.channel || ''))) {
        e.sources.push({ instance: occ, channel: m.channel || '', price: m.price || null, perCall: m.perCall == null ? null : m.perCall, sig });
      }
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
        

        for (const m of modelsOf(ch, inst.name)) push(m, inst.name);
      }
    }
    for (const e of seen.values()) {
      e.priceDiff = new Set(e.sources.map(s => s.sig)).size > 1;
    }
    return [...seen.values()];
  };

  






  const healState = { at: 0, last: null };
  const instChannelMaps = () => {
    const all = [];
    const self = myInstName();
    all.push({ name: self, uid: myInst().uid, channels: channels() });
    for (const inst of listInstancesSafe()) {
      if (String(inst.uid) === String(myInst().uid)) continue;
      let ic = null; try { ic = ctx.getInstanceConfig(inst.uid); } catch (_) {}
      all.push({ name: String(inst.name), uid: inst.uid, channels: (ic && ic.channels) || [] });
    }
    return all;
  };
  
  const scanOrphans = (dry) => {
    const out = { total: Object.keys(cfg.modelMeta).length, moved: [], pending: [] };
    const instByName = new Map(instChannelMaps().map(x => [String(x.name), x]));
    for (const k of Object.keys(cfg.modelMeta)) {
      const parts = String(k).split('|');
      if (parts.length < 3) { out.pending.push({ key: k, why: '键格式不对(应为 实例|渠道|模型)' }); continue; }
      const iName = parts[0], cName = parts[1], mName = parts.slice(2).join('|');
      const inst = instByName.get(iName);
      if (!inst) { out.pending.push({ key: k, why: '实例不存在: ' + iName }); continue; }
      const ch = inst.channels.find(c => c && String(c.name) === cName);
      if (ch && namesOf(ch).includes(mName)) continue;                 
      const uniq = [...new Set(inst.channels.filter(c => c && c.name && namesOf(c).includes(mName)).map(c => String(c.name)))];
      if (uniq.length === 1) {
        const nk = metaKey(iName, uniq[0], mName);
        out.moved.push({ from: k, to: nk });
        if (!dry) {
          if (!cfg.modelMeta[nk]) cfg.modelMeta[nk] = cfg.modelMeta[k];
          delete cfg.modelMeta[k];
        }
      } else {
        out.pending.push({
          key: k,
          why: (ch ? '该渠道已不含此模型' : '渠道已不存在: ' + cName)
            + (uniq.length ? '（候选渠道 ' + uniq.join(' / ') + '，不唯一 → 不自动迁移）' : '（无候选渠道 → 不自动迁移）'),
        });
      }
    }
    return out;
  };
  const healOrphans = () => {
    const now = Date.now();
    if (now - healState.at < 60000) return healState.last;
    healState.at = now;
    try {
      const r = scanOrphans(false);
      if (r.moved.length) {
        saveCfg();
        for (const x of r.moved) ctx.log('[model-square] 孤儿配置自愈: ' + x.from + ' → ' + x.to);
      }
      healState.last = r;
      if (r.moved.length || r.pending.length) {
        ctx.log('[model-square] 孤儿配置扫描: 自动迁移 ' + r.moved.length + ' 条, 待人工处理 ' + r.pending.length + ' 条（GET /admin/orphans）');
      }
      return r;
    } catch (e) {
      ctx.log('[model-square] 孤儿自愈失败: ' + e.message);
      healState.last = null;
      return null;
    }
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

  
  
  const chip = (label, selected, facet, value, view, f) => {
    const o = Object.assign({}, f, { [facet]: value, view: view || 'main' });
    const P = ['view=' + o.view, facet + '=' + encodeURIComponent(o[facet])];
    if (o.q) P.push('q=' + encodeURIComponent(o.q));
    if (o.sort) P.push('sort=' + o.sort);
    P.push('cols=' + (Number(o.cols) === 2 ? 2 : 1));
    ['group', 'provider', 'vendor', 'ugroup'].forEach(k => { if (k !== facet && o[k]) P.push(k + '=' + encodeURIComponent(o[k])); });
    P.push('limit=' + Math.max(1, Number(o.limit) || 150));
    return { type: 'chip', text: label, selected: !!selected, action: { type: 'open', target: 'page:square?' + P.join('&') } };
  };

  
  const copyBtn = (name) => ({
    type: 'iconButton', icon: 'msym:copy', container: 'outlined', size: 34,
    desc: '复制模型名', action: { type: 'copy', text: name, toast: '已复制 ' + name },
  });

  
  const backBtn = (label) => ({
    type: 'button', text: label || '返回列表', style: 'tonal', shape: 'pill',
    
    

    action: { type: 'open', target: 'page:square', nav: 'pop' },
  });

  
  const fmtN = (n) => { const v = Number(n) || 0; return (Math.round(v * 10000) / 10000).toString(); };

  



  const REF_SEP = ':';
  const refTok = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, '-');
  const refOf = (inst, ch, model) => {
    const p = [refTok(inst), refTok(ch), String(model == null ? '' : model)];
    return (p[0] && p[1] && p[2]) ? p.join(REF_SEP) : '';
  };

  const typeTone = (t) => (t === 'claude' ? 'tertiary' : t === 'gemini' ? 'primary' : 'success');

  const buildPage = (uk, view, base, fOverride) => {
    const isFilter = view === 'filter';
    const f = fOverride || filterOf(uk);
    const models = allModels();
    const my = myGroup(uk);
    const ug = f.ugroup;   

    
    const declared = groupNames();
    const derived = [...new Set(models.map(m => m.group))].filter(g => !declared.includes(g)).sort();
    const groups = declared.concat(derived);
    

    const chansOf = (m) => ((m.channels && m.channels.length) ? m.channels : [m.channel]).filter(Boolean);
    const providers = [...new Set(models.flatMap(m => chansOf(m)))].sort();
    
    const vendorOf = (m) => groupByRules(m.name);
    const vendors = [...new Set(models.map(m => vendorOf(m)).filter(Boolean))].sort();
    const unmatched = models.filter(m => !vendorOf(m)).length;
    const ugroups = groupsList();

    const match = (m, ff) =>
      (!ff.group || m.group === ff.group) &&
      (!ff.provider || chansOf(m).includes(ff.provider)) &&
      (!ff.vendor || (ff.vendor === '__none__' ? !vendorOf(m) : vendorOf(m) === ff.vendor)) &&
      (!ff.q || ((m.name || '') + ' ' + (m.alias || '') + ' ' + chansOf(m).join(' ') + ' ' + (m.group || '')).toLowerCase().includes(String(ff.q).toLowerCase())) &&
      visibleToGroup(m, ff.ugroup);
    let shown = models.filter(m => match(m, f));
    
    if (f.sort === 'name') shown = shown.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    else if (f.sort === 'group') shown = shown.slice().sort((a, b) => String(a.group).localeCompare(String(b.group)) || String(a.name).localeCompare(String(b.name)));

    
    const countFor = (patch) => models.filter(m => match(m, {
      group: patch.group !== undefined ? patch.group : f.group,
      provider: patch.provider !== undefined ? patch.provider : f.provider,
      vendor: patch.vendor !== undefined ? patch.vendor : f.vendor,
      ugroup: patch.ugroup !== undefined ? patch.ugroup : ug,
    })).length;

    const children = [];
    const active = [];
    if (f.group) active.push('分组 ' + f.group);
    if (f.provider) active.push('提供商 ' + f.provider);
    if (f.vendor) active.push('厂商 ' + (f.vendor === '__none__' ? '未匹配' : f.vendor));
    if (ug) active.push('用户分组 ' + ug);

    if (isFilter) {
      
      children.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: [
          { type: 'row', gap: 12, children: [
            { type: 'column', weight: 1, gap: 4, children: [
              { type: 'text', text: '筛选', style: 'title3' },
              { type: 'text', text: '点选条件立即生效' + (active.length ? ' · 当前: ' + active.join(' · ') : ' · 未筛选'), style: 'caption' },
            ] },
            { type: 'iconButton', icon: 'msym:check', container: 'filled', size: 44,
              desc: '完成，返回模型列表',
              action: { type: 'open', target: 'page:square?' + qs(f, { view: 'main' }), nav: 'pop' } },
          ] },
        ],
      });

      const section = (title, desc, items) => {
        const cols = [{ type: 'text', text: title, style: 'title4' }];
        if (desc) cols.push({ type: 'text', text: desc, style: 'caption' });
        cols.push({ type: 'hscroll', gap: 8, children: items });
        children.push({ type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 6, children: cols });
      };
      section('分组', '', [
        chip('全部 (' + countFor({ group: '' }) + ')', !f.group, 'group', '', 'filter', f),
        ...groups.map(g => chip(g + ' (' + countFor({ group: g }) + ')', f.group === g, 'group', g, 'filter', f)),
      ]);
      section('提供商', '', [
        chip('全部 (' + countFor({ provider: '' }) + ')', !f.provider, 'provider', '', 'filter', f),
        ...providers.map(pp => chip(pp + ' (' + countFor({ provider: pp }) + ')', f.provider === pp, 'provider', pp, 'filter', f)),
      ]);
      
      section('厂商', '按模型名自动推导（group-rules.txt）', [
        chip('全部 (' + countFor({ vendor: '' }) + ')', !f.vendor, 'vendor', '', 'filter', f),
        ...vendors.map(v => chip(v + ' (' + countFor({ vendor: v }) + ')', f.vendor === v, 'vendor', v, 'filter', f)),
        ...(unmatched ? [chip('未匹配 (' + unmatched + ')', f.vendor === '__none__', 'vendor', '__none__', 'filter', f)] : []),
      ]);
      if (ugroups.length) {
        section('用户分组', '', [
          chip('不限 (' + countFor({ ugroup: '' }) + ')', !ug, 'ugroup', '', 'filter', f),
          ...ugroups.map(g => chip(g + ' (' + countFor({ ugroup: g }) + ')', ug === g, 'ugroup', g, 'filter', f)),
        ]);
      }

      children.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: [
          { type: 'row', gap: 10, children: [
            { type: 'button', text: '重置全部条件', style: 'tonal', shape: 'pill',
              action: { type: 'open', target: 'page:square?view=filter&reset=1' } },
            { type: 'button', text: '完成', style: 'filled', shape: 'pill',
              action: { type: 'open', target: 'page:square?' + qs(f, { view: 'main' }), nav: 'pop' } },
          ] },
        ],
      });
    } else {
      
      
      const sortLabel = f.sort === 'name' ? '名称排序' : (f.sort === 'group' ? '分组排序' : '默认排序');
      const nextSort = f.sort === '' ? 'name' : (f.sort === 'name' ? 'group' : '');
      children.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: [
          { type: 'input', key: 'q', value: f.q || '', leadingIcon: 'msym:search',
            hint: '搜索模型名 / 厂商…',
            submit: { type: 'open', target: 'page:square?q={{input.q}}' + (qsCarry(f) ? '&' + qsCarry(f) : '') } },
          { type: 'row', gap: 8, children: [
            { type: 'chip', text: sortLabel, icon: 'msym:sort',
              action: { type: 'open', target: 'page:square?' + qs(f, { sort: nextSort }) } },
            { type: 'iconButton', icon: (Number(f.cols) === 2 ? 'msym:menu' : 'msym:grid'),
              container: 'outlined', size: 40, desc: '切换列表 / 网格',
              action: { type: 'open', target: 'page:square?' + qs(f, { cols: (Number(f.cols) === 2 ? 1 : 2) }) } },
            { type: 'chip', text: '筛选' + (active.length ? ' (' + active.length + ')' : ''), icon: 'msym:filter_list',
              selected: active.length > 0,
              
              action: { type: 'open', target: 'page:square?' + qs(f, { view: 'filter' }), nav: 'push' } },
          ] },
          { type: 'text', text: '共 ' + models.length + ' 个模型 · 显示 ' + shown.length + ' 个'
              + (active.length ? ' · ' + active.join(' · ') : '') + (f.q ? ' · 搜索「' + f.q + '」' : ''), style: 'caption' },
        ],
      });

      if (!shown.length) {
        children.push({
          type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 8, children: [
            { type: 'text', text: '没有符合条件的模型', style: 'body' },
            { type: 'text', text: '点右上角「筛选」换个条件试试；或在管理端「模型列表」里同步上游模型。', style: 'caption' },
          ],
        });
      } else {
        

        const lim = Math.max(1, Math.min(100000, Number(f.limit) || 150));
        const twoCol = Number(f.cols) === 2;
        const rows = [];
        for (const m of shown.slice(0, lim)) {
          const insts = m.instances || [];
          

          const chNames = ((m.channels && m.channels.length) ? m.channels : [m.channel]).filter(Boolean);
          const chTxt = chNames.length > 3
            ? chNames.slice(0, 3).join(' / ') + ' +' + (chNames.length - 3)
            : chNames.join(' / ');
          const meta = m.group + ' · ' + chTxt + (insts.length > 1 ? ' · ' + insts.length + ' 实例' : '')
            + (m.priceDiff ? ' · 价格不一' : '');
          const title = (m.alias ? (m.alias + ' → ' + m.name) : m.name);
          const avatar = { type: 'avatar', url: avatarOf(m.name, base), text: String(m.name).slice(0, 1).toUpperCase(), size: twoCol ? 22 : 26 };
          
          const kids = twoCol
            ? [
                { type: 'row', gap: 8, children: [avatar, { type: 'text', text: title, style: 'body', weight: 1, maxLines: 1 }] },
                { type: 'text', text: meta, style: 'caption', maxLines: 1 },
              ]
            : [
                { type: 'row', gap: 10, children: [
                  avatar,
                  { type: 'text', text: title, style: 'body', weight: 1, maxLines: 1 },
                  { type: 'text', text: meta, style: 'caption', maxLines: 1 },
                ] },
              ];
          rows.push({
            type: 'card', variant: 'outlined', shape: 'large', gap: twoCol ? 4 : 0,
            desc: '查看 ' + m.name + ' 详情',
            

            action: { type: 'open', target: 'page:detail?model=' + encodeURIComponent(m.name) + '&group=' + encodeURIComponent(m.group || '') },
            children: kids,
          });
        }
        if (Number(f.cols) === 2) {
          
          const grid = [];
          for (let i = 0; i < rows.length; i += 2) {
            const pair = [Object.assign({}, rows[i], { weight: 1 })];
            if (rows[i + 1]) pair.push(Object.assign({}, rows[i + 1], { weight: 1 }));
            grid.push({ type: 'row', gap: 6, children: pair });
          }
          children.push({ type: 'column', gap: 6, children: grid });
        } else {
          children.push({ type: 'column', gap: 3, children: rows });
        }
        if (shown.length > lim) {
          
          const step = 150;
          const next = Math.min(shown.length, lim + step);
          children.push({
            type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 8, children: [
              { type: 'text', text: '已显示 ' + lim + ' / ' + shown.length + ' 个模型', style: 'caption' },
              { type: 'row', gap: 8, children: [
                { type: 'button', text: '再看 ' + (next - lim) + ' 个', style: 'filled', shape: 'pill', weight: 1,
                  action: { type: 'open', target: 'page:square?' + qs(f, { limit: next }) } },
                { type: 'button', text: '一次显示全部', style: 'tonal', shape: 'pill', weight: 1,
                  action: { type: 'open', target: 'page:square?' + qs(f, { limit: shown.length }) } },
              ] },
              { type: 'text', text: '想少看一点就用「筛选」缩小范围', style: 'caption' },
            ],
          });
        }
      }
    }

    return { gcui: 1, title: isFilter ? '筛选' : '模型广场', root: { type: 'column', gap: 8, children } };
  };

  
  const curSym = () => { try { return (ctx.gateway.serverInfo ? ((ctx.gateway.serverInfo().currencySymbol || '') || '元') : '元'); } catch (_) { return '元'; } };

  
  const buildDetail = (uk, name, base, group) => {
    const models = allModels();
    
    const m = models.find(x => x.name === name && (!group || String(x.group || '') === String(group)))
      || models.find(x => x.name === name) || null;
    const kids = [];
    if (!m) {
      kids.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', children: [
          { type: 'text', text: '没有找到模型: ' + name, style: 'body' },
        ],
      });
    } else {
      const g = cfg.groups.find(x => x.name === m.group) || {};
      const rate = Number(g.rate) || 1;
      const kv = [];
      kv.push({ label: '模型名', value: m.name });
      if (m.alias) kv.push({ label: '对外名称', value: m.alias });
      if (m.upstream) kv.push({ label: '上游模型', value: m.upstream });
      kv.push({ label: '分组', value: m.group + (rate !== 1 ? '（计费倍率 ×' + rate + '）' : '') });
      
      const allCh = ((m.channels && m.channels.length) ? m.channels : [m.channel]).filter(Boolean);
      kv.push({ label: '提供商(渠道)', value: allCh.join(' / ') || '—' });
      kv.push({ label: '协议类型', value: m.type });
      kv.push({ label: '可用实例', value: (m.instances || []).join(' / ') || '—' });
      if (m.groups.length) kv.push({ label: '用户分组限制', value: '仅 ' + m.groups.join(' / ') });
      


      const srcsAll = (m.sources || []).filter(s => s.price || s.perCall != null);
      const multiPrice = m.priceDiff && srcsAll.length > 1;
      if (multiPrice) {
        kv.push({ label: '价格', value: '各来源不一致 —— 逐条见下（' + curSym() + ' / 1M tokens）' });
      } else if (m.price) {
        const pp = m.price;
        const sym = curSym();
        kv.push({ label: '输入价格', value: fmtN(pp['in']) + ' ' + sym + ' / 1M tokens' });
        kv.push({ label: '输出价格', value: fmtN(pp.out) + ' ' + sym + ' / 1M tokens' });
        if (Number(pp.cacheWrite) > 0) kv.push({ label: '缓存写入', value: fmtN(pp.cacheWrite) + ' ' + sym + ' / 1M tokens' });
        if (Number(pp.cacheRead) > 0) kv.push({ label: '缓存读取', value: fmtN(pp.cacheRead) + ' ' + sym + ' / 1M tokens' });
      } else if (m.perCall == null) {
        kv.push({ label: '价格', value: '（未在管理端配置）' });
      }
      if (m.perCall != null) kv.push({ label: '按次计费', value: fmtN(m.perCall) + ' ' + curSym() + ' / 次' });
      


      const srcs = (m.sources || []).filter(s => s.price || s.perCall != null);
      if (m.priceDiff && srcs.length > 1) {
        const one = (s) => {
          const nm = String(s.channel || '—').slice(0, 20);
          if (s.price) return nm + ' ' + fmtN(s.price['in']) + '/' + fmtN(s.price.out);
          return nm + ' 未配价';
        };
        kv.push({ label: '各来源价格（输入/输出 ' + curSym() + '/1M）', value: srcs.slice(0, 4).map(one).join(' · ') + (srcs.length > 4 ? ' …' : '') });
      }
      

      const refs = ((m.sources && m.sources.length) ? m.sources : [{ instance: (m.instances || [])[0] || '', channel: m.channel }])
        .map(s => refOf(s.instance, s.channel, m.name)).filter(Boolean);
      if (refs.length) {
        kv.push({ label: '完整调用名', value: refs.length > 1 ? '（同名冲突时用它指定来源）' : '' });
        kv.push({ label: '\u200b', value: refs.slice(0, 4).join('   ') });
        if (refs.length > 4) kv.push({ label: '\u200b', value: '…另有 ' + (refs.length - 4) + ' 个来源' });
      }
      kids.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: [
          { type: 'row', gap: 10, children: [
            { type: 'avatar', url: avatarOf(m.name, base), text: String(m.name).slice(0, 1).toUpperCase(), size: 36 },
            { type: 'column', weight: 1, gap: 3, children: [
              { type: 'text', text: (m.alias ? (m.alias + '  →  ' + m.name) : m.name), style: 'title3' },
              { type: 'text', text: (m.instances || []).join(' / ') || m.channel, style: 'caption' },
            ] },
            copyBtn(m.name),
          ] },
          { type: 'kv', label: kv[0].label, value: kv[0].value },
          ...kv.slice(1).map(x => ({ type: 'kv', label: x.label, value: x.value })),
        ],
      });
    }
    kids.push({
      type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 10, children: [
        { type: 'row', gap: 10, children: [backBtn()] },
      ],
    });
    return { gcui: 1, title: '模型详情', root: { type: 'column', gap: 12, children: kids } };
  };

  
  
  const apis = () => ctx.gateway.authApis();
  const ukOf = (p) => {
    
    if (p && p.userKey) return p.userKey;
    const t = (p && p.token) || '';
    if (!t || !apis().findKey) return null;
    let uk = null;
    try { uk = apis().findKey(null, t); } catch (_) { uk = null; }
    return (uk && uk.enable !== false) ? uk : null;
  };

  const baseOf = (req) => 'http://' + ((req && req.headers && req.headers.host) || '127.0.0.1:16484');

  route('GET', '/ui/square', (req, res, p) => {
    

    const uk = ukOf(p);
    const qp = parseQ(req);
    const view = qp.view === 'filter' ? 'filter' : 'main';
    let f;
    if (qp.reset) {
      if (uk) saveFilter(uk, allFilter());
      f = allFilter();
    } else {
      const patch = {};
      if ('q' in qp) patch.q = String(qp.q || '').slice(0, 60);
      if ('sort' in qp) patch.sort = ['', 'name', 'group'].includes(qp.sort) ? qp.sort : '';
      if ('cols' in qp) patch.cols = Number(qp.cols) === 2 ? 2 : 1;
      if ('limit' in qp) patch.limit = Math.max(1, Math.min(100000, Number(qp.limit) || 150));
      if ('group' in qp) patch.group = qp.group;
      if ('provider' in qp) patch.provider = qp.provider;
      if ('vendor' in qp) patch.vendor = qp.vendor;
      if ('ugroup' in qp) patch.ugroup = qp.ugroup;
      if (Object.keys(patch).length) {
        f = uk ? saveFilter(uk, patch) : Object.assign({}, filterOf(uk), patch);
      } else {
        f = filterOf(uk);
      }
    }
    const page = buildPage(uk, view, baseOf(req), f);
    if (!uk) {
      page.guest = true;
      page.root.children.unshift({ type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 6, children: [
        { type: 'text', text: '未登录 · 游客浏览', style: 'title4' },
        { type: 'text', text: '可以看模型清单、详情, 也能筛选、排序、切换视图。登录后可调用模型、管理卡密。', style: 'caption' },
      ] });
    }
    jsonRes(res, 200, page);
  });

  
  route('GET', '/icon', (req, res, p) => {
    const q = String((req.url || '').split('?')[1] || '');
    const m = q.match(/(?:^|&)f=([^&]+)/);
    const name = m ? decodeURIComponent(m[1]) : '';
    if (!/^[\w.-]+\.(svg|png)$/.test(name)) return jsonRes(res, 400, { error: 'bad file' });
    try {
      const fs = require('fs');
      const path = require('path');
      const file = path.join(__dirname, 'icons', name);
      if (!fs.existsSync(file)) return jsonRes(res, 404, { error: 'not found' });
      res.writeHead(200, {
        'Content-Type': name.endsWith('.png') ? 'image/png' : 'image/svg+xml',
        'Cache-Control': 'max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(fs.readFileSync(file));
    } catch (e) { return jsonRes(res, 500, { error: e.message }); }
  });

  
  route('GET', '/data/square', (req, res, p) => {
    const uk = ukOf(p);
    const models = allModels();
    jsonRes(res, 200, {
      ok: true,
      guest: !uk,
      myGroup: uk ? myGroup(uk) : '',
      groups: [...new Set(models.map(m => m.group))].sort(),
      providers: [...new Set(allModels().map(m => m.channel).filter(Boolean))].sort(),
      ugroups: groupsList(),
      models,
    });
  });

  

  




  const uidOfInst = (instName) => {
    if (String(instName) === String(myInstName())) return myInst().uid;
    for (const inst of listInstancesSafe()) if (String(inst.name) === String(instName)) return inst.uid;
    return null;
  };
  const chsOfInst = (instName, uid) => {
    if (uid == null || String(instName) === String(myInstName())) return channels();
    let ic = null; try { ic = ctx.getInstanceConfig(uid); } catch (_) {}
    return (ic && Array.isArray(ic.channels)) ? ic.channels : [];
  };
  
  const chNamesExposing = (instName, modelName) => {
    const m = String(modelName);
    return chsOfInst(instName, uidOfInst(instName))
      .filter(ch => ch && ch.name && namesOf(ch).includes(m))
      .map(ch => ch.name);
  };
  
  const mergeModels = (chs) => {
    const map = new Map();
    for (const c of chs) for (const m of (c.models || [])) {
      let e = map.get(m.name);
      if (!e) { e = { name: m.name, group: m.group, alias: m.alias, price: m.price, perCall: m.perCall, channels: [], chCount: 0, diff: false }; map.set(m.name, e); }
      e.channels.push(c.name); e.chCount++;
      if ((m.group || '') !== (e.group || '')) e.diff = true;
      if ((m.alias || '') !== (e.alias || '')) e.diff = true;
      if (m.price) { if (!e.price) e.price = m.price; else if (JSON.stringify(m.price) !== JSON.stringify(e.price)) e.diff = true; }
      if (m.perCall != null) { if (e.perCall == null) e.perCall = m.perCall; else if (m.perCall !== e.perCall) e.diff = true; }
    }
    return [...map.values()];
  };

  
  route('GET', '/admin/orphans', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    const r = scanOrphans(true);   
    jsonRes(res, 200, {
      ok: true,
      total: r.total,
      autoMigratable: r.moved,
      pending: r.pending,
      lastHeal: healState.last ? { moved: (healState.last.moved || []).length, at: healState.at } : null,
      note: 'autoMigratable = 下一次自愈会自动迁移的键; pending = 候选不唯一/无候选, 需人工处理',
    });
  });
  route('POST', '/admin/heal-meta', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    healState.at = 0;                     
    const r = healOrphans();
    jsonRes(res, 200, { ok: true, moved: (r && r.moved) || [], pending: (r && r.pending) || [] });
  });

  


  const groupsData = () => {
    const self = myInstName();
    const insts = [];
    
    insts.push({
      name: self, uid: myInst().uid, current: true,
      channels: channels().map(ch => ({
        name: ch.name, type: ch.type || 'openai',
        mapSize: (ch.modelMap && typeof ch.modelMap === 'object') ? Object.keys(ch.modelMap).length : 0,
        maps: (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {},
        models: modelsOf(ch, self).map(m => ({ name: m.name, group: m.group, alias: m.alias, price: m.price, perCall: m.perCall })),
      })),
      merged: mergeModels(channels().map(ch => ({
        name: ch.name,
        models: modelsOf(ch, self).map(m => ({ name: m.name, group: m.group, alias: m.alias, price: m.price, perCall: m.perCall })),
      }))),
    });
    
    for (const inst of listInstancesSafe()) {
      if (String(inst.uid) === String(myInst().uid)) continue;
      let ic = null;
      try { ic = ctx.getInstanceConfig(inst.uid); } catch (_) {}
      if (!ic || !Array.isArray(ic.channels)) continue;
      const chs = ic.channels.filter(ch => ch && ch.name).map(ch => ({
        name: ch.name, type: ch.type || 'openai',
        mapSize: (ch.modelMap && typeof ch.modelMap === 'object') ? Object.keys(ch.modelMap).length : 0,
        maps: (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {},
        models: (Array.isArray(ch.models) ? ch.models : []).map(n => ({
          name: n,
          group: groupFor(inst.name, ch.name, n),
          alias: aliasOf(inst.name, ch.name, n),
          price: priceOf(inst.name, ch.name, n),
          perCall: perCallOf(inst.name, ch.name, n),
        })),
      }));
      if (chs.length) insts.push({ name: inst.name, uid: inst.uid, current: false, channels: chs, merged: mergeModels(chs) });
    }
    const counts = {};
    for (const g of cfg.groups) counts[g.name] = 0;
    for (const it of insts) for (const c of it.channels) for (const m of c.models) counts[m.group] = (counts[m.group] || 0) + 1;
    return {
      defaultGroup: DEFAULT_GROUP,
      groups: cfg.groups.map(g => ({ name: g.name, rate: Number(g.rate) || 1 })),
      counts,
      instances: insts,
      channels: insts[0] ? insts[0].channels : [],
    };
  };

  
  route('GET', '/admin/groups', (req, res, p) => {
    const a = p.authAdmin(); if (!a.ok) return jsonRes(res, a.status || 401, { error: a.error });
    jsonRes(res, 200, Object.assign({ ok: true }, groupsData()));
  });

  
  route('POST', '/admin/groups', (req, res, p) => {
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
      const chList = ch === '*' ? chNamesExposing(inst, m) : [ch];
      if (!chList.length) return jsonRes(res, 400, { error: '该实例下没有渠道暴露这个模型' });
      let lastKey = '';
      for (const c of chList) {
        const k = metaKey(inst, c, m);
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
        if (j.rules !== undefined) cur.rules = Array.isArray(j.rules) ? j.rules : [];
        if (!cur.group) cur.group = DEFAULT_GROUP;
        cfg.modelMeta[k] = cur; lastKey = k;
      }
      saveCfg();
      return jsonRes(res, 200, { ok: true, applied: chList, meta: Object.assign({ key: lastKey }, cfg.modelMeta[lastKey]) });
    }
    
    if (act === 'bulk') {
      const items = Array.isArray(j.items) ? j.items : [];
      if (!items.length) return jsonRes(res, 400, { error: '没有选中模型' });
      let n = 0;
      for (const raw of items) {
        


        const it = (typeof raw === 'string')
          ? (function () { const a = String(raw).split('|'); return { instance: a[0], channel: a[1], model: a.slice(2).join('|') }; })()
          : raw;
        const ch = String((it && it.channel) || ''), m = String((it && it.model) || '');
        const inst = String((it && it.instance) || j.instance || myInstName());
        if (!ch || !m) continue;
        
        const chList = ch === '*' ? chNamesExposing(inst, m) : [ch];
        for (const c of chList) {
          const k = metaKey(inst, c, m);
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
          if (j.rules !== undefined) cur.rules = Array.isArray(j.rules) ? j.rules : [];
          if (!cur.group) cur.group = DEFAULT_GROUP;
          cfg.modelMeta[k] = cur; n++;
        }
      }
      saveCfg();
      return jsonRes(res, 200, { ok: true, updated: n });
    }
    


    if (act === 'addRule') {
      const ch = String(j.channel || ''), m = String(j.model || '');
      const inst = String(j.instance || myInstName());
      if (!m) return jsonRes(res, 400, { error: '缺少 model' });
      const chList = ch === '*' ? chNamesExposing(inst, m) : [ch];
      if (!chList.length) return jsonRes(res, 400, { error: '该实例下没有渠道暴露这个模型' });
      const trig = String(j.trig || 'none'), op = String(j.op || 'eq');
      const val = j.v == null ? '' : String(j.v);
      const eff = String(j.eff || 'mult'), effVal = String(j.effVal == null ? '' : j.effVal);
      
      const when = [];
      const trigK = { model: 'model', ugroup: 'ugroup', hour: 'hour', weekday: 'weekday', ctxLen: 'ctxLen' }[trig];
      if (trig === 'expr') when.push({ k: 'expr', op: 'eq', v: val });
      else if (trig !== 'none' && trigK) {
        let v = val;
        if (op === 'in' || op === 'nin') v = val.split(',').map(s => s.trim()).filter(Boolean);
        else if (op === 'between') v = val.split(',').map(s => Number(s.trim()) || 0).slice(0, 2);
        when.push({ k: trigK, op, v });
      }
      
      const then = [];
      if (eff === 'free') then.push({ k: 'free' });
      else if (eff === 'mult') then.push({ k: 'mult', v: Number(effVal) || 0 });
      else if (eff === 'perCall') then.push({ k: 'perCall', v: Number(effVal) || 0 });
      else if (eff === 'priceIn') then.push({ k: 'price', field: 'input', mode: 'set', v: Number(effVal) || 0 });
      else if (eff === 'priceOut') then.push({ k: 'price', field: 'output', mode: 'set', v: Number(effVal) || 0 });
      else if (eff === 'priceCR') then.push({ k: 'price', field: 'cacheRead', mode: 'set', v: Number(effVal) || 0 });
      if (!then.length) return jsonRes(res, 400, { error: '效果类型无效' });
      const rule = { note: String(j.note || '').slice(0, 80), on: true, when, then };
      for (const c of chList) {
        const k = metaKey(inst, c, m);
        const cur = cfg.modelMeta[k] || {};
        if (!Array.isArray(cur.rules)) cur.rules = [];
        cur.rules.push(rule);
        if (!cur.group) cur.group = DEFAULT_GROUP;
        cfg.modelMeta[k] = cur;
      }
      saveCfg();
      return jsonRes(res, 200, { ok: true, added: chList.length });
    }
    return jsonRes(res, 400, { error: '未知操作: ' + act });
  });

  route('POST', '/intent/square/filter', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: '需要登录' };
    const b = p.body || {};
    if (b.reset) {
      cfg.filters[fkey(uk)] = allFilter();
      ctx.setPluginConfig(cfg);
    } else {
      const facet = String(b.facet || '');
      if (facet) {
        if (!['group', 'provider', 'ugroup'].includes(facet)) return { ok: false, error: '未知筛选项: ' + facet };
        saveFilter(uk, { [facet]: String(b.value == null ? '' : b.value) });
      }
      
      if (b.q !== undefined) saveFilter(uk, { q: String(b.q == null ? '' : b.q).slice(0, 60) });
      if (b.sort !== undefined) saveFilter(uk, { sort: ['', 'name', 'group'].includes(String(b.sort)) ? String(b.sort) : '' });
      if (b.cols !== undefined) saveFilter(uk, { cols: Number(b.cols) === 2 ? 2 : 1 });
      
    }
    const view = String(b.view || 'main') === 'filter' ? 'filter' : 'main';
    
    return { ok: true, nav: 'replace', ui: buildPage(uk, view, baseOf(req)) };
  }));

  
  
  route('GET', '/ui/detail', (req, res, p) => {
    const q = String((req.url || '').split('?')[1] || '');
    const mm = q.match(/(?:^|&)model=([^&]+)/);
    const name = mm ? decodeURIComponent(mm[1]) : '';
    
    const mg = q.match(/(?:^|&)group=([^&]+)/);
    const group = mg ? decodeURIComponent(mg[1]) : '';
    if (!name) return jsonRes(res, 400, { error: '需要 model 参数' });
    const uk = ukOf(p);
    jsonRes(res, 200, buildDetail(uk, name, baseOf(req), group));
  });

  
  route('GET', '/data/detail', (req, res, p) => {
    const q = String((req.url || '').split('?')[1] || '');
    const mm = q.match(/(?:^|&)model=([^&]+)/);
    const name = mm ? decodeURIComponent(mm[1]) : '';
    const mg = q.match(/(?:^|&)group=([^&]+)/);
    const group = mg ? decodeURIComponent(mg[1]) : '';
    if (!name) return jsonRes(res, 400, { ok: false, error: '需要 model 参数' });
    const models = allModels();
    const m = models.find(x => x.name === name && (!group || String(x.group || '') === String(group)))
      || models.find(x => x.name === name) || null;
    if (!m) return jsonRes(res, 404, { ok: false, error: '没有找到模型: ' + name });
    const g = cfg.groups.find(x => x.name === m.group) || {};
    const rate = Number(g.rate) || 1;
    jsonRes(res, 200, {
      ok: true,
      model: {
        name: m.name, alias: m.alias || '', upstream: m.upstream || '',
        group: m.group, groupRate: rate, channel: m.channel,
        channels: m.channels || [], type: m.type || '', instances: m.instances || [],
        userGroups: m.groups || [], price: m.price || null,
        perCall: m.perCall == null ? null : m.perCall,
        
        priceDiff: !!m.priceDiff,
        sources: (m.sources || []).map(s => ({ instance: s.instance, channel: s.channel, price: s.price, perCall: s.perCall })),
        
        refs: ((m.sources && m.sources.length) ? m.sources : [{ instance: (m.instances || [])[0] || '', channel: m.channel }])
          .map(s => refOf(s.instance, s.channel, m.name)).filter(Boolean),
        avatarUrl: avatarOf(m.name, baseOf(req)),
      },
    });
  });

  route('POST', '/intent/square/detail', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
    if (!uk) return { ok: false, error: '需要登录' };
    const b = p.body || {};
    
    return { ok: true, nav: 'push', ui: buildDetail(uk, String(b.model || ''), baseOf(req), String(b.group || '')), refresh: 'intent' };
  }));












  ctx.registerAdminUi({
    id: 'model-edit',
    title: '编辑模型',
    icon: 'edit',
    menu: false,
    render: (gw, c, q) => { refreshCfg();   
      
      const txt = (text, style, color) => { const o = { type: 'text', text }; if (style) o.style = style; if (color) o.color = color; return o; };
      const gap = (h) => ({ type: 'spacer', height: h || 8 });
      const btn = (text, style, action) => Object.assign({ type: 'button', text, style: style, action: action }, {});
      const inst = String((q && q.get) ? q.get('instance') : '') || myInstName();
      const chName = String((q && q.get) ? q.get('channel') : '');
      const modelName = String((q && q.get) ? q.get('model') : '');
      const groups = cfg.groups.map(g => g.name);
      const sym = curSym();
      const call = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call', body: { plugin: 'model-square', path: '/admin/groups', method: 'POST', body: body } });

      



      const merged = chName === '*';
      const variantMetas = merged ? chNamesExposing(inst, modelName).map(ch => metaOf(inst, ch, modelName) || {}).filter(m => m && Object.keys(m).length) : [];
      const meta = merged
        ? variantMetas.reduce((a, m) => {
            if (!a) return Object.assign({}, m);
            if (!a.group && m.group) a.group = m.group;
            if (!a.alias && m.alias) a.alias = m.alias;
            if (!a.price && m.price) a.price = m.price;
            if (a.perCall == null && m.perCall != null) a.perCall = m.perCall;
            if (!Array.isArray(a.rules) && Array.isArray(m.rules)) a.rules = m.rules;
            return a;
          }, null) || { group: DEFAULT_GROUP }
        : (metaOf(inst, chName, modelName) || { group: DEFAULT_GROUP });
      const diff = merged && variantMetas.length > 1 && variantMetas.some(m =>
        (m.group || '') !== (meta.group || '') || (m.alias || '') !== (meta.alias || '') ||
        JSON.stringify(m.price || {}) !== JSON.stringify(meta.price || {}) ||
        (m.perCall == null ? null : m.perCall) !== (meta.perCall == null ? null : meta.perCall));
      const price = meta.price || {};
      const rules = Array.isArray(meta.rules) ? meta.rules : [];
      const chLabel = merged ? (variantMetas.length + ' 个渠道') : chName;

      const kids = [
        txt(meta.alias || modelName, 'title3'),
        txt(inst + ' · ' + chLabel + '  /  ' + modelName, 'caption', '$onSurfaceVariant'),
      ];
      if (merged && diff) kids.push(txt('⚠ 各渠道配置不一致，保存将统一覆盖到全部 ' + variantMetas.length + ' 个渠道。', 'caption', '$error'));
      kids.push(gap(8),
        {
          type: 'form', submitText: '保存', submitShape: 'large',
          fields: [
            { type: 'input', key: 'alias', label: '对外名称（留空 = 用原名）', value: meta.alias || '' },
            { type: 'input', key: 'group', label: '分组（可选: ' + groups.join(', ') + '）', value: meta.group || DEFAULT_GROUP },
            { type: 'input', key: 'perCall', label: '按次价格（' + sym + '/次，留空 = 按量计费）', inputType: 'number', value: meta.perCall != null ? String(meta.perCall) : '' },
            { type: 'input', key: 'priceIn', label: '输入（' + sym + ' / 1M tokens）', inputType: 'number', value: String(price['in'] || 0) },
            { type: 'input', key: 'priceOut', label: '输出（' + sym + ' / 1M tokens）', inputType: 'number', value: String(price.out || 0) },
            { type: 'input', key: 'priceCW', label: '缓存写入（' + sym + ' / 1M tokens）', inputType: 'number', value: String(price.cacheWrite || 0) },
            { type: 'input', key: 'priceCR', label: '缓存读取（' + sym + ' / 1M tokens）', inputType: 'number', value: String(price.cacheRead || 0) },
          ],
          submit: Object.assign(call({
            action: 'setModel', instance: inst, channel: chName, model: modelName,
            group: '{{form.group}}', alias: '{{form.alias}}', perCall: '{{form.perCall}}',
            price: { in: '{{form.priceIn}}', out: '{{form.priceOut}}', cacheWrite: '{{form.priceCW}}', cacheRead: '{{form.priceCR}}' },
          }), { then: 'close' }),
        },
        txt('两种计费方式二选一：填了「按次价格」就按次收，否则按 token 单价；都填 0 = 免费。', 'caption', '$onSurfaceVariant'),
        gap(12),
        txt('计费规则（该模型专属，会覆盖全局规则）', 'title3'),
      );

      if (!rules.length) {
        kids.push(txt('没有模型级规则。上面的价格字段已经决定基础扣费。点下面「添加规则」可以直接在这里加。', 'caption', '$onSurfaceVariant'));
      } else {
        for (let i = 0; i < rules.length; i++) {
          const r = rules[i];
          const wTxt = (r.when || []).map(c => c.k + ' ' + (c.op || 'eq') + ' ' + (Array.isArray(c.v) ? c.v.join(',') : c.v)).join(' 且 ') || '无条件';
          const tTxt = (r.then || []).map(e => e.k + (e.k === 'price' ? '(' + (e.field || 'all') + ',' + (e.mode || 'set') + '):' + e.v : ':' + e.v)).join('，');
          kids.push({
            type: 'card', variant: 'outlined', gap: 6, children: [
              txt((r.note || ('规则 ' + (i + 1))) + (r.on === false ? '（已停用）' : ''), 'body'),
              txt('触发: ' + wTxt, 'caption', '$onSurfaceVariant'),
              txt('效果: ' + tTxt, 'caption', '$onSurfaceVariant'),
              btn('删除规则', 'text', call({ action: 'setModel', instance: inst, channel: chName, model: modelName, rules: rules.filter((_, j) => j !== i) })),
            ],
          });
        }
      }

      


      kids.push(gap(8));
      kids.push(btn('添加规则', 'tonal', { type: 'setState', patch: { draft: '1' } }));
      kids.push({
        type: 'card', variant: 'outlined', gap: 8, visible: '{{state.draft}}', children: [
          txt('新建模型级规则', 'title3'),
          txt('触发条件（全部满足才生效；选「无条件」= 对所有请求生效）', 'caption', '$onSurfaceVariant'),
          { type: 'segmented', key: 'trig', selected: '{{state.trig}}', options: [
            { value: 'none', text: '无条件' }, { value: 'model', text: '模型' }, { value: 'ugroup', text: '用户组' },
            { value: 'hour', text: '时段' }, { value: 'weekday', text: '星期' }, { value: 'ctxLen', text: '上下文' }, { value: 'expr', text: '表达式' },
          ], action: { type: 'setState', patch: { trig: '{{input._value}}' } } },
          { type: 'segmented', key: 'op', selected: '{{state.op}}', options: [
            { value: 'eq', text: '=' }, { value: 'ne', text: '≠' }, { value: 'gt', text: '>' }, { value: 'gte', text: '≥' },
            { value: 'lt', text: '<' }, { value: 'lte', text: '≤' }, { value: 'in', text: '属于' }, { value: 'between', text: '介于' },
          ], action: { type: 'setState', patch: { op: '{{input._value}}' } } },
          { type: 'input', key: 'val', label: '触发值（属于/介于用逗号分隔；表达式如 hour>=22 && ctxLen>8000）', value: '' },
          txt('触发效果（按顺序叠加）', 'caption', '$onSurfaceVariant'),
          { type: 'segmented', key: 'eff', selected: '{{state.eff}}', options: [
            { value: 'mult', text: '整体倍率' }, { value: 'priceIn', text: '输入特价' }, { value: 'priceOut', text: '输出特价' },
            { value: 'priceCR', text: '缓存读特价' }, { value: 'perCall', text: '按次价' }, { value: 'free', text: '免费' },
          ], action: { type: 'setState', patch: { eff: '{{input._value}}' } } },
          { type: 'input', key: 'effVal', label: '效果值（倍率 0.5 / 特价 2 / 按次 0.01；免费不用填）', inputType: 'number', value: '' },
          { type: 'input', key: 'note', label: '备注（可选）', value: '' },
          btn('添加这条规则', 'filled', Object.assign(call({
            action: 'addRule', instance: inst, channel: chName, model: modelName,
            trig: '{{input.trig}}', op: '{{input.op}}', v: '{{input.val}}', eff: '{{input.eff}}', effVal: '{{input.effVal}}', note: '{{input.note}}',
          }), { then: 'reload' })),
          btn('取消', 'text', { type: 'setState', patch: { draft: '' } }),
        ],
      });

      kids.push(gap(8));
      kids.push(btn('关闭', 'text', { type: 'close' }));

      return { title: '编辑模型', state: {}, root: { type: 'column', gap: 10, children: kids } };
    },
  });


  
















  const MODELS_PAGE_LIMIT = 40;      


  const MODELS_LIMIT_STEP = 40;
  const MODELS_LIMIT_MAX = 2000;   

  
  const priceKindOf = (m) => (m && m.perCall != null) ? 'percall'
    : ((m && m.price && typeof m.price === 'object') ? 'has' : 'none');

  const buildModelsPage = (q) => {
    refreshCfg();
    const get = (k) => { try { return (q && q.get) ? String(q.get(k) || '') : ''; } catch (_) { return ''; } };
    const enc = encodeURIComponent;
    const fInst = get('inst'), fCh = get('ch'), fPrice = get('price'), fGrp = get('grp');
    const kw = get('kw').trim(), kwl = kw.toLowerCase();
    const cols = Math.min(4, Math.max(2, Number(get('cols')) || 2));
    

    

    const showAll = get('all') === '1';
    const lim = showAll ? MODELS_LIMIT_MAX
      : Math.min(MODELS_LIMIT_MAX, Math.max(1, Number(get('limit')) || MODELS_PAGE_LIMIT));
    const d = groupsData();
    const insts = Array.isArray(d.instances) ? d.instances : [];
    const self = myInstName();
    const sym = curSym();

    
    const txt = (text, style, color) => { const o = { type: 'text', text: text }; if (style) o.style = style; if (color) o.color = color; return o; };
    const gap = (h) => ({ type: 'spacer', height: h || 8 });
    const btn = (text, style, action) => { const o = { type: 'button', text: text, style: style }; if (action) o.action = action; return o; };
    const chip = (text, on, action) => { const o = { type: 'chip', text: text, selected: !!on }; if (action) o.action = action; return o; };
    const badge = (text, tone) => ({ type: 'badge', text: text, tone: tone });
    
    const call = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
      body: { plugin: 'model-square', path: '/admin/groups', method: 'POST', body: body } });
    const syncCall = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
      body: { plugin: 'model-sync', path: '/admin/run', method: 'POST', body: body } });

    
    const instOpts = [], chOpts = [];
    const grpOpts = (d.groups || []).map(g => g.name);
    for (const it of insts) {
      instOpts.push(it.name);
      for (const ch of (it.channels || [])) if (ch.name && chOpts.indexOf(ch.name) < 0) chOpts.push(ch.name);
    }

    
    const mkUrl = (pairs) => {
      const keep = [];
      for (const pair of pairs) {
        const k = pair[0], v = pair[1];
        if (v === undefined || v === null || String(v) === '') continue;
        const s = String(v);
        
        keep.push(k + '=' + (s.indexOf('{{') === 0 ? s : enc(s)));
      }
      return '/admin/ui/models' + (keep.length ? ('?' + keep.join('&')) : '');
    };
    const jump = (over) => {
      const m = { inst: fInst, ch: fCh, price: fPrice, grp: fGrp, kw: kw, cols: String(cols), all: showAll ? '1' : '' };
      Object.keys(over || {}).forEach(k => { m[k] = over[k]; });
      return { type: 'open', nav: 'replace',
        target: 'page:' + mkUrl([['inst', m.inst], ['ch', m.ch], ['price', m.price], ['grp', m.grp], ['kw', m.kw], ['cols', m.cols], ['all', m.all]]) };
    };
    
    const moreUrl = 'page:' + mkUrl([['inst', fInst], ['ch', fCh], ['price', fPrice], ['grp', fGrp], ['kw', kw],
      ['cols', String(cols)], ['limit', String(Math.min(MODELS_LIMIT_MAX, lim + MODELS_LIMIT_STEP))]]);
    const openPage = (path) => ({ type: 'open', target: 'page:' + path, nav: 'push' });

    
    let totalMerged = 0, totalModels = 0, totalCh = 0;
    for (const it of insts) {
      totalMerged += (it.merged || []).length;
      for (const ch of (it.channels || [])) { totalCh++; totalModels += (ch.models || []).length; }
    }
    




    const aliasIdx = {}, variantIdx = {};
    for (const it of insts) {
      const am = {}, vm = {};
      for (const ch of (it.channels || [])) for (const m of (ch.models || [])) {
        const nm = String(m.name || '');
        const a = String(m.alias || '');
        if (a && !am[nm]) am[nm] = a;
        let v = vm[nm];
        if (!v) v = vm[nm] = { groups: [], kinds: [], chs: [] };
        const g = String(m.group || DEFAULT_GROUP);
        if (v.groups.indexOf(g) < 0) v.groups.push(g);
        const k = priceKindOf(m);
        if (v.kinds.indexOf(k) < 0) v.kinds.push(k);
        if (v.chs.indexOf(ch.name) < 0) v.chs.push(ch.name);
      }
      aliasIdx[it.name] = am; variantIdx[it.name] = vm;
    }
    const kindLabel = (k) => (k === 'percall' ? '按次' : (k === 'has' ? '有价格' : '未定价'));
    const rows = [];
    for (const it of insts) {
      if (fInst && it.name !== fInst) continue;
      const am = aliasIdx[it.name] || {}, vm = variantIdx[it.name] || {};
      
      if (fCh) {
        const ch = (it.channels || []).find(c => c.name === fCh);
        if (!ch) continue;
        for (const m of (ch.models || [])) {
          const nm = String(m.name || ''), kind = priceKindOf(m), gname = String(m.group || DEFAULT_GROUP);
          if (fPrice && kind !== fPrice) continue;
          if (fGrp && gname !== fGrp) continue;
          if (kwl && ((nm + ' ' + String(m.alias || '')).toLowerCase().indexOf(kwl) < 0)) continue;
          rows.push({
            inst: it.name, name: nm,
            key: it.name + '|' + fCh + '|' + nm,
            label: String(m.alias || nm),
            sub: it.name + ' · 渠道 ' + fCh,
            gText: gname, gTone: gname === DEFAULT_GROUP ? 'neutral' : 'primary',
            pText: kind === 'percall' ? ('按次 ' + sym + m.perCall) : (kind === 'has' ? '有价格' : '未定价'),
            pTone: kind === 'percall' ? 'warning' : (kind === 'has' ? 'success' : 'neutral'),
            editUrl: '/admin/ui/model-edit?instance=' + enc(it.name) + '&channel=' + enc(fCh) + '&model=' + enc(nm),
          });
        }
        continue;
      }
      
      for (const m of (it.merged || [])) {
        const nm = String(m.name || ''), kind = priceKindOf(m), gname = String(m.group || DEFAULT_GROUP);
        const v = vm[nm];
        const kinds = (v && v.kinds.length) ? v.kinds : [kind];
        const groups = (v && v.groups.length) ? v.groups : [gname];
        const chs = (v && v.chs.length) ? v.chs : (m.channels || []);
        if (fPrice && kinds.indexOf(fPrice) < 0) continue;
        if (fGrp && groups.indexOf(fGrp) < 0) continue;
        if (kwl && ((nm + ' ' + String(m.alias || am[nm] || '')).toLowerCase().indexOf(kwl) < 0)) continue;
        const multiG = groups.length > 1, multiK = kinds.length > 1;
        rows.push({
          inst: it.name, name: nm,
          key: it.name + '|*|' + nm,
          label: String(m.alias || am[nm] || nm),
          sub: it.name + ' · ' + (Number(m.chCount) || 1) + ' 个渠道（' + chs.slice(0, 3).join(' / ') + (chs.length > 3 ? ' …' : '') + '）'
            + ((m.diff || multiG || multiK) ? ' · 配置不一致' : ''),
          gText: multiG ? groups.join(' / ') : gname,
          gTone: multiG ? 'warning' : (gname === DEFAULT_GROUP ? 'neutral' : 'primary'),
          pText: multiK ? kinds.map(kindLabel).join(' / ')
            : (kind === 'percall' ? ('按次 ' + sym + m.perCall) : (kind === 'has' ? '有价格' : '未定价')),
          pTone: multiK ? 'warning' : (kind === 'percall' ? 'warning' : (kind === 'has' ? 'success' : 'neutral')),
          editUrl: '/admin/ui/model-edit?instance=' + enc(it.name) + '&channel=*&model=' + enc(nm),
        });
      }
    }
    const shown = rows.slice(0, lim);
    const filtered = !!(fInst || fCh || fPrice || fGrp || kwl);

    
    const cardTpl = {
      type: 'card', variant: 'outlined', gap: 6,
      action: { type: 'open', target: 'page:{{item.editUrl}}', nav: 'push' },
      

      longAction: { type: 'toggleSelect', value: '{{item.key}}' },
      children: [
        { type: 'row', gap: 8, children: [
          { type: 'text', text: '{{item.label}}', style: 'title3', weight: 1 },
          { type: 'checkbox', value: '{{item.key}}' },
        ] },
        txt('{{item.sub}}', 'caption', '$onSurfaceVariant'),
        { type: 'row', gap: 6, children: [
          { type: 'badge', text: '{{item.gText}}', tone: '{{item.gTone}}' },
          { type: 'badge', text: '{{item.pText}}', tone: '{{item.pTone}}' },
        ] },
      ],
    };
    const filterRow = (label, chips) => ({ type: 'column', gap: 6, children: [
      txt(label, 'caption', '$onSurfaceVariant'),
      { type: 'hscroll', gap: 6, children: chips },
    ] });

    const kids = [];

    
    kids.push({ type: 'card', variant: 'outlined', gap: 8, children: [
      txt('模型列表 · ' + self, 'title3'),
      txt('共 ' + totalCh + ' 个渠道 / ' + totalModels + ' 个模型（同名合并后 ' + totalMerged + ' 个，跨 ' + insts.length + ' 个实例）', 'caption', '$onSurfaceVariant'),
      { type: 'row', gap: 8, children: [
        { type: 'metricTile', value: String(totalCh), label: '渠道', weight: 1 },
        { type: 'metricTile', value: String(totalMerged), label: '模型(合并)', weight: 1 },
        { type: 'metricTile', value: String(grpOpts.length), label: '分组', weight: 1 },
      ] },
      txt('本页由服务端渲染（服务端页面优先，失败自动回原生）。原生版入口：右上角「快速分组」；全回原生：设置页关掉「管理端使用服务端界面」。', 'caption', '$onSurfaceVariant'),
    ] });

    
    const kwTarget = 'page:' + mkUrl([
      ['inst', fInst], ['ch', fCh], ['price', fPrice], ['grp', fGrp], ['kw', '{{input.kw}}'], ['cols', String(cols)],
    ]);
    const fkids = [
      txt('筛选', 'title3'),
      { type: 'input', key: 'kw', label: '搜索模型名 / 别名（输入后按键盘的搜索键）', value: kw, leadingIcon: 'msym:search',
        submit: { type: 'open', target: kwTarget, nav: 'replace' } },
      { type: 'hscroll', gap: 6, children: [
        chip('全部', !filtered, jump({ inst: '', ch: '', price: '', grp: '', kw: '' })),
        chip('未定价', fPrice === 'none', jump({ price: 'none' })),
        chip('按次计费', fPrice === 'percall', jump({ price: 'percall' })),
        chip('有价格', fPrice === 'has', jump({ price: 'has' })),
        chip('无分组(Default)', fGrp === DEFAULT_GROUP, jump({ grp: DEFAULT_GROUP })),
      ] },
      filterRow('实例', [chip('全部', !fInst, jump({ inst: '' }))].concat(instOpts.map(n => chip(n, fInst === n, jump({ inst: n }))))),
      filterRow('渠道', [chip('全部', !fCh, jump({ ch: '' }))].concat(chOpts.map(n => chip(n, fCh === n, jump({ ch: n }))))),
      filterRow('价格', [
        chip('全部', !fPrice, jump({ price: '' })),
        chip('有价格', fPrice === 'has', jump({ price: 'has' })),
        chip('按次计费', fPrice === 'percall', jump({ price: 'percall' })),
        chip('未定价', fPrice === 'none', jump({ price: 'none' })),
      ]),
      filterRow('分组', [chip('全部', !fGrp, jump({ grp: '' }))].concat(grpOpts.map(n => chip(n, fGrp === n, jump({ grp: n }))))),
      txt('显示 ' + shown.length + ' / 共 ' + rows.length + ' 个模型'
        + (fCh ? '（已按渠道「' + fCh + '」展开：卡片是该渠道自己的分组/价格，点开或批量**只改这一条**）'
               : '（全库同名合并后 ' + totalMerged + ' 个；分组/价格不一致时会并排列出）')
        + (filtered ? ' · 已筛选' : '') + (showAll ? ' · **全部显示**模式' : ' · 单页 ' + lim + ' 个（越小越快）'), 'caption', '$onSurfaceVariant'),
    ];
    if (filtered) fkids.push({ type: 'hscroll', gap: 6, children: [
      chip('重置筛选', false, jump({ inst: '', ch: '', price: '', grp: '', kw: '' })),
    ] });
    kids.push({ type: 'card', variant: 'outlined', gap: 8, children: fkids });

    
    const viewChips = [
      txt('列数', 'caption', '$onSurfaceVariant'),
      chip('2', cols === 2, jump({ cols: '2' })),
      chip('3', cols === 3, jump({ cols: '3' })),
      chip('4', cols === 4, jump({ cols: '4' })),
    ];
    kids.push({ type: 'card', variant: 'outlined', gap: 8, children: [
      { type: 'row', gap: 6, children: viewChips },
      { type: 'hscroll', gap: 6, children: [
        chip('立即同步全部', false, Object.assign(syncCall({}), { confirm: '从上游拉取全部渠道的模型列表？' })),
        chip('同步设置', false, openPage('/admin/ui/plugin?pid=model-sync')),
        chip('分组管理', false, openPage('/admin/ui/model-groups')),
      ] },
    ] });

    



    kids.push({ type: 'card', variant: 'outlined', gap: 8, children: [
      txt('选中与操作', 'title3'),
      txt('勾选卡片右上角的方框、或**长按卡片** = 选中/取消该模型（切换筛选后已选仍保留；没有「全清」，逐个取消即可）。', 'caption', '$onSurfaceVariant'),
      { type: 'hscroll', gap: 6, children: [
        chip('批量操作 · 已选 {{selectedCount}} 个', false, openPage('/admin/ui/model-bulk')),
        chip('渠道一览', false, openPage('/admin/ui/model-channels')),
      ] },
    ] });

    
    kids.push(txt('模型（显示 ' + shown.length + ' / ' + rows.length
      + (rows.length > shown.length ? '，还有 ' + (rows.length - shown.length) + ' 个未显示' : '') + '）', 'title3'));
    if (!shown.length) {
      kids.push(txt(rows.length ? '（本页没有可显示的行）' : '没有符合筛选条件的模型。', 'body', '$onSurfaceVariant'));
    } else {
      kids.push({ type: 'list', items: '{{state.models}}', columns: cols, template: cardTpl });
      if (rows.length > shown.length || showAll) {
        const mv = [];
        if (rows.length > shown.length) {
          mv.push(chip('显示更多 +' + MODELS_LIMIT_STEP + '（还有 ' + (rows.length - shown.length) + ' 个）', false,
            { type: 'open', target: moreUrl, nav: 'replace' }));
          mv.push(chip('全部显示（' + rows.length + ' 个）', false, jump({ all: '1' })));
        } else if (showAll) {
          mv.push(chip('只看前 ' + MODELS_LIMIT_STEP + ' 个（更快）', false, jump({ all: '' })));
        }
        kids.push({ type: 'hscroll', gap: 6, children: mv });
      }
      if (shown.length > 100) {
        kids.push(txt('⚠ 正在一次渲染 ' + shown.length + ' 张卡：**切换筛选会明显变慢**（每次筛选都是整页重建）。'
          + '想跟手就用上面的筛选收窄，或点「只看前 ' + MODELS_LIMIT_STEP + ' 个」。', 'caption', '$error'));
      }
    }

    return {
      title: '模型分组',
      state: { models: shown, bulkGroup: grpOpts.length ? grpOpts[0] : DEFAULT_GROUP },
      root: { type: 'column', gap: 10, children: kids },
    };
  };

  


  const buildBulkPage = () => {
    refreshCfg();
    const txt = (text, style, color) => { const o = { type: 'text', text: text }; if (style) o.style = style; if (color) o.color = color; return o; };
    const gap = (h) => ({ type: 'spacer', height: h || 8 });
    const btn = (text, style, action) => { const o = { type: 'button', text: text, style: style }; if (action) o.action = action; return o; };
    const chip = (text, on, action) => { const o = { type: 'chip', text: text, selected: !!on }; if (action) o.action = action; return o; };
    const d = groupsData();
    const grpOpts = (d.groups || []).map(g => g.name);
    const sym = curSym();
    const call = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
      body: { plugin: 'model-square', path: '/admin/groups', method: 'POST', body: body } });
    const back = { type: 'open', target: 'page:/admin/ui/models', nav: 'pop' };
    return {
      title: '批量操作',
      state: { bulkGroup: grpOpts.length ? grpOpts[0] : DEFAULT_GROUP },
      root: { type: 'column', gap: 10, children: [
        txt('批量操作', 'title3'),
        txt('作用于「模型分组」页里勾选 / 长按选中的模型：当前已选 {{selectedCount}} 个。'
          + '选择跨页面、跨筛选保留；两个表单都是"提交才生效"。', 'caption', '$onSurfaceVariant'),
        { type: 'card', variant: 'outlined', gap: 8, children: [
          txt('设为分组', 'caption', '$onSurfaceVariant'),
          { type: 'segmented', key: 'bulkGroup', selected: '{{state.bulkGroup}}',
            options: grpOpts.map(g => ({ value: g, text: g })),
            action: { type: 'setState', patch: { bulkGroup: '{{input._value}}' } } },
          btn('把已选模型设为「{{state.bulkGroup}}」', 'filled',
            Object.assign(call({ action: 'bulk', group: '{{state.bulkGroup}}', items: '{{selected}}' }),
              { confirm: '把已选模型移到该分组？' })),
        ] },
        { type: 'card', variant: 'outlined', gap: 8, children: [
          txt('批量改价（' + sym + ' / 1M tokens）—— 空着的项会按 0 写入', 'caption', '$onSurfaceVariant'),
          { type: 'form', submitText: '应用改价到已选模型', fields: [
            { type: 'input', key: 'pIn', label: '输入', inputType: 'number', value: '0' },
            { type: 'input', key: 'pOut', label: '输出', inputType: 'number', value: '0' },
            { type: 'input', key: 'pCW', label: '缓存写入', inputType: 'number', value: '0' },
            { type: 'input', key: 'pCR', label: '缓存读取', inputType: 'number', value: '0' },
          ], submit: Object.assign(call({ action: 'bulk',
            price: { in: '{{form.pIn}}', out: '{{form.pOut}}', cacheWrite: '{{form.pCW}}', cacheRead: '{{form.pCR}}' },
            items: '{{selected}}' }), { confirm: '把上面这套价格应用到已选模型？' }) },
          gap(4),
          { type: 'form', submitText: '应用按次计费到已选模型', fields: [
            { type: 'input', key: 'pc', label: '按次价格（' + sym + ' / 次；留空提交 = 清除按次、回到按量）', inputType: 'number', value: '' },
          ], submit: Object.assign(call({ action: 'bulk', perCall: '{{form.pc}}', items: '{{selected}}' }),
            { confirm: '把该按次价格应用到已选模型？（留空 = 清除按次）' }) },
        ] },
        { type: 'hscroll', gap: 6, children: [
          chip('← 返回模型列表', false, back),
          chip('分组管理', false, { type: 'open', target: 'page:/admin/ui/model-groups', nav: 'push' }),
        ] },
      ] },
    };
  };

  
  const buildChannelsPage = () => {
    refreshCfg();
    const txt = (text, style, color) => { const o = { type: 'text', text: text }; if (style) o.style = style; if (color) o.color = color; return o; };
    const chip = (text, on, action) => { const o = { type: 'chip', text: text, selected: !!on }; if (action) o.action = action; return o; };
    const badge = (text, tone) => ({ type: 'badge', text: text, tone: tone });
    const enc2 = encodeURIComponent;
    const syncCall = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
      body: { plugin: 'model-sync', path: '/admin/run', method: 'POST', body: body } });
    const d = groupsData();
    const kids = [txt('渠道一览', 'title3'),
      txt('模型数 / 分组数按各实例口径；改名映射（modelMap）在渠道页编辑。', 'caption', '$onSurfaceVariant')];
    let n = 0;
    for (const it of (d.instances || [])) {
      const chs = it.channels || [];
      if (!chs.length) continue;
      kids.push(txt('实例 · ' + it.name + (it.current ? '（当前）' : ''), 'caption', '$onSurfaceVariant'));
      for (const ch of chs) {
        n++;
        const names = (ch.models || []).slice(0, 4).map(x => x.name).join(', ');
        const mapN = Number(ch.mapSize) || Object.keys(ch.maps || {}).length || 0;
        const mapText = (ch.maps && typeof ch.maps === 'object')
          ? Object.keys(ch.maps).slice(0, 8).map(k => k + ' → ' + ch.maps[k]).join('   ') : '';
        const cc = [
          txt(ch.name, 'title3'),
          { type: 'row', gap: 6, children: [
            badge((ch.models || []).length + ' 模型', (ch.models || []).length ? 'primary' : 'neutral'),
            badge(mapN + ' 分组', mapN ? 'success' : 'neutral'),
            badge(it.name, it.current ? 'primary' : 'neutral'),
          ] },
          txt((ch.models || []).length ? (names + ((ch.models || []).length > 4 ? ' … 共 ' + (ch.models || []).length + ' 个' : ''))
            : '还没有模型 —— 点「同步该渠道」从上游拉取', 'caption', '$onSurfaceVariant'),
        ];
        if (mapText) cc.push(txt(mapText, 'caption', '$onSurfaceVariant'));
        cc.push({ type: 'hscroll', gap: 6, children: [
          
          chip('看这个渠道的模型', false,
            { type: 'open', target: 'page:/admin/ui/models?inst=' + enc2(it.name) + '&ch=' + enc2(ch.name), nav: 'pop' }),
          chip('同步该渠道', false, Object.assign(syncCall({ channel: ch.name }), { confirm: '从上游同步渠道「' + ch.name + '」的模型列表？' })),
          chip('编辑渠道 / 改名映射', false, { type: 'open', target: 'page:/admin/ui/channel-edit?name=' + enc2(ch.name), nav: 'push' }),
        ] });
        kids.push({ type: 'card', variant: 'outlined', gap: 6, children: cc });
      }
    }
    if (!n) kids.push(txt('还没有渠道。', 'caption', '$onSurfaceVariant'));
    kids.push(chip('← 返回模型列表', false, { type: 'open', target: 'page:/admin/ui/models', nav: 'pop' }));
    return { title: '渠道一览', state: {}, root: { type: 'column', gap: 10, children: kids } };
  };

  
  const buildGroupManagePage = () => {
    refreshCfg();
    const txt = (text, style, color) => { const o = { type: 'text', text: text }; if (style) o.style = style; if (color) o.color = color; return o; };
    const gap = (h) => ({ type: 'spacer', height: h || 8 });
    const btn = (text, style, action) => { const o = { type: 'button', text: text, style: style }; if (action) o.action = action; return o; };
    const bad = (text, tone) => ({ type: 'badge', text: text, tone: tone });
    const call = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
      body: { plugin: 'model-square', path: '/admin/groups', method: 'POST', body: body } });
    const d = groupsData();
    const counts = d.counts || {};
    const kids = [txt('分组管理', 'title3'), txt('共 ' + (d.groups || []).length + ' 个分组 · 倍率用于「按分组计价」', 'caption', '$onSurfaceVariant')];
    for (const g of (d.groups || [])) {
      const gkids = [
        { type: 'row', gap: 6, children: [
          { type: 'text', text: g.name, style: 'body', weight: 1 },
          bad('×' + g.rate, g.name === DEFAULT_GROUP ? 'neutral' : 'primary'),
          bad((counts[g.name] || 0) + ' 个模型', 'neutral'),
        ] },
        { type: 'form', submitText: '改倍率', fields: [
          { type: 'input', key: 'rate_' + g.name, label: '计费倍率（1 = 不加价）', inputType: 'number', value: String(g.rate) },
        ], submit: call({ action: 'setGroupRate', name: g.name, rate: '{{form.rate_' + g.name + '}}' }) },
      ];
      if (g.name !== DEFAULT_GROUP) {
        gkids.push(btn('删除「' + g.name + '」', 'text', Object.assign(call({ action: 'removeGroup', name: g.name }),
          { confirm: '删除分组「' + g.name + '」？该分组的模型会回到 Default。' })));
      }
      kids.push({ type: 'card', variant: 'outlined', gap: 8, children: gkids });
    }
    kids.push(gap(4));
    kids.push({ type: 'card', variant: 'outlined', gap: 8, children: [
      txt('新建分组', 'title3'),
      { type: 'form', submitText: '创建分组', fields: [
        { type: 'input', key: 'gname', label: '分组名称', value: '' },
        { type: 'input', key: 'grate', label: '计费倍率（1 = 不加价）', inputType: 'number', value: '1' },
      ], submit: call({ action: 'addGroup', name: '{{form.gname}}', rate: '{{form.grate}}' }) },
    ] });
    return { title: '分组管理', state: {}, root: { type: 'column', gap: 10, children: kids } };
  };

  ctx.registerAdminUi({
    id: 'models',
    title: '模型分组',
    subtitle: '客户端名 → 上游名',
    icon: 'sort',
    menu: true,
    render: (gw, c, q) => buildModelsPage(q),
  });
  ctx.registerAdminUi({
    id: 'model-bulk',
    title: '批量操作',
    subtitle: '对已选模型批量改价 / 设分组',
    icon: 'edit',
    menu: false,
    render: () => buildBulkPage(),
  });
  ctx.registerAdminUi({
    id: 'model-channels',
    title: '渠道一览',
    subtitle: '各实例渠道与模型数',
    icon: 'apps',
    menu: false,
    render: () => buildChannelsPage(),
  });
  ctx.registerAdminUi({
    id: 'model-groups',
    title: '分组管理',
    subtitle: '模型分组的加减与计费倍率',
    icon: 'sort',
    menu: false,
    render: () => buildGroupManagePage(),
  });

  ctx.log('模型广场已激活 (bottomBar 页面 ui=/ui/square)');
};
