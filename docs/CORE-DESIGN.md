# ai-gateway-core 设计文档

> 定位：ai-gateway 从"单体网关工具"演进为"精简内核 + 插件生态"平台的架构蓝图。
> 与 [PLUGIN-DESIGN.md](./PLUGIN-DESIGN.md) 互补——那份定义"插件怎么写"，本份定义"内核留什么、插件配什么、怎么从现有代码迁过去"。
> 状态：设计阶段，未动代码。审阅通过后按 §8 实施。

---

## 0. 背景与动机

现有 `gateway.js` 已长到 3388 行，把协议互转、渠道路由、故障切换、思考链精简、扩展端点、探测、认证、多实例池全揉在一个文件里。带来的问题：

1. **bug 搜索空间大**：一个请求从进来到出去要穿过 7-8 个功能层，出问题要在 3000 行里定位。
2. **改名脆弱**：实例名同时承担"路由前缀"和"配置引用 key"两个角色，改名会断插件配置关联（已踩坑：gunmu/bai → AgnesAI/SOTA-Model）。
3. **功能耦合**：thinkingSummary hook 在 canonical writer 内部，openaiExtras 强依赖路由表，想关一个功能要在多处加 `if (enable)` 开关，开关散落难追踪。
4. **演进困难**：每加一个功能都在 gateway.js 里塞，文件只增不减。

core 重构的目标不是"推倒重写"，是**把不该在内核的功能拆成插件，让内核变薄、边界变清**。内核稳定后，新功能增量都在插件层，Debug 搜索空间从"整个网关"缩到"某个插件"。

---

## 1. 架构哲学

### 1.1 内核 + Mod 分形递归

所有成品应用本质都是"内核 + Mod"：Minecraft 是 Mod 的内核，但 Minecraft 跑在 JVM 上，JVM 是它的内核；JVM 跑在操作系统上，操作系统内核又是 JVM 的内核。每一层内核对上一层是地基、对下一层自己又是 Mod。没有最底层，是俄罗斯套娃。

ai-gateway 的分层：
```
操作系统内核 (Linux + Termux bionic)
  └─ Node.js 运行时
       └─ ai-gateway-core（转发内核）         ← 本文档定义的边界
            ├─ canonical 中枢（协议互转）        ← 内核灵魂
            ├─ 渠道路由 + 故障切换 + 重试         ← 内核
            ├─ checkAuth hook + 默认实现         ← 内核
            ├─ PluginManager（插件加载器）        ← 内核
            └─ 插件生态
                 ├─ 认证插件（卡密/TOTP/OAuth）   ← 注册到 checkAuth hook
                 ├─ thinkingSummary 插件          ← hook canonical writer
                 ├─ openaiExtras 插件             ← 注册扩展端点
                 ├─ 探测 probe 插件
                 ├─ 隧道/余额/签到...             ← 独立旁路插件
                 └─ 用户自研插件
```

### 1.2 内核职责判断标准

**核心准则：如果一个能力会被多个插件共享、依赖，那它就该待在内核里。**

因为一旦把它做成插件，每个用它的插件都得跨插件调用它，耦合比直接放内核还深，bug 反而跨边界跑。反过来说：如果一个功能不被别的插件依赖，只是"用户用得多"，它就该留在插件层——跑得再稳也不该捆绑进内核。

### 1.3 稳定性悖论

内核一旦给插件暴露了 API，就被钉死了——改内核 API 会破坏所有插件。所以插件化不是"内核写完就一劳永逸"，而是"内核写完就要开始忍着别动"。这意味着：**plugin context API 要一次设计到位，宁可多想一轮也别急着发版**。后续演进靠"新增 API"而不是"改旧 API"。

### 1.4 插件 = 可执行配置

软件工程的终态追求是"写一个够通用的内核，剩下全是配置"。Mod 不过是"可执行的配置"——它比静态配置多了逻辑，但本质还是"在内核之上声明行为"。从这个视角，ai-gateway 的差异化（签到/会员/生图/充值）全该是"配置层"的事，内核只管转发。

---

## 2. 内核边界（core 范围）

### 2.1 必须留在内核（动不得）

