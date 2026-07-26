# pi-fancy-footer-plus 开发说明

> 基于 `pi-fancy-footer` v2.0.0 的增强分支，为 Pi 增加统一的订阅额度、中转站余额、API 配额与模型价格展示能力。

## 1. 项目背景

`pi-fancy-footer` 当前已经具备：

* Codex 与 Anthropic 订阅额度查询；
* Provider 状态缓存和失败降级；
* Gauge、重置时间、Credits 等 Footer 展示；
* Session Token、上下文和成本信息展示；
* 第三方 Widget 协议；
* 配置校验和配置 TUI；
* 较完整的 Provider 状态测试。

但当前 Provider 状态实现仍然偏向内置平台：

* Provider registry 固定；
* 配置中的 Provider ID 为固定枚举；
* 状态模型只支持 `primary`、`secondary` 和 `credits`；
* 自定义 Widget 只能提交文本，无法复用原生额度 Gauge；
* 无法声明式配置任意中转站的余额、额度和重置时间接口；
* 模型价格只能由 Pi 的模型定义提供，Footer 无法单独修正 Session cost。

本项目的目标，是在尽量保留上游设计和兼容性的前提下，将 Provider 状态模块改造成可扩展的资源查询框架。

---

## 2. 开发目标

### 2.1 第一阶段：Provider 资源状态

支持以下资源统一显示：

* Codex 订阅额度；
* Claude Code / Anthropic 订阅额度；
* API 或中转站余额；
* 按小时、每日、每周、每月等额度窗口；
* 请求次数、Token、Credits 等非金额配额；
* 重置时间；
* Provider 查询失败时的旧缓存；
* 当前模型对应 Provider 的自动匹配。

用户应当可以仅通过配置文件，为任意 Provider 声明：

* 请求 URL；
* HTTP 方法；
* Header；
* Body；
* JSON 字段选择；
* 数值换算；
* 时间戳格式；
* 展示名称和单位。

### 2.2 第二阶段：模型价格

支持从远端价格接口查询模型单价，并用于：

* Footer 中展示远端价格；
* 估算当前 Session 成本；
* 可选地通过 Pi Provider 注册机制注入模型价格。

模型价格和实时余额必须保持独立生命周期：

* 余额和额度：运行期间周期刷新；
* 模型价格：启动时加载，低频刷新；
* 价格接口失败不应阻止 Pi 启动；
* 不自动覆写用户的 `models.json`。

---

## 3. 非目标

第一版不处理以下内容：

* 在配置中执行任意 JavaScript；
* 自动修改 `~/.pi/agent/models.json`；
* 自动猜测未知中转站接口；
* 从 HTML 页面抓取余额或价格；
* 代理登录、验证码、浏览器 Cookie 自动提取；
* 完整支持所有 JSONPath/JMESPath 运算；
* 将通用适配器强行替代 Codex、Anthropic 原生适配器；
* 把 Footer 变成完整账单或财务管理工具。

遇到需要 OAuth 刷新、专用响应头、CLI 本地凭据或复杂认证的平台，优先继续使用原生 Adapter。

---

## 4. 兼容原则

### 4.1 上游兼容

开发基线：

```text
upstream tag: v2.0.0
```

应尽量满足：

* 旧版 `fancy-footer.json` 继续生效；
* 现有 Codex 和 Anthropic 行为不变；
* 现有 Widget ID 和布局配置不变；
* 原有测试在纯重构阶段全部通过；
* 新功能尽量集中在 `provider-status` 与 `pricing` 模块；
* 避免无必要修改 Footer 布局、Git Widget 和其他独立模块。

### 4.2 配置兼容

保留原配置：

```json
{
  "providerStatus": {
    "providers": ["openai-codex", "anthropic"],
    "refreshMs": 60000,
    "cacheTtlMs": 300000,
    "display": "gauge",
    "showCredits": true,
    "showReset": true
  }
}
```

第一阶段新增字段，而不是直接改变 `providers` 的类型：

```json
{
  "providerStatus": {
    "providers": ["openai-codex", "anthropic"],
    "customProviders": {
      "zero": {}
    }
  }
}
```

暂时不要把：

```json
"providers": ["openai-codex", "anthropic"]
```

改成对象形式，以降低与上游配置、README 和用户现有配置的冲突。

---

## 5. 总体架构

