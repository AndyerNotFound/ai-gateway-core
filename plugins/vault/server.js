'use strict';
/* vault - 密钥保险箱 (2026-09-18)
 *
 * 用户诉求（原话）：「依旧做一个插件 … 可能需要用到 SDUI，因为我不想让密钥文件明文存盘」。
 * 现状：内核 crypt.js 早就有字段级 AGWENC1（scrypt+AES-256-GCM），但口令来源只有 `.agwkey` 文件
 *      或环境变量 —— core 的数据目录里没有 `.agwkey`，所以**加密整体空转，渠道 apiKey 是明文落盘**。
 *
 * 本插件的定位：**只做 UI 与流程，算法一律用内核的**。
 *   - 口令经管理端 API 提交 → 只进内核内存（`ctx.gateway.cryptUnlock`），**绝不写 .agwkey**；
 *   - 重启网关 = 自动回到"锁定"态 → 内核会直接对转发请求回 503「网关已锁定」，
 *     而不是把 AGWENC1 密文当 apiKey 发上游、让用户对着一片 401 排查；
 *   - 加密范围沿用内核的敏感字段规则（apiKey / adminKey / secondKey / password* / secret / token …），
 *     端口、模型、启用状态这些非敏感字段保持明文，方便人工排查；
 *   - App 端（Gay Core）把口令存 Android Keystore，启动/刷新时自动调 `/admin/unlock` 实现自动解锁。
 *
 * ⚠️ 三条必须让用户知道的事（页面上也写了）：
 *   1) 口令丢了 = 密文不可解（不过"迁移加密"时留了 `.bak-crypt-*` 明文备份，可回滚）；
 *   2) 那份明文备份本身就是安全性折扣 —— 确认无误后请用本页「删除明文备份」清掉；
 *   3) 旧版 ai-gateway 仍读它自己的 `~/ai-gateway/.agwkey`（本次不动它）—— 想让 legacy-import
 *      导入旧版加密配置，请让两边的口令保持一致。
 */

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

