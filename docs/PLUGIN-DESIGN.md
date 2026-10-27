# ai-gateway 插件系统设计（定稿）

> 目标：中转站功能差异化（签到 / 会员 Plan / 生图页 ...），用插件化解决"功能千人千面、全内置工程量爆炸"的矛盾。
> 决策记录：开放不审核（信任制+SHA256校验）；暂不做官方索引（支持手动 zip 链接 + 自定义索引 URL）；插件设置用 WebView 包装；用户端首页做插件板块；完整版（服务端+前端），分多次实施。

---

## 0. 核心原则

1. **插件 = 服务端逻辑 + 前端页面 两半**。签到/会员/生图都需服务端存数据，所以纯前端插件不够。
2. **插件 UI 全部关在 WebView 里**，不允许碰原生界面 → 前端兼容性可控，插件写烂不崩 App。
3. **分实例启用**：每个网关实例独立安装/启用/配置插件。
4. **信任制**：插件是任意 JS，有完全能力。靠"SHA256 强制校验来源 + 安装页明示风险 + 仅 adminKey 可装"兜底，不做强制沙箱（但提供受限 require 白名单选项）。

---

## 1. 插件包结构

一个 zip 包（或目录），根必须含 `manifest.json`：

```
<plugin-id>.zip
├── manifest.json      # 必需，元数据
├── server.js          # 可选，服务端逻辑（网关注册 endpoint / 定时任务 / hook）
├── pages/             # 可选，前端页面（App WebView 加载）
│   ├── user.html      #   用户端首页板块入口
│   └── admin.html     #   管理端设置页
└── icon.png           # 可选，图标
```

## 2. manifest.json 规范

```json
{
  "id": "signin",                  // 必需，唯一，小写字母数字连字符，=目录名
  "name": "每日签到",               // 必需
  "version": "1.0.0",              // 必需
  "author": "xxx",
  "description": "用户每日签到领额度",
  "icon": "icon.png",
  "minGateway": "1.4.0",           // 最低网关版本
  "hasServer": true,               // 是否有 server.js
  "userPage": "pages/user.html",   // 用户端板块入口（有则在用户端显示）
  "adminPage": "pages/admin.html", // 管理端设置页（有则管理端可点进）
  "permissions": ["storage", "hook", "gateway:grantQuota"],
                                        // 权限声明（明示用，见 §9）
  "configSchema": [                 // 插件设置表单（管理端 WebView/自动表单）
    {"key":"rewardTokens","label":"签到奖励额度","type":"number","default":1000}
  ]
}
```

## 3. 服务端插件 API（server.js）

`server.js` 用 CommonJS，导出 `activate(ctx)` / 可选 `deactivate()`：

```js
module.exports = {
  activate(ctx) {
    // 注册端点: GET /plugins/signin/status
    ctx.registerRoute('GET', '/status', async (req, res, params) => { ... });
    ctx.registerRoute('POST', '/checkin', async (req, res, params) => { ... });

    // 数据持久化（自动落盘 plugins-data/<id>.json）
    const rec = ctx.data.get('sign_' + uid) || {};
    ctx.data.set('sign_' + uid, { ...rec, last: Date.now() });   // set 即标记脏, 定时落盘

    // 定时任务
    ctx.cron(3600_000, () => ctx.log('每小时'));

    // hook（可选，谨慎）
    // ctx.hook('afterResponse', (info) => {...});

    // 调用网关能力（按 permissions 放行）
    // await ctx.gateway.grantQuota(keyId, tokens);   // 给卡密加额度
    // const inst = ctx.gateway.instanceName;
  },
  deactivate() {}   // 卸载/停用时清理
};
```

### ctx 完整接口

| 接口 | 说明 |
|---|---|
| `ctx.id` / `ctx.instanceName` | 插件 id / 所属实例名 |
| `ctx.registerRoute(method, path, handler)` | 注册 `/plugins/<id><path>`；handler(req,res,params)，params 含 query/body/认证信息 |
| `ctx.data.get(k)` / `set(k,v)` / `del(k)` / `all()` | 插件私有 KV，自动持久化 `plugins-data/<id>.json`（30s 脏落盘） |
| `ctx.cron(ms, fn)` | 定时任务（停用时自动清理） |
| `ctx.hook(name, fn)` | `beforeRequest`(改请求体) / `afterResponse`(响应后) / `onRequestLog` |
| `ctx.gateway.grantQuota(keyId, tokens)` | 给卡密加额度（需 `gateway:grantQuota` 权限） |
| `ctx.gateway.findKey(token)` | 按卡密查 key 记录（校验调用者身份） |
| `ctx.config` | 插件设置（管理端在设置页填的，按 configSchema） |
| `ctx.log(msg)` | 写实例日志 |

