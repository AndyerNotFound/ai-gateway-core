# ai-gateway Plugin System Design (Finalized)

> Goal: differentiated relay features (check-in / membership plans / image-gen pages ...) via plugins, resolving the conflict between "features tailored to each site" and "building everything in explodes the workload".
> Decision record: open but unaudited (trust-based + SHA256 verification); no official index for now (manual zip links + custom index URLs supported); plugin settings wrapped in a WebView; the user home page gets a plugin section; full version (server + frontend), delivered in phases.

---

## 0. Core principles

1. **A plugin = server-side logic + frontend page, both halves.** Check-in/membership/image-gen all need server-side storage, so frontend-only plugins are not enough.
2. **All plugin UI lives inside a WebView**, never touching native UI -> frontend compatibility stays controllable; a badly written plugin cannot crash the App.
3. **Per-instance enablement**: every gateway instance installs/enables/configures plugins independently.
4. **Trust-based**: a plugin is arbitrary JS with full capabilities. Safety rests on "mandatory SHA256 source verification + explicit risk disclosure on the install page + only adminKey may install", with no forced sandbox (a restricted require whitelist is available as an option).

---

## 1. Plugin package structure

One zip package (or directory); the root must contain `manifest.json`:

```
<plugin-id>.zip
├── manifest.json      # required, metadata
├── server.js          # optional, server-side logic (gateway endpoints / cron / hooks)
├── pages/             # optional, frontend pages (loaded in the App WebView)
│   ├── user.html      #   user-side home section entry
│   └── admin.html     #   admin settings page
└── icon.png           # optional, icon
```

## 2. manifest.json spec

```json
{
  "id": "signin",                  // required, unique, lowercase alphanumeric+hyphen, = directory name
  "name": "Daily Check-in",               // required
  "version": "1.0.0",              // required
  "author": "xxx",
  "description": "Users check in daily for quota",
  "icon": "icon.png",
  "minGateway": "1.4.0",           // minimum gateway version
  "hasServer": true,               // whether server.js exists
  "userPage": "pages/user.html",   // user-side section entry (shown in the user home when present)
  "adminPage": "pages/admin.html", // admin settings page (clickable from the admin panel when present)
  "permissions": ["storage", "hook", "gateway:grantQuota"],
                                        // permission declarations (disclosure purpose, see §9)
  "configSchema": [                 // settings form (admin WebView / auto-generated form)
    {"key":"rewardTokens","label":"Check-in reward quota","type":"number","default":1000}
  ]
}
```

## 3. Server-side plugin API (server.js)

`server.js` uses CommonJS and exports `activate(ctx)` / optional `deactivate()`:

```js
module.exports = {
  activate(ctx) {
    // register endpoints: GET /plugins/signin/status
    ctx.registerRoute('GET', '/status', async (req, res, params) => { ... });
    ctx.registerRoute('POST', '/checkin', async (req, res, params) => { ... });

    // data persistence (auto-flushed to plugins-data/<id>.json)
    const rec = ctx.data.get('sign_' + uid) || {};
    ctx.data.set('sign_' + uid, { ...rec, last: Date.now() });   // set marks dirty; flushed on a timer

    // scheduled tasks
    ctx.cron(3600_000, () => ctx.log('every hour'));

    // hooks (optional, use with care)
    // ctx.hook('afterResponse', (info) => {...});

    // gateway capabilities (gated by permissions)
    // await ctx.gateway.grantQuota(keyId, tokens);   // add quota to a key card
    // const inst = ctx.gateway.instanceName;
  },
  deactivate() {}   // cleanup on uninstall/disable
};
```

### Full ctx interface

