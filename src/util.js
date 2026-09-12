'use strict';
                          
const crypto = require('crypto');

function ts() { return new Date().toISOString().slice(11, 19); }
function log(...a) { console.log('[' + ts() + ']', ...a); }
function logErr(...a) { console.error('[' + ts() + ']', ...a); }
function randId(prefix) { return prefix + crypto.randomBytes(10).toString('hex'); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }

                                     
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

module.exports = { ts, log, logErr, randId, nowSec, safeParse, atomicWrite, readJson, toText, normStop };
