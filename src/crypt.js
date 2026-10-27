'use strict';
/** crypt.js - AGWENC1 field-level encryption (doc §5.3)
   * algorithm: AES-256-GCM; the key is derived from the passphrase via scrypt (N=16384,r=8,p=1); each value gets its own random salt+iv
   * ciphertext format: "AGWENC1:" + base64(salt[16] | iv[12] | authTag[16] | ciphertext)
   * passphrase source: env AGW_CRYPT_PASS or the key file <data dir>/.agwkey
   * vs the old version: the old one encrypted whole files; this one encrypts only sensitive fields (apiKey/adminKey/password hashes etc.),
 *             non-sensitive fields stay plaintext, and the main index instances.json is plaintext throughout.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = 'AGWENC1:';

function deriveKey(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 32, { N: 16384, r: 8, p: 1 });
}
function isEncText(t) { return typeof t === 'string' && t.startsWith(MAGIC); }

/** *decryption cache (2026-09-18): each ciphertext carries its own random salt => every decryption is an independent scrypt run (~50ms).
   *  while "unlock / reload instance / reload plugin" **repeatedly decrypts the same ciphertext** (measured: one reload = thousands of decrypt runs, blocking the gateway).
 *  Plaintext is cached by (passphrase fingerprint, ciphertext) -- changing the passphrase changes the fingerprint and invalidates old entries; a count cap backstops memory growth.
   *  note: cache decryption only (encryption must keep a fresh random salt; never cached). */
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

/** passphrase: env first, then the data dir's .agwkey (mode 600) */
function loadPass(dir) {
  if (process.env.AGW_CRYPT_PASS) return process.env.AGW_CRYPT_PASS;
  const kf = path.join(dir || process.cwd(), '.agwkey');
  try { const t = fs.readFileSync(kf, 'utf8').trim(); return t || null; } catch (_) { return null; }
}

/** ---- field-level encrypt/decrypt: walk the object, encrypting/decrypting string values under "sensitive field names" ---- */
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

/** masked display (for getInstanceConfig): ciphertext -> "encrypted", plaintext secrets -> sk-t****st-a */
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
