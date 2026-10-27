# ai-gateway-core Design Document

> Positioning: the architecture blueprint for ai-gateway's evolution from a "monolithic gateway tool" into a "lean kernel + plugin ecosystem" platform.
> Complements [PLUGIN-DESIGN.md](./PLUGIN-DESIGN.md) — that one defines "how to write a plugin"; this one defines "what the kernel keeps, what plugins own, and how to migrate from the existing code".
> Status: design phase, no code touched yet. Implementation follows §8 after review approval.

---

## 0. Background & motivation

The existing `gateway.js` has grown to 3388 lines, cramming protocol conversion, channel routing, failover, thinking-chain condensing, extended endpoints, probing, auth, and the multi-instance pool into one file. The problems:

1. **Large bug-search space**: a request crosses 7-8 functional layers from entry to exit; finding a fault means hunting through 3000 lines.
2. **Fragile renames**: an instance name plays two roles at once — "routing prefix" and "config reference key" — so renaming breaks plugin config associations (already bitten: gunmu/bai -> AgnesAI/SOTA-Model).
3. **Feature coupling**: the thinkingSummary hook lives inside the canonical writer; openaiExtras hard-depends on the routing table; disabling one feature means sprinkling `if (enable)` switches in several places, and the switches scatter.
4. **Hard to evolve**: every new feature gets stuffed into gateway.js; the file only grows.

The core refactor's goal is not "tear it down and rewrite" — it is to **split what does not belong in the kernel into plugins, making the kernel thinner and the boundaries clearer**. Once the kernel stabilizes, new features land in the plugin layer, shrinking the debug search space from "the whole gateway" to "one plugin".

---

## 1. Architecture philosophy

### 1.1 Kernel + mod fractal recursion

Every finished application is fundamentally "kernel + mods": Minecraft is a kernel of mods, but Minecraft runs on the JVM, which is its kernel; the JVM runs on an OS, and the OS kernel is in turn the JVM's kernel. Each layer's kernel is the foundation for the layer above and itself a mod of the layer below. There is no bottom; it's nesting dolls all the way down.

ai-gateway's layers:
```
OS kernel (Linux + Termux bionic)
  └─ Node.js runtime
       └─ ai-gateway-core (forwarding kernel)        <- the boundary this document defines
            ├─ canonical hub (protocol conversion)    <- the kernel's soul
            ├─ channel routing + failover + retry     <- kernel
            ├─ checkAuth hook + default impl          <- kernel
            ├─ PluginManager (plugin loader)          <- kernel
            └─ plugin ecosystem
                 ├─ auth plugins (key cards/TOTP/OAuth)   <- register into the checkAuth hook
                 ├─ thinkingSummary plugin                <- hooks the canonical writer
                 ├─ openaiExtras plugin                   <- registers extended endpoints
                 ├─ probe plugin
                 ├─ tunnel/balance/check-in ...           <- standalone side plugins
                 └─ user-built plugins
```

### 1.2 Kernel responsibility test

**Core rule: if a capability will be shared or depended on by multiple plugins, it belongs in the kernel.**

Because once it becomes a plugin, every plugin using it must make cross-plugin calls — deeper coupling than putting it in the kernel, and bugs then cross boundaries. Conversely: if a feature is not depended on by other plugins and is merely "popular with users", it belongs in the plugin layer — no matter how stable it runs, it must not be bundled into the kernel.

### 1.3 The stability paradox

Once the kernel exposes an API to plugins, it is nailed down — changing kernel APIs breaks every plugin. So pluginization is not "write the kernel once, relax forever"; it is "write the kernel once, then resist touching it". This means: **the plugin context API must be designed right the first time; better to think one more round than to rush a release.** Later evolution happens by "adding new APIs", never "changing old APIs".

### 1.4 Plugin = executable configuration

Software engineering's end state is "write one general-enough kernel; everything else is configuration". A mod is nothing more than "executable configuration" — it adds logic to static config, but at its core it still "declares behavior on top of the kernel". From that angle, ai-gateway's differentiation (check-in/membership/image generation/top-up) all belongs to the "configuration layer"; the kernel only forwards.

---

## 2. Kernel boundary (core scope)

### 2.1 Must stay in the kernel (untouchable)

