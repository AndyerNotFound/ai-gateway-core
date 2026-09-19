'use strict';



















const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOME = '/data/data/com.termux/files/home';
const AUDIO_EXT = ['*.mp3', '*.flac', '*.m4a', '*.aac', '*.ogg', '*.oga', '*.opus', '*.wav', '*.wma'];

function jsonRes(res, code, o) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
}

function mimeForFile(fp) {
  const ext = path.extname(fp).toLowerCase();
  const map = {
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus',
    '.wav': 'audio/wav', '.flac': 'audio/flac', '.wma': 'audio/x-ms-wma'
  };
  return map[ext] || 'audio/mpeg';
}

function fmtTime(sec) {
  if (!sec || sec < 0 || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}


function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

module.exports.activate = (ctx) => {
  const cfg = ctx.config;
  const pollMs = Math.max(1, Number(cfg.pollSeconds) || 3) * 1000;

  let playerHtml = '';
  try { playerHtml = fs.readFileSync(path.join(__dirname, 'pages', 'player.html'), 'utf8'); }
  catch (e) { playerHtml = '<!DOCTYPE html><html><body style="background:#141218;color:#e7e0e8;font-family:sans-serif;padding:40px"><h1>播放器页面加载失败</h1><p>' + (e.message || '') + '</p></body></html>'; }

  const rishPath = () => cfg.rishPath || (HOME + '/Shizuku/rish');

  
  function rish(cmd, timeout) {
    const r = spawnSync('sh', [rishPath(), '-c', cmd], {
      env: Object.assign({}, process.env, { RISH_APPLICATION_ID: 'com.termux' }),
      encoding: 'utf8', timeout: timeout || 12000, maxBuffer: 32 * 1024 * 1024
    });
    if (r.error) throw new Error('rish 调用失败: ' + r.error.message);
    
    return (r.stdout || '') + (r.stderr || '');
  }

  function parseSessions(text) {
    const sessions = [];
    let cur = null;
    for (const rawLine of text.split('\n')) {
      const t = rawLine.trim();
      if (/^package=/.test(t)) { if (cur) sessions.push(cur); cur = { pkg: t.slice(8).trim(), active: false }; continue; }
      if (!cur) continue;
      if (/^active=/.test(t)) cur.active = t.endsWith('true');
      const m = t.match(/^state=PlaybackState \{state=([A-Z_]+)\((\d+)\), position=(-?\d+).*?speed=([-\d.]+), updated=(\d+)/);
      if (m) { cur.state = m[1]; cur.position = +m[3]; cur.speed = +m[4]; cur.updated = +m[5]; }
      const md = t.match(/^metadata: size=(\d+), description=(.*)$/);
      if (md && md[2] && md[2] !== 'null') {
        cur.description = md[2];
        const parts = md[2].split(', ');
        cur.title = parts[0] || '';
        cur.artist = parts[1] || '';
        cur.album = parts.slice(2).join(', ') || '';
      }
    }
    if (cur) sessions.push(cur);
    return sessions;
  }

  let msCache = { at: 0, data: null };

  function readNowPlaying(force) {
    if (!force && msCache.data && (Date.now() - msCache.at) < 1500) return msCache.data;

    let out;
    try { out = rish('cat /proc/uptime; dumpsys media_session'); }
    catch (e) { const d = { ok: false, error: e.message }; msCache = { at: Date.now(), data: d }; return d; }

    const upLine = (out.split('\n').find(l => /^\d+\.\d+\s+\d+\.\d+\s*$/.test(l.trim())) || '').trim();
    const uptimeMs = upLine ? parseFloat(upLine.split(/\s+/)[0]) * 1000 : null;

    
    const cands = parseSessions(out).filter(s => s.active && (s.state === 'PLAYING' || s.state === 'PAUSED'));
    cands.sort((a, b) => {
      const ap = a.state === 'PLAYING' ? 1 : 0, bp = b.state === 'PLAYING' ? 1 : 0;
      if (ap !== bp) return bp - ap;              
      return (b.updated || 0) - (a.updated || 0); 
    });
    const s = cands[0];

    let data;
    if (!s) {
      data = { ok: true, playing: false, state: 'idle', message: '手机上当前没有在播放音乐' };
    } else {
      data = {
        ok: true, playing: true,
        pkg: s.pkg,
        state: s.state,
        playingBool: s.state === 'PLAYING',
        description: s.description || '',
        title: s.title || '',
        artist: s.artist || '',
        album: s.album || '',
        basePosition: s.position || 0,
        speed: s.speed || 0,
        updated: s.updated || 0,
        uptimeMs: uptimeMs,
        sampledAt: Date.now()
      };
    }
    msCache = { at: Date.now(), data };
    return data;
  }

  
  function positionOf(np) {
    if (!np || !np.playing) return 0;
    let elapsed = 0;
    if (np.uptimeMs != null && np.updated) elapsed = np.uptimeMs - np.updated;
    else if (np.speed > 0) elapsed = (Date.now() - np.sampledAt);
    const pos = np.basePosition + Math.max(0, elapsed) * (np.speed || 0);
    return Math.max(0, Math.round(pos));
  }

  
  let libCache = { at: 0, files: [] };

  const DEFAULT_ROOTS = '/storage/emulated/0/Music,/storage/emulated/0/岸听/Music';

  function roots() {
    return String(cfg.musicRoots || DEFAULT_ROOTS)
      .split(/[,\n]/).map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
  }

  
  function inRoots(fp) {
    const abs = path.resolve(fp);
    return roots().some(r => abs === r || abs.startsWith(r + '/'));
  }

  function library(force) {
    if (!force && libCache.files.length && (Date.now() - libCache.at) < 10 * 60000) return libCache.files;
    const files = [];
    for (const root of roots()) {
      if (!fs.existsSync(root)) continue;
      const args = [root, '-type', 'f', '('];
      AUDIO_EXT.forEach((e, i) => { if (i) args.push('-o'); args.push('-iname', e); });
      args.push(')');
      try {
        const r = spawnSync('find', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
        for (const f of String(r.stdout || '').split('\n')) if (f) files.push(f);
      } catch (e) { ctx.log('[music-remote] find 失败:', e.message); }
    }
    libCache = { at: Date.now(), files };
    return files;
  }

  



  const TAG_CACHE_FILE = HOME + '/.music-remote-tags.json';
  let tagCache = null;      
  let tagBuilding = false;

  function readTagCache() {
    if (tagCache) return tagCache;
    try {
      const j = JSON.parse(fs.readFileSync(TAG_CACHE_FILE, 'utf8'));
      if (j && Array.isArray(j.entries)) { tagCache = j; return tagCache; }
    } catch (e) {  }
    tagCache = { at: 0, entries: [] };
    return tagCache;
  }

  
  function readTagsBatch(files, cmd) {
    const out = {};
    if (!files.length) return out;
    const script = 'for f in "$@"; do echo "F:$f"; ' + cmd + ' -- "$f" 2>/dev/null; done';
    const r = spawnSync('sh', ['-c', script, '_'].concat(files), {
      encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024
    });
    let cur = null;
    for (const line of String(r.stdout || '').split('\n')) {
      if (line.startsWith('F:')) { cur = line.slice(2); out[cur] = {}; continue; }
      const m = /^(TITLE|ARTIST|ALBUM)=(.*)$/.exec(line.trim());
      if (m && cur) out[cur][m[1].toLowerCase()] = m[2].trim();
    }
    return out;
  }

  function buildTagIndex() {
    const files = library();
    if (!files.length) return { at: Date.now(), entries: [] };
    const t0 = Date.now();
    const flac = files.filter(f => /\.flac$/i.test(f));
    const rest = files.filter(f => !/\.flac$/i.test(f));
    const tags = {};
    Object.assign(tags, readTagsBatch(flac,
      'metaflac --show-tag=TITLE --show-tag=ARTIST --show-tag=ALBUM'));
    if (rest.length) {
      Object.assign(tags, readTagsBatch(rest,
        'ffprobe -v quiet -show_entries format_tags=title,artist,album -of default=nw=1:nk=0'));
    }
    const entries = [];
    for (const f of files) {
      const t = tags[f];
      if (!t) continue;
      if (!t.title && !t.artist) continue;
      entries.push({ file: f, title: t.title || '', artist: t.artist || '', album: t.album || '' });
    }
    ctx.log('[music-remote] 标签索引完成: ' + entries.length + '/' + files.length
      + ' 首 (' + (Date.now() - t0) + 'ms)');
    const data = { at: Date.now(), entries };
    try { fs.writeFileSync(TAG_CACHE_FILE, JSON.stringify(data)); } catch (e) {  }
    tagCache = data;
    return data;
  }

  
  function ensureTagIndex() {
    const c = readTagCache();
    if (c.entries.length) return c;
    if (tagBuilding) return c;
    tagBuilding = true;
    setTimeout(() => {
      try { buildTagIndex(); } catch (e) { ctx.log('[music-remote] 标签索引失败:', e.message); }
      tagBuilding = false;
    }, 1500);
    return c;
  }

  function rebuildTagIndex() {
    if (tagBuilding) return;
    tagBuilding = true;
    setTimeout(() => {
      try { buildTagIndex(); } catch (e) { ctx.log('[music-remote] 标签索引失败:', e.message); }
      tagBuilding = false;
    }, 10);
  }

  





  const MIN_SCORE = 500;

  




  function candidatesFromDesc(desc) {
    const out = [];
    const seen = new Set();
    const push = (t, a) => {
      const k = (t || '') + '\u0000' + (a || '');
      if (!t || seen.has(k)) return;
      seen.add(k); out.push({ title: t, artist: a || '' });
    };
    for (const part of String(desc || '').split(', ')) {
      push(part.trim(), '');
      const seg = part.split(' - ');
      if (seg.length >= 2) push(seg.slice(1).join(' - ').trim(), seg[0].trim());
    }
    return out;
  }

  function matchFile(desc, title, artist) {
    const nd = norm(desc || '');
    let best = null;
    const take = (score, file, by, entry) => { if (score > 0 && (!best || score > best.score)) best = { score, file, by, entry: entry || null }; };

    
    const idx = ensureTagIndex();
    if (idx.entries.length) {
      const cands = candidatesFromDesc(desc);
      if (title) cands.push({ title, artist: artist || '' });
      for (const c of cands) {
        const ct = norm(c.title), ca = norm(c.artist);
        if (!ct) continue;
        for (const e of idx.entries) {
          const et = norm(e.title), ea = norm(e.artist), eal = norm(e.album);
          if (!et || et !== ct) continue;
          const artistHit = ca && ea === ca;
          const albumBonus = (eal && eal.length >= 4 && nd.includes(eal)) ? 200 : 0;
          if (artistHit && ct.length >= 1) take(20000 + et.length + albumBonus, e.file, 'tag', e);
          else if (ct.length >= 4) take(15000 + et.length + albumBonus, e.file, 'tag', e);
          else if (ct.length === 3) take(12000 + albumBonus, e.file, 'tag', e);
          else if (ct.length === 2) take(8000 + albumBonus, e.file, 'tag', e);
          else if (ct.length === 1 &&
                   ((ea.length >= 3 && nd.includes(ea)) || (eal.length >= 4 && nd.includes(eal))))
            take(18000, e.file, 'tag', e);   
          
        }
      }
      
      for (const e of idx.entries) {
        const et = norm(e.title);
        if (et.length >= 4 && nd && nd.includes(et)) take(2600 + et.length, e.file, 'tag');
      }
    }

    
    for (const f of library()) {
      const base = f.split('/').pop().replace(/\.[^.]+$/, '');
      const nb = norm(base);
      if (nb.length < 3) continue;
      if (nb === nd) take(10000, f, 'name');
      else if (nd && nd.startsWith(nb)) take(1000 + nb.length, f, 'name');
      else if (nb.startsWith(nd) && nd.length >= 3) take(900 + nd.length, f, 'name');
      else if (nb.length >= 5 && nd && nd.includes(nb)) take(500 + nb.length, f, 'name');
    }
    return best && best.score >= MIN_SCORE ? best : null;
  }

  
  function snapshot(force) {
    const np = readNowPlaying(force);
    const out = Object.assign({}, np);
    out.position = positionOf(np);
    out.matched = null;
    if (np.playing) {
      const q = () => matchFile(np.description || np.title, np.title, np.artist);
      let hit = q();
      if (!hit) { library(true); hit = q(); }
      if (!hit && readTagCache().entries.length === 0) { ensureTagIndex(); hit = q(); }  
      if (hit) {
        out.matched = hit.file; out.matchScore = hit.score; out.matchBy = hit.by;
        

        if (hit.entry) {
          out.rawTitle = out.title;
          if (hit.entry.title) out.title = hit.entry.title;
          if (hit.entry.artist) out.artist = hit.entry.artist;
          if (hit.entry.album) out.album = hit.entry.album;
        }
      }
    }
    return out;
  }

  
  function dispatch(key) {
    const allow = ['play', 'pause', 'play-pause', 'next', 'previous', 'stop'];
    if (allow.indexOf(key) < 0) return { ok: false, error: '不支持的命令: ' + key };
    try {
      rish('cmd media_session dispatch ' + key, 10000);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  
  
  function lanHost(port) {
    try {
      const ifaces = os.networkInterfaces();
      
      const score = (n) => {
        if (/^wlan\d*$/.test(n)) return 100;
        if (/^(eth|ap|wifi)\d*$/.test(n)) return 90;
        if (/^rmnet/.test(n)) return 50;
        if (/^(tun|tap|vgate|ppp|p2p|dummy)/.test(n)) return 5;
        return 40;
      };
      const cands = [];
      for (const n of Object.keys(ifaces)) {
        for (const ni of ifaces[n] || []) {
          if (ni.family === 'IPv4' && !ni.internal &&
              /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address)) {
            cands.push({ n, addr: ni.address, s: score(n) });
          }
        }
      }
      cands.sort((a, b) => b.s - a.s);
      if (cands.length) return cands[0].addr + ':' + port;
    } catch (e) {  }
    return null;
  }

  function baseUrlOf(req) {
    const h = (req && req.headers) || {};
    let host = h.host || 'localhost';
    const proto = h['x-forwarded-proto'] || (req && req.connection && req.connection.encrypted ? 'https' : 'http');
    
    const conf = String(cfg.publicBaseUrl || '').replace(/\/+$/, '');
    if (conf) {
      if (/\/plugins\/music-remote$/.test(conf)) return conf;
      return conf + '/plugins/music-remote';
    }
    
    const hn = host.split(':')[0];
    if (hn === '127.0.0.1' || hn === 'localhost' || hn === '::1') {
      const port = host.split(':')[1] || '16484';
      const lh = lanHost(port);
      if (lh) host = lh;
    }
    const url = (req && req.url) || '';
    const idx = url.indexOf('/plugins/music-remote');
    const prefix = idx >= 0 ? url.substring(0, idx) : '';
    return proto + '://' + host + prefix + '/plugins/music-remote';
  }

  function buildGcuiPage(snap, base) {
    const children = [];

    if (!snap.ok) {
      children.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 12, children: [
          { type: 'avatar', text: '♪', size: 64 },
          { type: 'text', text: '读不到媒体会话', style: 'title3' },
          { type: 'text', text: snap.error || '未知错误', style: 'caption', maxLines: 3 },
          { type: 'divider' },
          { type: 'text', text: '需要 Shizuku 正在运行（插件用 shell 权限读系统媒体会话）', style: 'caption', maxLines: 2 },
          { type: 'button', text: '重试', style: 'outlined', shape: 'full', action: { type: 'intent', endpoint: 'intent/control', body: { cmd: 'refresh' } } }
        ]
      });
    } else if (!snap.playing) {
      children.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 12, children: [
          { type: 'avatar', text: '♪', size: 64 },
          { type: 'text', text: '没有在播放', style: 'title3' },
          { type: 'text', text: '在手机上随便哪个播放器放首歌，这里就会自动跟随', style: 'caption', maxLines: 2 },
          { type: 'button', text: '刷新', style: 'outlined', shape: 'full', action: { type: 'refresh' } }
        ]
      });
    } else {
      const info = [{ type: 'avatar', text: '♪', size: 64 }];
      info.push({ type: 'text', text: snap.title || '未知曲目', style: 'title3', maxLines: 2 });
      if (snap.artist || snap.album) {
        info.push({ type: 'text', text: [snap.artist, snap.album].filter(Boolean).join(' · '), style: 'caption', maxLines: 1 });
      }
      const badges = [{ type: 'badge', text: snap.playingBool ? '播放中' : '已暂停', tone: snap.playingBool ? 'success' : 'neutral' }];
      if (!snap.matched) badges.push({ type: 'badge', text: '无法转发', tone: 'warning' });
      info.push({ type: 'row', gap: 8, children: badges });
      children.push({ type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 12, children: info });

      if (!snap.matched) {
        children.push({
          type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 8, children: [
            { type: 'text', text: '这首歌不在本机音乐目录里', style: 'body', maxLines: 2 },
            { type: 'text', text: '只有本地存储的音频才能转发（网络/在线音源拿不到文件）。在插件设置里可加音乐目录。', style: 'caption', maxLines: 3 }
          ]
        });
      }

      children.push({
        type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 8, children: [
          { type: 'kv', label: '手机进度', value: fmtTime(snap.position / 1000) },
          { type: 'kv', label: '来源', value: snap.pkg || '-' },
          { type: 'kv', label: '本地文件', value: snap.matched ? path.basename(snap.matched) : '（未匹配）' }
        ]
      });

      if (snap.matched) {
        const url = base + '/player';
        children.push({
          type: 'card', variant: 'outlined', shape: 'extraLarge', gap: 8, children: [
            { type: 'text', text: '在浏览器里收听（不想听可以静音）', style: 'body', maxLines: 2 },
            { type: 'text', text: url, style: 'caption', maxLines: 1 },
            { type: 'button', text: '复制播放器地址', style: 'outlined', shape: 'full',
              action: { type: 'copy', text: url, toast: '已复制' } }
          ]
        });
      }

      const ctl = [];
      if (snap.playingBool) ctl.push({ type: 'button', text: '暂停', style: 'filled', shape: 'full', action: { type: 'intent', endpoint: 'intent/control', body: { cmd: 'pause' } } });
      else ctl.push({ type: 'button', text: '继续', style: 'filled', shape: 'full', action: { type: 'intent', endpoint: 'intent/control', body: { cmd: 'play' } } });
      ctl.push({ type: 'button', text: '上一首', style: 'outlined', shape: 'full', action: { type: 'intent', endpoint: 'intent/control', body: { cmd: 'previous' } } });
      ctl.push({ type: 'button', text: '下一首', style: 'outlined', shape: 'full', action: { type: 'intent', endpoint: 'intent/control', body: { cmd: 'next' } } });
      children.push({ type: 'row', gap: 8, children: ctl });
    }

    return { gcui: 1, title: '音乐远程播放', root: { type: 'column', gap: 12, children } };
  }

  
  ctx.registerRoute('GET', '/ui/player', (req, res, p) => {
    jsonRes(res, 200, buildGcuiPage(snapshot(), baseUrlOf(req)));
  });

  ctx.registerRoute('GET', '/data/now-playing', (req, res, p) => {
    const snap = snapshot();
    jsonRes(res, 200, {
      ok: snap.ok, playing: !!snap.playing, playingBool: !!snap.playingBool,
      state: snap.state || 'idle', title: snap.title || '', artist: snap.artist || '',
      album: snap.album || '', description: snap.description || '', rawTitle: snap.rawTitle || '',
      position: snap.position || 0, pkg: snap.pkg || '',
      matched: !!snap.matched, file: snap.matched ? path.basename(snap.matched) : '',
      error: snap.error || '', message: snap.message || ''
    });
  });

  ctx.registerRoute('GET', '/stream', (req, res, p) => {
    const snap = snapshot();
    
    const qs = String(req.url || '').split('?')[1] || '';
    const qf = (qs.match(/(?:^|&)file=([^&]*)/) || [])[1];
    let fp = null;
    if (qf) {
      try { fp = decodeURIComponent(qf); } catch { fp = qf; }
      if (!inRoots(fp)) return jsonRes(res, 403, { error: '文件不在允许的音乐目录内' });
    } else {
      if (!snap.matched) return jsonRes(res, 404, { error: snap.ok ? '没有匹配到本地音频文件' : (snap.error || '读不到媒体会话') });
      fp = snap.matched;
    }
    if (!fs.existsSync(fp)) return jsonRes(res, 404, { error: '文件不存在: ' + fp });
    const stat = fs.statSync(fp);
    const size = stat.size;
    const mime = mimeForFile(fp);
    const range = req.headers.range;
    const hdr = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
    if (range) {
      const mm = /bytes=(\d*)-(\d*)/.exec(range);
      let start = mm && mm[1] ? parseInt(mm[1], 10) : 0;
      let end = mm && mm[2] ? parseInt(mm[2], 10) : size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= size) end = size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
      hdr['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
      hdr['Content-Length'] = String(end - start + 1);
      res.writeHead(206, hdr);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(fp, { start, end }).pipe(res);
    } else {
      hdr['Content-Length'] = String(size);
      res.writeHead(200, hdr);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(fp).pipe(res);
    }
  });

  ctx.registerRoute('GET', '/art', (req, res, p) => {
    const snap = snapshot();
    if (!snap.matched) return jsonRes(res, 404, { error: '无封面' });
    const dir = path.dirname(snap.matched);
    const base = path.basename(snap.matched, path.extname(snap.matched));
    const cands = [];
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) cands.push(path.join(dir, base + ext));
    for (const n of ['cover', 'folder', 'Folder', 'album', 'Album', 'front']) for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) cands.push(path.join(dir, n + ext));
    for (const c of cands) {
      if (fs.existsSync(c)) {
        const mime = /\.png$/i.test(c) ? 'image/png' : (/\.webp$/i.test(c) ? 'image/webp' : 'image/jpeg');
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(fs.statSync(c).size), 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
        return fs.createReadStream(c).pipe(res);
      }
    }
    jsonRes(res, 404, { error: '无封面' });
  });

  ctx.registerRoute('GET', '/player', (req, res, p) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(playerHtml);
  });

  ctx.registerRoute('GET', '/library', (req, res, p) => {
    const all = library();
    const q = (String(req.url || '').split('?')[1] || '').match(/(?:^|&)q=([^&]*)/);
    let files = all;
    if (q && q[1]) {
      let needle = ''; try { needle = decodeURIComponent(q[1]).toLowerCase(); } catch { needle = q[1].toLowerCase(); }
      files = all.filter(f => f.toLowerCase().includes(needle));
    }
    jsonRes(res, 200, {
      roots: roots(), count: all.length, shown: Math.min(files.length, 300),
      files: files.slice(0, 300).map(f => ({ path: f, name: path.basename(f), dir: path.basename(path.dirname(f)) }))
    });
  });

  ctx.registerRoute('GET', '/debug', (req, res, p) => {
    const out = { rishPath: rishPath(), roots: roots(), libCount: library().length };
    try { out.raw = rish('cat /proc/uptime; dumpsys media_session', 12000).slice(0, 8000); }
    catch (e) { out.rawError = e.message; }
    out.snap = snapshot(true);
    
    const qs = String(req.url || '').split('?')[1] || '';
    const dq = qs.match(/(?:^|&)desc=([^&]*)/);
    if (dq && dq[1]) {
      let desc = ''; try { desc = decodeURIComponent(dq[1]); } catch { desc = dq[1]; }
      const tq = qs.match(/(?:^|&)title=([^&]*)/);
      let title = ''; try { title = tq && tq[1] ? decodeURIComponent(tq[1]) : ''; } catch { title = ''; }
      const hit = matchFile(desc, title || desc.split(', ')[0], '');
      out.matchTest = { desc, title, hit: hit ? hit.file : null, score: hit ? hit.score : 0, by: hit ? hit.by : '' };
    }
    out.tagIndex = { entries: readTagCache().entries.length, building: tagBuilding, cachedAt: readTagCache().at || 0 };
    if (/(?:^|&)rebuild=1/.test(qs)) { rebuildTagIndex(); out.tagIndex.rebuildStarted = true; }
    jsonRes(res, 200, out);
  });

  ctx.registerRoute('POST', '/control', (req, res, p) => {
    if (cfg.enableControl === false) return jsonRes(res, 403, { error: '远程控制已在插件设置里关闭' });
    const a = p.authAdmin ? p.authAdmin() : { ok: false };
    if (!a.ok && !p.userKey) return jsonRes(res, 401, { error: '需要管理员密钥或卡密' });
    const b = p.body || {};
    const r = dispatch(b.cmd);
    if (!r.ok) return jsonRes(res, 400, r);
    jsonRes(res, 200, { ok: true, now: snapshot(true) });
  });

  ctx.registerRoute('POST', '/intent/control', (req, res, p) =>
    ctx.security.guard(req, p, res, (uk) => {
      const b = p.body || {};
      if (b.cmd && b.cmd !== 'refresh') {
        if (cfg.enableControl === false) return { ok: false, error: '远程控制已关闭' };
        const r = dispatch(b.cmd);
        if (!r.ok) return { ok: false, error: r.error };
      }
      const snap = snapshot(true);
      const req2 = { headers: req.headers, url: req.url, connection: req.connection };
      

      return { ok: true, nav: 'replace', ui: buildGcuiPage(snap, baseUrlOf(req2)) };
    })
  );

  
  ensureTagIndex();

  ctx.log('音乐远程播放 v2 已激活 (媒体会话 + 标签/文件名匹配, 轮询 ' + (pollMs / 1000) + 's)');
};
