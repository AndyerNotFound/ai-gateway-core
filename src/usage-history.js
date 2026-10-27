'use strict';
/* usage-history.js — 「使用统计」的历史持久化（2026-09-18）
 *
 * 为什么有这个文件：
 *   内核的 `_stats`（stats.js）只有内存里的 requests/errors/byChannel/**recent(最多 200 条)**，
 *   重启就归零；「使用」页的 24 小时曲线是**每次从 recent 现算**的 → 一旦请求少或时间久，
 *   「选一个时段看统计」根本无从查起（recent 200 条覆盖不了几小时）。
 *
 * 这里做的最小、可持久、低写入的实现：
 *   - 结构：小时桶（**永久保留**）+ 10 分钟桶（保留 30 天，细粒度近看用）
 *   - 落盘：data/usage-history.jsonl  **只追加增量行**，读取时同键累加
 *     ★ 绝不能"每次 flush 全量重写 JSON"：文件随历史线性长大（一年数 MB），
 *       每分钟重写一遍 = 每天数 GB 写入量，会毁掉手机闪存寿命（TBW）。
 *   - 时机：Gateway 起 60s 定时 flush + 进程退出 flush（只有变化的桶才写行）
 *   - 压实：启动时若行数远多于桶数（历史被反复增量写过），一次性重写去重
 *
 * 口径：所有时间桶一律按 **UTC** 对齐（本地 +08:00 正好是 10 分钟的整数倍 →
 *   UTC 桶对齐 == 本地桶对齐，省掉一套时区运算）；展示用本地时间字符串。
 *
 * 调用方：
 *   - src/router.js  logDone() 里 usageHist.bump(uid, recent 记录)
 *   - src/core.js    start() 里 init(dir)；close() 里 flush(true)
 *   - src/admin-ui.js buildUsage() 里 queryMany(uids, from, to, gran)
 */
const fs = require('fs');
const path = require('path');

const HOUR_MS = 3600000;
const MIN10_MS = 600000;
const MIN_KEEP_MS = 30 * 24 * HOUR_MS;   /* 10 分钟桶保留 30 天（小时桶永久） */
const MAX_POINTS = 1024;                 /* 单条曲线最多桶数；超出自动降档（2026-09-19: 180→1024，配合 App 端平滑曲线，点更密曲线更顺） */
const COMPACT_MIN_LINES = 20000;         /* 行数下限：低于它就攒着（≈1.3MB），别频繁重写 */

/** 小时桶 key：UTC "YYYY-MM-DDTHH" */
function hourKey(ms) { return new Date(ms).toISOString().slice(0, 13); }
/** 10 分钟桶 key：UTC "YYYY-MM-DDTHH:MM"（MM 对齐到 00/10/20…） */
function tenKey(ms) {
  const d = new Date(ms);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 10) * 10, 0, 0);
  return d.toISOString().slice(0, 16);
}
/** 桶 key → 起始毫秒 */
function keyMs(k, g) { return Date.parse(k.length === 13 ? (k + ':00:00Z') : (k + ':00Z')); }
/** 本地时区偏移（毫秒） */
function tzOff() { return -new Date().getTimezoneOffset() * 60000; }

/** 粒度 → 毫秒 */
const GRAN_MS = { day: 24 * HOUR_MS, hour: HOUR_MS, min30: 1800000, min10: MIN10_MS };
const GRAN_NEXT = { min10: 'min30', min30: 'hour', hour: 'day', day: 'day' };

