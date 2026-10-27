'use strict';
/* util.js - 小工具集 (零依赖) */
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

function ts() { return new Date().toISOString().slice(11, 19); }
function log(...a) { console.log('[' + ts() + ']', ...a); }
function logErr(...a) { console.error('[' + ts() + ']', ...a); }
function randId(prefix) { return prefix + crypto.randomBytes(10).toString('hex'); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }

/* ★跨分块安全解码（2026-09-18）：多字节字符（中文/emoji）常被 TCP 分块切断，逐块
 *  Buffer.toString('utf8') 会把半个字符解成 U+FFFD 乱码 —— 实测：上游响应流、客户端请求体
 *  都会中招，且只取决于分块时机（表现为"有概率"）。用 StringDecoder 跨块累积即可。
 *  用法： const u8 = utf8();  buf += u8(chunk); */
function utf8() { const sd = new StringDecoder('utf8'); return (buf) => sd.write(buf); }

/* 原子写文件: 写临时文件 + rename (文档 §5.4) */
const fs = require('fs');
const path = require('path');
function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/* 读 JSON 文件, 不存在/解析失败返回 null */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/* 消息内容转纯文本 (OpenAI content 数组兼容) */
function toText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => (p && p.type === 'text') ? (p.text || '') : '').join('');
}

/* finish_reason 归一化 */
function normStop(v) {
  if (v == null || v === '') return null;
  const s = String(v).toLowerCase();
  if (s === 'stop' || s === 'end_turn' || s === 'complete' || s === 'stop_sequence') return 'stop';
  if (s === 'length' || s === 'max_tokens' || s === 'max_output_tokens' || s === 'model_context_window_exceeded') return 'length';
  if (s === 'tool_calls' || s === 'tool_use' || s === 'function_call') return 'tool_calls';
  if (s === 'content_filter' || s === 'safety' || s === 'blocked' || s === 'recitation') return 'content_filter';
  return s;
}

/* ★用户/卡密标识（2026-09-18「使用统计按用户隔离」）：
 *   优先用卡密绑定的**用户账号 uid**（同一用户的多张卡合并成一份统计）；
 *   没绑用户就退化成卡密本身的 sha256 前缀（**绝不把明文卡密写进统计文件**）。
 *   返回 '' = 无法识别（免密/网关Key请求）→ 统计照旧只进实例级账本。 */
function keyIdOf(userKey) {
  if (!userKey || typeof userKey !== 'object') return '';
  const u = userKey.uid ? String(userKey.uid) : '';
  if (u) return 'u:' + u;
  const k = userKey.key ? String(userKey.key) : '';
  if (k) return 'k:' + crypto.createHash('sha256').update(k).digest('hex').slice(0, 12);
  return '';
}

/** userKey → 展示名（卡密名优先，其次卡密前 12 位；与原 record 插件的口径一致） */
function keyNameOf(userKey) {
  if (!userKey || typeof userKey !== 'object') return '';
  return String(userKey.name || (userKey.key ? String(userKey.key).slice(0, 12) : '') || '');
}

module.exports = { ts, log, logErr, randId, nowSec, safeParse, atomicWrite, readJson, toText, normStop, utf8, keyIdOf, keyNameOf };
