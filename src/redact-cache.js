/* redact-cache.js — 隐私过滤的增量分块缓存(多级 CDC)
 *
 * 核心思路: 对话请求每次都会把完整上下文重发一遍, 其中绝大多数内容
 * 与上次请求相同。用「内容定义分块(CDC) + 内容 hash 缓存」跳过已确认
 * 干净的部分, 只有没见过的/被修改过的块才真正跑正则过滤。
 *
 * 多级切割(用户指定):
 *   L1 整串 hash → 命中直接原样返回(零复制/零正则/零 CDC)
 *   L2 大块: min 4K / max 64K / avg 16K
 *   L3 中块: min 1K / max 4K / avg 2K   (L2 块未命中时递归)
 *   L4 小块: min 256 / max 1K / avg 512 (L3 块未命中时递归, 再小直接正则)
 *   → 局部修改只让「真正变化的微小块」失效, 其余块照常命中缓存
 *
 * 两个关键技术点(缺一不可):
 * 1. buzhash 滚动(固定 64B 窗口)替代 Gear(无限记忆):
 *    插入/删除只影响 ±64B 窗口内的切点, 错位传播 ≤1 块
 * 2. 安全切点 safeCut: 切点处检查前后 OVERLAP=128 字符,
 *    若有正则 match 横跨切点 → 切点后延到 match 结束,
 *    保证密钥完整落在单块内, 每块独立跑正则不漏替换
 *
 * 内容 hash: 双 FNV-1a 32 位拼 64 位(计算快; 5 万条碰撞概率 ~1e-10)
 * 缓存: CLEAN 标记(上限 10 万) + 脏块替换结果(上限 2000, 仅 ≤32K 的块)
 *
 * ⚠️ extra 正则配置变化时结果可能不同 → 自动按指纹失效(或调用 reset())
 * (gateway.js 的 loadConfig() 已自动调用 reset())
 */
'use strict';

/* ---- buzhash 随机表: 固定种子确定性生成 ---- */
const BT = new Uint32Array(256);
{
  let seed = 0x12345678;
  for (let i = 0; i < 256; i++) {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    BT[i] = seed;
  }
}
const WINDOW = 64;         // buzhash 滚动窗口(字节): 切点判定位置无关
const OVERLAP = 128;       // 安全切点检查范围(字符): > 最长密钥模式(~34)

/* ---- 多级 CDC 参数(字符) ---- */
const LEVELS = [
  { min: 4096,  max: 65536, mask: 0x3fff }, // L2: avg 16K
  { min: 1024,  max: 4096,  mask: 0x7ff },  // L3: avg 2K
  { min: 256,   max: 1024,  mask: 0x1ff },  // L4: avg 512
];
const MIN_TOP = LEVELS[0].min;

/* ---- FNV-1a 32 种子(两个不同种子 = 两个独立 32 位 hash) ---- */
const F1_SEED = 0x811c9dc5;
const F2_SEED = 0x01000193;

/* ---- 正则(与 gateway.js 原逻辑完全一致) ---- */
const REDACT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}/g,            // OpenAI/DeepSeek/Anthropic 风格
  /\bgh[pou]_[A-Za-z0-9]{20,}/g,          // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,      // Slack
  /\bAKIA[0-9A-Z]{16}/g,                  // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g,            // Google
  /\bglpat-[A-Za-z0-9_-]{15,}/g,          // GitLab
  /\bhf_[A-Za-z0-9]{20,}/g,               // HuggingFace
  /\bBearer\s+[A-Za-z0-9._~-]{16,}/g,     // 文本里粘贴的 Bearer 头
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

/* ---- 缓存 ---- */
const CLEAN = Symbol('clean');
const cleanCache = new Map();   // key(BigInt) → CLEAN
const dirtyCache = new Map();   // key(BigInt) → 替换后字符串
const CLEAN_MAX = 100000;
const DIRTY_MAX = 2000;
const DIRTY_MAX_LEN = 32768;    // 超过此长度的脏块不缓存结果(防内存)