class UsageHistory {
  constructor() {
    this.dir = '';
    this.file = '';
    this.hours = new Map();   /* 实例uid -> Map<hourKey, {r,e,i,o,c}> */
    this.mins = new Map();    /* 实例uid -> Map<tenKey,  {r,e,i,o,c}> */
    /* ★per-key 桶（2026-09-18「按用户隔离」）：主键 = 实例uid + '~' + keyId
     *   （keyId = 卡密绑定用户 uid 或卡密哈希，见 util.keyIdOf；'' 的免密请求不进这里）。
     *   为什么要单独一套：实例级桶把所有用户混在一起，用户端「使用」页只能看到全站数据。
     *   只有**真的产生过请求**的 keyId 才会建桶 → 内存/文件按活跃用户数增长（不是卡数）。 */
    this.hoursK = new Map();
    this.minsK = new Map();
    this._pendH = new Map();  /* uid -> Set<key>：自上次 flush 起变化的桶 */
    this._pendM = new Map();
    this._pendHK = new Map(); /* 复合键(uid~keyId) -> Set<key> */
    this._pendMK = new Map();
    this.keyScope = true;     /* 配置开关：false = 不记 per-key 桶（只保留实例级） */
    this._minSince = 0;       /* mins 里最早桶的时间（判"这段有没有细粒度数据"） */
    this._lines = 0;
    this._writes = 0;
    this._timer = null;
    this._loaded = false;
  }

