'use strict';
/* modelref.js -- "instance:channel:model" model references (user-requested 2026-09-18)
 *
 * Why it exists: `/v1/models` is a **site-wide, deduplicated-by-model-name** list -- same-named models (e.g. deepseek-v4-pro
 *   present on default/fake, DeepSeek/DeepSeek Official, and SenseNova-Router/SenseNova Router alike)
 *   appear as one entry, so the client **cannot specify "which source I want"**; when forwarding, the core can only guess by "default first / other instances first-come-first-served",
 *   which users reported as "same-named models overwriting each other".
 *
   * scheme (user decision 2026-09-18 = plan B): **only name-conflicted models** get the id `instance:channel:model`,
 *   the rest keep their original names; **original names keep working** (backward compatible -- old clients and issued card-key whitelists are unaffected).
 *
 * The separator is ':' -- RFC 3986 allows ':' inside path segments, so Gemini's
 *   `/v1beta/models/<ref>:generateContent` still works (the core changed its regex from `[^:]+` to greedy `.+`,
 *   splitting the method name at the **last** colon). A model name containing ':' is also safe: parsing takes only the first two segments as instance/channel,
 *   and re-joins **everything** remaining into the model name.
 */

const SEP = ':';

/** instance/channel name -> public token: **whitespace uniformly replaced with hyphens** (2026-09-18 user request)
 *  `DeepSeek Official` → `DeepSeek-Official`、`MotoMoto 2` → `MotoMoto-2`。
   *  why: spaces get eaten or mis-encoded most easily in URLs / command lines / various clients; hyphens are the least troublesome.
   *  *the model name is **never** replaced (it must go upstream verbatim). */
function tokenize(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, '-');
}

/** join a reference (public id). Any empty segment -> returns '' (callers read that as "no reference") */
function makeRef(instance, channel, model) {
  const p = [tokenize(instance), tokenize(channel), String(model == null ? '' : model)];
  if (!p[0] || !p[1] || !p[2]) return '';
  return p.join(SEP);
}

/** join a reference (original whitespace preserved; for internal troubleshooting/logging) */
function makeRefRaw(instance, channel, model) {
  const p = [instance, channel, model].map(x => String(x == null ? '' : x));
  if (!p[0] || !p[1] || !p[2]) return '';
  return p.join(SEP);
}

/** split a reference: the first two segments = instance/channel; everything after = the model name.
   *  returning null = "not a legal three-segment reference" (callers treat it as an ordinary model name). */
function parseRef(s) {
  const t = String(s == null ? '' : s);
  const i = t.indexOf(SEP);
  if (i <= 0) return null;
  const j = t.indexOf(SEP, i + 1);
  if (j <= i + 1 || j >= t.length - 1) return null;
  return { instance: t.slice(0, i), channel: t.slice(i + 1, j), model: t.slice(j + 1) };
}

/** lenient instance/channel name comparison: exact -> case-insensitive -> **spaces / underscores / hyphens treated as equal**
   *  (clients may write `DeepSeek Official` as `DeepSeek-Official`, `DeepSeek_Official`, or `deepseekofficial`)
   *  *fall back only when exact matching fails, so normal channels whose names legitimately contain hyphens are not misjudged. */
function channelMatch(wantCh, chName) {
  const a = String(wantCh == null ? '' : wantCh);
  const b = String(chName == null ? '' : chName);
  if (a === b) return true;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const norm = (x) => x.toLowerCase().replace(/[\s_\-]+/g, '');
  return norm(a) === norm(b) && norm(a).length > 0;
}

/**
   * computes /v1/models's id list from the "instance list".
   * @param {Array} instances [{ name, channels: [{ name, models: [], modelMap: {} }] }] (already clipped by card instance whitelists and sorted by the caller)
 * @returns {{ entries: Array, conflicts: Array }}
 *   entries: [{ id, plain, instance, channel, model, composite }] -- id is the externally exposed name
 *   conflicts: list of **original model names** that collide (handy for logs/debugging)
   * *token-conflict protection: if the hyphen-swapped form would collide with **another channel name in the same instance** (or another instance name),
 *   those names revert to the original spelling -- better to keep a space than let two different channels map to one id.
 */
function buildRefs(instances) {
  const list = Array.isArray(instances) ? instances : [];
  /* 1) token conflict detection (instance-level + channel-level within an instance) */
  const instTok = new Map();                        // token -> original name (marked null when several originals collide on one token)
  for (const inst of list) {
    if (!inst || !inst.name) continue;
    const t = tokenize(inst.name);
    if (instTok.has(t) && instTok.get(t) !== inst.name) instTok.set(t, null);
    else if (!instTok.has(t)) instTok.set(t, inst.name);
  }
  const chTok = new Map();                          // "instanceToken\u0000channelToken" -> original name or null
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

  /* 2) collect the (instance, channel, model) triples */
  const occ = [];                       // in traversal order
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

/** filter entries by the card whitelist: whitelists match **original** or **composite** names (backward compatible);
   *  group whitelists always look up groups by the **original name**. */
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