| Interface | Description |
|---|---|
| `ctx.id` / `ctx.instanceName` | plugin id / owning instance name |
| `ctx.registerRoute(method, path, handler)` | registers `/plugins/<id><path>`; handler(req,res,params) where params carries query/body/auth info |
| `ctx.data.get(k)` / `set(k,v)` / `del(k)` / `all()` | plugin-private KV, auto-persisted to `plugins-data/<id>.json` (30s dirty flush) |
| `ctx.cron(ms, fn)` | scheduled task (auto-cleaned on disable) |
| `ctx.hook(name, fn)` | `beforeRequest` (rewrite the body) / `afterResponse` / `onRequestLog` |
| `ctx.gateway.grantQuota(keyId, tokens)` | add quota to a key card (needs the `gateway:grantQuota` permission) |
| `ctx.gateway.findKey(token)` | look up a key record by card token (verify the caller's identity) |
| `ctx.config` | plugin settings (filled on the admin settings page, per configSchema) |
| `ctx.log(msg)` | write to the instance log |

## 4. Routes and endpoints

- **Plugin endpoints**: `/plugins/<id>/<path>` (with an instance prefix: `/<instance>/plugins/<id>/<path>`). Auth is the plugin's own decision (use ctx.gateway.findKey to verify key cards).
- **User-side plugin list**: `GET /plugins` -> this instance's enabled plugins that have a userPage (id/name/icon/desc).
- **First-login prompt**: `GET /plugins/required` -> the admin-configured recommended plugin list (cfg.requiredPlugins).
- **Admin API** (requires adminKey):
  - `GET /admin/api/plugins/:inst` -> installed list + status
  - `POST /admin/api/plugins-install/:inst` {zipUrl, sha256?} or {indexUrl, id} -> download, verify, install
  - `POST /admin/api/plugins-remove/:inst` {id, keepData?}
  - `POST /admin/api/plugins-enable/:inst` {id, enable}
  - `GET/POST /admin/api/plugins-config/:inst/:id` -> read/write plugin settings

## 5. Files and storage

```
~/ai-gateway/
├── plugins/<id>/            # extracted plugin package (per instance? see note below)
├── plugins-data/<inst>/<id>.json   # plugin data (isolated per instance)
└── config[.<inst>].json     # cfg.plugins = [{id, enable, version, config:{}}]
```

> Note: plugin **code** is shared globally (plugins/<id>/); **enablement, config, and data** are per-instance. The default master instance uses the same mechanism as any other instance.
> Add `plugins` / `plugins-data` to RESERVED_PATHS (so they cannot be taken as instance names).

## 6. Install / update / uninstall

**Install** (one of three sources):
1. Manual zip direct link (sha256 optional; if absent it is computed after download and shown for user confirmation)
2. Pick a plugin from a custom index URL (index.json)
3. Local path (Termux already has zip)

Flow: download -> **SHA256 verification** (strong when provided) -> extract to a temp dir -> validate manifest (legal id / hasServer matches a file) -> move to plugins/<id>/ -> register in cfg.plugins -> **hot load** (loadPlugin).

**Update**: download the new version -> verify -> back up the old dir -> replace -> reload.
**Uninstall**: deactivate -> remove from cfg -> delete plugins/<id>/ (data kept by default, optional delete).

## 7. Index repository format (no official index this phase)

`index.json`:
```json
{
  "name": "Some Plugin Source",
  "plugins": [
    {"id":"signin","name":"Daily Check-in","version":"1.0.0","author":"x",
     "description":"...","icon":".../icon.png",
     "zipUrl":"https://.../signin-1.0.0.zip","sha256":"..."}
  ]
}
```
The admin panel can add several custom index URLs; the list page merges them and labels each source.

## 8. App side

### Admin side
- Bottom-bar slot 5 candidate (or top-bar menu) "Plugins" page:
  - installed list (name/version/enable switch/source)
  - tap a plugin -> sub-page: loads adminPage in a WebView when present, otherwise auto-generates a form from configSchema
  - "Install plugin": enter a zip link / an index URL to browse
- The plugin page also configures "recommended plugins" (cfg.requiredPlugins)

### User side
- Home page gains a "Plugins" section: cards for plugins with a userPage -> tap loads `user.html` in the WebView

### WebView container + JSBridge (whitelist)
Plugin pages (user.html/admin.html) run in a WebView and reach native capabilities through a JSBridge (**whitelist only**, exactly these):
```js
window.AGW.getToken()            // the current user's key card / admin temp token
window.AGW.callApi(path, opts)   // call this instance's API (instance prefix + auth added automatically)
window.AGW.close()               // close the plugin page
window.AGW.toast(msg)
```
> The JSBridge is the only channel; plugin pages may not connect to arbitrary external hosts with user data (WebView domain whitelist: only this gateway + domains the plugin declares).

## 9. Security model

| Measure | Description |
|---|---|
| Mandatory SHA256 verification | a hash mismatch against the index refuses installation |
| Only adminKey may install/uninstall/configure | users can use plugins but never install them |
| Risk disclosure | the install page prominently warns "a plugin = fully trusted code; verify its source" |
| Permission declarations | manifest.permissions is explicit; sensitive capabilities (grantQuota etc.) are granted only if declared |
| WebView domain whitelist | plugin page network requests are limited to whitelisted domains |
| Data isolation | one json per plugin; path checks block `..` traversal |

## 10. Phased plan

| Phase | Content | Output |
|---|---|---|
| **Phase 1 gateway core** | plugin loader (scan/manifest/server.js activation/route registration/data store/cron) + /plugins routes + admin API + one sample plugin (hello+signin) | the gateway can install/run plugins |
| **Phase 2 App admin** | plugin list page + install (zip link/index URL) + WebView settings + requiredPlugins config | admins can manage plugins |
| **Phase 3 App user side** | home plugin section + WebView user page + JSBridge + first-login prompt | users can use plugins |
| **Phase 4 rider features** | key length 8-128, model square grouped by channel, user permission completion, email verification codes (SMTP) | experience completion |

## 11. First sample plugins (phase 1 validation)

1. **hello**: minimal skeleton; registers `/plugins/hello/ping` returning `{msg:"pong"}`; validates loading/routing/data.
2. **signin (daily check-in)**: server.js records check-ins + calls grantQuota; user.html has the check-in button + streak; admin.html configures the reward. Validates the full loop.

---

_Finalized 2026-09-09. Later phases treat this document as authoritative; changes must update it._

---

## §GC Gay Core App integration (SDUI, 2026-09-10)

> The App frontend does **not** use a WebView: plugin UI = gcui JSON declarations rendered with native Material components.

### manifest extension

```jsonc
{
  "provides": ["user-system"],          // capability declaration (user-system -> the App "Profile" tab is provided by this plugin)
  "appUi": {
    "personal":  { "title": "Profile", "icon": "person", "ui": "/ui/personal" },
    "home":      { "title": "Check-in", "icon": "check",  "ui": "/ui/home" },   // home component
    "bottomBar": { "id": "signin", "title": "Check-in", "icon": "check", "ui": "/ui/home" },
    "settings":  { "title": "Check-in settings", "ui": "/ui/settings" },
    "pages":     [ { "id": "rank", "title": "Leaderboard", "icon": "list", "ui": "/ui/rank" } ]
  }
}
```

- `ui` = an endpoint path relative to the plugin; `ctx.registerRoute('GET', '/ui/personal', ...)` returns gcui JSON.
- Everything is optional; undeclared slots never appear in the App.

### gcui page format (`"gcui": 1`)

```jsonc
{ "gcui": 1, "title": "Page title", "state": { /* template data source */ },
  "root": { "type": "column", "gap": 12, "children": [ ...components... ] } }
```

Component whitelist: column/row/card/text/button/input/switch/progress/kv/image/icon/divider/spacer/list.
- Templates: `{{state.x}}`, `{{input.key}}`, `{{item.x}}` (list), `{{user.uid}}` inside strings; a whole-string single template preserves the original type.
- `visible`: settable on any component; truthiness controls display.
- `weight`: child proportions in column/row.
- Colors are theme tokens only (`"$primary"` etc.); bare hex is forbidden (anti visual-spoofing).

### Actions

```jsonc
{ "type": "intent", "endpoint": "./checkin", "body": {"k":"{{input.x}}"}, "confirm": "...", "then": "reload", "pop": false }
{ "type": "open", "target": "page:xxx" | "https://..." }
{ "type": "copy", "text": "{{state.key}}", "toast": "Copied" }
```

### Intent endpoints (must use the signature guard)

```js
ctx.registerRoute('POST', '/intent/checkin', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
  // uk = the signature-verified + authenticated key card record; the guard handles: HMAC verification / +/-5min time window / nonce dedup / sequence anti-rollback / idempotent replay cache
  return { ok: true, toast: 'checked in', ui: null };  // when ui is present the App replaces the whole page; otherwise `then` applies
}));
```

- On a client sequence rollback the guard returns `{error, currentSeq}` and the App auto-corrects and retries.
- Security records live in `plugins-data/<uid>/.gc-security.json`; key cards are never stored (only their sha256).

### Theme plugins (type:"theme")

Style tokens only, **enforced by the kernel**: a theme plugin carrying server.js or permissions is refused at load.
The built-in theme-md3 is the default theme and cannot be uninstalled/hidden (bootstrap injects it as a fallback).

### App support API (kernel)

| Endpoint | Description |
|---|---|
| `GET /api/app/bootstrap` | aggregate: server profile/branches/plugin disclosures (permissions + SHA256)/theme/layout/debug mode |
| `GET/POST /admin/api/server-info` | server profile (name/blurb/icon/notice, field whitelist) |
| `GET/POST /admin/api/client-config/:uid` | user-side default layout + user debug mode {uid, minutes} |
| `GET /admin/api/audit/:uid?limit=` | audit log reads |
| `GET/POST /admin/api/market/test-mode` | test mode (off by default: custom plugin sources forbidden) |
