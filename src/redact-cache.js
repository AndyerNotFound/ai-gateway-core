/* redact-cache.js -- incremental chunk cache for privacy redaction (multi-level CDC)
 *
   * core idea: every chat request resends the full context, and most of it
   * identical to the previous request. Content-defined chunking (CDC) + a content-hash cache skip parts already verified
   * clean parts; only unseen/modified chunks actually run the regex filtering.
 *
   * multi-level splitting (user-specified):
 *   L1 whole-string hash -> a hit returns the original verbatim (zero copies / zero regex / zero CDC)
 *   L2 large: min 4K / max 64K / avg 16K
 *   L3 medium: min 1K / max 4K / avg 2K   (recursed when an L2 chunk misses)
 *   L4 small: min 256 / max 1K / avg 512 (recursed when an L3 chunk misses; smaller goes straight to regex)
 *   -> local edits invalidate only the tiny chunks that truly changed; the rest keep hitting the cache
 *
   * Two key techniques (both required):
   * 1. buzhash rolling (fixed 64B window) replacing Gear (unbounded memory):
 *    insertions/deletions affect only cut points within a ±64B window; drift spreads at most 1 chunk
   * 2. safe cut points: at a cut, inspect the OVERLAP=128 characters around it,
 *    when a regex match straddles a cut point -> the cut point moves back past the match's end,
 *    guaranteeing each secret lands wholly inside one chunk, so per-chunk regex runs miss no replacement
 *
   * content hash: two FNV-1a 32-bit hashes joined into 64 bits (fast; ~1e-10 collision odds at 50k entries)
   * cache: CLEAN markers (capped at 100k) + dirty-chunk replacement results (capped at 2000, chunks <=32K only)
 *
   * results may differ when the extra regex config changes -> auto-invalidation by fingerprint (or call reset())
   * (gateway.js's loadConfig() already calls reset())
 */
'use strict';

/** ---- buzhash random table: deterministically generated from a fixed seed ---- */
const BT = new Uint32Array(256);
{
  let seed = 0x12345678;
  for (let i = 0; i < 256; i++) {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    BT[i] = seed;
  }
}
const WINDOW = 64;         // the buzhash rolling window (bytes): position-independent cut decisions
const OVERLAP = 128;       // safe-cut-point inspection window (chars): > the longest secret pattern (~34)

/** ---- multi-level CDC parameters (characters) ---- */
const LEVELS = [
  { min: 4096,  max: 65536, mask: 0x3fff }, // L2: avg 16K
  { min: 1024,  max: 4096,  mask: 0x7ff },  // L3: avg 2K
  { min: 256,   max: 1024,  mask: 0x1ff },  // L4: avg 512
];
const MIN_TOP = LEVELS[0].min;

/** ---- FNV-1a 32-bit seeds (two different seeds = two independent 32-bit hashes) ---- */
const F1_SEED = 0x811c9dc5;
const F2_SEED = 0x01000193;

/** ---- regexes (identical to gateway.js's original logic) ---- */
const REDACT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}/g,            // OpenAI/DeepSeek/Anthropic style
  /\bgh[pou]_[A-Za-z0-9]{20,}/g,          // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,      // Slack
  /\bAKIA[0-9A-Z]{16}/g,                  // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g,            // Google
  /\bglpat-[A-Za-z0-9_-]{15,}/g,          // GitLab
  /\bhf_[A-Za-z0-9]{20,}/g,               // HuggingFace
  /\bBearer\s+[A-Za-z0-9._~-]{16,}/g,     // Bearer headers pasted into text
];
const SENSITIVE_PREFIXES = ['sk-', 'ghp_', 'gho_', 'ghu_', 'github_pat_', 'xox', 'AKIA', 'AIza', 'glpat-', 'hf_', 'Bearer'];

function compileRegexes(extra) {
  const list = REDACT_PATTERNS.slice();
  if (extra) for (const p of extra) { if (typeof p === 'string') { try { list.push(new RegExp(p, 'g')); } catch (_) {} } }
  return list;
}
function plainRedact(s, res) {
  for (const re of res) s = s.replace(re, '***');
  return s;
}