| 功能 | 现有位置 | 留内核理由 |
|------|---------|-----------|
| HTTP server + 多实例路由 + RESERVED_PATHS | startServer / poolRoute / RESERVED_PATHS | 转发的入口与路由，拆了不叫 gateway |
| canonical 中枢（OpenAI/Claude/Gemini/Responses 互转） | canonicalTo*Body / canonicalTo*Resp / makeWriter | 每个插件都可能产/吃不同格式，是地基 |
| 渠道路由（modelMap/models/default/round-robin） | buildRequestForChannel / pickChannels | "转发"二字的全部含义 |
| 故障切换 + 重试 + keepAlive agents | handleChat 的 doSend / isConnErr | 转发可靠性的核心，多渠道依赖 |
| SOCKS5 / HTTP CONNECT 代理 | 自定义 Agent | 出站通道，多插件可能要用 |
| checkAuth 鉴权 hook + 默认实现（gatewayKey） | checkAuth | 见 §3，hook 必须内核持有 |
| PluginManager 加载器本体 | plugins.js | "插件能加载"的前提，不能是插件（鸡生蛋） |
| 配置加载/保存（AGWENC1 加密） | loadConfig / saveCfg | 内核状态持久化 |
| 基础统计/日志结构 | stats / log | 所有插件都要写统计和日志 |

### 2.2 可拆卸为"内置插件"或独立模块

这些功能现在揉在 gateway.js 里，重构后拆出去。按"对内核内部的依赖深度"排序：

| 功能 | 现有位置 | 依赖深度 | 拆法 |
|------|---------|---------|------|
| thinkingSummary（思考链精简） | 192-440 行 | 深（hook makeWriter） | 内核暴露 `wrapWriter` hook，插件注册中间件 |
| openaiExtras（扩展端点） | 2051-2642 行 | 深（依赖路由表 + canonical） | 内核暴露 `registerExtraEndpoint` hook |
| redactDeep（隐私过滤） | 89 行 | 中（请求/响应中间件） | `onRequest` / `onResponse` hook |
| 多实例池（单进程多实例） | 3251-3384 行 | 中（server 扩展） | 可作内核模块，也可内置插件 |
| setupProbe（成功率探测） | 1957 行 | 浅（独立定时器 + 写 stats） | 纯旁路插件 |
| cloudflared 隧道 | admin.js | 浅（spawn 进程 + 暴露 URL） | 纯旁路插件 |
| 渠道余额代查 | admin.js | 浅（独立 HTTP + 预设表） | 纯旁路插件 |
| 用户体系/注册/Turnstile | gateway.js + admin.js | 中（依赖认证 hook） | 认证插件 + 用户管理插件 |
| 卡密系统（apiKeys/credits/quota） | checkAuth + admin.js | 中（认证 hook 的策略实现） | 认证插件（注册到 checkAuth hook） |

### 2.3 边界案例：thinkingSummary 与 openaiExtras

这两个是"想拆但拆不干净"的典型：

- **thinkingSummary** 包在 `makeWriter` 产出的 writer 外面，拦截 reasoning 事件。做成插件需要内核暴露 `wrapWriter(format, writer) → newWriter` hook。性能上几乎无损（只是多一层函数调用），但 hook 点比较私密（writer 是流式管道的核心抽象）。
- **openaiExtras** 的扩展端点（/v1/images、/v1/embeddings 等）强依赖内核路由表和渠道选择逻辑。做成插件需要 `registerExtraEndpoint(method, path, handler)` 且 handler 能拿到"选中渠道"的上下文。

**决策**：两者都做成内置插件，但通过"内核暴露 hook"而非"插件直接读内核内部"实现。hook 是公开 API 的一部分（见 §7），一旦发布就钉死，要一次设计好。如果短期搞不定 hook 设计，先留在内核打 `enable` 开关，标注 `// TODO: 待 hook 化`，不硬拆。

---

## 3. 认证设计

### 3.1 checkAuth hook 架构（核心）

认证不能纯插件化——会鸡生蛋：插件请求进来要先鉴权，那"卡密插件"自己怎么加载？谁先加载？

**分两层**：
- 内核持有 `checkAuth` hook 点 + 一个默认实现（简单的 `gatewayKey` 比对）
- 认证策略（卡密/TOTP/OAuth/第二验证）= 注册到 hook 的"认证插件"

类比：Linux PAM、Spring Security 的 AuthenticationProvider——可插拔的是策略，不是鉴权点本身。

