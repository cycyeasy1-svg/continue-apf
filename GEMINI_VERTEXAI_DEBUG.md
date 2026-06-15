# Continue 使用自定义 Vertex AI Gemini 代理 — 调试全记录

## 背景

在内网开发环境中，通过自定义代理 `https://172.26.133.12/api/user/vertexai-gemini-proxy` 访问 Google Gemini API。以下环境变量在直接使用 `@google/genai` SDK 时可正常工作：

```
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_VERTEX_BASE_URL="https://172.26.133.12/api/user/vertexai-gemini-proxy"
GOOGLE_API_KEY="sk_live_org_nri_..."
http_proxy="xxx"
node_tls_reject_unauthorized="0"
```

但在 Continue 插件中，Chat 和 Autocomplete 走了**完全不同的代码路径**，导致 Autocomplete 一直 fetch failed。

---

## 核心发现：Continue 的双路径架构

Continue 内部对 LLM 请求有**两套代码**：

|                    | 新路径（Adapter/SDK）                         | 旧路径（Legacy）                                |
| ------------------ | --------------------------------------------- | ----------------------------------------------- |
| **代码位置**       | `packages/openai-adapters/src/apis/Gemini.ts` | `core/llm/llms/Gemini.ts`                       |
| **HTTP 客户端**    | `@google/genai` SDK（内部用 undici fetch）    | `BaseLLM.fetch()` → `fetchwithRequestOptions()` |
| **URL 来源**       | SDK 从环境变量读取 `GOOGLE_GEMINI_BASE_URL`   | 从 config 的 `apiBase` 字段读取                 |
| **认证方式**       | SDK 自动加 `x-goog-api-key` Header            | 硬编码 `?key=xxx` URL 参数                      |
| **requestOptions** | ❌ 不生效（SDK 绕过 Continue 的 fetch）       | ✅ 生效（verifySsl, proxy, headers）            |

### Chat 的调用链（成功）

```
CompletionStreamer → streamChat()
  → shouldUseOpenAIAdapter("streamChat") = true
    → GeminiApi.chatCompletionStream()
      → @google/genai SDK → undici fetch
        → 读 GOOGLE_GEMINI_BASE_URL 环境变量 → 正确的代理 URL ✅
        → x-goog-api-key Header 认证 ✅
```

### Autocomplete 的调用链（失败）

```
CompletionStreamer → supportsFim() = false（Gemini 没覆写）
  → streamComplete()
    → shouldUseOpenAIAdapter("streamComplete") = false（列表里没有！）
      → _streamComplete() → _streamChat() → streamChatGemini()
        → new URL("models/xxx:streamGenerateContent?key=xxx", this.apiBase)
        → this.fetch() → fetchwithRequestOptions()
          → 默认 apiBase = generativelanguage.googleapis.com ❌
          → ?key= URL 参数认证 ❌
```

**Autocomplete 不走 SDK 的根本原因：**

1. `supportsFim()` 返回 `false` → 走 `streamComplete()` 而非 `streamFim()`
2. `useOpenAIAdapterFor` 列表不包含 `"streamComplete"`
3. 旧代码硬编码 `?key=` URL 参数，代理不接受这种认证方式

---

## `@google/genai` SDK 环境变量行为

SDK v1.30.0 源码分析：

```javascript
// 构造函数读取环境变量
this.vertexai =
  options.vertexai ?? getBooleanEnv("GOOGLE_GENAI_USE_VERTEXAI") ?? false;

// URL 解析优先级：httpOptions.baseUrl > setDefaultBaseUrls > 环境变量
const baseUrl = getBaseUrl(
  options.httpOptions,
  options.vertexai,
  getEnv("GOOGLE_VERTEX_BASE_URL"), // Vertex AI 模式
  getEnv("GOOGLE_GEMINI_BASE_URL"), // Gemini 模式 ★
);
```

Continue 创建 SDK 时只传 `apiKey`：

```typescript
this.genAI = new GoogleGenAI({ apiKey: this.config.apiKey });
```