/** ---- Cache ---- */
const CLEAN = Symbol('clean');
const cleanCache = new Map();   // key(BigInt) → CLEAN
const dirtyCache = new Map();   // key(BigInt) -> replaced string
const CLEAN_MAX = 100000;
const DIRTY_MAX = 2000;
const DIRTY_MAX_LEN = 32768;    // results for dirty chunks longer than this are not cached (memory guard)

function trimCache(map, max) {
  if (map.size <= max) return;
  let del = map.size - max + (max >> 2); // evict below max with a 1/4 headroom
  for (const k of map.keys()) { if (del-- <= 0) break; map.delete(k); }
}

/** must be called whenever the (extra) config changes */
function reset() { cleanCache.clear(); dirtyCache.clear(); }
function stats() { return { clean: cleanCache.size, dirty: dirtyCache.size }; }

/** extra regex fingerprint: auto-reset on change, so calls with different extra never hit stale cache and skip filtering */
let lastExtraKey = null;
function extraFingerprint(extra) {
  if (!extra || !extra.length) return 0;
  let h = 0xdeadbeef;
  for (const p of extra) {
    if (typeof p !== 'string') continue;
    for (let i = 0; i < p.length; i++) h = (Math.imul(h ^ p.charCodeAt(i), 0x01000193)) >>> 0;
  }
  return h;
}

function keyOf(a, b) { return (BigInt(a) << 32n) | BigInt(b >>> 0); }
function rotl32(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

/** quick probe: does the window contain a sensitive prefix (skips regex when there is no extra) */
function quickSuspicious(win) {
  for (let i = 0; i < SENSITIVE_PREFIXES.length; i++) {
    if (win.indexOf(SENSITIVE_PREFIXES[i]) !== -1) return true;
  }
  return false;
}

/** safe cut point: if a match in [cutAt-OVERLAP, cutAt+OVERLAP) straddles cutAt,
   * then push the cut past the match end (up to 8 times), ensuring secrets never straddle a chunk boundary */
function safeCut(s, cutAt, res, hasExtra) {
  const O = OVERLAP;
  for (let guard = 0; guard < 8; guard++) {
    const ws = Math.max(0, cutAt - O), we = Math.min(s.length, cutAt + O);
    const win = s.slice(ws, we);
    if (!hasExtra && !quickSuspicious(win)) return cutAt; // the window has no sensitive traits; cut directly
    const off = cutAt - ws;
    let moved = false;
    for (let ri = 0; ri < res.length; ri++) {
      const re = res[ri];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(win)) !== null) {
        if (m.index < off && m.index + m[0].length > off) {
          cutAt = ws + m.index + m[0].length;
          moved = true;
          break;
        }
      }
      if (moved) break;
    }
    if (!moved) return cutAt;
  }
  return cutAt;
}

/** short strings (< the top-level min): hash the whole string -> return the original on hit; otherwise run regex and cache the result */
function lookupShort(s, extra, res) {
  let f1 = F1_SEED, f2 = F2_SEED;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    f1 = Math.imul(f1 ^ c, 0x01000193) >>> 0;
    f2 = Math.imul(f2 ^ c, 0x01000193) >>> 0;
  }
  const key = keyOf(f1, f2);
  if (cleanCache.has(key)) return s;
  const dirty = dirtyCache.get(key);
  if (dirty !== undefined) return dirty;
  const out = plainRedact(s, res);
  if (out === s) { cleanCache.set(key, CLEAN); return s; }
  if (s.length <= DIRTY_MAX_LEN) dirtyCache.set(key, out);
  trimCache(cleanCache, CLEAN_MAX);
  trimCache(dirtyCache, DIRTY_MAX);
  return out;
}

