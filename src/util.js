'use strict';

const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

function ts() { return new Date().toISOString().slice(11, 19); }
function log(...a) { console.log('[' + ts() + ']', ...a); }
function logErr(...a) { console.error('[' + ts() + ']', ...a); }
function randId(prefix) { return prefix + crypto.randomBytes(10).toString('hex'); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }





function utf8() { const sd = new StringDecoder('utf8'); return (buf) => sd.write(buf); }


const fs = require('fs');
const path = require('path');
function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}


function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}


function toText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => (p && p.type === 'text') ? (p.text || '') : '').join('');
}


function normStop(v) {
  if (v == null || v === '') return null;
  const s = String(v).toLowerCase();
  if (s === 'stop' || s === 'end_turn' || s === 'complete' || s === 'stop_sequence') return 'stop';
  if (s === 'length' || s === 'max_tokens' || s === 'max_output_tokens' || s === 'model_context_window_exceeded') return 'length';
  if (s === 'tool_calls' || s === 'tool_use' || s === 'function_call') return 'tool_calls';
  if (s === 'content_filter' || s === 'safety' || s === 'blocked' || s === 'recitation') return 'content_filter';
  return s;
}





function keyIdOf(userKey) {
  if (!userKey || typeof userKey !== 'object') return '';
  const u = userKey.uid ? String(userKey.uid) : '';
  if (u) return 'u:' + u;
  const k = userKey.key ? String(userKey.key) : '';
  if (k) return 'k:' + crypto.createHash('sha256').update(k).digest('hex').slice(0, 12);
  return '';
}


function keyNameOf(userKey) {
  if (!userKey || typeof userKey !== 'object') return '';
  return String(userKey.name || (userKey.key ? String(userKey.key).slice(0, 12) : '') || '');
}

module.exports = { ts, log, logErr, randId, nowSec, safeParse, atomicWrite, readJson, toText, normStop, utf8, keyIdOf, keyNameOf };