由于 `options.vertexai` 是 undefined，SDK 会 fallback 到环境变量 `GOOGLE_GENAI_USE_VERTEXAI`。如果设了 `true`，走 Vertex 路径读 `GOOGLE_VERTEX_BASE_URL`；否则读 `GOOGLE_GEMINI_BASE_URL`。

**关键：** Continue 没传 `vertexai: true`，所以即使设了 `GOOGLE_GENAI_USE_VERTEXAI=true`，SDK 也会读它。最终 URL 取决于 `vertexai` 标志：

- `vertexai=true` → 读 `GOOGLE_VERTEX_BASE_URL`
- `vertexai=false` → 读 `GOOGLE_GEMINI_BASE_URL`

---

## 调试过程与错误对照表

| 尝试                                                     | 配置                          | 错误             | 原因                                                                                                                         |
| -------------------------------------------------------- | ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1. `provider: "openai"`                                  | `apiBase` 指向代理            | **404**          | 代理不支持 OpenAI `/v1/chat/completions` 路径格式                                                                            |
| 2. `provider: "openai"` + `extraArgs.rejectUnauthorized` | 同上                          | **fetch failed** | `extraArgs` 不是 Continue 合法字段，被 Zod schema 忽略                                                                       |
| 3. `provider: "gemini"` + `GOOGLE_VERTEX_BASE_URL`       | 仅环境变量                    | **fetch failed** | Chat 走 SDK 但 SDK 走了 Gemini 路径（非 Vertex），读的是 `GOOGLE_GEMINI_BASE_URL`（未设置）                                  |
| 4. `provider: "gemini"` + `GOOGLE_GEMINI_BASE_URL`       | 环境变量                      | ✅ Chat 成功     | SDK 正确读到自定义 base URL                                                                                                  |
| 5. 同上                                                  | Autocomplete                  | **fetch failed** | Autocomplete 走旧代码，`apiBase` 未设，指向 Google 官方域名                                                                  |
| 6. Autocomplete + `apiBase` + `verifySsl`                | config 设 apiBase             | **401**          | URL 正确了，但旧代码用 `?key=` 认证，代理只接受 Header 认证                                                                  |
| 7. 加 `x-goog-api-key` header                            | requestOptions.headers        | **404**          | `apiBase` 路径格式是 Gemini 格式（`/v1beta/models/xxx`），代理期望 Vertex AI 格式（`/v1beta1/publishers/google/models/xxx`） |
| 8. `apiBase` 含 Vertex 路径前缀                          | `/v1beta1/publishers/google/` | **401**          | URL 路径正确了，但认证方式仍是 `?key=`                                                                                       |
| 9. apiBase + header 两者都加                             | 同时有 `?key=` 和 header      | **400**          | 代理拒绝同时存在两种认证方式                                                                                                 |

**结论：** 配置方案无法解决问题，必须改代码。

---

## 最终解决方案：修改源码

### 修改文件：`core/llm/llms/Gemini.ts`

将 `streamChatGemini` 方法中的认证方式从 URL 参数改为 Header：

```typescript
// ===== 修改前 =====
const apiURL = new URL(
  `models/${options.model}:streamGenerateContent?key=${this.apiKey}`,
  this.apiBase,
);
const response = await this.fetch(apiURL, {
  method: "POST",
  body: JSON.stringify(body),
  signal,
});

// ===== 修改后 =====
const apiURL = new URL(
  `models/${options.model}:streamGenerateContent`,
  this.apiBase,
);
const response = await this.fetch(apiURL, {
  method: "POST",
  body: JSON.stringify(body),
  signal,
  headers: {
    "x-goog-api-key": this.apiKey ?? "",
  },
});
```

### 修改文件：`extensions/vscode/package.json`

```json
"name": "continue-apf",
"displayName": "Continue for APF",
"publisher": "YiChen",
"version": "1.0.0",
```

### 追加自定义请求头（流量统计）

通过环境变量 `GEMINI_CLI_CUSTOM_HEADERS` 向所有 Gemini 请求注入自定义 HTTP header（流量统计等用途）。格式为 `header-name:header-value`，多个 header 用换行分隔，例如：