/** CDC-split [start, end) at this level (buzhash window rolling + safe cut points) while computing each chunk's dual FNV */
function cutChunks(s, start, end, level, res, hasExtra) {
  let h = 0;
  let cf1 = F1_SEED, cf2 = F2_SEED;
  let cs = start;
  const chunks = [];
  // buzhash window ring buffer
  const win = new Uint8Array(WINDOW);
  let wpos = 0, wcount = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    const b = c & 0xff;
    // buzhash rolling: h = rotl(h,1) ^ BT[b]; once the window fills, the oldest byte is rotated out
    h = rotl32(h, 1) ^ BT[b];
    if (wcount >= WINDOW) h ^= rotl32(BT[win[wpos]], WINDOW);
    else wcount++;
    win[wpos] = b;
    wpos = (wpos + 1) % WINDOW;
    // current chunk FNV
    cf1 = Math.imul(cf1 ^ c, 0x01000193) >>> 0;
    cf2 = Math.imul(cf2 ^ c, 0x01000193) >>> 0;
    // cut-point decision
    const pos = i + 1;
    const size = pos - cs;
    if (size >= level.min) {
      let cutAt = -1;
      if (size >= level.max) cutAt = pos;
      else if ((h & level.mask) === 0) cutAt = pos;
      if (cutAt > 0) {
        const safe = safeCut(s, cutAt, res, hasExtra);
        if (safe >= end) { // deferred to the block end: no cut, output whole
          chunks.push({ s: cs, e: end, f1: cf1, f2: cf2 });
          return chunks;
        }
        chunks.push({ s: cs, e: safe, f1: cf1, f2: cf2 });
        cs = safe; cf1 = F1_SEED; cf2 = F2_SEED;
      }
    }
  }
  if (cs < end) chunks.push({ s: cs, e: end, f1: cf1, f2: cf2 });
  return chunks;
}

/** process one chunk recursively: cache hit -> skip; miss -> drill into the smaller level; regex runs only at the bottom.
   * returns { text, allClean } */
function processChunk(s, start, end, extra, li, res, hasExtra) {
  const len = end - start;
  if (li >= LEVELS.length || len < LEVELS[li].min) {
    const sub = s.slice(start, end);
    const out = plainRedact(sub, res);
    return { text: out, allClean: out === sub };
  }
  const level = LEVELS[li];
  const chunks = cutChunks(s, start, end, level, res, hasExtra);
  let allClean = true;
  const parts = [];
  for (const c of chunks) {
    const k = keyOf(c.f1, c.f2);
    if (cleanCache.has(k)) { parts.push(s.slice(c.s, c.e)); continue; }
    const dirty = dirtyCache.get(k);
    if (dirty !== undefined) { parts.push(dirty); allClean = false; continue; }
    // miss -> recurse into the next level (smaller chunks)
    const sub = processChunk(s, c.s, c.e, extra, li + 1, res, hasExtra);
    if (sub.allClean) {
      cleanCache.set(k, CLEAN);
      parts.push(s.slice(c.s, c.e)); // zero copy
    } else {
      allClean = false;
      if (len <= DIRTY_MAX_LEN) dirtyCache.set(k, sub.text);
      parts.push(sub.text);
    }
  }
  trimCache(cleanCache, CLEAN_MAX);
  trimCache(dirtyCache, DIRTY_MAX);
  return { text: parts.join(''), allClean };
}

/** long strings (>= the top-level min): L1 whole-string hash -> multi-level CDC recursion */
function redactSmart(s, extra) {
  if (typeof s !== 'string' || s.length === 0) return s;
  const ek = extraFingerprint(extra);
  if (ek !== lastExtraKey) { reset(); lastExtraKey = ek; }
  const len = s.length;
  const hasExtra = !!(extra && extra.length);
  const res = compileRegexes(extra);
  if (len < MIN_TOP) return lookupShort(s, extra, res);

  // ---- L1: whole-string double FNV (cheap scan); a hit returns the original reference ----
  let f1 = F1_SEED, f2 = F2_SEED;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    f1 = Math.imul(f1 ^ c, 0x01000193) >>> 0;
    f2 = Math.imul(f2 ^ c, 0x01000193) >>> 0;
  }
  const allKey = keyOf(f1, f2);
  if (cleanCache.has(allKey)) return s;

  const res2 = processChunk(s, 0, len, extra, 0, res, hasExtra);
  if (res2.allClean) { cleanCache.set(allKey, CLEAN); return s; }
  return res2.text;
}

module.exports = { redactSmart, reset, stats, LEVELS, MIN_CHUNK: MIN_TOP };
