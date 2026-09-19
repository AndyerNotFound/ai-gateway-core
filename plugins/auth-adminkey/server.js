'use strict';





module.exports.activate = (ctx) => {
  ctx.registerAuth({
    name: 'adminkey',
    check: ({ token, cfg }) => {
      if (!token) return null;
      const ak = cfg && cfg.adminKey;
      if (!ak || token !== ak) return null;
      return {
        ok: true,
        admin: true,
        userKey: {
          key: token,
          name: '管理员',
          uid: 'uadmin',   
          quotaTokens: -1,   
          usedTokens: 0,
          models: [],
          branches: [],
          isMain: true,
          admin: true,
        },
      };
    },
  });
  ctx.log('管理员密钥可作为用户密钥使用 (adminKey → /v1/*, /credits, /auth/*)');
};