```
GEMINI_CLI_CUSTOM_HEADERS="x-summary-key:LDNavi/UI-renewal"
```

实现覆盖两条代码路径（与认证修改一致）：

- **旧代码路径（Autocomplete / Embed）**：`core/llm/llms/Gemini.ts` 的 `getGeminiCliCustomHeaders()` 在 `streamChatGemini` / `streamChatBison` / `_embed` 的 fetch headers 中注入。
- **SDK 路径（Chat / Embed）**：`packages/openai-adapters/src/apis/Gemini.ts` 通过 `httpOptions.headers` 传给 `@google/genai` SDK，并在 `embed()` 的 fetch 中注入。

只按第一个冒号拆分（value 中允许出现 `:` / `/`）；自定义 header 优先级**低于**认证 / `Content-Type`，不会破坏认证。

### 环境变量缺失检查（醒目提示 + 阻断）

在内网代理场景下，`GOOGLE_API_KEY` 是 Gemini 认证的关键。当它（以及 config 的 `apiKey`）都缺失时，请求会因无认证失败。增加两层检查：

- **激活时弹窗**（`extensions/vscode/src/activation/activate.ts`）：扩展激活时检查 `GOOGLE_API_KEY` 环境变量，缺失则 `vscode.window.showErrorMessage` 弹窗提醒（用 `context.globalState` 去重，每个环境只弹一次）。
- **请求时阻断**（`core/llm/llms/Gemini.ts` + `packages/openai-adapters/src/apis/Gemini.ts`）：在请求入口（`_streamChat` / `_embed` / `chatCompletionStream` / `embed`）调用 `ensureGeminiConfigured()`，apiKey 为空时抛出醒目错误，冒泡到 Chat UI 显示并阻断请求。

**为何不在 constructor 抛错**：`core/config/load.ts` 构造模型时无 try-catch，constructor 抛错会让 `Promise.all` 整体 reject、整个 config 加载失败（所有模型不可用）。改为请求入口校验，只阻断缺失配置的请求，不影响模型列表加载。

**检查范围（项目规约，强制）**：

| 环境变量                                  | 是否检测       | 说明                                    |
| ----------------------------------------- | -------------- | --------------------------------------- |
| `GOOGLE_API_KEY`                          | ✅ 弹窗 + 阻断 | 必需认证，可被 config 的 `apiKey` 替代  |
| `GEMINI_CLI_CUSTOM_HEADERS`               | ✅ 弹窗 + 阻断 | 流量统计规约，强制                      |
| `GOOGLE_GEMINI_BASE_URL`                  | ❌             | activate.ts 保证有值（SDK fallback 用） |
| `NODE_TLS_REJECT_UNAUTHORIZED`            | ❌             | activate.ts 强制设为 `0`                |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | ❌             | 见下方「代理环境变量」说明              |

**代理环境变量（重要：路径差异）**：经核实，`@google/genai` SDK 1.46.0 源码**完全不处理代理**（无 `ProxyAgent`、不读 `HTTP_PROXY`），而 `@continuedev/fetch`（[packages/fetch/src/util.ts](packages/fetch/src/util.ts)）会读 `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy` + `NO_PROXY`/`no_proxy`（优先级 `requestOptions.proxy` > 环境变量）。因此：

| 路径                                                   | 是否走 `HTTP_PROXY` 等环境变量 |
| ------------------------------------------------------ | ------------------------------ |
| Autocomplete（core 旧路径，`fetchwithRequestOptions`） | ✅ 走                          |
| Embed（core `_embed` / adapter `customFetch`）         | ✅ 走                          |
| **Chat（SDK `generateContentStream`，undici）**        | ❌ **不走**                    |

即：若内网访问需先走 HTTP 代理，Autocomplete 能通过环境变量走代理，但 **Chat 不会**（SDK 内部 undici fetch 既不读环境变量也无法注入 `ProxyAgent`，见「待改进 #5」）。这是已知遗留问题，故代理变量不纳入强制检测——即使检测也无法让 Chat 走代理。

