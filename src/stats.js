'use strict';
/* stats.js - 基础统计/日志结构 (内核职责, 文档 §2.1) */
function newStats() {
  return { startedAt: new Date().toISOString(), requests: 0, errors: 0, byChannel: {}, recent: [] };
}
module.exports = { newStats };