```text
Provider API / CLI / Response Headers
                │
                ▼
        ProviderStatusSource
                │
                ▼
     标准化 ProviderResourceSnapshot
                │
        ┌───────┴────────┐
        ▼                ▼
      Cache          Footer Renderer
                         │
                         ▼
              Gauge / Balance / Reset
```

模型价格单独处理：

```text
Pricing API / Local Fallback
             │
             ▼
       Pricing Normalizer
             │
      ┌──────┴─────────┐
      ▼                ▼
 Estimate-only     registerProvider
      │                │
      ▼                ▼
 Footer 估算      Pi 原生 usage.cost
```

---

## 6. 推荐目录结构

先将当前较大的 Provider 状态文件拆分为：

```text
src/
├── provider-status/
│   ├── index.ts
│   ├── types.ts
│   ├── registry.ts
│   ├── cache.ts
│   ├── http-client.ts
│   ├── normalize.ts
│   ├── env.ts
│   ├── redact.ts
│   └── sources/
│       ├── codex.ts
│       ├── anthropic.ts
│       └── declarative.ts
├── pricing/
│   ├── types.ts
│   ├── fetch.ts
│   ├── normalize.ts
│   ├── cache.ts
│   ├── estimate.ts
│   └── register.ts
└── footer/
    └── provider-status-widget.ts
```

如果上游现有模块边界不适合一次性移动，可先建立兼容导出：

```ts
export * from "./provider-status/index.js";
```

避免全仓库立即修改 import 路径。

---

## 7. 核心数据模型

### 7.1 标准化 Provider 快照

```ts
export interface ProviderResourceSnapshot {
  provider: string;
  label: string;

  fetchedAt: string;
  source: "api" | "headers" | "local" | "cache";

  windows: QuotaWindow[];
  balances: BalanceMetric[];

  stale?: boolean;
  error?: ProviderStatusError;
}
```

### 7.2 额度窗口

```ts
export interface QuotaWindow {
  id: string;
  label: string;

  remainingPercent?: number;
  usedPercent?: number;

  remaining?: number;
  used?: number;
  limit?: number;

  unit?: string;
  resetAt?: string;
}
```

约束：

* `remainingPercent` 和 `usedPercent` 均使用 `0–100`；
* 如果只提供其中一个，可以自动推导另一个；
* 推导结果必须限制在 `0–100`；
* `resetAt` 标准化为 ISO 8601；
* `remaining`、`used`、`limit` 不强制要求同时存在；
* `unit` 可为 `tokens`、`requests`、`credits`、`USD`、`CNY` 等。

### 7.3 余额指标

```ts
export interface BalanceMetric {
  id: string;
  label?: string;

  value: number;
  currency?: string;
  unit?: string;

  approximate?: boolean;
}
```

示例：

```json
{
  "id": "remaining",
  "label": "余额",
  "value": 84.26,
  "currency": "CNY"
}
```

### 7.4 错误对象

```ts
export interface ProviderStatusError {
  code:
    | "network"
    | "timeout"
    | "http"
    | "parse"
    | "selector"
    | "config"
    | "auth"
    | "unknown";

  message: string;
  status?: number;
}
```

错误消息不得包含：

* Authorization Header；
* API Key；
* Cookie；
* 请求 Body 中的凭据；
* 完整原始响应；
* 完整本地凭据文件内容。

---

## 8. Source 抽象

保留并扩展现有 Source 接口：

```ts
export interface ProviderStatusSource {
  id: string;
  label: string;

  supports(providerId: string): boolean;

  fetch(
    context: ProviderStatusContext
  ): Promise<ProviderResourceSnapshot | null>;
}
```

建议 Context：

```ts
export interface ProviderStatusContext {
  providerId?: string;
  modelId?: string;

  now: Date;
  signal: AbortSignal;

  cache: ProviderStatusCache;
  logger: SafeLogger;
}
```

Source 分类：

```text
Builtin Source
├── Codex
├── Anthropic
└── 后续专用平台

Declarative Source
└── 用户通过 JSON 配置声明 HTTP 请求和解析规则
```

不要为了形式统一而删除 Codex、Anthropic 的专用认证、响应头和缓存逻辑。

---

## 9. Registry

将固定数组改成 Registry：