| Feature | Current location | Why it stays |
|------|---------|-----------|
| HTTP server + multi-instance routing + RESERVED_PATHS | startServer / poolRoute / RESERVED_PATHS | The entry and routing of forwarding; without it, it is not a gateway |
| canonical hub (OpenAI/Claude/Gemini/Responses conversion) | canonicalTo*Body / canonicalTo*Resp / makeWriter | Every plugin may produce/consume different formats; this is the foundation |
| Channel routing (modelMap/models/default/round-robin) | buildRequestForChannel / pickChannels | The entire meaning of "forwarding" |
| Failover + retry + keepAlive agents | handleChat's doSend / isConnErr | The heart of forwarding reliability; multi-channel depends on it |
| SOCKS5 / HTTP CONNECT proxy | custom Agent | The outbound channel; multiple plugins may need it |
| checkAuth hook + default impl (gatewayKey) | checkAuth | See §3; the hook must be kernel-held |
| PluginManager itself | plugins.js | The precondition for "plugins can load"; cannot itself be a plugin (chicken and egg) |
| Config load/save (AGWENC1 encryption) | loadConfig / saveCfg | Kernel state persistence |
| Basic stats/log structures | stats / log | Every plugin writes stats and logs |

### 2.2 Detachable as "built-in plugins" or standalone modules

These features are currently fused into gateway.js and will be split out in the refactor, ordered by "depth of dependence on kernel internals":

| Feature | Current location | Dependence depth | Split approach |
|------|---------|---------|------|
| thinkingSummary (thinking-chain condensing) | lines 192-440 | deep (hooks makeWriter) | kernel exposes a `wrapWriter` hook; plugin registers middleware |
| openaiExtras (extended endpoints) | lines 2051-2642 | deep (depends on routing table + canonical) | kernel exposes a `registerExtraEndpoint` hook |
| redactDeep (privacy filter) | line 89 | medium (request/response middleware) | `onRequest` / `onResponse` hooks |
| Multi-instance pool (single process) | lines 3251-3384 | medium (server extension) | kernel module or built-in plugin |
| setupProbe (success-rate probing) | line 1957 | shallow (own timer + stats writes) | pure side plugin |
| cloudflared tunnel | admin.js | shallow (spawn process + expose URL) | pure side plugin |
| Channel balance lookup | admin.js | shallow (standalone HTTP + preset table) | pure side plugin |
| User system/registration/Turnstile | gateway.js + admin.js | medium (depends on auth hook) | auth plugin + user-management plugin |
| Key card system (apiKeys/credits/quota) | checkAuth + admin.js | medium (a strategy over the auth hook) | auth plugin (registered into the checkAuth hook) |

### 2.3 Boundary cases: thinkingSummary and openaiExtras

These two are the classic "want to split but can't split cleanly":

- **thinkingSummary** wraps the writer produced by `makeWriter`, intercepting reasoning events. As a plugin it needs the kernel to expose `wrapWriter(format, writer) -> newWriter`. Performance loss is negligible (one extra function call), but the hook point is rather intimate (the writer is the core abstraction of the streaming pipeline).
- **openaiExtras**' extended endpoints (/v1/images, /v1/embeddings, etc.) hard-depend on the kernel's routing table and channel selection. As a plugin it needs `registerExtraEndpoint(method, path, handler)` where the handler can access the "selected channel" context.

**Decision**: both become built-in plugins, implemented via "kernel-exposed hooks" rather than "plugins reading kernel internals". Hooks are part of the public API (see §7); once published they are nailed down, so design them right the first time. If the hook design cannot be settled short-term, leave the feature in the kernel behind an `enable` switch marked `// TODO: to be hooked`, and do not force the split.

---

## 3. Auth design

### 3.1 checkAuth hook architecture (core)

Auth cannot be purely pluginized — chicken and egg: an incoming plugin request needs auth first, so how does the "key-card plugin" itself load? Who loads first?

**Two layers**:
- The kernel holds the `checkAuth` hook point + one default implementation (a simple `gatewayKey` comparison)
- Auth strategies (key cards/TOTP/OAuth/second factor) = "auth plugins" registered into the hook

Analogy: Linux PAM, Spring Security's AuthenticationProvider — what is pluggable is the strategy, not the authentication point itself.

