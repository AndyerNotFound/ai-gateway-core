'use strict';
/** usage-history.js -- history persistence for the "usage stats" page (2026-09-18)
 *
   * why this file exists:
*   The core's `_stats` (stats.js) keeps only in-memory requests/errors/byChannel/**recent (at most 200 entries)**,
*   reset on restart; the usage page's 24-hour curve is **recomputed from recent every time** -> once traffic is light or time has passed,
*   "pick a time range and view stats" becomes impossible (200 recent entries span only a few hours).
 *
   * the minimal, persistent, low-write implementation here:
*   - Structure: hourly buckets (**kept forever**) + 10-minute buckets (kept 30 days, for fine-grained recent views)
*   - On disk: data/usage-history.jsonl -- **append incremental lines only**, summed per key when read
*     ★ Never "rewrite the whole JSON on every flush": the file grows linearly with history (several MB a year),
*       a rewrite every minute = several GB of writes per day, which would destroy the phone's flash endurance (TBW).
*   - Timing: a 60s flush timer while Gateway runs + flush on process exit (only changed buckets write lines)
*   - Compaction: at startup, when lines far outnumber buckets (history incrementally appended many times), rewrite once to deduplicate
 *
   * convention: all time buckets align to **UTC** (local +08:00 is exactly a multiple of 10 minutes ->
*   UTC bucket alignment == local bucket alignment, skipping a whole set of timezone math); display uses local-time strings.
 *
   * callers:
*   - src/router.js  logDone() calls usageHist.bump(uid, recent record)
*   - src/core.js    start() calls init(dir); close() calls flush(true)
*   - src/admin-ui.js buildUsage() calls queryMany(uids, from, to, gran)
 */
const fs = require('fs');
const path = require('path');

const HOUR_MS = 3600000;
const MIN10_MS = 600000;
const MIN_KEEP_MS = 30 * 24 * HOUR_MS;   /* 10-minute buckets kept 30 days (hourly buckets forever) */
const MAX_POINTS = 1024;                 /* max buckets per curve; beyond that, granularity auto-downgrades (2026-09-19: 180 -> 1024 to match the App's smoothing; denser points, smoother curve) */
const COMPACT_MIN_LINES = 20000;         /* line floor: below it, accumulate (~1.3MB) instead of rewriting often */

/** hourly bucket key: UTC "YYYY-MM-DDTHH" */
function hourKey(ms) { return new Date(ms).toISOString().slice(0, 13); }
/** 10-minute bucket key: UTC "YYYY-MM-DDTHH:MM" (MM aligned to 00/10/20...) */
function tenKey(ms) {
  const d = new Date(ms);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 10) * 10, 0, 0);
  return d.toISOString().slice(0, 16);
}
/** bucket key -> start ms */
function keyMs(k, g) { return Date.parse(k.length === 13 ? (k + ':00:00Z') : (k + ':00Z')); }
/** local timezone offset (ms) */
function tzOff() { return -new Date().getTimezoneOffset() * 60000; }

/** granularity -> ms */
const GRAN_MS = { day: 24 * HOUR_MS, hour: HOUR_MS, min30: 1800000, min10: MIN10_MS };
const GRAN_NEXT = { min10: 'min30', min30: 'hour', hour: 'day', day: 'day' };