```ts
export class ProviderStatusRegistry {
  register(source: ProviderStatusSource): void;
  get(id: string): ProviderStatusSource | undefined;
  findForProvider(providerId: string): ProviderStatusSource[];
  list(): ProviderStatusSource[];
}
```

初始化：

```ts
registry.register(createCodexSource());
registry.register(createAnthropicSource());

for (const [id, config] of Object.entries(customProviders)) {
  registry.register(createDeclarativeSource(id, config));
}
```

Provider 匹配优先级：

1. 配置键与当前 Pi Provider ID 完全一致；
2. `matchProviders` 精确匹配；
3. 内置 Source 的 `supports()`；
4. `alwaysRefresh: true`；
5. 否则不刷新。

不要默认每分钟请求所有自定义 Provider。

---

## 10. 配置设计

### 10.1 第一版配置示例

```json
{
  "providerStatus": {
    "providers": ["openai-codex", "anthropic"],
    "refreshMs": 60000,
    "cacheTtlMs": 300000,

    "customProviders": {
      "zero": {
        "label": "0-0",
        "matchProviders": ["zero"],
        "alwaysRefresh": false,

        "request": {
          "url": "https://api.example.com/api/user/self",
          "method": "GET",
          "headers": {
            "Authorization": "Bearer $ZERO_API_KEY"
          },
          "timeoutMs": 5000,
          "maxResponseBytes": 1048576
        },

        "balances": [
          {
            "id": "remaining",
            "label": "余额",
            "selector": "data.quota",
            "transform": {
              "scale": 0.000002,
              "round": 2
            },
            "currency": "CNY"
          }
        ],

        "windows": [
          {
            "id": "monthly",
            "label": "月",
            "remainingPercentSelector": "data.monthly.remaining_percent",
            "resetAtSelector": "data.monthly.reset_at",
            "timestampUnit": "seconds"
          }
        ]
      }
    }
  }
}
```

### 10.2 请求配置

```ts
export interface DeclarativeRequestConfig {
  url: string;
  method?: "GET" | "POST";

  headers?: Record<string, string>;
  body?: unknown;

  timeoutMs?: number;
  maxResponseBytes?: number;

  followRedirects?: boolean;
}
```

默认值：

```ts
{
  method: "GET",
  timeoutMs: 5000,
  maxResponseBytes: 1024 * 1024,
  followRedirects: false
}
```

### 10.3 变量替换

至少支持：

```text
$ENV_VAR
${ENV_VAR}
```

例如：

```json
{
  "Authorization": "Bearer $ZERO_API_KEY"
}
```

可选地兼容 Pi 的命令取值语义：

```text
!command
```

但命令执行必须单独实现安全边界：

* 不通过 shell 拼接；
* 设置超时；
* 限制输出长度；
* 不在日志中打印命令输出；
* 默认关闭，显式启用。

第一版可以只实现环境变量。

---

## 11. JSON 选择和转换

第一版应保持简单、可校验。

### 11.1 Selector

支持点路径和数组下标：

```text
data.quota
data.items[0].remaining
usage.windows.weekly.reset_at
```

建议先实现轻量 selector，而不是立即引入复杂表达式语言。

接口：

```ts
export function selectJson(
  value: unknown,
  selector: string
): unknown;
```

如果后续引入 JMESPath，应作为额外模式：

```json
{
  "selectorType": "jmespath",
  "selector": "data.models[].{id: name, input: input_price}"
}
```

不要允许配置文件执行 JavaScript。

### 11.2 数值转换

```ts
export interface NumericTransform {
  scale?: number;
  offset?: number;
  invertPercent?: boolean;
  clamp?: [number, number];
  round?: number;
}
```

执行顺序：

```text
原值
→ Number 转换
→ scale
→ offset
→ invertPercent
→ clamp
→ round
```

无效数值必须返回明确的 parse 错误，不允许静默显示 `NaN`。

### 11.3 时间转换

```ts
export type TimestampUnit =
  | "seconds"
  | "milliseconds"
  | "iso8601";
```

所有输出统一为 ISO 8601：

```ts
new Date(value).toISOString()
```

非法日期应忽略该字段并记录 selector/parse 错误，不得导致整个 Provider 崩溃。

---

## 12. 缓存

缓存仅保存标准化快照，不保存：

* API Key；
* Header；
* Cookie；
* 原始响应；
* 请求 Body；
* OAuth Token。

