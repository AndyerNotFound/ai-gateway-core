

























'use strict';


const BT = new Uint32Array(256);
{
  let seed = 0x12345678;
  for (let i = 0; i < 256; i++) {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    BT[i] = seed;
  }
}
const WINDOW = 64;         
const OVERLAP = 128;       


const LEVELS = [
  { min: 4096,  max: 65536, mask: 0x3fff }, 
  { min: 1024,  max: 4096,  mask: 0x7ff },  
  { min: 256,   max: 1024,  mask: 0x1ff },  
];
const MIN_TOP = LEVELS[0].min;


const F1_SEED = 0x811c9dc5;
const F2_SEED = 0x01000193;


const REDACT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}/g,            
  /\bgh[pou]_[A-Za-z0-9]{20,}/g,          
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,      
  /\bAKIA[0-9A-Z]{16}/g,                  
  /\bAIza[0-9A-Za-z_-]{30,}/g,            
  /\bglpat-[A-Za-z0-9_-]{15,}/g,          
  /\bhf_[A-Za-z0-9]{20,}/g,               
  /\bBearer\s+[A-Za-z0-9._~-]{16,}/g,     
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


const CLEAN = Symbol('clean');
const cleanCache = new Map();   
const dirtyCache = new Map();   
const CLEAN_MAX = 100000;
const DIRTY_MAX = 2000;
const DIRTY_MAX_LEN = 32768;    

function trimCache(map, max) {
  if (map.size <= max) return;
  let del = map.size - max + (max >> 2); 
  for (const k of map.keys()) { if (del-- <= 0) break; map.delete(k); }
}


function reset() { cleanCache.clear(); dirtyCache.clear(); }
function stats() { return { clean: cleanCache.size, dirty: dirtyCache.size }; }


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


function quickSuspicious(win) {
  for (let i = 0; i < SENSITIVE_PREFIXES.length; i++) {
    if (win.indexOf(SENSITIVE_PREFIXES[i]) !== -1) return true;
  }
  return false;
}



function safeCut(s, cutAt, res, hasExtra) {
  const O = OVERLAP;
  for (let guard = 0; guard < 8; guard++) {
    const ws = Math.max(0, cutAt - O), we = Math.min(s.length, cutAt + O);
    const win = s.slice(ws, we);
    if (!hasExtra && !quickSuspicious(win)) return cutAt; 
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


function cutChunks(s, start, end, level, res, hasExtra) {
  let h = 0;
  let cf1 = F1_SEED, cf2 = F2_SEED;
  let cs = start;
  const chunks = [];
  
  const win = new Uint8Array(WINDOW);
  let wpos = 0, wcount = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    const b = c & 0xff;
    
    h = rotl32(h, 1) ^ BT[b];
    if (wcount >= WINDOW) h ^= rotl32(BT[win[wpos]], WINDOW);
    else wcount++;
    win[wpos] = b;
    wpos = (wpos + 1) % WINDOW;
    
    cf1 = Math.imul(cf1 ^ c, 0x01000193) >>> 0;
    cf2 = Math.imul(cf2 ^ c, 0x01000193) >>> 0;
    
    const pos = i + 1;
    const size = pos - cs;
    if (size >= level.min) {
      let cutAt = -1;
      if (size >= level.max) cutAt = pos;
      else if ((h & level.mask) === 0) cutAt = pos;
      if (cutAt > 0) {
        const safe = safeCut(s, cutAt, res, hasExtra);
        if (safe >= end) { 
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
    
    const sub = processChunk(s, c.s, c.e, extra, li + 1, res, hasExtra);
    if (sub.allClean) {
      cleanCache.set(k, CLEAN);
      parts.push(s.slice(c.s, c.e)); 
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


function redactSmart(s, extra) {
  if (typeof s !== 'string' || s.length === 0) return s;
  const ek = extraFingerprint(extra);
  if (ek !== lastExtraKey) { reset(); lastExtraKey = ek; }
  const len = s.length;
  const hasExtra = !!(extra && extra.length);
  const res = compileRegexes(extra);
  if (len < MIN_TOP) return lookupShort(s, extra, res);

  
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