module.exports = {
  activate(ctx) {
    /* 内核状态（失败时给错误串，别让页面整页炸） */
    const st = () => {
      try { return ctx.gateway.cryptStatus() || {}; } catch (e) { return { error: String((e && e.message) || e) }; }
    };
    const adminOnly = (p, res) => {
      const a = p && p.authAdmin ? p.authAdmin() : { ok: false };
      if (!a || !a.ok) { jsonRes(res, (a && a.status) || 401, { error: (a && a.error) || '需要管理密码(adminKey)' }); return false; }
      return true;
    };

    /* ---------------- 路由 ---------------- */

    /* 公开的"够用就好"状态：App 据此判断要不要自动解锁。不含任何密钥/路径信息。 */
    ctx.registerRoute('GET', '/status', (req, res) => {
      const s = st();
      jsonRes(res, 200, {
        ok: true,
        locked: !!s.locked,          /* true = 有密文但没口令 → 转发会被 503 拦 */
        unlocked: !!s.unlocked,
        encrypted: s.encrypted || 0, /* 已加密文件数 */
        files: s.files || 0,
      });
    });

    /* 详细状态（管理端页面用） */
    ctx.registerRoute('GET', '/admin/status', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      jsonRes(res, 200, Object.assign({ ok: true }, st()));
    });

    /* 解锁：口令只进内存。
     * ★锁定时这个端点**不能**要求 adminKey 头 —— 那时 adminKey 自己也是密文，常规鉴权必然失败
     *   （"锁"的本意就是如此）。改用「口令 + 管理员密钥」两因子自证：内核拿提交的口令去解实例文件里的
     *   adminKey 密文，解得出且与提交值一致 ⇒ 两样都对。因此这里做限速（防爆破），且绝不记录口令。 */
    const attempts = new Map();   /* ip -> [ts,...] */
    const rateLimited = (req) => {
      const ip = (req && req.socket && req.socket.remoteAddress) || 'local';
      const now = Date.now();
      const arr = (attempts.get(ip) || []).filter(t => now - t < 60000);
      arr.push(now);
      attempts.set(ip, arr);
      return arr.length > 6;      /* 每分钟 6 次 */
    };
    ctx.registerRoute('POST', '/admin/unlock', (req, res, p) => {
      const body = p.body && typeof p.body === 'object' ? p.body : {};
      const pass = String(body.pass == null ? '' : body.pass);
      const st0 = st();
      let ak = String(body.adminKey == null ? '' : body.adminKey).trim();
      if (!ak && req.headers) ak = String(req.headers['x-admin-key'] || '').trim();   /* 管理端代调桥会带这个头 */
      if (st0.locked) {
        if (rateLimited(req)) return jsonRes(res, 429, { error: '尝试过于频繁，请等一分钟再试' });
      } else if (!adminOnly(p, res)) {
        return;
      }
      const r = ctx.gateway.cryptUnlock(pass, ak);
      if (!r.ok) return jsonRes(res, 400, { error: r.error });
      ctx.log('[vault] 已解锁（口令仅存内存）');
      jsonRes(res, 200, { ok: true, toast: '已解锁 · 口令只在内存里', status: r.status });
    });

    /* 锁定：清内存口令 + 重载（内存里的明文 key 一并消失） */
    ctx.registerRoute('POST', '/admin/lock', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      const r = ctx.gateway.cryptLock();
      ctx.log('[vault] 已锁定');
      jsonRes(res, 200, { ok: true, toast: '已锁定：转发请求现在会被 503 拦下', status: r.status });
    });

    /* 立即加密现有数据 / 换口令（body.pass = 目标口令；留空则回退用①里的口令或用当前内存口令） */
    ctx.registerRoute('POST', '/admin/encrypt-all', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      const body = p.body && typeof p.body === 'object' ? p.body : {};
      /* ★宽容处理：②（新口令）为空就退回用①（用户很可能只填了①就点"加密现有数据"） */
      const target = String(body.pass == null ? '' : body.pass).trim()
        || String(body.pass1 == null ? '' : body.pass1).trim();
      const before = st();
      const r = ctx.gateway.cryptReencrypt(target);
      if (!r.ok) return jsonRes(res, 400, { error: r.error });
      const changed = r.rewritten || 0;
      ctx.log('[vault] 加密迁移/换口令: 改写 ' + changed + '/' + (r.scanned || 0) + ' 个文件'
        + ((r.errors || []).length ? '，失败 ' + r.errors.length : ''));
      jsonRes(res, 200, {
        ok: true,
        toast: (before.encrypted ? '已换口令并重写 ' : '已加密 ') + changed + ' 个文件'
          + '（旧文件留了 .bak-crypt-* 备份）',
        rewritten: changed, scanned: r.scanned, errors: r.errors,
        status: r.status,
      });
    });

    /* 删除迁移/换口令时留下的明文备份（确认无误后再点） */
    ctx.registerRoute('POST', '/admin/clean-backups', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      const r = ctx.gateway.cryptCleanBackups();
      ctx.log('[vault] 删除明文备份 ' + r.count + ' 个');
      jsonRes(res, 200, { ok: true, toast: r.count ? '已删除 ' + r.count + ' 个明文备份' : '没有待删除的明文备份', status: r.status });
    });

    /* ---------------- App 管理端页面（SDUI / gcui） ---------------- */

    /* 动作：走内核代调桥 /admin/api/plugin-call（只允许白名单插件的 /admin/ 子路径） */
    const call = (path, body) => ({
      type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call',
      body: { plugin: 'vault', path: path, method: 'POST', body: body || {} },
    });
    const btn = (text, style, action) => ({ type: 'button', text: text, style: style, shape: 'pill', action: action });
    const kv = (label, value) => ({ type: 'kv', label: label, value: value });
    const txt = (text, style, color) => {
      const o = { type: 'text', text: text };
      if (style) o.style = style;
      if (color) o.color = color;
      return o;
    };

    ctx.registerAdminUi({
      id: 'vault',
      title: '密钥保险箱',
      icon: 'key',
      menu: true,
      render: (gw, c, q) => {
        const s = st();
        const locked = !!s.locked, unlocked = !!s.unlocked;
        const enc = Number(s.encrypted) || 0, files = Number(s.files) || 0;
        const backups = s.backups || [];
        const stateTxt = locked ? '已锁定 —— 转发请求会被 503 拦下'
          : (unlocked ? '已解锁' : '未启用加密（敏感字段当前是明文）');
        const srcTxt = s.source === 'file' ? '⚠️ 明文口令文件 .agwkey（安全性打折）'
          : (s.source === 'env' ? '环境变量 AGW_CRYPT_PASS' : (s.source === 'memory' ? '内存（不落盘，推荐）' : '—'));

        const kids = [
          txt('密钥保险箱', 'title3'),
          txt('敏感字段加密（apiKey / adminKey / 密码哈希…）· 口令只存内存，不落盘', 'caption', '$onSurfaceVariant'),
        ];

        /* 状态卡 */
        const rows = [
          kv('当前状态', stateTxt),
          kv('加密进度', enc + ' / ' + files + ' 个配置文件' + (files && enc === files ? '（全部已加密）' : (enc ? '' : '（尚未加密）'))),
          kv('口令来源', srcTxt),
        ];
        if (backups.length) rows.push(kv('明文备份', backups.length + ' 个 .bak-crypt-*（含明文，确认无误后请删除）'));
        kids.push({ type: 'card', variant: 'outlined', gap: 8, children: rows });

        /* 提示卡：按状态给"下一步" */
        const tips = [];
        if (locked) {
          tips.push('网关已锁定：所有 /v1 转发请求返回 503「网关已锁定」。在下面输入口令解锁即可（App 侧保存后可自动解锁）。');
        } else if (!enc) {
          tips.push('现在还没有加密：渠道 apiKey、实例 adminKey 都是明文落盘。填一个口令 → 「加密现有数据」即可启用。');
        } else {
          tips.push('已启用加密。重启网关后会自动回到锁定态，需要 App 自动解锁或手动输入口令。');
        }
        if (s.keyFile) tips.push('⚠️ 检测到 data/.agwkey 明文口令文件 —— 锁定保护形同虚设，建议删除该文件后再用本页口令解锁。');
        tips.push('口令请存进 KeePassDX：丢了就解不开密文（可回滚到 .bak-crypt-* 明文备份，但那份备份在盘上就是明文）。');
        tips.push('★自动解锁：把同一个口令在 Gay Core「站点信息 → 网关口令」里填一遍（存 App 的 Keystore 加密区）。'
          + '否则每次重启网关都要手动来这页解锁 —— 锁定状态下管理端接口验不了鉴权，这页本身也打不开。');
        kids.push({
          type: 'card', variant: 'outlined', gap: 6, children: [
            txt('注意', 'body'),
            ...tips.map(t => txt('· ' + t, 'caption', '$onSurfaceVariant')),
          ],
        });

        /* 口令输入 + 解锁/锁定
         * ★字段名必须是 `label`（App 渲染器读 label 做浮标；写 hint 会被忽略 → 输入框变"白框"） */
        kids.push(txt('① 口令（解锁用它；首次「加密现有数据」也用它当目标口令）', 'caption', '$onSurfaceVariant'));
        kids.push({ type: 'input', key: 'pass', inputType: 'password', label: '口令（至少 8 位，从 KeePassDX 粘贴）', value: '' });
        kids.push({
          type: 'row', gap: 8, children: [
            btn('解锁（用①）', 'filled', Object.assign(call('/admin/unlock', { pass: '{{input.pass}}' }), { then: 'reload' })),
            btn('锁定', 'tonal', Object.assign(call('/admin/lock', {}), { then: 'reload' })),
          ],
        });

        /* 加密 / 换口令 / 清理 */
        kids.push(txt('② 新口令（仅「换口令」时填；留空 = 仍用①）', 'caption', '$onSurfaceVariant'));
        kids.push({ type: 'input', key: 'newpass', inputType: 'password', label: '新口令（可留空）', value: '' });
        kids.push({
          type: 'row', gap: 8, children: [
            btn(enc ? '换口令（①→②）' : '加密现有数据（用①）', 'filled', Object.assign(call('/admin/encrypt-all', { pass: '{{input.newpass}}', pass1: '{{input.pass}}' }), { then: 'reload' })),
            btn('删除明文备份', 'outlined', Object.assign(call('/admin/clean-backups', {}), { then: 'reload' })),
          ],
        });
        if (backups.length) {
          kids.push(txt('待删：' + backups.slice(0, 4).join('、') + (backups.length > 4 ? ' 等 ' + backups.length + ' 个' : ''), 'caption', '$onSurfaceVariant'));
        }

        kids.push({ type: 'spacer', height: 6 });
        kids.push(txt('说明：加密算法与字段规则都在内核（AGWENC1 / scrypt+AES-256-GCM），本页只负责口令与流程；'
          + '口令不写入磁盘，重启后需重新解锁。旧版 ai-gateway 仍用它自己的 .agwkey —— 想让它俩互通（legacy-import 导旧配置），'
          + '请保持两边口令一致。', 'caption', '$onSurfaceVariant'));

        return { title: '密钥保险箱', state: {}, root: { type: 'column', gap: 10, children: kids } };
      },
    });

    ctx.log('密钥保险箱已激活 (管理页 /admin/ui/vault; 口令不落盘)');
  },
};