建议缓存结构：

```ts
export interface CachedProviderSnapshot {
  version: 1;
  provider: string;
  savedAt: string;
  snapshot: ProviderResourceSnapshot;
}
```

刷新失败时：

1. 有未过期缓存：返回缓存，标记 `stale: true`；
2. 有过期缓存：可在配置允许时继续显示，并明确标记 stale；
3. 无缓存：返回错误状态；
4. 不因单个 Provider 失败影响 Footer 其他部分。

缓存 key 至少包含：

```text
provider ID + endpoint URL hash
```

防止用户修改 endpoint 后继续误用旧数据。

---

## 13. 刷新策略

### 13.1 余额和额度

默认刷新：

```text
当前模型所属 Provider
+ alwaysRefresh 为 true 的 Provider
+ 内置 Provider 特殊触发
```

触发时机：

* Footer 初始化；
* 定时器到期；
* 模型切换；
* 一次模型请求结束后；
* 用户手动执行 refresh。

应避免同一 Provider 并发重复刷新。可使用 single-flight：

```ts
Map<string, Promise<ProviderResourceSnapshot | null>>
```

### 13.2 模型价格

模型价格不应跟随 Footer 每分钟刷新。

建议：

* 启动时加载；
* 默认缓存 6–24 小时；
* 网络失败回退到磁盘缓存；
* 无缓存时回退到本地模型价格；
* 手动命令触发刷新；
* 不阻止 Pi 启动。

---

## 14. Footer 渲染

### 14.1 Gauge

额度窗口按顺序渲染：

```text
5h ■■■■□ 82%  7d ■■□□□ 47%
```

颜色阈值沿用现有设计，或配置为：

```ts
remainingPercent >= 50  => safe
remainingPercent >= 20  => warning
otherwise               => danger
```

不要让自定义 Provider 绕过原生 Gauge。

### 14.2 余额

示例：

```text
0-0 ¥84.26
OpenRouter $12.31
Copilot 217 requests
```

格式规则：

* `CNY` 使用 `¥`；
* `USD` 使用 `$`；
* 未知货币显示代码；
* 非金额单位显示 `value + unit`；
* `approximate: true` 时使用 `≈` 前缀；
* stale 缓存可增加弱提示，例如 `~` 或 dim 样式。

### 14.3 宽度降级

空间不足时按以下顺序降级：

1. 隐藏重置时间；
2. 缩短 Provider label；
3. 隐藏低优先级余额；
4. Gauge 从图形切换为百分比；
5. 最终只显示当前 Provider 的主要指标。

不得因为 Provider 状态过长破坏 Footer 的主布局。

---

## 15. 命令设计

第一版至少支持：

```text
/fancy-footer provider list
/fancy-footer provider refresh
/fancy-footer provider refresh <provider>
/fancy-footer provider test <provider>
/fancy-footer provider debug <provider>
```

### list

显示：

```text
openai-codex  builtin      enabled
anthropic     builtin      enabled
zero          declarative  matched: zero
```

### test

执行一次真实请求和解析，显示：

```text
Provider: zero
Request: GET https://api.example.com/api/user/self
HTTP: 200
Latency: 183 ms
Balance selectors: 1/1 success
Window selectors: 1/1 success
Result: ¥84.26, 月 73%
```

### debug

只显示脱敏信息：

```text
Provider: zero
Source: declarative
Cache: refreshed 12s ago
Endpoint host: api.example.com
HTTP: 200
Latency: 183 ms
Snapshot: valid
```

禁止显示：

* Authorization；
* Cookie；
* API Key；
* 完整 Body；
* 完整原始响应。

---

## 16. 模型价格设计

### 16.1 标准价格模型

```ts
export interface NormalizedModelPrice {
  id: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;

  currency: string;
  unit: "per_million_tokens";
}
```

Pi 使用的价格字段应保持：

```ts
cost: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
```

### 16.2 两种模式

#### estimate-only

```json
{
  "pricing": {
    "mode": "estimate-only"
  }
}
```

特点：

* 不改变 Pi Provider；
* Footer 自己根据 Token usage 估算；
* 显示 `≈`；
* 不回写历史 Session；
* 适合实验性远端价格。

#### register-provider

```json
{
  "pricing": {
    "mode": "register-provider"
  }
}
```

