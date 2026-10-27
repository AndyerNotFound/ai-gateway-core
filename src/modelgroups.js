'use strict';
/* modelgroups.js - 模型分组索引 (2026-09-13)
 *
 * 作用: 把「模型名」解析成「它属于哪些分组」。
 *   ① 卡密「分组白名单」校验 (auth-cardkey 的 onChatAuth 钩子)
 *   ② /v1/models 按分组过滤 + 聚合路由
 *   ③ 免登录公开模型接口 /api/app/models
 *
 * 分组来源(优先级):
 *   1) model-square 插件配置里的 modelMeta —— 键 "实例|渠道|模型" → { group }
 *      即管理员在「快速分组」里显式指定的分组(权威)。
 *   2) 名称前缀推导 —— gpt-4o → gpt / claude-3-5 → claude
 *
 * 分组列表顺序: model-square 声明的 groups 在前(固定顺序, 编号稳定), 推导出来的补在后面。
 *
 * 注意: 本模块只做纯计算, 不做缓存 —— 调用方(Gateway)自行按 TTL 缓存, 避免每请求读盘。
 */

const DEFAULT_GROUP = 'Default';

/** 名称前缀分组: gpt-4o → gpt ; claude-3-5-sonnet → claude */
function prefixGroup(name) {
  const n = String(name == null ? '' : name).trim();
  const first = n.split(/[-_./: ]+/)[0];
  return first || n;
}

/**
 * 构建分组索引。
 * @param {object} store 内核 Store 实例
 * @param {object} [src] ★2026-10-07 深度改造: 分组数据源。可传能力对象(含 allMeta()/groups()),
 *   不传则回退读 store —— 兼容既有调用点。内核因此不再必须知道"分组由 model-square 提供"。
 * @returns {{declared:string[], groupsOf:function, allGroups:function, matches:function}}
 */
function buildIndex(store, src) {
  const declared = [];
  const meta = {};
  try {
    /* ★能力优先: 谁提供 model-pricing(含 groups/allMeta) 就用谁; 拿不到 → 回退旧路径 */
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
  } catch (_) { /* model-square 未装/未配置 → 只用前缀推导 */ }

  /** model → Set<group> (只含显式声明的) */
  const byModel = new Map();
  for (const k of Object.keys(meta)) {
    const parts = String(k).split('|');
    /* 键格式 "实例|渠道|模型" —— 模型名本身可能含 '|', 所以从第 3 段起整体拼回 */
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

  /** 全部可用分组: 声明的在前, 其余(需传入模型清单)按字典序补 */
  const allGroups = (models) => {
    const out = declared.slice();
    const list = Array.isArray(models) ? models : [];
    const extra = new Set();
    for (const m of list) for (const g of groupsOf(m)) if (!out.includes(g)) extra.add(g);
    return out.concat([...extra].sort());
  };

  /** model 是否落在 groups 白名单里 (groups 空 = 不限) */
  const matches = (model, groups) => {
    if (!Array.isArray(groups) || !groups.length) return true;
    const gs = groupsOf(model);
    return gs.some(g => groups.includes(g));
  };

  return { declared: declared.slice(), groupsOf, allGroups, matches };
}

module.exports = { buildIndex, prefixGroup, DEFAULT_GROUP };