```
请求进来
  → 内核 checkAuth(req) 调用注册的认证策略链
      ├─ gatewayKey 默认实现（内核内置，最低优先级）
      ├─ 卡密认证插件（if 装了）→ 查 apiKeys
      ├─ TOTP 第二验证插件（if 装了）→ 验证 adminAuth
      └─ ...其他认证策略
  → 链上第一个匹配的策略返回 {ok, userKey, ...} 即通过
  → 全不匹配 → 401
```

### 3.2 加载顺序（生命周期钉死）

```
1. 内核启动
2. 加载配置（instances.json 主索引 + instances/<uid>.json）
3. 加载认证插件（标记 type:'auth'）         ← 先于业务插件
   ├─ 认证插件 activate() 失败 → 阻断后续加载（fail-closed）
   └─ 认证插件 registerAuth(strategy) 注册到 checkAuth hook
4. 加载业务插件（标记 type:'business'）
5. startServer，开始接受请求
```

认证插件必须先于业务插件加载，否则签到插件运行时拿不到认证上下文。这个顺序在 PluginManager 里硬编码，不靠配置。

### 3.3 首次安装 setup 模式

用白名单替代"绕过验证 + 限制访问"（黑名单）：

- 启动时检测 `instances.json` 是否有管理员记录
- 无管理员 → 进入 setup 模式
  - setup 模式只开放一个接口：`POST /setup/admin`（创建第一个管理员：设密码 / 绑 TOTP）
  - 其他所有接口（读配置、改实例、装插件、/v1/*）全部 403
  - 绑定 localhost only（非 127.0.0.1 来源直接拒）
  - 首次启动后 10 分钟超时自动锁死（没配完就锁，逼用户用命令行 `agw.sh setup-reset` 救场）
- 管理员创建成功 → setup 模式关闭，永久进入"必须验证"模式，再也回不去 setup

黑名单 vs 白名单的区别：黑名单（"绕过验证但不能访问带 Key 的文件"）容易漏——新加接口忘了加禁止列表就是漏洞。白名单（"只能创建管理员"）攻击面最小，且不存在"严格度该定多少"的纠结。

### 3.4 第二验证

`adminAuth`（secondKey + totpSecret）作为认证插件的配置项，不是独立模块。管理员登录管理后台时，checkAuth 链上 TOTP 策略生效；普通用户请求只走卡密策略。TOTP 实现 RFC6238（SHA1, 30s 窗口, 6 位, ±1 容忍）已有，沿用。

---

## 4. UID 设计

### 4.1 UID 语义

- UID = 实例的稳定标识，永不变（即使改名）
- 实例名 = 路由用（URL 路径前缀 `/实例名/`），可变
- UID 与实例名分离：改名只动实例名，不动 UID，插件配置引用不断

### 4.2 生成策略

**顺序分配 + 32bit**：
- 从 1 递增，持久化一个 `nextUid` 计数器（写在 `instances.json` 主索引里，防重启回退）
- 32bit 顺序够 40 亿个实例，"够不够"这个问题就不存在
- 永远不碰撞（vs 随机分配的生日悖论碰撞风险）
- UID 短可读（1、2、3...），配置文件里一眼能认

**为什么不随机**：随机 UID 一旦碰撞要重新生成，重新生成 = 引用旧 UID 的所有插件配置全断。顺序分配从根上消灭碰撞。

### 4.3 配套机制

- 启动时全局扫描 UID 唯一性，重复自动重生（极端情况：用户手动复制配置文件）
- 导出/导入实例时校验 UID，冲突则提示"导入会改 UID，关联的插件配置会断"
- 提供 `agw.sh reset-uid <实例名>` 命令（极端救场，会断该实例所有插件配置，执行前强制确认）
- UID 不放进文件名（`config.inst_3.json` 这种），因为那会让"实例名（路由）"和"UID（引用）"耦合，等于白做这层抽象

### 4.4 UID 与"实例数量上限"无关

UID 位数决定的是标识空间大小（碰撞概率 + 可读性），不是实例数量上限。实例数量上限是存储/性能问题。后续做"存储后端插件"把文件存储换成 SQLite/远程，实例数就能涨，跟 UID 位数无关。所以不必为"以后实例多了 UID 不够"担心——那是存储层的事。

---

## 5. 存储设计

### 5.1 主索引 + 分散文件

借鉴数据库（索引 + 数据文件）和 git（refs 索引 + objects 分散）的思路：

```
~/.agw/                              # 或实例化时的 DATA_DIR
├── instances.json                   # 主索引（轻量元数据）
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
│   ├── 1.json                       # 实例 1 的重配置（channels/listen/plugins 引用/adminKey...）
│   ├── 2.json
│   └── ...
├── plugins-config/                  # 插件配置（按插件隔离，UID 引用实例）
│   ├── signin.json                  # { "1": {rewardTokens:1000}, "2": {rewardTokens:500} }
│   ├── auth-cardkey.json            # 卡密认证插件配置
│   └── probe.json
├── plugins-data/                    # 插件运行时数据（沿用现有）
│   ├── 1/                           # 按实例 UID 隔离
│   │   └── signin.json
│   └── 2/
└── plugins/                         # 插件包本体（沿用现有）
    ├── hello/
    └── signin/
```

### 5.2 各层职责

| 文件 | 内容 | 谁写 | 加密 |
|------|------|------|------|
| instances.json | UID+名+端口+启用+文件指针+nextUid+setupMode | 内核 | 不加密（无敏感字段） |
| instances/<uid>.json | channels（含 apiKey）/listen/adminKey/plugins 启用列表 | 内核 | 敏感字段级加密（apiKey/adminKey） |
| plugins-config/<id>.json | 该插件对各实例的配置，按 UID 分组 | 该插件（经 ctx.setPluginConfig） | 插件自决（敏感字段可调 ctx.encrypt） |
| plugins-data/<uid>/<id>.json | 插件运行时数据（签到记录等） | 该插件（ctx.data） | 插件自决 |

### 5.3 加密：字段级，不是整文件

当前 AGWENC1 是整文件加密。重构后改为字段级加密：只加密敏感字段（apiKey/adminKey/用户密码哈希等），非敏感字段（端口/模型名/启用状态）明文。好处：
- `instances.json` 主索引全程明文，加载快，启动时不用解密就能建路由表
- 改一个非敏感字段不用重新加解密整个文件
- 调试时看配置更直观（敏感值打码显示）

AGWENC1 算法沿用（scrypt + AES-256-GCM），只是加密粒度从"整文件"变"单字段"。提供 `ctx.encrypt(value)` / `ctx.decrypt(value)` 给插件用。

### 5.4 原子性

- 单实例配置写 = 单文件（`instances/<uid>.json`），天然原子
- 跨文件原子操作（实例启停/重置/改名）收编进内核 API，插件层禁止跨文件写
- 内核 API 内部用"写临时文件 + rename"保证原子性
- 重启时校验一致性：主索引里的 file 指针必须存在，缺失则标记实例为 `corrupted` 并提示

### 5.5 实例状态总览

提供 `agw.sh status <实例名|UID>` 命令 + `GET /admin/api/instance-full/:uid` 接口：按 UID 聚合该实例在 `instances/<uid>.json` + 所有 `plugins-config/*.json` 里对该 UID 的配置，输出一个完整视图。调试时一眼看全，不用拼好几个文件。

---

## 6. 插件配置模型

### 6.1 UID 引用

插件配置文件里用 UID 引用实例，不用实例名：

```json
// plugins-config/signin.json
{
  "1": { "enabled": true, "rewardTokens": 1000 },
  "2": { "enabled": false, "rewardTokens": 500 }
}
```

实例从 `AgnesAI` 改名成 `Foo`，UID 1 不变，signin 配置里的 `"1"` 仍然指向它。根治改名坑。

### 6.2 插件间配置访问

插件之间不直接读对方的配置文件（否则耦合 + schema 绑死）。统一走内核 plugin context API：

```js
// 签到插件想查卡密插件给某 UID 配了多少额度
const authCfg = ctx.getPluginConfig('auth-cardkey', uid);
const quota = authCfg?.quotaTokens || 0;
```

内核 ctx 做中间层，插件 schema 可以独立演进。代价是每次跨插件查询多一层函数调用，但配置查询不是热路径（请求处理才是），可接受。

### 6.3 插件生命周期

```
install → activate（注册 route/hook/auth）→ 运行 → deactivate（清理）→ uninstall（删配置+数据）
```

- 卸载时配置文件一起删（干净）
- 停用（deactivate）保留配置和数据，只是不再加载
- 认证插件 deactivate 会导致 checkAuth 链变短，要提示"停用后该实例鉴权降级为 gatewayKey only"

### 6.4 捆绑判断

功能跑稳后是否"捆绑进内核"？判断标准：

- 被多个其他插件依赖 → 捆绑（如卡密被签到/充值/credits 依赖）
- 只是用户用得多但不被依赖 → 留插件层（如 signin 跑再稳也不捆绑）
- 捆绑 = 代码合并进内核 + 升级为内核 API，从"可拆卸"变"内核契约"，**下次想拆回去非常痛**——所以捆绑要慎重，宁可不捆

---

## 7. 插件 API 边界（plugin context）

### 7.1 暴露给插件的（公开 API，发布即钉死）

```js
ctx = {
  // —— 配置 ——
  getPluginConfig(pluginId, uid),        // 读别的插件对某实例的配置
  setPluginConfig(uid, config),          // 写自己的配置（单文件原子）
  getInstanceConfig(uid),                // 读实例配置（打码敏感字段）
  uid,                                   // 当前请求所属实例 UID
  instanceName,                          // 当前实例名

  // —— 认证（仅 type:'auth' 插件可用）——
  registerAuth(strategy),                // 注册认证策略到 checkAuth 链
  findKey(token),                        // 查卡密（认证插件暴露给业务插件）
  grantQuota(uid, tokens),               // 加额度

  // —— HTTP ——
  registerRoute(method, path, handler),  // 注册端点（路径相对于 /plugins/<id>/）
  registerExtraEndpoint(method, path, handler),  // 注册 /v1/* 扩展端点（需 permission）
  wrapWriter(format, writerFn),          // 包流式 writer（thinkingSummary 用）

  // —— 中间件 ——
  onRequest(handler),                    // 请求中间件（redact 用）
  onResponse(handler),                   // 响应中间件

  // —— 基础设施 ——
  data,                                  // 按实例隔离的 KV 存储（ctx.data.get/set）
  cron(intervalMs, fn),                  // 定时任务
  log(...), logErr(...),
  stats(uid, delta),                     // 统计
  emit(event, data), on(event, fn),      // 事件总线
  encrypt(value), decrypt(value),        // 字段级加密

  // —— 上游调用 ——
  upstreamRequest(opts),                 // 经内核 agent 池发上游请求（复用代理/keepAlive）
}
```

### 7.2 不暴露的（内核私有）

- canonical 中枢内部函数（canonicalTo*Body 等）——插件只通过 `wrapWriter` / `onResponse` 间接介入
- 渠道路由内部（pickChannels / buildRequestForChannel）——插件通过 `upstreamRequest` 间接用
- agent 池内部——插件通过 `upstreamRequest` 间接用
- 多实例池内部（poolLoadInstance / poolRoute）——插件通过 `ctx.uid` / `ctx.instanceName` 拿当前实例信息

### 7.3 权限声明

manifest.json 的 `permissions` 字段声明插件要用的高级 API：

```json
"permissions": ["storage", "hook", "gateway:grantQuota", "gateway:registerExtraEndpoint", "auth:registerAuth"]
```

安装时明示风险，运行时校验。无声明的 API 调用直接抛权限错误。

---

## 8. 迁移路径

### 8.1 现状盘点

- 26 个实例运行中（中转站生产环境）
- 每实例 `config.<name>.json` 单文件（channels/listen/plugins/adminKey/...）
- 插件配置在 `cfg.plugins[]`（实例配置内）+ `plugins-data/<inst>/<id>.json`
- 实例名同时是路由前缀和配置引用 key

### 8.2 迁移策略：兼容层 + 自动迁移

不走"配置不兼容、用户重配"路线（26 个实例重配成本太高）。走自动迁移：

1. 启动时检测旧格式（`config.<name>.json` 存在且 `instances.json` 不存在）
2. 自动迁移：
   - 按实例名顺序分配 UID（1, 2, 3...）
   - 生成 `instances.json` 主索引
   - 每实例配置拆到 `instances/<uid>.json`
   - 插件配置从 `cfg.plugins[]` 迁到 `plugins-config/<id>.json`（key 从实例名换成 UID）
   - 旧文件保留为 `config.<name>.json.bak-migrate`
3. 迁移后启动，日志打印迁移报告（N 个实例、M 个插件配置已迁）
4. 验证：对比迁移前后实例状态（端口/渠道数/插件数），不一致则回滚

### 8.3 迁移脚本设计

```
agw.sh migrate              # 检测+迁移旧格式
agw.sh migrate --verify     # 校验迁移后完整性（实例数/渠道数/插件数对比）
agw.sh migrate --rollback   # 从 .bak 恢复旧格式
```

迁移脚本独立于正常启动流程，但启动时也会自动检测并提示"检测到旧格式，建议运行 agw.sh migrate"。

### 8.4 渐进重构顺序

不一口气把 gateway.js 拆散。按"风险从低到高"分步：

| 步骤 | 内容 | 风险 | 验证 |
|------|------|------|------|
| 1 | 加 UID 字段（旧配置兼容，无 UID 时按实例名顺序分配并写回） | 低 | 实例正常跑，UID 写入 |
| 2 | 加 `instances.json` 主索引 + `instances/<uid>.json` 拆分（双写：同时写旧格式和新格式） | 低 | 双写一致，旧客户端不受影响 |
| 3 | 切读：从新格式读，旧格式只读不写 | 中 | 切读后实例状态一致 |
| 4 | 加 setup 模式 + checkAuth hook 改造（默认实现保持 gatewayKey 行为不变） | 中 | 认证行为与旧版一致 |
| 5 | 拆 setupProbe / cloudflared 隧道 / 余额代查为内置插件 | 低 | 功能等价，开关迁移 |
| 6 | 拆 thinkingSummary 为内置插件（暴露 wrapWriter hook） | 高 | 流式精简行为一致，顺序保证不破 |
| 7 | 拆 openaiExtras 为内置插件（暴露 registerExtraEndpoint hook） | 高 | 扩展端点行为一致 |
| 8 | 拆卡密/用户体系为认证插件 | 高 | 认证链行为一致 |
| 9 | 删旧格式双写，只留新格式 | 中 | 确认无回退需求后执行 |

每步独立可回滚，每步跑全套测试（现有 135 项 + 新增）。生产环境切换在某步验证通过后、低峰期逐实例重启。

---

## 9. 实施阶段

| 阶段 | 产出 | 验收标准 |
|------|------|---------|
| 0 设计文档 | 本文件 | 用户审阅通过 |
| 1 UID + 存储重构 | instances.json + instances/<uid>.json + 迁移脚本 | 26 实例自动迁移、双写一致、回滚可用 |
| 2 认证 hook + setup 模式 | checkAuth hook + setup 模式 + 默认实现 | 认证行为与旧版一致、setup 流程可用 |
| 3 插件 API 定稿 | ctx 全集 + 权限模型 + 生命周期 | 现有 hello/signin 插件在新 API 下正常 |
| 4 功能拆分 | probe/隧道/余额 → 插件 | 功能等价、开关迁移 |
| 5 深度拆分 | thinkingSummary/openaiExtras → 插件 | 流式/扩展端点行为一致 |
| 6 认证插件化 | 卡密/TOTP → 认证插件 | 认证链一致、加载顺序正确 |
| 7 清理 | 删旧格式双写、删冗余 .bak | 仅新格式、测试全过 |

---

## 10. 开放问题（待定）

1. **插件沙箱**：当前信任制（任意 JS + SHA256 校验）。是否加受限 require 白名单？用户表态过"先随便他们"，暂不做强制沙箱，但 plugin context API 是事实上的沙箱边界（插件拿不到内核私有）。
2. **官方插件索引**：暂不做，手动 zip + 自定义索引 URL。core 稳定后再考虑类 F-Droid 模式。
3. **远程存储后端**：实例多了文件存储不够时，做存储后端插件（SQLite/远程）。非本期。
4. **插件版本兼容**：minGateway 字段已有，但插件升级 vs 内核 API 升级的兼容矩阵还没定，待 plugin context API 定稿后补。
5. **多实例共享插件配置**：当前每实例独立配置。是否支持"一组实例共享某插件配置"？非本期，UID 引用模型已能支撑（多 UID 指向同一配置块）。

---

## 附：与 PLUGIN-DESIGN.md 的关系

| PLUGIN-DESIGN.md | 本文档 |
|------------------|--------|
| 插件怎么写（包结构/manifest/server.js/ctx） | 内核留什么、插件配什么、怎么迁 |
| 已定稿，实施中（期 1 完成） | 设计阶段，审阅中 |
| 定义 ctx 的基本形态 | 扩展 ctx（加 getPluginConfig/getInstanceConfig/encrypt 等）、定义哪些是内核私有 |

两份文档不冲突。本文件定稿后，PLUGIN-DESIGN.md 的 ctx 章节按本文件 §7 扩充。