特点：

* 扩展启动时拉取价格；
* 通过 Pi Provider 注册机制提供模型定义；
* 新请求的 `usage.cost` 使用该价格；
* 价格失败时使用缓存或 fallback；
* 不自动修改 `models.json`。

第一版只实现 `estimate-only`，第二阶段再实现 `register-provider`。

---

## 17. 安全要求

必须满足：

* 日志自动脱敏 Bearer Token；
* 不记录完整 Header；
* 不落盘原始 API 响应；
* 请求设置超时；
* 响应体设置大小上限；
* 默认不跟随重定向；
* 跟随重定向时，不向不同主机转发 Authorization；
* URL 仅允许 `http:` 和 `https:`；
* JSON selector 不执行代码；
* 环境变量缺失时返回配置错误；
* 错误信息限制长度；
* 测试中覆盖 Secret 脱敏；
* 缓存文件权限遵循现有 Pi 配置目录策略。

如果未来支持 `!command`：

* 默认关闭；
* 不使用 `shell: true`；
* 命令有超时；
* stdout 有大小限制；
* stderr 不原样展示；
* 输出只作为 Secret 值使用。

---

## 18. 测试要求

### 18.1 纯重构阶段

必须确保：

```bash
npm test
```

结果与上游一致。

此阶段禁止：

* 改变配置行为；
* 改变 Codex/Anthropic 输出；
* 改变缓存格式；
* 改变 Footer 文本；
* 同时新增 declarative provider。

### 18.2 单元测试

新增测试至少覆盖：

#### Selector

* 普通对象路径；
* 数组下标；
* 缺失字段；
* `null`；
* 非对象中间节点；
* 非法 selector。

#### Transform

* scale；
* offset；
* invertPercent；
* clamp；
* round；
* 非数字；
* Infinity；
* NaN。

#### 时间

* Unix 秒；
* Unix 毫秒；
* ISO 8601；
* 非法日期。

#### HTTP

* GET；
* POST；
* Header 变量替换；
* 超时；
* 非 2xx；
* 响应超限；
* 非 JSON；
* 重定向；
* AbortSignal。

#### 缓存

* 正常命中；
* TTL 过期；
* stale fallback；
* endpoint 改变导致 cache key 改变；
* 不包含 Secret。

#### Provider 匹配

* 配置键精确匹配；
* `matchProviders`；
* `alwaysRefresh`；
* 当前模型切换；
* 不刷新无关 Provider。

#### 安全

* Bearer Token 脱敏；
* API Key 脱敏；
* Header 不进入错误对象；
* 原始响应不写入缓存。

### 18.3 集成测试

用本地 HTTP Server 模拟：

```text
正常余额接口
慢响应
401
500
超大响应
格式变化
额度窗口数组
价格列表
```

测试中不得依赖真实在线中转站。

---

## 19. 提交顺序

### Commit 1：拆分 Provider 状态模块

目标：

* 只移动代码；
* 不改变行为；
* 所有现有测试通过。

建议提交信息：

```text
refactor(provider-status): split sources and cache modules
```

### Commit 2：引入通用资源模型

目标：

* `primary/secondary` 迁移为 `windows[]`；
* `credits` 迁移为 `balances[]`；
* 增加旧结构兼容转换；
* 原有 UI 保持一致。

```text
refactor(provider-status): normalize quota windows and balances
```

### Commit 3：引入 Registry

目标：

* 移除固定 Source 数组；
* Codex、Anthropic 通过 Registry 注册；
* 不开放配置。

```text
refactor(provider-status): add provider source registry
```

### Commit 4：声明式 HTTP Source

目标：

* GET/POST；
* Header 环境变量；
* selector；
* transform；
* timeout；
* response limit；
* cache fallback。

```text
feat(provider-status): add declarative HTTP providers
```

### Commit 5：命令和调试

目标：

* list；
* test；
* refresh；
* debug；
* Secret 脱敏。

```text
feat(provider-status): add provider diagnostics commands
```

### Commit 6：配置 TUI

目标：

* 查看自定义 Provider；
* 启用/禁用；
* 调整顺序；
* 展示配置错误；
* 不强求在 TUI 内编辑 Secret。

```text
feat(config): expose custom providers in footer settings
```

### Commit 7：价格估算

目标：

