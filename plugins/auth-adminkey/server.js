'use strict';
/* auth-adminkey - 让实例的 adminKey 也能当用户密钥用
 * 用途: 管理员不必再给自己单独发一张卡, 一个账号就能进用户端。
 * 安全: 开启后 adminKey 会随 Authorization / x-api-key 头流动, 相当于多一条泄露通道,
 *       只建议在自己的设备上开。
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
          quotaTokens: -1,   /* -1 = 不限额度 */
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