```
request arrives
  -> kernel checkAuth(req) invokes the registered auth strategy chain
      ├─ gatewayKey default impl (built-in, lowest priority)
      ├─ key-card auth plugin (if installed) -> checks apiKeys
      ├─ TOTP second-factor plugin (if installed) -> verifies adminAuth
      └─ ... other auth strategies
  -> the first matching strategy on the chain returns {ok, userKey, ...}: pass
  -> none match -> 401
```

### 3.2 Load order (nailed by the lifecycle)

```
1. kernel starts
2. load config (instances.json master index + instances/<uid>.json)
3. load auth plugins (marked type:'auth')         <- before business plugins
   ├─ an auth plugin's activate() failing -> block subsequent loading (fail-closed)
   └─ auth plugins call registerAuth(strategy) into the checkAuth hook
4. load business plugins (marked type:'business')
5. startServer, begin accepting requests
```

Auth plugins must load before business plugins, otherwise a check-in plugin cannot access auth context at runtime. This order is hard-coded in the PluginManager, not configured.

### 3.3 First-install setup mode

A whitelist replaces "bypass auth + restricted access" (blacklist):

- On startup, check whether `instances.json` has an admin record
- No admin -> enter setup mode
  - setup mode exposes exactly one endpoint: `POST /setup/admin` (create the first admin: set password / bind TOTP)
  - every other endpoint (read config, edit instances, install plugins, /v1/*) returns 403
  - bound to localhost only (non-127.0.0.1 sources are refused outright)
  - 10 minutes after first boot it auto-locks (unfinished setup locks; users recover via the CLI `agw.sh setup-reset`)
- Admin created -> setup mode closes and the "auth required" mode begins, never returning to setup

Blacklist vs whitelist: a blacklist ("bypass auth but cannot access key-protected files") leaks easily — add a new endpoint, forget the deny list, and it is a hole. A whitelist ("you may only create an admin") has the smallest attack surface and no agonizing over "how strict is strict enough".

### 3.4 Second factor

`adminAuth` (secondKey + totpSecret) is a config item of the auth plugin, not a standalone module. When an admin logs into the panel, the TOTP strategy in the checkAuth chain engages; ordinary user requests go through the key-card strategy only. The TOTP implementation is RFC6238 (SHA1, 30s window, 6 digits, +/-1 tolerance) and already exists; keep it.

---

## 4. UID design

### 4.1 UID semantics

- UID = the instance's stable identity, never changes (even across renames)
- Instance name = for routing (the URL path prefix `/<name>/`), mutable
- UID and instance name are separated: renaming only touches the name, not the UID, so plugin config references never break

### 4.2 Generation strategy

**Sequential allocation + 32-bit**:
- Increment from 1, persisting a `nextUid` counter (kept in the `instances.json` master index so restarts cannot rewind it)
- A 32-bit sequence covers 4 billion instances — "is it enough" stops being a question
- Never collides (vs the birthday-paradox risk of random allocation)
- Short, readable UIDs (1, 2, 3...) are recognizable at a glance in config files

**Why not random**: a random UID collision forces regeneration, and regeneration breaks every plugin config referencing the old UID. Sequential allocation kills collisions at the root.

### 4.3 Supporting mechanisms

- On startup, scan globally for UID uniqueness; auto-regenerate duplicates (extreme case: the user hand-copied a config file)
- Validate UIDs on instance export/import; on conflict, warn "importing will change the UID and break associated plugin configs"
- Provide `agw.sh reset-uid <instance>` (last-resort; breaks all of that instance's plugin configs; forced confirmation before execution)
- Never put the UID in filenames (no `config.inst_3.json`), because that couples "instance name (routing)" with "UID (reference)", defeating the abstraction

### 4.4 UID size is unrelated to "instance count limits"

UID width determines the identity-space size (collision odds + readability), not the instance count limit. Instance count is a storage/performance question. A future "storage backend plugin" can swap file storage for SQLite/remote storage and instance counts rise, regardless of UID width. So there is no need to worry that "one day instances will outgrow the UID" — that is the storage layer's business.

---

## 5. Storage design

### 5.1 Master index + distributed files

Borrowing from databases (index + data files) and git (refs index + scattered objects):

```
~/.agw/                              # or the DATA_DIR chosen at instantiation
├── instances.json                   # master index (lightweight metadata)
│   {
│     "nextUid": 27,
│     "setupMode": false,
│     "instances": [
│       { "uid": 1, "name": "AgnesAI", "port": 16384, "enabled": true, "file": "instances/1.json" },
│       { "uid": 2, "name": "SOTA-Model", "port": 16385, "enabled": true, "file": "instances/2.json" },
│       ...
│     ]
│   }
├── instances/
│   ├── 1.json                       # instance 1's heavy config (channels/listen/plugin refs/adminKey...)
│   ├── 2.json
│   └── ...
├── plugins-config/                  # plugin configs (isolated per plugin, UID-referenced)
│   ├── signin.json                  # { "1": {rewardTokens:1000}, "2": {rewardTokens:500} }
│   ├── auth-cardkey.json            # key-card auth plugin config
│   └── probe.json
├── plugins-data/                    # plugin runtime data (unchanged from today)
│   ├── 1/                           # isolated per instance UID
│   │   └── signin.json
│   └── 2/
└── plugins/                         # plugin packages themselves (unchanged)
    ├── hello/
    └── signin/
```

### 5.2 Responsibilities per layer

| File | Content | Written by | Encrypted |
|------|------|------|------|
| instances.json | UID+name+port+enabled+file pointer+nextUid+setupMode | kernel | no (no sensitive fields) |
| instances/<uid>.json | channels (with apiKey)/listen/adminKey/enabled plugin list | kernel | field-level encryption of sensitive fields (apiKey/adminKey) |
| plugins-config/<id>.json | that plugin's per-instance configs, grouped by UID | that plugin (via ctx.setPluginConfig) | plugin's choice (sensitive fields can use ctx.encrypt) |
| plugins-data/<uid>/<id>.json | plugin runtime data (check-in records etc.) | that plugin (ctx.data) | plugin's choice |

### 5.3 Encryption: field-level, not whole-file

AGWENC1 today encrypts whole files. The refactor moves to field-level encryption: only sensitive fields (apiKey/adminKey/user password hashes etc.) are encrypted; non-sensitive fields (ports/model names/enabled flags) stay plaintext. Benefits:
- The `instances.json` master index stays plaintext throughout — fast loads, routing tables built without decryption at startup
- Changing a non-sensitive field no longer re-encrypts the whole file
- Debugging configs is more readable (sensitive values shown masked)

The AGWENC1 algorithm is unchanged (scrypt + AES-256-GCM); only the granularity moves from "whole file" to "single field". Plugins get `ctx.encrypt(value)` / `ctx.decrypt(value)`.

### 5.4 Atomicity

- A single-instance config write = one file (`instances/<uid>.json`), atomic by nature
- Cross-file atomic operations (instance start/stop/reset/rename) are absorbed into kernel APIs; plugins are forbidden from cross-file writes
- Kernel APIs use "write temp file + rename" internally to guarantee atomicity
- On restart, verify consistency: the file pointer in the master index must exist; a missing file marks the instance `corrupted` with a warning

### 5.5 Instance status overview

A `agw.sh status <instance|UID>` command + a `GET /admin/api/instance-full/:uid` endpoint: aggregate by UID the instance's `instances/<uid>.json` plus its entries across all `plugins-config/*.json` into one complete view. One glance while debugging instead of stitching several files.

---

## 6. Plugin config model

### 6.1 UID references

Plugin config files reference instances by UID, not by name:

```json
// plugins-config/signin.json
{
  "1": { "enabled": true, "rewardTokens": 1000 },
  "2": { "enabled": false, "rewardTokens": 500 }
}
```

Rename `AgnesAI` to `Foo` and UID 1 is unchanged; signin's `"1"` still points at it. The rename trap is cured at the root.

### 6.2 Cross-plugin config access

Plugins never read each other's config files directly (that couples them and welds schemas together). Everything goes through the kernel plugin context API:

```js
// the check-in plugin wants to see what quota the card-key plugin gave a UID
const authCfg = ctx.getPluginConfig('auth-cardkey', uid);
const quota = authCfg?.quotaTokens || 0;
```

The kernel ctx acts as the middle layer, so plugin schemas can evolve independently. The cost is one extra function call per cross-plugin query, but config queries are not the hot path (request handling is); acceptable.

### 6.3 Plugin lifecycle

```
install -> activate (register routes/hooks/auth) -> run -> deactivate (cleanup) -> uninstall (delete config+data)
```

- Uninstall deletes config files together (clean)
- Disable (deactivate) keeps config and data; it just stops loading
- Deactivating an auth plugin shortens the checkAuth chain; warn "after disabling, this instance's auth degrades to gatewayKey only"

### 6.4 Bundling test

Once a feature runs stably, should it be "bundled into the kernel"? The test:

- Depended on by multiple other plugins -> bundle (e.g. key cards used by check-in/top-up/credits)
- Merely popular but not depended on -> keep in the plugin layer (e.g. signin no matter how stable is never bundled)
- Bundling = merging code into the kernel + promoting it to a kernel API, from "detachable" to "kernel contract" — **un-bundling later is very painful**. So bundle cautiously; prefer not to.

---

## 7. Plugin API boundary (plugin context)

### 7.1 Exposed to plugins (public API; frozen on release)

```js
ctx = {
  // -- config --
  getPluginConfig(pluginId, uid),        // read another plugin's config for an instance
  setPluginConfig(uid, config),          // write own config (single-file atomic)
  getInstanceConfig(uid),                // read an instance's config (sensitive fields masked)
  uid,                                   // UID of the instance the current request belongs to
  instanceName,                          // current instance name

  // -- auth (only type:'auth' plugins) --
  registerAuth(strategy),                // register an auth strategy into the checkAuth chain
  findKey(token),                        // look up a key card (exposed by auth plugins to business plugins)
  grantQuota(uid, tokens),               // add quota

  // -- HTTP --
  registerRoute(method, path, handler),  // register an endpoint (path relative to /plugins/<id>/)
  registerExtraEndpoint(method, path, handler),  // register a /v1/* extended endpoint (permission required)
  wrapWriter(format, writerFn),          // wrap a streaming writer (used by thinkingSummary)

  // -- middleware --
  onRequest(handler),                    // request middleware (used by redact)
  onResponse(handler),                   // response middleware

  // -- infrastructure --
  data,                                  // per-instance-isolated KV store (ctx.data.get/set)
  cron(intervalMs, fn),                  // scheduled tasks
  log(...), logErr(...),
  stats(uid, delta),                     // stats
  emit(event, data), on(event, fn),      // event bus
  encrypt(value), decrypt(value),        // field-level encryption

  // -- upstream calls --
  upstreamRequest(opts),                 // upstream request via the kernel agent pool (reuses proxy/keepAlive)
}
```

### 7.2 Not exposed (kernel-private)

- canonical hub internals (canonicalTo*Body etc.) — plugins intervene only indirectly via `wrapWriter` / `onResponse`
- Channel routing internals (pickChannels / buildRequestForChannel) — plugins use them indirectly via `upstreamRequest`
- Agent pool internals — indirectly via `upstreamRequest`
- Multi-instance pool internals (poolLoadInstance / poolRoute) — plugins read current-instance info via `ctx.uid` / `ctx.instanceName`

### 7.3 Permission declarations

manifest.json's `permissions` field declares the advanced APIs a plugin uses:

```json
"permissions": ["storage", "hook", "gateway:grantQuota", "gateway:registerExtraEndpoint", "auth:registerAuth"]
```

Risks are disclosed at install time and validated at runtime. Calling an undeclared API throws a permission error immediately.

---

## 8. Migration path

### 8.1 Current state

- 26 instances running (production relay environment)
- Per instance, a single `config.<name>.json` (channels/listen/plugins/adminKey/...)
- Plugin configs live in `cfg.plugins[]` (inside the instance config) + `plugins-data/<inst>/<id>.json`
- The instance name doubles as routing prefix and config reference key

### 8.2 Migration strategy: compatibility layer + automatic migration

Not the "configs incompatible, users reconfigure everything" route (reconfiguring 26 instances costs too much). Automatic migration instead:

1. On startup, detect the old format (`config.<name>.json` exists and `instances.json` does not)
2. Auto-migrate:
   - allocate UIDs sequentially by instance name (1, 2, 3...)
   - generate the `instances.json` master index
   - split each instance's config into `instances/<uid>.json`
   - move plugin configs from `cfg.plugins[]` to `plugins-config/<id>.json` (keys switch from names to UIDs)
   - keep old files as `config.<name>.json.bak-migrate`
3. Boot after migration and print a migration report in the log (N instances, M plugin configs migrated)
4. Verify: compare instance status before/after (ports/channel counts/plugin counts); on mismatch, roll back

### 8.3 Migration script design

```
agw.sh migrate              # detect + migrate the old format
agw.sh migrate --verify     # verify post-migration integrity (instance/channel/plugin count comparison)
agw.sh migrate --rollback   # restore the old format from .bak files
```

The migration script is separate from normal startup, but startup also auto-detects and hints "old format detected; run agw.sh migrate".

### 8.4 Gradual refactor order

Do not shred gateway.js in one go. Step by step, "risk low to high":

| Step | Content | Risk | Verification |
|------|------|------|------|
| 1 | Add the UID field (old configs compatible; when missing, allocate sequentially by name and write back) | low | instances run normally, UIDs written |
| 2 | Add the `instances.json` master index + `instances/<uid>.json` split (dual-write: both formats) | low | dual-write consistent; old clients unaffected |
| 3 | Switch reads: read the new format; the old format is read-only, never written | medium | instance status consistent after the switch |
| 4 | Add setup mode + checkAuth hook refactor (default impl keeps gatewayKey behavior) | medium | auth behavior matches the old version |
| 5 | Split setupProbe / cloudflared tunnel / balance lookup into built-in plugins | low | feature parity; switches migrated |
| 6 | Split thinkingSummary into a built-in plugin (expose the wrapWriter hook) | high | streaming condensing behavior identical; ordering intact |
| 7 | Split openaiExtras into a built-in plugin (expose registerExtraEndpoint) | high | extended endpoint behavior identical |
| 8 | Split key cards/user system into auth plugins | high | auth chain behavior identical |
| 9 | Remove old-format dual-writes; keep only the new format | medium | execute after confirming no rollback need |

Every step is independently rollbackable and runs the full test suite (existing 135 cases + new ones). Production cutover restarts instance by instance during off-peak hours after a step verifies.

---

## 9. Implementation phases

| Phase | Output | Acceptance criteria |
|------|------|---------|
| 0 design docs | this file | user review approved |
| 1 UID + storage refactor | instances.json + instances/<uid>.json + migration script | 26 instances auto-migrated, dual-write consistent, rollback works |
| 2 auth hook + setup mode | checkAuth hook + setup mode + default impl | auth behavior matches old; setup flow usable |
| 3 plugin API freeze | full ctx set + permission model + lifecycle | existing hello/signin plugins work on the new API |
| 4 feature splits | probe/tunnel/balance -> plugins | feature parity, switches migrated |
| 5 deep splits | thinkingSummary/openaiExtras -> plugins | streaming/extended-endpoint behavior identical |
| 6 auth pluginization | key cards/TOTP -> auth plugins | auth chain identical, load order correct |
| 7 cleanup | remove old-format dual-writes, remove stale .bak files | new format only, all tests pass |

---

## 10. Open questions (TBD)

1. **Plugin sandbox**: currently trust-based (arbitrary JS + SHA256 verification). Add a restricted require whitelist? The user has said "let them do whatever for now"; no forced sandbox yet, but the plugin context API is the de facto sandbox boundary (plugins cannot reach kernel internals).
2. **Official plugin index**: not for now; manual zip links + custom index URLs. Consider an F-Droid-like model once core stabilizes.
3. **Remote storage backend**: when instance counts outgrow file storage, build a storage-backend plugin (SQLite/remote). Not this phase.
4. **Plugin version compatibility**: a minGateway field exists, but the compatibility matrix of plugin upgrades vs kernel API upgrades is undecided; to be filled in after the plugin context API freezes.
5. **Cross-instance shared plugin configs**: currently per-instance. Support "a group of instances sharing one plugin config"? Not this phase; the UID reference model already supports it (several UIDs pointing at one config block).

---

## Appendix: relationship with PLUGIN-DESIGN.md

| PLUGIN-DESIGN.md | This document |
|------------------|--------|
| How to write a plugin (package structure/manifest/server.js/ctx) | What the kernel keeps, what plugins own, how to migrate |
| Finalized, being implemented (phase 1 done) | Design phase, under review |
| Defines the basic shape of ctx | Extends ctx (adds getPluginConfig/getInstanceConfig/encrypt etc.), defines what stays kernel-private |

The two documents do not conflict. Once this file is finalized, PLUGIN-DESIGN.md's ctx chapter expands per this file's §7.