class UsageHistory {
  constructor() {
    this.dir = '';
    this.file = '';
    this.hours = new Map();   /* instanceUid -> Map<hourKey, {r,e,i,o,c}> */
    this.mins = new Map();    /* instanceUid -> Map<tenKey, {r,e,i,o,c}> */
    /* *per-key buckets (2026-09-18 "per-user isolation"): primary key = instanceUid + '~' + keyId
     *   (keyId = the card's bound user uid or the card hash, see util.keyIdOf; keyless '' requests never reach here).
     *   why a separate set: instance-level buckets mix all users together, so the user "Usage" page could only show site-wide data.
     *   buckets are created only for keyIds that **actually made requests** -> memory/files grow with active users (not card count). */
    this.hoursK = new Map();
    this.minsK = new Map();
    this._pendH = new Map();  /* uid -> Set<key>: buckets changed since the last flush */
    this._pendM = new Map();
    this._pendHK = new Map(); /* composite key (uid~keyId) -> Set<key> */
    this._pendMK = new Map();
    this.keyScope = true;     /* config switch: false = do not record per-key buckets (instance-level only) */
    this._minSince = 0;       /* the earliest bucket in mins (tests "does this span have fine-grained data") */
    this._lines = 0;
    this._writes = 0;
    this._timer = null;
    this._loaded = false;
  }

/** Called by Gateway.start(); dir = data directory (independent of cwd)
   *  optional config at data/usage-history.config.json:
   *    {"keepDays":0, "compactMinHours":6}
   *    keepDays>0 = hourly buckets are also trimmed to that many days (default 0 = forever); both memory and files shrink with it */
  init(dir) {
    this.dir = dir || '';
    this.file = dir ? path.join(dir, 'usage-history.jsonl') : '';
    this.cfgFile = dir ? path.join(dir, 'usage-history.config.json') : '';
    this.keepDays = 0;                                 /* hourly buckets: 0 = forever (user decision 2026-09-18: bills are never lost) */
    this.minKeepDays = MIN_KEEP_MS / (24 * HOUR_MS);   /* 10-minute buckets: 30 days by default; 0 = forever (memory will climb to hundreds of MB) */
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
      const mk = Number(j.minKeepDays);            /* 0 is legal (= forever), hence the >= 0 check */
      if (isFinite(mk) && mk >= 0) this.minKeepDays = mk;
      const cm = Number(j.compactMinHours);
      if (isFinite(cm) && cm > 0) this.compactMinHours = cm;
      /* *2026-09-18: keyScope=false disables per-key buckets (for site-wide stats when per-user isolation is not wanted).
       *   on by default; after switching off, **existing per-key rows are still read back** (data is not deleted), just no new ones. */
      if (j.keyScope === false) this.keyScope = false;
    } catch (_) { /* a broken config must not take stats down */ }
  }

  _bucketCount() {
    let n = 0;
    for (const m of this.hours.values()) n += m.size;
    for (const m of this.mins.values()) n += m.size;
    for (const m of this.hoursK.values()) n += m.size;
    for (const m of this.minsK.values()) n += m.size;
    return n;
  }

  /* ---------- Disk reads (last-writer-wins: a bucket's final snapshot row wins) ---------- */
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
      let o; try { o = JSON.parse(ln); } catch (_) { continue; }   /* skip broken lines: a stats file is not worth crashing over */
      if (!o || !o.u || !o.t) continue;
      const perKey = !!o.k;                                       /* *k present = a per-key bucket row */
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

  /* ---------- Accounting (in-memory accumulation + dirty marking; no disk writes) ---------- */
  /**
* @param {string|number} uid  instance uid
* @param {object} rec         recent record (carrying time/status/inputTokens/outputTokens/chargedTokens)
* @param {string} [keyId]     ★per-user isolation (2026-09-18): card-key identity (util.keyIdOf). When given, per-key buckets are bumped too
   */
  bump(uid, rec, keyId) {
    if (uid == null || !rec) return;
    /* *uids normalized to strings always: JSON yields numbers while CLI/args may pass strings,
     *   without normalization you get "the log says 31 buckets loaded but the page finds none" type mismatches (hit in e2e). */
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

  /* ---------- Persist (append-only "bucket snapshot" rows) ---------- */
  flush() {
    if (!this.file) return 0;
    /* *periodic compaction (added 2026-09-18): append-only + writing "changed buckets" only => at most
     *  "current hourly + current 10-minute bucket" rows; with the gateway **rarely restarting**, the file grows forever
     *  (measured: 6 instances at full load = 1.1MB/day, ~416MB/year extrapolated). Compaction dedups repeated snapshot rows into "one row per bucket",
     *  steady state = buckets x ~67B (6 instances for a year + 10-min buckets for 30 days ~ 5MB). The trigger is "lines > buckets x 2"
     *  triggering it, at most once per compactMinHours hours (each rewrite ~5MB; protects TBW). */
    this._maybeCompact();
    const now = Date.now();
    const rows = [];
    const stale = [];
    /* with perKey=true: the container's primary key is "instanceUid~keyId"; persisted rows split into u + k fields */
    const collect = (map, pend, g, perKey) => {
      for (const [main, keys] of pend) {
        const m = map.get(main); if (!m) continue;
        const sep = String(main).indexOf('~');
        for (const k of keys) {
          const b = m.get(k);
          /* past retention -> the data was due to be dropped; remove it from the pending set (do not write it out just to read it back)
           *   10-minute buckets: fixed 30 days; hourly buckets: retained only when keepDays>0 (default forever) */
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
    /* expired buckets: data is dropped by design; remove them from the pending set (get may be empty; do not call .delete blindly) */
    for (const [perKey, g, main, k] of stale) { const s = this._pend(g, perKey).get(main); if (s) s.delete(k); }
    if (!rows.length) { this._pendH.clear(); this._pendM.clear(); this._pendHK.clear(); this._pendMK.clear(); return 0; }
    try {
      fs.appendFileSync(this.file, rows.join('\n') + '\n');
    } catch (_) {
      /* *write failures must **not** drop increments: keep pend as-is and retry next round (stats may be late, never undercounted) */
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

/** Compact once when lines far outnumber buckets (= the same buckets got snapshots appended repeatedly); at most once per compactMinHours hours */
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

/** One-time rewrite at startup (deduplicating compaction + trimming expired 10-minute buckets) */
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

/** Trim expired buckets in memory (10-minute buckets fixed at 30 days; hourly buckets follow the keepDays config, 0 = forever)
   *  *instance-level and per-key buckets share one retention policy (the user's "my history" matches the admin side). */
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

  /* ---------- Queries: build the curve buckets ---------- */
  /**
* @param {string[]} uids  instance uid list (pass all instances for Default aggregation)
* @param {number} fromMs  start (inclusive)
* @param {number} toMs    end (inclusive)
   * @param {string} gran    'min10' | 'min30' | 'hour' | 'day'
* @param {string} [keyId] ★per-user isolation (2026-09-18): when given, only that user's per-key buckets are counted
   * @returns {{gran:string, asked:string, covered:boolean, series:Array, total:Object, perKey:boolean}}
   */
  queryMany(uids, fromMs, toMs, gran, keyId) {
    if (!(toMs > fromMs)) toMs = fromMs + HOUR_MS;
    /* *per-key mode: the data source switches to hoursK/minsK (primary key = instanceUid~keyId).
     *   *note the check looks **only at keyId**, not keyScope: with keyScope=false (per-key recording stopped),
     *   queries carrying keyId must return **empty** (= you have no data); never quietly fall back to instance-level
     *   -- that would hand site-wide data to ordinary users as "theirs" (privilege escalation). */
    const pk = keyId ? String(keyId) : '';
    const HMAP = pk ? this.hoursK : this.hours;
    const MMAP = pk ? this.minsK : this.mins;
    let g = GRAN_MS[gran] ? gran : 'hour';
    const asked = g;
    /* fine-grained buckets keep only 30 days -> spans older than retention auto-escalate to hourly,
     *   *the test uses the **retention period**, not "the earliest fine-grained data":
     *   when the service has run for 1 hour, the first 5 hours being empty is a **fact** (no data then); the whole curve must not be downgraded for it. */
    if ((g === 'min10' || g === 'min30') && fromMs < Date.now() - MIN_KEEP_MS) g = 'hour';
    /* too many buckets -> escalate granularity level by level (this is "breaks automatically thinning out") */
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
        else { /* day bucket = the sum of that day's 24 hourly buckets */
          b = { r: 0, e: 0, i: 0, o: 0, c: 0 };
          for (let h = 0; h < 24; h++) {
            const one = this._get(HMAP, uids, hourKey(t + h * HOUR_MS), pk);
            if (!one) continue;
            b.r += one.r; b.e += one.e; b.i += one.i; b.o += one.o; b.c += one.c;
          }
        }
      } else if (g === 'min30') {
        /* *30-min bucket = the sum of its 3 ten-minute sub-buckets. Must merge **unconditionally**:
         *   it used to be `if (g === 'min30' && b)` (merging only when the first sub-bucket was non-empty),
         *   so "empty 09:00 sub-bucket, data landing at 09:10" computed the whole bucket as 0 -- reproduced in stub and e2e tests. */
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

/** Merge values across instances by key (uids compared as strings)
   *  *a non-empty keyId -> read per-key buckets (primary key instUid~keyId) */
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

/** History coverage range (for the page's "queryable range" display)
   *  with a keyId, read that user's own earliest bucket ("all time" only makes sense on the user side). */
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

/* For tests / debugging */
  _stats() { return { keysH: this.hours.size, keysM: this.mins.size, keysHK: this.hoursK.size, keysMK: this.minsK.size, buckets: this._bucketCount(), lines: this._lines }; }
}

/** bucket start -> display label (**local time**: add the offset to the UTC ms, then crop the ISO string) */
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
