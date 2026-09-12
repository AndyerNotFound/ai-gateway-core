# ai-gateway-core

**精简内核 + 插件生态** 的 AI 网关。从 [ai-gateway](https://github.com/AndyerNotFound/ai-gateway-AI) 单体架构演进而来,遵循 [docs/CORE-DESIGN.md](docs/CORE-DESIGN.md) 的架构蓝图。

- **协议互转内核**: OpenAI Chat Completions / Claude Messages / Gemini generateContent / OpenAI Responses 四格式任意互转(请求+响应+流式 SSE)
- **渠道路由**: modelMap 改名 → models 列表 → default 兜底, round-robin 轮询 + 故障切换 + 连接级重试
- **出站代理**: SOCKS5 / HTTP CONNECT(零依赖手写握手), 按渠道指定
- **认证 hook**: checkAuth 策略链(类比 PAM), 默认 gatewayKey, 卡密/TOTP 由认证插件注册
- **setup 模式**: 首次安装白名单模式(仅 localhost + 10 分钟窗口), 替代黑名单
- **UID 存储**: 实例 UID(顺序分配 32bit) 与实例名(路由前缀)分离, 根治改名断链
- **字段级加密**: AGWENC1(scrypt + AES-256-GCM), 只加密敏感字段, 主索引明文
- **插件系统**: type:auth 先于 type:business 加载(fail-closed), permissions 声明式权限

## 快速开始

```bash
# 首次启动(进入 setup 模式, 10 分钟窗口)
node bin/agw-core.js start

# 创建第一个管理员(另开终端, 本机执行)
curl -X POST http://127.0.0.1:16384/setup/admin \
  -H 'Content-Type: application/json' \
  -d '{"adminKey":"你的管理密钥"}'

# 之后用管理密钥配置渠道
curl http://127.0.0.1:16384/admin/api/instances -H 'x-admin-key: 你的管理密钥'
```

## 数据目录

默认 `./data`(可用 `--dir` 或 `AGW_DIR` 覆盖):

```
data/
├── instances.json            # 主索引(UID+名+端口+nextUid+setupMode) — 明文
├── instances/<uid>.json      # 实例配置(channels/listen/adminKey) — 敏感字段加密
├── plugins-config/<id>.json  # 插件配置(按 UID 引用实例)
├── plugins-data/<uid>/<id>…  # 插件运行时数据
└── plugins/<id>/             # 插件包
```

## 从旧版 ai-gateway 迁移

```bash
node bin/agw-core.js migrate --from ~/ai-gateway   # 检测+迁移 config.*.json
node bin/agw-core.js migrate --verify              # 校验迁移完整性
node bin/agw-core.js migrate --rollback            # 回滚
```

## CLI

```
agw-core start [--dir D] [--port P]   启动(默认多实例单进程)
agw-core status [实例]                实例状态总览
agw-core migrate [--from DIR]         旧格式迁移
agw-core uid-reset <实例>             重置 UID(断插件配置, 慎用)
```

## 插件市场

面板「插件」页内置市场：添加索引链接 → 浏览 → 一键安装。也支持 CLI:

```bash
node bin/agw-core.js plugin-install <url|本地路径> [--sha256 X] [--proxy http://127.0.0.1:7890]
node bin/agw-core.js plugin-list
node bin/agw-core.js plugin-remove <id>
```

插件包为 `.tar.gz`（内含 manifest.json + server.js 等），安装强制 SHA256 校验（索引提供）。
内置插件随内核分发，不可卸载只能禁用；安装的插件默认不启用，需手动打开开关。

索引格式（自建市场，静态文件即可）:

```json
{
  "name": "我的插件索引",
  "plugins": [
    {"id": "signin", "name": "每日签到", "version": "1.0.0", "type": "business",
     "icon": "📅", "description": "...", "author": "you",
     "url": "https://example.com/signin-1.0.0.tar.gz", "sha256": "...", "size": 12345}
  ]
}
```

## 测试

```bash
npm test    # node test/run.js (内核45) + test/plugins-e2e.js (插件17) + test/panel-e2e.js (面板12) + test/market-e2e.js (市场16)
```

## License

[AGPL-3.0](LICENSE)。网络服务使用也需向用户提供源码。