  /** 由 Gateway.start() 调用；dir = 数据目录（与 cwd 无关）
   *  可选配置 data/usage-history.config.json：
   *    {"keepDays":0, "compactMinHours":6}
   *    keepDays>0 = 小时桶也只保留这么多天（默认 0 = 永久）；内存/文件都会跟着裁 */
  init(dir) {
    this.dir = dir || '';
    this.file = dir ? path.join(dir, 'usage-history.jsonl') : '';
    this.cfgFile = dir ? path.join(dir, 'usage-history.config.json') : '';
    this.keepDays = 0;                                 /* 小时桶：0 = 永久（用户 2026-09-18 定：账单不丢） */
    this.minKeepDays = MIN_KEEP_MS / (24 * HOUR_MS);   /* 10 分钟桶：默认 30 天；设 0 = 永久（⚠️ 内存会涨到几百 MB） */
    this.compactMinHours = 6;
    this._loadConfig();
    this.load();
    if (this.file && this._lines > Math.max(this._bucketCount() * 2, COMPACT_MIN_LINES)) {
      try { this.compact(); } catch (_) {}
    }
    this._lastCompactAt = Date.now();
    if (this._timer) { try { clearInterval(this._timer); } catch (_) {} }
    this._timer = setInterval(() => { try { this.flush(); } catch (_) {} }, 60000);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  _loadConfig() {
    try {
      if (!this.cfgFile || !fs.existsSync(this.cfgFile)) return;
      const j = JSON.parse(fs.readFileSync(this.cfgFile, 'utf8')) || {};
      const kd = Number(j.keepDays);
      if (isFinite(kd) && kd > 0) this.keepDays = kd;
      const mk = Number(j.minKeepDays);            /* 0 是合法值（= 永久），所以用 >= 0 判断 */
      if (isFinite(mk) && mk >= 0) this.minKeepDays = mk;
      const cm = Number(j.compactMinHours);
      if (isFinite(cm) && cm > 0) this.compactMinHours = cm;
      /* ★2026-09-18：keyScope=false 关掉 per-key 桶（只想看全站统计、不在意用户隔离时）。
       *   默认开；关掉后**已存在的 per-key 行仍会读进来**（不删数据），只是不再新增。 */
      if (j.keyScope === false) this.keyScope = false;
    } catch (_) { /* 配置坏了不该拖垮统计 */ }
  }

  _bucketCount() {
    let n = 0;
    for (const m of this.hours.values()) n += m.size;
    for (const m of this.mins.values()) n += m.size;
    for (const m of this.hoursK.values()) n += m.size;
    for (const m of this.minsK.values()) n += m.size;
    return n;
  }

  /* ---------- 读盘（覆盖语义：同一桶以最后一行快照为准） ---------- */
  load() {
    this.hours.clear(); this.mins.clear(); this.hoursK.clear(); this.minsK.clear();
    this._pendH.clear(); this._pendM.clear(); this._pendHK.clear(); this._pendMK.clear();
    this._lines = 0; this._minSince = 0;
    this._loaded = true;
    if (!this.file || !fs.existsSync(this.file)) return this;
    let txt = '';
    try { txt = fs.readFileSync(this.file, 'utf8'); } catch (_) { return this; }
    for (const ln of txt.split('\n')) {
      if (!ln.trim()) continue;
      this._lines++;
      let o; try { o = JSON.parse(ln); } catch (_) { continue; }   /* 坏行跳过：统计文件不值得为一行崩掉 */
      if (!o || !o.u || !o.t) continue;
      const perKey = !!o.k;                                       /* ★k 存在 = per-key 桶行 */
      const map = perKey
        ? ((o.g === 'm') ? this.minsK : this.hoursK)
        : ((o.g === 'm') ? this.mins : this.hours);
      const main = perKey ? (String(o.u) + '~' + String(o.k)) : o.u;
      let m = map.get(main); if (!m) { m = new Map(); map.set(main, m); }
      m.set(o.t, { r: o.r || 0, e: o.e || 0, i: o.i || 0, o: o.o || 0, c: o.c || 0 });
    }
    for (const map of [this.mins, this.minsK]) for (const m of map.values()) for (const k of m.keys()) {
      const t = keyMs(k, 'min10'); if (!this._minSince || t < this._minSince) this._minSince = t;
    }
    this._prune(Date.now());
    return this;
  }

  /* ---------- 记账（内存累加 + 标脏，不写盘） ---------- */
  /**
   * @param {string|number} uid  实例 uid
   * @param {object} rec         recent 记录（含 time/status/inputTokens/outputTokens/chargedTokens）
   * @param {string} [keyId]     ★按用户隔离（2026-09-18）：卡密身份（util.keyIdOf）。给了就同时记 per-key 桶
   */
  bump(uid, rec, keyId) {
    if (uid == null || !rec) return;
    /* ★uid 一律按字符串归一：JSON 里读出来是 number、CLI/参数传进来可能是 string，
     *   不归一就会出现"日志说加载了 31 个桶、页面却查不到"的类型错位（e2e 实测踩到）。 */
    const u = String(uid);
    const t = Date.parse(String(rec.time || '').replace(' ', 'T') + 'Z');
    if (!isFinite(t)) return;
    const d = {
      r: 1,
      e: (Number(rec.status) >= 400 ? 1 : 0),
      i: Number(rec.inputTokens) || 0,
      o: Number(rec.outputTokens) || 0,
      c: Number(rec.chargedTokens) || 0,
    };
    this._add(this.hours, this._pendH, u, hourKey(t), d);
    this._add(this.mins, this._pendM, u, tenKey(t), d);
    if (keyId && this.keyScope) {
      const ck = u + '~' + String(keyId);
      this._add(this.hoursK, this._pendHK, ck, hourKey(t), d);
      this._add(this.minsK, this._pendMK, ck, tenKey(t), d);
    }
    if (!this._minSince || t < this._minSince) this._minSince = t;
  }

  _add(map, pend, uid, key, d) {
    let m = map.get(uid); if (!m) { m = new Map(); map.set(uid, m); }
    let b = m.get(key); if (!b) { b = { r: 0, e: 0, i: 0, o: 0, c: 0 }; m.set(key, b); }
    b.r += d.r; b.e += d.e; b.i += d.i; b.o += d.o; b.c += d.c;
    let s = pend.get(uid); if (!s) { s = new Set(); pend.set(uid, s); }
    s.add(key);
  }

  /* ---------- 写盘（只追加"桶快照"行） ---------- */
  flush() {
    if (!this.file) return 0;
    /* ★周期性压实（2026-09-18 补）：只追加 + 只写"变化的桶" ⇒ 每分钟最多给
     *  「当前小时桶 + 当前 10 分钟桶」各追一行；网关**长期不重启**时文件会一直长
     *  （实测满负荷 6 实例 = 1.1MB/天、外推一年 416MB）。压实把重复快照行去重成"每桶一行"，
     *  稳态 = 桶数 × ~67B（6 实例满一年 + 10 分钟桶 30 天 ≈ 5MB）。这里按"行数 > 桶数×2"
     *  触发，最多每 compactMinHours 小时一次（重写一次约 5MB，护 TBW）。 */
    this._maybeCompact();
    const now = Date.now();
    const rows = [];
    const stale = [];
    /* perKey=true 时：容器主键是 "实例uid~keyId"，落盘行拆成 u + k 两个字段 */
    const collect = (map, pend, g, perKey) => {
      for (const [main, keys] of pend) {
        const m = map.get(main); if (!m) continue;
        const sep = String(main).indexOf('~');
        for (const k of keys) {
          const b = m.get(k);
          /* 过了保留期 → 数据本来就要丢，直接从待写里摘掉（别再写进文件又被读回来）
           *   10 分钟桶：固定 30 天；小时桶：只有 keepDays>0 时才有期（默认永久） */
          const tooOld = (g === 'm')
            ? (this.minKeepDays > 0 && keyMs(k, 'min10') < now - this.minKeepDays * 24 * HOUR_MS)
            : (this.keepDays > 0 && keyMs(k, 'hour') < now - this.keepDays * 24 * HOUR_MS);
          if (!b || tooOld) { stale.push([perKey, g, main, k]); continue; }
          const row = { u: (perKey && sep >= 0) ? String(main).slice(0, sep) : main, t: k, g: g };
          if (perKey) row.k = (sep >= 0) ? String(main).slice(sep + 1) : String(main);
          if (b.r) row.r = b.r;
          if (b.e) row.e = b.e;
          if (b.i) row.i = b.i;
          if (b.o) row.o = b.o;
          if (b.c) row.c = Math.round(b.c * 1e6) / 1e6;
          rows.push(JSON.stringify(row));
        }
      }
    };
    collect(this.hours, this._pendH, 'h', false);
    collect(this.mins, this._pendM, 'm', false);
    if (this.keyScope) {
      collect(this.hoursK, this._pendHK, 'h', true);
      collect(this.minsK, this._pendMK, 'm', true);
    }
    /* 超期桶：数据按设计丢弃，从待写集合里摘掉（注意 get 可能为空，别直接 .delete） */
    for (const [perKey, g, main, k] of stale) { const s = this._pend(g, perKey).get(main); if (s) s.delete(k); }
    if (!rows.length) { this._pendH.clear(); this._pendM.clear(); this._pendHK.clear(); this._pendMK.clear(); return 0; }
    try {
      fs.appendFileSync(this.file, rows.join('\n') + '\n');
    } catch (_) {
      /* ★写失败**不能**丢增量：pend 保持原样，下一轮再试（统计宁可晚写，不能凭空少记） */
      return 0;
    }
    this._lines += rows.length;
    this._writes++;
    this._pendH.clear(); this._pendM.clear(); this._pendHK.clear(); this._pendMK.clear();
    this._prune(now);
    return rows.length;
  }

  _pend(g, perKey) {
    if (perKey) return g === 'm' ? this._pendMK : this._pendHK;
    return g === 'm' ? this._pendM : this._pendH;
  }

  /** 行数远超桶数（= 同一批桶被反复追加快照）就压实一次；最多每 compactMinHours 小时一次 */
  _maybeCompact() {
    if (!this.file) return;
    const now = Date.now();
    if (this._lastCompactAt && (now - this._lastCompactAt) < this.compactMinHours * HOUR_MS) return;
    const buckets = this._bucketCount();
    if (this._lines <= Math.max(buckets * 2, COMPACT_MIN_LINES)) return;
    const before = this._lines;
    try { this.compact(); } catch (_) { return; }
    this._lastCompactAt = now;
    try { require('./util').log('[usage] 统计历史已压实: ' + before + ' 行 → ' + this._lines + ' 行(' + buckets + ' 桶)'); } catch (_) {}
  }

  /** 启动时一次性重写（去重压缩 + 裁掉超期 10 分钟桶） */
  compact() {
    if (!this.file) return 0;
    const rows = [];
    const dump = (map, g, perKey) => {
      for (const [main, m] of map) for (const [k, b] of m) {
        const sep = String(main).indexOf('~');
        const row = { u: (perKey && sep >= 0) ? String(main).slice(0, sep) : main, t: k, g: g };
        if (perKey) row.k = (sep >= 0) ? String(main).slice(sep + 1) : String(main);
        if (b.r) row.r = b.r;
        if (b.e) row.e = b.e;
        if (b.i) row.i = b.i;
        if (b.o) row.o = b.o;
        if (b.c) row.c = Math.round(b.c * 1e6) / 1e6;
        rows.push(JSON.stringify(row));
      }
    };
    dump(this.hours, 'h', false);
    dump(this.mins, 'm', false);
    dump(this.hoursK, 'h', true);
    dump(this.minsK, 'm', true);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, rows.length ? rows.join('\n') + '\n' : '');
    fs.renameSync(tmp, this.file);
    this._lines = rows.length;
    return rows.length;
  }

