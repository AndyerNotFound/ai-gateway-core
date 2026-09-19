'use strict';
















const SEP = ':';





function tokenize(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, '-');
}


function makeRef(instance, channel, model) {
  const p = [tokenize(instance), tokenize(channel), String(model == null ? '' : model)];
  if (!p[0] || !p[1] || !p[2]) return '';
  return p.join(SEP);
}


function makeRefRaw(instance, channel, model) {
  const p = [instance, channel, model].map(x => String(x == null ? '' : x));
  if (!p[0] || !p[1] || !p[2]) return '';
  return p.join(SEP);
}



function parseRef(s) {
  const t = String(s == null ? '' : s);
  const i = t.indexOf(SEP);
  if (i <= 0) return null;
  const j = t.indexOf(SEP, i + 1);
  if (j <= i + 1 || j >= t.length - 1) return null;
  return { instance: t.slice(0, i), channel: t.slice(i + 1, j), model: t.slice(j + 1) };
}




function channelMatch(wantCh, chName) {
  const a = String(wantCh == null ? '' : wantCh);
  const b = String(chName == null ? '' : chName);
  if (a === b) return true;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const norm = (x) => x.toLowerCase().replace(/[\s_\-]+/g, '');
  return norm(a) === norm(b) && norm(a).length > 0;
}










function buildRefs(instances) {
  const list = Array.isArray(instances) ? instances : [];
  
  const instTok = new Map();                        
  for (const inst of list) {
    if (!inst || !inst.name) continue;
    const t = tokenize(inst.name);
    if (instTok.has(t) && instTok.get(t) !== inst.name) instTok.set(t, null);
    else if (!instTok.has(t)) instTok.set(t, inst.name);
  }
  const chTok = new Map();                          
  for (const inst of list) {
    if (!inst || !inst.name) continue;
    for (const ch of (Array.isArray(inst.channels) ? inst.channels : [])) {
      if (!ch || !ch.name) continue;
      const k = tokenize(inst.name) + '\u0000' + tokenize(ch.name);
      if (chTok.has(k) && chTok.get(k) !== ch.name) chTok.set(k, null);
      else if (!chTok.has(k)) chTok.set(k, ch.name);
    }
  }
  const instLabel = (n) => (instTok.get(tokenize(n)) === n ? tokenize(n) : String(n));
  const chLabel = (iName, cName) => {
    const k = tokenize(iName) + '\u0000' + tokenize(cName);
    return (chTok.get(k) === cName ? tokenize(cName) : String(cName));
  };

  
  const occ = [];                       
  const seen = new Set();
  for (const inst of list) {
    if (!inst || !inst.name) continue;
    for (const ch of (Array.isArray(inst.channels) ? inst.channels : [])) {
      if (!ch || !ch.name) continue;
      const names = [];
      for (const m of (Array.isArray(ch.models) ? ch.models : [])) if (m) names.push(String(m));
      const mm = (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {};
      for (const k of Object.keys(mm)) if (k && !names.includes(k)) names.push(String(k));
      for (const m of names) {
        const key = String(inst.name) + '\u0000' + String(ch.name) + '\u0000' + m;
        if (seen.has(key)) continue;
        seen.add(key);
        occ.push({ instance: String(inst.name), channel: String(ch.name), model: m });
      }
    }
  }
  const count = new Map();
  for (const o of occ) count.set(o.model, (count.get(o.model) || 0) + 1);
  const conflicts = [...count.keys()].filter(m => count.get(m) > 1).sort();
  const conflictSet = new Set(conflicts);
  const entries = occ.map(o => {
    const composite = conflictSet.has(o.model);
    return {
      id: composite ? [instLabel(o.instance), chLabel(o.instance, o.channel), o.model].join(SEP) : o.model,
      plain: o.model,
      instance: o.instance,
      channel: o.channel,
      model: o.model,
      composite,
    };
  });
  return { entries, conflicts };
}



function filterEntries(entries, userKey, groupIndex) {
  const list = Array.isArray(entries) ? entries : [];
  if (!userKey) return list;
  const ms = Array.isArray(userKey.models) ? userKey.models : [];
  const gs = Array.isArray(userKey.groups) ? userKey.groups : [];
  if (!ms.length && !gs.length) return list;
  return list.filter(e => {
    if (ms.length && !ms.includes(e.id) && !ms.includes(e.plain)) return false;
    if (gs.length && !(groupIndex && groupIndex.matches ? groupIndex.matches(e.plain, gs) : true)) return false;
    return true;
  });
}

module.exports = { SEP, tokenize, makeRef, makeRefRaw, parseRef, channelMatch, buildRefs, filterEntries };