* 远端价格读取；
* 价格缓存；
* `estimate-only`；
* 明确显示估算标记。

```text
feat(pricing): add remote model price estimation
```

### Commit 8：动态 Provider 注册

第二阶段目标：

* Pi 启动时加载价格；
* 注册带 `cost` 的模型；
* 失败回退；
* 不修改 `models.json`。

```text
feat(pricing): register provider models with remote pricing
```

---

## 20. 第一阶段验收标准

第一阶段完成时必须满足：

* [x] 原 Codex 状态显示无回归；
* [x] 原 Anthropic 状态显示无回归；
* [x] 旧配置无需修改；
* [x] 用户可以配置至少一个自定义 Provider；
* [x] 自定义 Provider 可以使用 GET；
* [x] 自定义 Provider 可以使用 POST；
* [x] Header 支持环境变量；
* [x] 可提取余额；
* [x] 可提取一个或多个额度窗口；
* [x] 可转换比例和单位；
* [x] 可解析重置时间；
* [x] 当前 Provider 自动匹配；
* [x] 无关 Provider 不周期刷新；
* [x] 查询失败时可以显示旧缓存；
* [x] Footer 可复用原生 Gauge；
* [x] `/fancy-footer provider test` 可验证配置；
* [x] debug 输出不泄露 Secret；
* [x] 单个 Provider 错误不影响 Pi 和其他 Footer Widget；
* [x] 所有测试通过；
* [x] README 包含完整配置示例。

---

## 21. 第二阶段验收标准

* [x] 可从声明式接口获取模型价格；
* [x] 价格统一转换为每百万 Token；
* [x] 支持 input、output、cacheRead、cacheWrite；
* [x] 价格接口有独立缓存周期；
* [x] 网络失败不会阻止 Pi 启动；
* [x] `estimate-only` 明确显示为估算；
* [x] 可选动态注册 Provider；
* [x] 新请求的 Pi `usage.cost` 与注册价格一致；
* [x] 不修改用户 `models.json`；
* [x] 余额刷新和价格刷新彼此独立。

---

## 22. README 示例应覆盖的场景

至少提供以下配置样例：

1. New API / One API 风格余额；
2. 普通 JSON 余额接口；
3. 月度请求额度；
4. 多个额度窗口；
5. Unix 秒重置时间；
6. 环境变量认证；
7. POST Body 中携带用户 ID；
8. 无金额、仅 Credits；
9. 价格接口；
10. Provider ID 与配置键不同的 `matchProviders`。

不要在仓库中提交真实站点 Token。

---

## 23. 开发启动

```bash
git clone https://github.com/<your-name>/pi-fancy-footer.git
cd pi-fancy-footer

git remote add upstream https://github.com/mavam/pi-fancy-footer.git
git fetch upstream --tags

git checkout -b refactor/provider-status v2.0.0

npm install
npm test
```

首次提交前确认：

```bash
git status
npm test
```

第一笔提交只做文件拆分和 import 调整，不新增功能。

---

## 24. 开发决策记录

遇到架构取舍时，在仓库新增：

```text
docs/decisions/
```

ADR 示例：

```text
0001-keep-builtin-provider-adapters.md
0002-use-declarative-selectors-with-explicit-transforms.md
0003-do-not-write-models-json.md
0004-separate-pricing-and-quota-lifecycles.md
```

每份 ADR 包含：

```markdown
# 标题

## 状态

Accepted / Proposed / Rejected

## 背景

## 决策

## 后果
```

---

## 25. 给编码 Agent 的执行要求

编码 Agent 在执行任务时应遵循：

1. 先阅读当前实现和现有测试；
2. 不在同一提交中混合纯重构和新功能；
3. 每次改动后运行相关测试；
4. 不删除现有错误降级逻辑；
5. 不输出或提交真实 Secret；
6. 不自动覆写用户配置；
7. 不改变上游无关 Widget；
8. 新配置必须加入 schema、类型、测试和 README；
9. 新的网络请求必须有超时和响应上限；
10. 新增错误消息必须经过脱敏；
11. 价格功能不得与每分钟额度刷新共用生命周期；
12. 无法确认的上游行为应先添加 characterization test，再修改实现。

优先保持简单、可测试和可回滚。第一阶段的核心交付是稳定的通用余额与额度查询，不是一次性支持所有中转站。
