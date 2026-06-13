# Continue for APF — 从源码构建流程

## 前置条件

- Node.js **v20.20.1**（项目要求，见 `.nvmrc`）
- npm（随 Node.js 安装）
- git

## 一次性设置（首次构建）

### 1. 克隆源码（如果还没有）

```bash
git clone https://github.com/continuedev/continue.git
cd continue
```

### 2. 安装依赖并构建

```bash
# 在项目根目录执行（PowerShell 或 bash 均可）
# 这是官方的完整安装脚本，会按顺序构建所有子项目
bash scripts/install-dependencies.sh
```

这个脚本会依次完成：

1. 根目录 `npm install`
2. 内部 packages 构建（config-types → fetch → config-yaml → openai-adapters 等）
3. `core/` 安装依赖 + `npm link`
4. `gui/` 安装依赖 + 构建
5. `extensions/vscode/` 安装依赖 + prepackage + 打包 VSIX
6. `binary/` 和 `docs/` 安装

### 3. 验证构建成功

```bash
ls extensions/vscode/build/continue-apf-*.vsix
```

---

## 后续更新流程（每次 Continue 发布新版本时）

### Step 1: 拉取最新代码

```bash
cd continue
git stash                    # 暂存你的自定义修改
git pull origin main         # 拉取最新代码
git stash pop                # 恢复你的修改（可能需要解决冲突）
```

### Step 2: 重新应用自定义修改

#### 修改 1: Gemini 认证方式（文件：`core/llm/llms/Gemini.ts`）

找到 `streamChatGemini` 方法中的：

```typescript
const apiURL = new URL(
  `models/${options.model}:streamGenerateContent?key=${this.apiKey}`,
  this.apiBase,
);
```

改为：

```typescript
const apiURL = new URL(
  `models/${options.model}:streamGenerateContent`,
  this.apiBase,
);
```

以及同一个方法中的 fetch 调用：

```typescript
const response = await this.fetch(apiURL, {
  method: "POST",
  body: JSON.stringify(body),
  signal,
});
```

改为：

```typescript
const response = await this.fetch(apiURL, {
  method: "POST",
  body: JSON.stringify(body),
  signal,
  headers: {
    "x-goog-api-key": this.apiKey ?? "",
  },
});
```

#### 修改 2: 扩展重命名（文件：`extensions/vscode/package.json`）

```json
"name": "continue-apf",
"displayName": "Continue for APF",
"publisher": "YiChen",
"version": "1.0.0",
```

> 版本号按需递增

#### 修改 3: 扩展 ID 硬编码（共 3 处）

改了 publisher/name 后，源码中有 **3 处**硬编码了原始扩展 ID `Continue.continue`，必须同步修改，否则 webview 加载会直接崩溃。

**文件 1：`extensions/vscode/src/util/vscode.ts`**

```typescript
// 原来的
return vscode.extensions.getExtension("Continue.continue")!.extensionUri;
// 改为
return vscode.extensions.getExtension("YiChen.continue-apf")!.extensionUri;
```

**文件 2：`extensions/vscode/src/autocomplete/RecentlyVisitedRangesService.ts`**

```typescript
// 原来的
"output:extension-output-Continue.continue",
// 改为
"output:extension-output-YiChen.continue-apf",
```

**文件 3：`core/autocomplete/templating/validation.ts`**

```typescript
// 原来的
"output:extension-output-Continue.continue",
// 改为
"output:extension-output-YiChen.continue-apf",
```

### Step 3: 增量构建

#### 只改了 `core/` 下的文件（如 Gemini.ts）：

```bash
cd core && npm run build && cd ..
cd extensions/vscode && npm run esbuild && cd ..
```

#### 改了 `gui/` 下的文件，或第一次构建 / 拉取新代码后：

```bash
cd core && npm run build && cd ..
cd gui && npm run build && cd ..
cd extensions/vscode && node scripts/prepackage.js --target win32-x64 && cd ..
```

> `prepackage.js` 会把 `gui/dist` 复制到 `extensions/vscode/gui/`，并复制 native 二进制文件（onnxruntime、sqlite3、lancedb 等）。**第一次构建或大版本更新后必须跑一次。**

#### 注意：修改 3（扩展 ID 硬编码）涉及 core 目录

修改 3 的文件 3 在 `core/` 下，改完后必须重新 `cd core && npm run build`，然后再 esbuild。

### Step 4: 打包 VSIX

```bash
cd extensions/vscode
node scripts/package.js --target win32-x64
```

生成的 VSIX 在：`extensions/vscode/build/continue-apf-1.0.0.vsix`

### Step 5: 安装

```bash
code --install-extension extensions/vscode/build/continue-apf-1.0.0.vsix
```

安装前先卸载旧版：`code --uninstall-extension YiChen.continue-apf`

---

## 注意事项

- Node.js 版本必须是 **v20.20.1**，用 `nvm use` 切换
- `npm link` 步骤很重要，它让 `extensions/vscode` 和 `gui` 能引用本地 `core`
- 如果遇到 `PUPPETEER_SKIP_DOWNLOAD` 相关问题：`$env:PUPPETEER_SKIP_DOWNLOAD='true'`（PowerShell）
- Windows 上运行 `install-dependencies.sh` 需要 bash（Git Bash 即可），或手动按顺序执行其中的命令