function trimCache(map, max) {
  if (map.size <= max) return;
  let del = map.size - max + (max >> 2); // 删到 max 之下再留 1/4 余量
  for (const k of map.keys()) { if (del-- <= 0) break; map.delete(k); }
}

/* 配置(extra)变化时必须调用 */
function reset() { cleanCache.clear(); dirtyCache.clear(); }
function stats() { return { clean: cleanCache.size, dirty: dirtyCache.size }; }

/* extra 正则指纹: 变化时自动 reset, 防止带不同 extra 的调用命中旧缓存漏过滤 */
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

/* 快速探测: 窗口里有没有敏感前缀(无 extra 时避免跑正则) */
function quickSuspicious(win) {
  for (let i = 0; i < SENSITIVE_PREFIXES.length; i++) {
    if (win.indexOf(SENSITIVE_PREFIXES[i]) !== -1) return true;
  }
  return false;
}

/* 安全切点: 若 [cutAt-OVERLAP, cutAt+OVERLAP) 内有 match 横跨 cutAt,
 * 则把切点后延到 match 结束(最多 8 次), 保证密钥不横跨块边界 */
function safeCut(s, cutAt, res, hasExtra) {
  const O = OVERLAP;
  for (let guard = 0; guard < 8; guard++) {
    const ws = Math.max(0, cutAt - O), we = Math.min(s.length, cutAt + O);
    const win = s.slice(ws, we);
    if (!hasExtra && !quickSuspicious(win)) return cutAt; // 窗口无敏感特征, 直接切
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

/* 短串(< 顶层 min): 整串 hash → 命中返回原引用; 未命中跑正则并缓存结果 */
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

/* 对 [start, end) 范围做该层 CDC 切块(buzhash 窗口滚动 + 安全切点), 同时算每块双 FNV */
function cutChunks(s, start, end, level, res, hasExtra) {
  let h = 0;
  let cf1 = F1_SEED, cf2 = F2_SEED;
  let cs = start;
  const chunks = [];
  // buzhash 窗口环形缓冲
  const win = new Uint8Array(WINDOW);
  let wpos = 0, wcount = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    const b = c & 0xff;
    // buzhash 滚动: h = rotl(h,1) ^ BT[b], 窗口满后移出最旧字节
    h = rotl32(h, 1) ^ BT[b];
    if (wcount >= WINDOW) h ^= rotl32(BT[win[wpos]], WINDOW);
    else wcount++;
    win[wpos] = b;
    wpos = (wpos + 1) % WINDOW;
    // 当前块 FNV
    cf1 = Math.imul(cf1 ^ c, 0x01000193) >>> 0;
    cf2 = Math.imul(cf2 ^ c, 0x01000193) >>> 0;
    // 切点判定
    const pos = i + 1;
    const size = pos - cs;
    if (size >= level.min) {
      let cutAt = -1;
      if (size >= level.max) cutAt = pos;
      else if ((h & level.mask) === 0) cutAt = pos;
      if (cutAt > 0) {
        const safe = safeCut(s, cutAt, res, hasExtra);
        if (safe >= end) { // 后延到块尾: 不切, 整块输出
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

/* 递归处理一块: 命中缓存跳过; 未命中下钻到更小层; 到底层才跑正则。
 * 返回 { text, allClean } */
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
    // 未命中 → 递归下一层(更小块)
    const sub = processChunk(s, c.s, c.e, extra, li + 1, res, hasExtra);
    if (sub.allClean) {
      cleanCache.set(k, CLEAN);
      parts.push(s.slice(c.s, c.e)); // 零复制
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

/* 长串(≥ 顶层 min): L1 整串 hash → 多层 CDC 递归 */
function redactSmart(s, extra) {
  if (typeof s !== 'string' || s.length === 0) return s;
  const ek = extraFingerprint(extra);
  if (ek !== lastExtraKey) { reset(); lastExtraKey = ek; }
  const len = s.length;
  const hasExtra = !!(extra && extra.length);
  const res = compileRegexes(extra);
  if (len < MIN_TOP) return lookupShort(s, extra, res);

  // ---- L1: 整串双 FNV(廉价扫描), 命中直接返回原引用 ----
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