  /** 内存里裁掉超期的桶（10 分钟桶固定 30 天；小时桶看 keepDays 配置，0 = 永久）
   *  ★实例级与 per-key 两套桶用同一套保留期（用户端看到的"我的历史"与管理端口径一致）。 */
  _prune(now) {
    const cutMin = this.minKeepDays > 0 ? now - this.minKeepDays * 24 * HOUR_MS : 0;
    const cutH = this.keepDays > 0 ? now - this.keepDays * 24 * HOUR_MS : 0;
    const pruneMap = (map, gran, cut) => {
      if (!cut) return;
      for (const [main, m] of [...map]) {
        for (const k of [...m.keys()]) if (keyMs(k, gran) < cut) m.delete(k);
        if (!m.size) map.delete(main);
      }
    };
    pruneMap(this.mins, 'min10', cutMin);
    pruneMap(this.minsK, 'min10', cutMin);
    pruneMap(this.hours, 'hour', cutH);
    pruneMap(this.hoursK, 'hour', cutH);
  }

  /* ---------- 查询：生成曲线桶 ---------- */
  /**
   * @param {string[]} uids  实例 uid 列表（default 聚合时传全部实例）
   * @param {number} fromMs  起始（含）
   * @param {number} toMs    结束（含）
   * @param {string} gran    'min10' | 'min30' | 'hour' | 'day'
   * @param {string} [keyId] ★按用户隔离（2026-09-18）：给了就只统计该用户的 per-key 桶
   * @returns {{gran:string, asked:string, covered:boolean, series:Array, total:Object, perKey:boolean}}
   */
  queryMany(uids, fromMs, toMs, gran, keyId) {
    if (!(toMs > fromMs)) toMs = fromMs + HOUR_MS;
    /* ★per-key 模式：数据源换成 hoursK/minsK（主键 = 实例uid~keyId）。
     *   ★注意判定**只看 keyId**，不看 keyScope：keyScope=false（停止记录 per-key）时，
     *   带 keyId 的查询应返回**空**（= 没有你的数据），绝不能悄悄退回实例级
     *   —— 那会把全站数据当成"你的"发给普通用户（越权）。 */
    const pk = keyId ? String(keyId) : '';
    const HMAP = pk ? this.hoursK : this.hours;
    const MMAP = pk ? this.minsK : this.mins;
    let g = GRAN_MS[gran] ? gran : 'hour';
    const asked = g;
    /* 细粒度桶只保留 30 天 → 时段早于保留期就自动升档到小时，
     *   ★判据用「保留期」而**不是**"最早一条细粒度数据"：
     *   服务刚跑 1 小时时，前 5 小时为空是**事实**（那会儿没数据），不该因此把整条曲线降档。 */
    if ((g === 'min10' || g === 'min30') && fromMs < Date.now() - MIN_KEEP_MS) g = 'hour';
    /* 桶数太多 → 逐级升档（这就是"折点自动变少"） */
    for (let i = 0; i < 4; i++) {
      const step = GRAN_MS[g];
      const n = Math.floor(toMs / step) - Math.floor(fromMs / step) + 1;
      if (n <= MAX_POINTS || g === 'day') break;
      g = GRAN_NEXT[g];
    }
    const step = GRAN_MS[g];
    const spanH = (toMs - fromMs) / HOUR_MS;
    const withDate = spanH > 36;
    const series = [];
    const total = { r: 0, e: 0, i: 0, o: 0, c: 0 };
    const start = Math.floor(fromMs / step) * step;
    for (let t = start; t <= toMs; t += step) {
      let b = null;
      if (g === 'day' || g === 'hour') {
        const key = hourKey(t);
        if (g === 'hour') b = this._get(HMAP, uids, key, pk);
        else { /* 天桶 = 该天 24 个小时桶求和 */
          b = { r: 0, e: 0, i: 0, o: 0, c: 0 };
          for (let h = 0; h < 24; h++) {
            const one = this._get(HMAP, uids, hourKey(t + h * HOUR_MS), pk);
            if (!one) continue;
            b.r += one.r; b.e += one.e; b.i += one.i; b.o += one.o; b.c += one.c;
          }
        }
      } else if (g === 'min30') {
        /* ★30 分桶 = 该桶下 3 个 10 分子桶求和。必须**无条件**合并：
         *   以前写成 `if (g === 'min30' && b)`（只有第一个子桶非空才合并），
         *   于是"09:00 子桶为空、数据落在 09:10"时整桶算 0 —— 桩测与 e2e 都实测到过。 */
        const acc = { r: 0, e: 0, i: 0, o: 0, c: 0 };
        for (const off of [0, 1, 2]) {
          const one = this._get(MMAP, uids, tenKey(t + off * MIN10_MS), pk);
          if (!one) continue;
          acc.r += one.r; acc.e += one.e; acc.i += one.i; acc.o += one.o; acc.c += one.c;
        }
        b = acc;
      } else {
        b = this._get(MMAP, uids, tenKey(t), pk);
      }
      const d = b || { r: 0, e: 0, i: 0, o: 0, c: 0 };
      total.r += d.r; total.e += d.e; total.i += d.i; total.o += d.o; total.c += d.c;
      series.push({
        label: fmtLabel(t, g, withDate),
        count: d.r, errors: d.e, inTok: d.i, outTok: d.o,
        charged: Math.round(d.c * 1e6) / 1e6, _t: t,
      });
    }
    return { gran: g, asked: asked, covered: g === asked, series: series, total: total, perKey: !!pk };
  }

