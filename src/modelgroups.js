'use strict';
/** modelgroups.js - the model group index (2026-09-13)
 *
   * purpose: resolve "a model name" into "which groups it belongs to".
 *   (1) card-key "group whitelist" checks (auth-cardkey's onChatAuth hook)
 *   (2) /v1/models filtering by group + aggregation routing
 *   (3) the login-free public model endpoint /api/app/models
 *
   * group sources (by priority):
 *   1) modelMeta from the model-square plugin config -- key "instance|channel|model" -> { group }
 *      i.e. the group the admin explicitly set in "quick groups" (authoritative).
 *   2) name-prefix inference -- gpt-4o -> gpt / claude-3-5 -> claude
 *
   * group list order: model-square's declared groups first (fixed order, stable numbering), inferred ones appended.
 *
 * Note: this module is pure computation, no caching -- the caller (Gateway) caches by TTL itself, avoiding a disk read per request.
 */

const DEFAULT_GROUP = 'Default';

/** name-prefix grouping: gpt-4o -> gpt ; claude-3-5-sonnet -> claude */
function prefixGroup(name) {
  const n = String(name == null ? '' : name).trim();
  const first = n.split(/[-_./: ]+/)[0];
  return first || n;
}

/**
   * build the group index.
   * @param {object} store the kernel Store instance
   * @param {object} [src] *2026-10-07 deep refactor: the group data source. A capability object (with allMeta()/groups()) may be passed,
 *   When omitted it falls back to reading the store -- keeping existing call sites working. The core no longer must know "groups come from model-square".
 * @returns {{declared:string[], groupsOf:function, allGroups:function, matches:function}}
 */
function buildIndex(store, src) {
  const declared = [];
  const meta = {};
  try {
    /* *capability first: whoever provides model-pricing (incl. groups/allMeta) is used; unavailable -> the old path */
    let c = null;
    if (src && typeof src === 'object') {
      const mm = (typeof src.allMeta === 'function') ? src.allMeta() : null;
      const gs = (typeof src.groups === 'function') ? src.groups() : [];
      c = { modelMeta: mm || {}, groups: Array.isArray(gs) ? gs : [] };
    } else if (store && store.getPluginConfig) {
      c = store.getPluginConfig('model-square', 0);
    }
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
  } catch (_) { /* model-square absent/unconfigured -> prefix inference only */ }

  /** model -> Set<group> (explicitly declared ones only) */
  const byModel = new Map();
  for (const k of Object.keys(meta)) {
    const parts = String(k).split('|');
    /* Key format "instance|channel|model" -- the model name itself may contain '|', so everything from the 3rd segment on is re-joined */
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

  /** All available groups: declared ones first, the rest (needs the model list passed in) appended in lexicographic order */
  const allGroups = (models) => {
    const out = declared.slice();
    const list = Array.isArray(models) ? models : [];
    const extra = new Set();
    for (const m of list) for (const g of groupsOf(m)) if (!out.includes(g)) extra.add(g);
    return out.concat([...extra].sort());
  };

  /** Whether model falls inside the groups whitelist (empty groups = unrestricted) */
  const matches = (model, groups) => {
    if (!Array.isArray(groups) || !groups.length) return true;
    const gs = groupsOf(model);
    return gs.some(g => groups.includes(g));
  };

  return { declared: declared.slice(), groupsOf, allGroups, matches };
}

module.exports = { buildIndex, prefixGroup, DEFAULT_GROUP };