## 4. 路由与端点

- **插件端点**：`/plugins/<id>/<path>`（带实例前缀时 `/<实例>/plugins/<id>/<path>`）。认证：插件自行决定（用 ctx.gateway.findKey 校验卡密）。
- **用户端插件列表**：`GET /plugins` → 本实例已启用且有 userPage 的插件（id/name/icon/desc）。
- **首次登录提示**：`GET /plugins/required` → 管理端配置的推荐插件列表（cfg.requiredPlugins）。
- **管理 API**（需 adminKey）：
  - `GET /admin/api/plugins/:inst` → 已安装列表+状态
  - `POST /admin/api/plugins-install/:inst` {zipUrl, sha256?} 或 {indexUrl, id} → 下载校验安装
  - `POST /admin/api/plugins-remove/:inst` {id, keepData?}
  - `POST /admin/api/plugins-enable/:inst` {id, enable}
  - `GET/POST /admin/api/plugins-config/:inst/:id` → 读/写插件设置

## 5. 文件与存储

```
~/ai-gateway/
├── plugins/<id>/            # 解压的插件包（每实例独立？见下注）
├── plugins-data/<inst>/<id>.json   # 插件数据（按实例隔离）
└── config[.<inst>].json     # cfg.plugins = [{id, enable, version, config:{}}]
```

> 注：插件**代码**全局共享一份（plugins/<id>/），**启用状态和配置和数据**按实例独立。default 主实例与其他实例相同机制。
> `plugins` / `plugins-data` 加进 RESERVED_PATHS（防被当实例名）。

## 6. 安装 / 更新 / 卸载

**安装**（三选一来源）：
1. 手动 zip 直链（可填 sha256，没填则下载后计算并展示让用户确认）
2. 自定义索引 URL（index.json）里选插件
3. 本地路径（Termux 已有 zip）

流程：下载 → **SHA256 校验**（有则强校验）→ 解压到临时目录 → 校验 manifest（id 合法/hasServer 对应文件存在）→ 移到 plugins/<id>/ → 登记 cfg.plugins → **热加载**（loadPlugin）。

**更新**：下载新版 → 校验 → 备份旧目录 → 替换 → 重载。
**卸载**：deactivate → 移出 cfg → 删 plugins/<id>/（数据默认保留，可选删）。

## 7. 索引仓库格式（本期不做官方索引）

`index.json`：
```json
{
  "name": "某某插件源",
  "plugins": [
    {"id":"signin","name":"每日签到","version":"1.0.0","author":"x",
     "description":"...","icon":".../icon.png",
     "zipUrl":"https://.../signin-1.0.0.zip","sha256":"..."}
  ]
}
```
管理端可添加多个自定义索引 URL；列表页合并展示，标注来源。

## 8. App 侧

### 管理端
- 底栏第 5 格候选（或顶栏菜单）「插件」页：
  - 已安装列表（名称/版本/启停开关/来源）
  - 点进某插件 → 二级页：若有 adminPage 用 WebView 加载，否则按 configSchema 自动生成表单
  - 「安装插件」：填 zip 链接 / 填索引 URL 浏览
- 插件页内提供「推荐插件」配置（cfg.requiredPlugins）

### 用户端
- 首页加「插件」板块：列出有 userPage 的插件卡片 → 点进 WebView 加载 `user.html`

### WebView 容器 + JSBridge（白名单）
插件页面（user.html/admin.html）在 WebView 里，通过 JSBridge 调原生能力（**白名单制**，只开放这几个）：
```js
window.AGW.getToken()            // 当前用户卡密 / 管理端临时令牌
window.AGW.callApi(path, opts)   // 调本实例 API（自动带实例前缀+认证）
window.AGW.close()               // 关闭插件页
window.AGW.toast(msg)
```
> JSBridge 是唯一通道，插件页不能直连任意外网地址发用户数据（WebView 加域白名单：只放行本网关 + 插件声明的域）。

## 9. 安全模型

| 措施 | 说明 |
|---|---|
| SHA256 强制校验 | 索引提供的哈希不符则拒装 |
| 仅 adminKey 可装/卸/配 | 用户端只能用，不能装 |
| 风险明示 | 安装页显著提示"插件=完全信任的代码，请确认来源" |
| 权限声明 | manifest.permissions 明示，敏感能力（grantQuota 等）按声明放行 |
| WebView 域白名单 | 插件页网络请求限制在白名单域 |
| 数据隔离 | 每插件独立 json，路径校验防 `..` 穿越 |

## 10. 分期实施计划

