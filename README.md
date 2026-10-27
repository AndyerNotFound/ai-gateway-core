# ai-gateway-core

A **lean kernel + plugin ecosystem** AI gateway. Evolved from the monolithic [ai-gateway](https://github.com/AndyerNotFound/ai-gateway-AI) architecture, following the blueprint in [docs/CORE-DESIGN.md](docs/CORE-DESIGN.md).

- **Protocol conversion kernel**: any-to-any conversion between OpenAI Chat Completions / Claude Messages / Gemini generateContent / OpenAI Responses (requests + responses + streaming SSE)
- **Channel routing**: modelMap renames -> models list -> default fallback, with round-robin + failover + connection-level retries
- **Outbound proxies**: SOCKS5 / HTTP CONNECT (hand-written handshake, zero deps), per channel
- **Auth hooks**: a checkAuth strategy chain (think PAM); gatewayKey by default, key cards/TOTP registered by auth plugins
- **Setup mode**: first-install whitelist mode (localhost only + a 10-minute window) instead of a blacklist
- **UID storage**: instance UIDs (sequentially allocated 32-bit) are separate from instance names (routing prefixes), curing broken references after renames
- **Field-level encryption**: AGWENC1 (scrypt + AES-256-GCM); only sensitive fields are encrypted, the master index stays plaintext
- **Plugin system**: type:auth plugins load before type:business (fail-closed); declarative permissions

## Quick start

```bash
# first start (enters setup mode, 10-minute window)
node bin/agw-core.js start

# create the first admin (another terminal, on the same machine)
curl -X POST http://127.0.0.1:16384/setup/admin \
  -H 'Content-Type: application/json' \
  -d '{"adminKey":"your-admin-key"}'

# then configure channels with the admin key
curl http://127.0.0.1:16384/admin/api/instances -H 'x-admin-key: your-admin-key'
```

## Data directory

Defaults to `./data` (override with `--dir` or `AGW_DIR`):

```
data/
├── instances.json            # master index (UID + name + port + nextUid + setupMode) -- plaintext
├── instances/<uid>.json      # instance config (channels/listen/adminKey) -- sensitive fields encrypted
├── plugins-config/<id>.json  # plugin configs (instances referenced by UID)
├── plugins-data/<uid>/<id>…  # plugin runtime data
└── plugins/<id>/             # plugin packages
```

## Migrating from older ai-gateway

```bash
node bin/agw-core.js migrate --from ~/ai-gateway   # detect + migrate config.*.json
node bin/agw-core.js migrate --verify              # verify migration integrity
node bin/agw-core.js migrate --rollback            # roll back
```

## CLI

```
agw-core start [--dir D] [--port P]   start (multi-instance single process by default)
agw-core status [instance]            instance status overview
agw-core migrate [--from DIR]         migrate the old format
agw-core uid-reset <instance>         reset the UID (breaks plugin configs; use with care)
```

## Plugin market

The panel's "Plugins" page has a built-in market: add an index link -> browse -> one-click install. CLI also works:

```bash
node bin/agw-core.js plugin-install <url|local path> [--sha256 X] [--proxy http://127.0.0.1:7890]
node bin/agw-core.js plugin-list
node bin/agw-core.js plugin-remove <id>
```

Plugin packages are `.tar.gz` (containing manifest.json + server.js etc.); installation enforces SHA256 verification (provided by the index).
Built-in plugins ship with the kernel: they cannot be uninstalled, only disabled. Installed plugins are disabled by default; flip the switch to enable.

Index format (for self-hosted markets; static files suffice):

```json
{
  "name": "My plugin index",
  "plugins": [
    {"id": "signin", "name": "Daily Check-in", "version": "1.0.0", "type": "business",
     "icon": "📅", "description": "...", "author": "you",
     "url": "https://example.com/signin-1.0.0.tar.gz", "sha256": "...", "size": 12345}
  ]
}
```

## Tests

```bash
npm test    # node test/run.js (kernel 45) + test/plugins-e2e.js (plugins 17) + test/panel-e2e.js (panel 12) + test/market-e2e.js (market 16)
```

## License

[AGPL-3.0](LICENSE). Network-service use also requires offering the source to users.
