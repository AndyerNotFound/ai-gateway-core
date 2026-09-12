'use strict';
                                          
function newStats() {
  return { startedAt: new Date().toISOString(), requests: 0, errors: 0, byChannel: {}, recent: [] };
}
module.exports = { newStats };
