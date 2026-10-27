'use strict';
/** vault - the key vault (2026-09-18)
 *
   * the user's ask (verbatim): "still a plugin ... it may need SDUI, because I don't want the key file stored in plaintext".
   * status quo: the kernel's crypt.js has long had field-level AGWENC1 (scrypt+AES-256-GCM), but the passphrase came only from the `.agwkey` file
 *      or environment variable -- the core's data directory holds no `.agwkey`, so **encryption idles entirely and channel apiKeys land on disk in plaintext**.
 *
   * this plugin's positioning: **UI and flow only; all algorithms come from the kernel**.
 *   - The passphrase is submitted via the admin API -> it lives only in core memory (`ctx.gateway.cryptUnlock`), **never written to .agwkey**;
 *   - Restarting the gateway = back to the "locked" state -> the core answers forwarding requests with 503 "gateway locked",
 *     instead of shipping AGWENC1 ciphertext upstream as the apiKey and leaving users to debug a wall of 401s;
 *   - Encrypted scope follows the core's sensitive-field rules (apiKey / adminKey / secondKey / password* / secret / token ...),
 *     while non-sensitive fields like ports, models, and enabled flags stay plaintext for easy manual debugging;
 *   - The App side (Gay Core) stores the passphrase in the Android Keystore and calls `/admin/unlock` automatically on start/refresh for auto-unlock.
 *
   * three things users must know (also written on the page):
 *   1) A lost passphrase = undecryptable ciphertext (though migration left `.bak-crypt-*` plaintext backups for rollback);
 *   2) That plaintext backup is itself a security discount -- once verified, clear it with this page's "delete plaintext backups";
 *   3) The old ai-gateway still reads its own `~/ai-gateway/.agwkey` (untouched this time) -- for legacy-import
 *      to import old encrypted config, keep the passphrases on both sides identical.
 */

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

module.exports = {
  activate(ctx) {
    /* kernel state (error string on failure; never blow up the whole page) */
    const st = () => {
      try { return ctx.gateway.cryptStatus() || {}; } catch (e) { return { error: String((e && e.message) || e) }; }
    };
    const adminOnly = (p, res) => {
      const a = p && p.authAdmin ? p.authAdmin() : { ok: false };
      if (!a || !a.ok) { jsonRes(res, (a && a.status) || 401, { error: (a && a.error) || '需要管理密码(adminKey)' }); return false; }
      return true;
    };

    /* ---------------- Routes ---------------- */

    /* public "good enough" status: the App decides from it whether to auto-unlock. Contains no secrets or paths. */
    ctx.registerRoute('GET', '/status', (req, res) => {
      const s = st();
      jsonRes(res, 200, {
        ok: true,
        locked: !!s.locked,          /* true = ciphertext present but no passphrase -> forwarding is 503-blocked */
        unlocked: !!s.unlocked,
        encrypted: s.encrypted || 0, /* encrypted file count */
        files: s.files || 0,
      });
    });

    /* detailed status (for admin pages) */
    ctx.registerRoute('GET', '/admin/status', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      jsonRes(res, 200, Object.assign({ ok: true }, st()));
    });

    /* unlock: the passphrase enters memory only.
     * ★While locked this endpoint must **not** require an adminKey header -- at that point adminKey itself is ciphertext, so regular auth would always fail
     *   (that is exactly what the "lock" means). Instead: two-factor self-proof with passphrase + admin key -- the kernel decrypts the instance file's
     *   adminKey ciphertext; decrypting it to the submitted value proves both. Hence rate limiting here (anti brute-force) and never logging the passphrase. */
    const attempts = new Map();   /* ip -> [ts,...] */
    const rateLimited = (req) => {
      const ip = (req && req.socket && req.socket.remoteAddress) || 'local';
      const now = Date.now();
      const arr = (attempts.get(ip) || []).filter(t => now - t < 60000);
      arr.push(now);
      attempts.set(ip, arr);
      return arr.length > 6;      /* more than 6 per minute */
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

    /* lock: clear the in-memory passphrase + reload (in-memory plaintext keys vanish with it) */
    ctx.registerRoute('POST', '/admin/lock', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      const r = ctx.gateway.cryptLock();
      ctx.log('[vault] 已锁定');
      jsonRes(res, 200, { ok: true, toast: '已锁定：转发请求现在会被 503 拦下', status: r.status });
    });

    /* encrypt existing data now / change passphrase (body.pass = target passphrase; empty falls back to the (1) passphrase or the current in-memory one) */
    ctx.registerRoute('POST', '/admin/encrypt-all', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      const body = p.body && typeof p.body === 'object' ? p.body : {};
      /* *tolerant handling: if (2) the new passphrase is empty, fall back to (1) (users often fill only (1) then tap "encrypt existing data") */
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

    /* delete plaintext backups left by migration/passphrase changes (tap only after verifying) */
    ctx.registerRoute('POST', '/admin/clean-backups', (req, res, p) => {
      if (!adminOnly(p, res)) return;
      const r = ctx.gateway.cryptCleanBackups();
      ctx.log('[vault] 删除明文备份 ' + r.count + ' 个');
      jsonRes(res, 200, { ok: true, toast: r.count ? '已删除 ' + r.count + ' 个明文备份' : '没有待删除的明文备份', status: r.status });
    });

    /* ---------------- App admin pages (SDUI / gcui) ---------------- */

    /* actions: go through the kernel proxy-call bridge /admin/api/plugin-call (only whitelisted plugins' /admin/ sub-paths) */
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

        /* Status card */
        const rows = [
          kv('当前状态', stateTxt),
          kv('加密进度', enc + ' / ' + files + ' 个配置文件' + (files && enc === files ? '（全部已加密）' : (enc ? '' : '（尚未加密）'))),
          kv('口令来源', srcTxt),
        ];
        if (backups.length) rows.push(kv('明文备份', backups.length + ' 个 .bak-crypt-*（含明文，确认无误后请删除）'));
        kids.push({ type: 'card', variant: 'outlined', gap: 8, children: rows });

        /* Hint card: state-appropriate "next step" */
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

        /* Passphrase input + unlock/lock
         * the field name must be `label` (the App renderer reads label for the floating hint; hint is ignored -> the input becomes a blank box) */
        kids.push(txt('① 口令（解锁用它；首次「加密现有数据」也用它当目标口令）', 'caption', '$onSurfaceVariant'));
        kids.push({ type: 'input', key: 'pass', inputType: 'password', label: '口令（至少 8 位，从 KeePassDX 粘贴）', value: '' });
        kids.push({
          type: 'row', gap: 8, children: [
            btn('解锁（用①）', 'filled', Object.assign(call('/admin/unlock', { pass: '{{input.pass}}' }), { then: 'reload' })),
            btn('锁定', 'tonal', Object.assign(call('/admin/lock', {}), { then: 'reload' })),
          ],
        });

        /* Encrypt / change passphrase / cleanup */
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
