'use strict';
/* crypt.js - AGWENC1 字段级加密 (文档 §5.3)
 * 算法: AES-256-GCM, 密钥由口令经 scrypt(N=16384,r=8,p=1) 派生, 每值独立随机 salt+iv
 * 密文格式: "AGWENC1:" + base64(salt[16] | iv[12] | authTag[16] | ciphertext)
 * 口令来源: 环境变量 AGW_CRYPT_PASS 或密钥文件 <数据目录>/.agwkey
 * 与旧版差异: 旧版整文件加密; 本版只加密敏感字段(apiKey/adminKey/密码哈希等),
 *             非敏感字段明文, 主索引 instances.json 全程明文。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = 'AGWENC1:';

function deriveKey(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 32, { N: 16384, r: 8, p: 1 });
}
function isEncText(t) { return typeof t === 'string' && t.startsWith(MAGIC); }

/* ★解密缓存 (2026-09-18)：每个密文自带随机 salt ⇒ 每次解密都要独立跑一次 scrypt(~50ms)。
 *  而"解锁/重载实例/重载插件"会**反复解密同一批密文**（实测把网关阻塞到无响应：一次重载要解几千次）。
 *  这里按 (口令指纹, 密文) 缓存明文 —— 口令一变指纹就变、旧缓存自动失效；条数上限兜底防内存膨胀。
 *  注意：只缓存解密（加密必须保持随机 salt，不能缓存）。 */
const CACHE_MAX = 8000;
const _dcache = new Map();
let _dcacheTag = null;
function passTag(pass) { return crypto.createHash('sha256').update(String(pass)).digest('hex').slice(0, 20); }

function encryptText(plain, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return MAGIC + Buffer.concat([salt, iv, c.getAuthTag(), ct]).toString('base64');
}
function decryptText(enc, pass) {
  const tag = passTag(pass);
  if (_dcacheTag !== tag) { _dcache.clear(); _dcacheTag = tag; }
  const hit = _dcache.get(enc);
  if (hit !== undefined) return hit;
  const b = Buffer.from(String(enc).slice(MAGIC.length), 'base64');
  if (b.length < 45) throw new Error('密文格式无效');
  const salt = b.subarray(0, 16), iv = b.subarray(16, 28), tagB = b.subarray(28, 44), ct = b.subarray(44);
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  d.setAuthTag(tagB);
  const plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  if (_dcache.size < CACHE_MAX) _dcache.set(enc, plain);
  return plain;
}

/* 口令: env 优先, 其次数据目录 .agwkey (权限600) */
function loadPass(dir) {
  if (process.env.AGW_CRYPT_PASS) return process.env.AGW_CRYPT_PASS;
  const kf = path.join(dir || process.cwd(), '.agwkey');
  try { const t = fs.readFileSync(kf, 'utf8').trim(); return t || null; } catch (_) { return null; }
}

/* ---- 字段级加解密: 遍历对象, 对命中"敏感字段名"的字符串值加密/解密 ---- */
const SENSITIVE_KEYS = /^(apiKey|adminKey|secondKey|password|passwordHash|secret|token|accessToken|refreshToken|privateKey|key)$/i;

function encryptFields(obj, pass, keyRe = SENSITIVE_KEYS) {
  if (!pass) return obj;
  const walk = (v, key) => {
    if (typeof v === 'string' && key && keyRe.test(key) && v && !isEncText(v)) return encryptText(v, pass);
    if (Array.isArray(v)) return v.map(x => walk(x, null));
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k], k); return o; }
    return v;
  };
  return walk(obj, null);
}

function decryptFields(obj, pass, keyRe = SENSITIVE_KEYS) {
  if (!pass) return obj;
  const walk = (v, key) => {
    if (typeof v === 'string' && isEncText(v)) {
      if (key && keyRe.test(key)) { try { return decryptText(v, pass); } catch (_) { return v; } }
      return v;
    }
    if (Array.isArray(v)) return v.map(x => walk(x, null));
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k], k); return o; }
    return v;
  };
  return walk(obj, null);
}

/* 打码显示 (给 getInstanceConfig 用): 密文→"已加密", 明文敏感值→sk-t****st-a */
function maskFields(obj, keyRe = SENSITIVE_KEYS) {
  const walk = (v, key) => {
    if (typeof v === 'string' && key && keyRe.test(key) && v) {
      if (isEncText(v)) return '(已加密)';
      return v.length <= 8 ? '****' : v.slice(0, 4) + '****' + v.slice(-4);
    }
    if (Array.isArray(v)) return v.map(x => walk(x, null));
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k], k); return o; }
    return v;
  };
  return walk(obj, null);
}

module.exports = { MAGIC, isEncText, encryptText, decryptText, loadPass, encryptFields, decryptFields, maskFields, SENSITIVE_KEYS };