**base URL 勘误**：早期记录称「1.46+ 不再读取 `GOOGLE_GEMINI_BASE_URL`」，经核实 SDK **1.46.0 仍读取**（作为 `httpOptions.baseUrl` 未提供时的 fallback）。优先级：`config.apiBase`（→ `httpOptions.baseUrl`）> `setDefaultBaseUrls` > 环境变量（`GOOGLE_GENAI_USE_VERTEXAI=true` 读 `GOOGLE_VERTEX_BASE_URL`，否则读 `GOOGLE_GEMINI_BASE_URL`）。

**`config.apiBase` 默认值**：core/adapter 的 `apiBase` 默认是 Google 官方域名 `https://generativelanguage.googleapis.com/v1beta/`（内网不可用）。内网代理地址不来自该默认值，而来自：Chat 走 activate.ts 设的 `GOOGLE_GEMINI_BASE_URL`，Autocomplete 必须在 config 显式填 `apiBase`。故 `GOOGLE_GEMINI_BASE_URL` 无需检测（activate.ts 兜底）。

---

## 最终可用的 Continue 配置

### Chat 模型（走 SDK 路径）

```json
{
  "models": [
    {
      "title": "Company Gemini",
      "provider": "gemini",
      "model": "gemini-2.5-flash",
      "apiKey": "sk_live_org_nri_你的Key"
    }
  ]
}
```

依赖环境变量 `GOOGLE_GEMINI_BASE_URL`（如果 `GOOGLE_GENAI_USE_VERTEXAI=true` 则用 `GOOGLE_VERTEX_BASE_URL`）。

### Autocomplete 模型（走旧代码路径，需源码修改）

```json
{
  "tabAutocompleteModel": {
    "title": "Company Gemini Autocomplete",
    "provider": "gemini",
    "model": "gemini-2.5-flash",
    "apiKey": "sk_live_org_nri_你的Key",
    "apiBase": "https://172.26.133.12/api/user/vertexai-gemini-proxy/v1beta1/publishers/google/",
    "requestOptions": {
      "verifySsl": false,
      "proxy": "http://你的http代理:端口"
    }
  }
}
```

**注意：** `apiBase` 尾部必须有 `/`，且路径包含 `/v1beta1/publishers/google/` 以匹配 Vertex AI URL 格式。

### 必要的系统环境变量（设置后重启 VS Code）

```
GOOGLE_GEMINI_BASE_URL=https://172.26.133.12/api/user/vertexai-gemini-proxy
NODE_TLS_REJECT_UNAUTHORIZED=0
```

（如果设了 `GOOGLE_GENAI_USE_VERTEXAI=true`，SDK 会读 `GOOGLE_VERTEX_BASE_URL` 而非 `GOOGLE_GEMINI_BASE_URL`）

**可选** —— 自定义请求头（流量统计），Chat 与 Autocomplete 两条路径都生效：

```
GEMINI_CLI_CUSTOM_HEADERS="x-summary-key:LDNavi/UI-renewal"
```

详见上文「追加自定义请求头（流量统计）」一节。

---

## 从源码构建 VSIX 的流程

详见 [BUILD_APF.md](BUILD_APF.md)。

---

## 待改进 / 遗留问题

1. **`supportsFim()` 应该为 Gemini 返回 true**：目前 Gemini 没覆写 `supportsFim()`，导致 autocomplete 走 `streamComplete` 而非 `streamFim`
2. **`useOpenAIAdapterFor` 应包含 `"streamComplete"`**：这样 autocomplete 也能走 SDK 路径
3. **GeminiApi.fimStream 和 completionStream 未实现**：adapter 抛 "Method not implemented"
4. **SDK 不走 Continue 的 requestOptions**：代理、TLS 等配置对 SDK 无效，只能靠全局环境变量
5. **undici fetch 不读 HTTP_PROXY 环境变量**：SDK 内部的 undici fetch 不支持代理环境变量，需要其他方式处理
