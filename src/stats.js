'use strict';
/** stats.js - basic stats/log structures (kernel responsibility, doc §2.1) */
function newStats() {
  return { startedAt: new Date().toISOString(), requests: 0, errors: 0, byChannel: {}, recent: [] };
}
module.exports = { newStats };
