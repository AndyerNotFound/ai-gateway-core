'use strict';
/** util.js - small utility collection (zero deps) */
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

function ts() { return new Date().toISOString().slice(11, 19); }
function log(...a) { console.log('[' + ts() + ']', ...a); }
function logErr(...a) { console.error('[' + ts() + ']', ...a); }
function randId(prefix) { return prefix + crypto.randomBytes(10).toString('hex'); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }

/** *chunk-safe decoding (2026-09-18): multi-byte characters (CJK/emoji) are often split across TCP chunks; per-chunk
 *  Buffer.toString('utf8') turns half a character into U+FFFD mojibake -- observed in practice on upstream response streams and client request bodies
   *  are all hit, depending only on chunk timing (it "happens sometimes"). Accumulate across chunks with StringDecoder.
   *  usage: const u8 = utf8();  buf += u8(chunk); */
function utf8() { const sd = new StringDecoder('utf8'); return (buf) => sd.write(buf); }

/** atomic file writes: write a temp file + rename (doc §5.4) */
const fs = require('fs');
const path = require('path');
function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** read a JSON file; return null when missing/unparseable */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/** convert message content to plain text (OpenAI content-array compatible) */
function toText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => (p && p.type === 'text') ? (p.text || '') : '').join('');
}

/** finish_reason normalization */
function normStop(v) {
  if (v == null || v === '') return null;
  const s = String(v).toLowerCase();
  if (s === 'stop' || s === 'end_turn' || s === 'complete' || s === 'stop_sequence') return 'stop';
  if (s === 'length' || s === 'max_tokens' || s === 'max_output_tokens' || s === 'model_context_window_exceeded') return 'length';
  if (s === 'tool_calls' || s === 'tool_use' || s === 'function_call') return 'tool_calls';
  if (s === 'content_filter' || s === 'safety' || s === 'blocked' || s === 'recitation') return 'content_filter';
  return s;
}

/** *user/card identity (2026-09-18 "per-user usage stats isolation"):
 *   Prefer the **user account uid** bound to the card key (several cards of one user merge into one set of stats);
 *   with no bound user, degrade to a sha256 prefix of the card key itself (**never write raw card keys into stats files**).
 *   Returning '' = unrecognized (keyless / gateway-key requests) -> stats go into the instance-level ledger as before. */
function keyIdOf(userKey) {
  if (!userKey || typeof userKey !== 'object') return '';
  const u = userKey.uid ? String(userKey.uid) : '';
  if (u) return 'u:' + u;
  const k = userKey.key ? String(userKey.key) : '';
  if (k) return 'k:' + crypto.createHash('sha256').update(k).digest('hex').slice(0, 12);
  return '';
}

/** userKey -> display name (the card name first, else the first 12 chars of the card; same convention as the original record plugin) */
function keyNameOf(userKey) {
  if (!userKey || typeof userKey !== 'object') return '';
  return String(userKey.name || (userKey.key ? String(userKey.key).slice(0, 12) : '') || '');
}

module.exports = { ts, log, logErr, randId, nowSec, safeParse, atomicWrite, readJson, toText, normStop, utf8, keyIdOf, keyNameOf };
