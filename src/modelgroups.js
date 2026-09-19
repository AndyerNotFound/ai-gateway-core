'use strict';

















const DEFAULT_GROUP = 'Default';


function prefixGroup(name) {
  const n = String(name == null ? '' : name).trim();
  const first = n.split(/[-_./: ]+/)[0];
  return first || n;
}






function buildIndex(store) {
  const declared = [];
  const meta = {};
  try {
    const c = store && store.getPluginConfig ? store.getPluginConfig('model-square', 0) : null;
    if (c) {
      if (Array.isArray(c.groups)) {
        for (const g of c.groups) {
          const n = g && g.name != null ? String(g.name) : '';
          if (n && !declared.includes(n)) declared.push(n);
        }
      }
      if (c.modelMeta && typeof c.modelMeta === 'object') {
        for (const k of Object.keys(c.modelMeta)) {
          const v = c.modelMeta[k];
          if (v && typeof v === 'object') meta[k] = v;
        }
      }
    }
  } catch (_) {  }

  
  const byModel = new Map();
  for (const k of Object.keys(meta)) {
    const parts = String(k).split('|');
    
    if (parts.length < 3) continue;
    const model = parts.slice(2).join('|');
    const g = meta[k].group;
    if (!model || !g) continue;
    if (!byModel.has(model)) byModel.set(model, new Set());
    byModel.get(model).add(String(g));
  }

  const groupsOf = (model) => {
    const s = byModel.get(String(model == null ? '' : model));
    if (s && s.size) return [...s];
    return [prefixGroup(model)];
  };

  
  const allGroups = (models) => {
    const out = declared.slice();
    const list = Array.isArray(models) ? models : [];
    const extra = new Set();
    for (const m of list) for (const g of groupsOf(m)) if (!out.includes(g)) extra.add(g);
    return out.concat([...extra].sort());
  };

  
  const matches = (model, groups) => {
    if (!Array.isArray(groups) || !groups.length) return true;
    const gs = groupsOf(model);
    return gs.some(g => groups.includes(g));
  };

  return { declared: declared.slice(), groupsOf, allGroups, matches };
}

module.exports = { buildIndex, prefixGroup, DEFAULT_GROUP };
