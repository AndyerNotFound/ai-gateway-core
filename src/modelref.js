'use strict';
/* modelref.js — 「实例:渠道:模型」模型引用（2026-09-18 用户提出）
 *
 * 为什么需要: `/v1/models` 是**全站按模型名去重**的清单 —— 同名模型（例如 deepseek-v4-pro
 *   在 default/fake、DeepSeek/DeepSeek Official、SenseNova-Router/SenseNova Router 各有一份）
 *   只列一条，客户端**无法指定"要哪个来源"**，转发时只能由内核按 "default 优先 / 其余实例先到先得"
 *   去猜 → 用户报「以防同名模型覆盖」。
 *
 * 方案（用户 2026-09-18 拍板 = 方案 B）: **只有同名冲突的模型**才把 id 变成 `实例:渠道:模型名`，
 *   其余保持原名；**原名继续可用**（向后兼容，老客户端与已发卡密白名单都不受影响）。
 *
 * 分隔符用 ':' —— RFC 3986 允许 path 段里出现 ':'，所以 Gemini 的
 *   `/v1beta/models/<ref>:generateContent` 也能用（内核那边把正则的 `[^:]+` 改成贪婪 `.+`，
 *   由**最后一个**冒号切出方法名）。模型名自己含 ':' 也安全: 解析时只取前两段当实例/渠道，
 *   剩下**全部**拼回模型名。
 */

const SEP = ':';

/** 实例/渠道名 → 对外 token：**空白统一换成连字符**（2026-09-18 用户要求）
 *  `DeepSeek Official` → `DeepSeek-Official`、`MotoMoto 2` → `MotoMoto-2`。
 *  为什么: 空格在 URL / 命令行 / 各种客户端里最容易被吃掉或编码错，连字符最省心。
 *  ★模型名**不做**替换（它要原样发给上游）。 */
function tokenize(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, '-');
}

/** 拼引用（对外 id）。任一段为空 → 返回 ''（调用方视为"没有引用"） */
function makeRef(instance, channel, model) {
  const p = [tokenize(instance), tokenize(channel), String(model == null ? '' : model)];
  if (!p[0] || !p[1] || !p[2]) return '';
  return p.join(SEP);
}

/** 拼引用（保留原始空白，内部排查/日志用） */
function makeRefRaw(instance, channel, model) {
  const p = [instance, channel, model].map(x => String(x == null ? '' : x));
  if (!p[0] || !p[1] || !p[2]) return '';
  return p.join(SEP);
}

/** 拆引用: 前两段 = 实例/渠道, 其余全部 = 模型名。
 *  返回 null 表示"这不是一个合法的三段引用"(调用方就当普通模型名处理)。 */
function parseRef(s) {
  const t = String(s == null ? '' : s);
  const i = t.indexOf(SEP);
  if (i <= 0) return null;
  const j = t.indexOf(SEP, i + 1);
  if (j <= i + 1 || j >= t.length - 1) return null;
  return { instance: t.slice(0, i), channel: t.slice(i + 1, j), model: t.slice(j + 1) };
}

/** 实例/渠道名宽松比对：精确 → 忽略大小写 → **空白 / 下划线 / 连字符 视为等价**
 *  （客户端可能把 `DeepSeek Official` 写成 `DeepSeek-Official`、`DeepSeek_Official` 或 `deepseekofficial`）
 *  ★只有精确匹配失败才回退，避免"名字本来就带连字符"的正常渠道被误判。 */
function channelMatch(wantCh, chName) {
  const a = String(wantCh == null ? '' : wantCh);
  const b = String(chName == null ? '' : chName);
  if (a === b) return true;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const norm = (x) => x.toLowerCase().replace(/[\s_\-]+/g, '');
  return norm(a) === norm(b) && norm(a).length > 0;
}

/**
 * 由「实例清单」算出 /v1/models 的 id 列表。
 * @param {Array} instances [{ name, channels: [{ name, models: [], modelMap: {} }] }]（调用方已按卡密实例白名单裁剪、已排序）
 * @returns {{ entries: Array, conflicts: Array }}
 *   entries: [{ id, plain, instance, channel, model, composite }] —— id 为对外暴露的名字
 *   conflicts: 同名冲突的**原始模型名**列表（便于日志/排查）
 * ★token 冲突保护：如果"换连字符之后"会和**同实例里另一个渠道名**（或另一个实例名）撞名，
 *   那些名字就退回原始写法 —— 宁可留空格，也不能让两个不同的渠道映射到同一个 id。
 */
function buildRefs(instances) {
  const list = Array.isArray(instances) ? instances : [];
  /* 1) token 冲突检测（实例级 + 同实例内渠道级） */
  const instTok = new Map();                        // token → 原始名（多个原始名撞同一 token 时标记为 null）
  for (const inst of list) {
    if (!inst || !inst.name) continue;
    const t = tokenize(inst.name);
    if (instTok.has(t) && instTok.get(t) !== inst.name) instTok.set(t, null);
    else if (!instTok.has(t)) instTok.set(t, inst.name);
  }
  const chTok = new Map();                          // "实例token\u0000渠道token" → 原始名 或 null
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

  /* 2) 收集 (实例, 渠道, 模型) 三元组 */
  const occ = [];                       // 按遍历顺序
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

/** 按卡密白名单过滤 entries：白名单里写**原名**或**复合名**都能命中（向后兼容）；
 *  分组白名单一律用**原名**去查分组。 */
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