  /** 多实例按 key 合并取值（uid 统一按字符串比对）
   *  ★keyId 非空 → 查 per-key 桶（主键 instUid~keyId） */
  _get(map, uids, key, keyId) {
    let out = null;
    for (const u of uids) {
      const main = keyId ? (String(u) + '~' + String(keyId)) : String(u);
      const m = map.get(main); if (!m) continue;
      const b = m.get(key); if (!b) continue;
      if (!out) out = { r: 0, e: 0, i: 0, o: 0, c: 0 };
      out.r += b.r; out.e += b.e; out.i += b.i; out.o += b.o; out.c += b.c;
    }
    return out;
  }

  /** 历史覆盖范围（给页面显示"可查范围"）
   *  keyId 给了就看该用户自己的最早桶（"全部"时段对用户端才有意义）。 */
  range(keyId) {
    const pk = keyId ? String(keyId) : '';
    const map = pk ? this.hoursK : this.hours;
    let min = 0, max = 0;
    for (const [main, m] of map) {
      if (pk && !String(main).endsWith('~' + pk)) continue;
      for (const k of m.keys()) {
        const t = keyMs(k, 'hour'); if (!min || t < min) min = t; if (t > max) max = t;
      }
    }
    return { minMs: min, maxMs: max, hours: this._bucketCount(), lines: this._lines, writes: this._writes };
  }

  /* 测试/调试用 */
  _stats() { return { keysH: this.hours.size, keysM: this.mins.size, keysHK: this.hoursK.size, keysMK: this.minsK.size, buckets: this._bucketCount(), lines: this._lines }; }
}

/** 桶起始 → 展示标签（**本地时间**：把 UTC 毫秒加偏移后按 ISO 截取） */
function fmtLabel(tMs, g, withDate) {
  const s = new Date(tMs + tzOff()).toISOString();
  if (g === 'day') return s.slice(5, 10);                     /* 09-18 */
  if (g === 'hour') return (withDate ? s.slice(5, 10) + ' ' : '') + s.slice(11, 13) + ':00';
  return s.slice(11, 16);                                     /* 20:10 */
}

module.exports = new UsageHistory();
module.exports.GRAN_MS = GRAN_MS;
module.exports.MAX_POINTS = MAX_POINTS;
module.exports.MIN_KEEP_DAYS = MIN_KEEP_MS / (24 * HOUR_MS);
