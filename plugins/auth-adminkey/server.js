'use strict';
/** auth-adminkey - lets an instance's adminKey double as a user key
   * purpose: admins no longer issue themselves a separate card; one account reaches the user side.
   * security: once on, the adminKey flows in Authorization / x-api-key headers -- one more leak channel,
 *       Recommended only on your own devices.
 */
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
          uid: 'uadmin',   /* ★给管理员一个真实 uid —— 否则 /auth/profile 因 uid 为空直接跳过(静默失败) */
          quotaTokens: -1,   /* -1 = unlimited quota */
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
