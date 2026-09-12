'use strict';
                                    
const { Gateway, CORE_VERSION } = require('./core');
const { Store, RESERVED_PATHS, INST_NAME_RE } = require('./store');
const { AuthChain } = require('./auth');
const { PluginManager } = require('./plugins');
const router = require('./router');
const canonical = require('./canonical');
const proxy = require('./proxy');
const auth = require('./auth');
const crypt = require('./crypt');
const stats = require('./stats');
const util = require('./util');

module.exports = {
  VERSION: CORE_VERSION,
  Gateway, Store, AuthChain, PluginManager,
  router, canonical, proxy, auth, crypt, stats, util,
  RESERVED_PATHS, INST_NAME_RE,
};