| 期 | 内容 | 产出 |
|---|---|---|
| **期1 网关核心** | 插件加载器（扫描/manifest/server.js 激活/路由注册/数据存储/cron）+ /plugins 路由 + admin 管理 API + 1 个示例插件(hello+signin) | 网关能装/跑插件 |
| **期2 App 管理端** | 插件列表页 + 安装(zip链接/索引URL) + WebView 设置页 + requiredPlugins 配置 | 管理端能管插件 |
| **期3 App 用户端** | 首页插件板块 + WebView user 页 + JSBridge + 首次登录提示 | 用户能用插件 |
| **期4 小需求搭车** | Key 长度 8~128、模型广场按渠道分组、用户权限补全、邮箱验证码(SMTP) | 体验补全 |

## 11. 首批示例插件（期1 验证用）

1. **hello**：最小骨架，注册一个 `/plugins/hello/ping` 返回 `{msg:"pong"}`，验证加载/路由/数据。
2. **signin（每日签到）**：server.js 记签到 + 调 grantQuota 加额度；user.html 签到按钮+连续天数；admin.html 配奖励额度。验证完整闭环。

---

_定稿于 2026-09-09。后续每期开发以本文档为准，变更需更新本文档。_

---

## §GC Gay Core App 集成 (SDUI, 2026-09-10)

> App 前端 **不用 WebView**：插件 UI = gcui JSON 声明, App 原生 Material 组件渲染。

### manifest 扩展

```jsonc
{
  "provides": ["user-system"],          // 能力声明 (user-system → App「个人」tab 由本插件提供)
  "appUi": {
    "personal":  { "title": "个人", "icon": "person", "ui": "/ui/personal" },
    "home":      { "title": "签到", "icon": "check",  "ui": "/ui/home" },   // 首页组件
    "bottomBar": { "id": "signin", "title": "签到", "icon": "check", "ui": "/ui/home" },
    "settings":  { "title": "签到设置", "ui": "/ui/settings" },
    "pages":     [ { "id": "rank", "title": "排行榜", "icon": "list", "ui": "/ui/rank" } ]
  }
}
```

- `ui` = 相对插件的端点路径, `ctx.registerRoute('GET', '/ui/personal', ...)` 返回 gcui JSON。
- 全部可选; 未声明的注册点不出现在 App。

### gcui 页面格式 (`"gcui": 1`)

```jsonc
{ "gcui": 1, "title": "页标题", "state": { /* 模板数据源 */ },
  "root": { "type": "column", "gap": 12, "children": [ ...组件... ] } }
```

组件白名单: column/row/card/text/button/input/switch/progress/kv/image/icon/divider/spacer/list。
- 模板: 字符串里 `{{state.x}}` `{{input.key}}` `{{item.x}}`(list) `{{user.uid}}`; 整串单模板保留原始类型。
- `visible`: 任意组件可设, truthy 判定控制显隐。
- `weight`: column/row 子节点比重。
- 颜色仅主题令牌 `"$primary"` 等, 禁止裸 hex (防视觉欺骗)。

### 动作 action

```jsonc
{ "type": "intent", "endpoint": "./checkin", "body": {"k":"{{input.x}}"}, "confirm": "...", "then": "reload", "pop": false }
{ "type": "open", "target": "page:xxx" | "https://..." }
{ "type": "copy", "text": "{{state.key}}", "toast": "已复制" }
```

### 意图端点 (必须用签名守卫)

```js
ctx.registerRoute('POST', '/intent/checkin', (req, res, p) => ctx.security.guard(req, p, res, (uk) => {
  // uk = 已验签+认证的卡密记录; 自动完成: HMAC验签/±5min时间窗/nonce去重/序列号防回滚/幂等重放缓存
  return { ok: true, toast: '签到成功', ui: null };  // ui 存在→App整页替换; 否则按 then 处理
}));
```

- 客户端序列号回滚时 guard 返回 `{error, currentSeq}`, App 自动校正重试。
- 安全记录存 `plugins-data/<uid>/.gc-security.json`, 卡密不落盘(存 sha256)。

### 主题插件 (type:"theme")

只允许样式令牌, **内核强制**: 带 server.js 或 permissions 的主题插件拒绝加载。
内置 theme-md3 为默认主题, 不可卸载/隐藏 (bootstrap 兜底注入)。

### App 支撑 API (内核)

| 端点 | 说明 |
|---|---|
| `GET /api/app/bootstrap` | 聚合: 服务点资料/分支/插件公示(权限+SHA256)/主题/布局/调试模式 |
| `GET/POST /admin/api/server-info` | 服务点资料 (名称/简介/图标/公告, 字段白名单) |
| `GET/POST /admin/api/client-config/:uid` | 用户端默认布局 + 用户调试模式 {uid, minutes} |
| `GET /admin/api/audit/:uid?limit=` | 审计日志读取 |
| `GET/POST /admin/api/market/test-mode` | 测试模式 (默认关: 禁止自定义插件来源) |
