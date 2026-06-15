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

> **先看 `git status`，按改动范围决定跑哪些步骤，不要无脑全跑。** 依赖链是 `packages/ → core → gui / vscode 扩展`，上游一改就必须先重建上游（core 是 gui 和 vscode 扩展的共同依赖；`packages/` 又是 core 的依赖）：
>
> | 改动范围                                                   | 要跑的步骤    |
> | ---------------------------------------------------------- | ------------- |
> | 改了 `packages/` 的 src（如 config-yaml、openai-adapters） | ⓪ ① ④         |
> | 只改 `core/`（如 Gemini.ts）                               | ① ④           |
> | 改了 `gui/`                                                | ① ② ③         |
> | 改了 `extensions/vscode/src/`（如 activate.ts）            | ④             |
> | 第一次 / 拉取新代码后                                      | ① ② ③（全量） |
>
> 多范围叠加取并集。

#### ⓪ 构建 packages（仅当 `packages/` 的 src 有改动时）

`core` 通过 `file:` 引用 `@continuedev/config-yaml`、`@continuedev/openai-adapters` 等内部包（见 `core/package.json`）。这些包用 `tsc` 编译到各自的 `dist/`，**源码改了就必须先重建 dist，否则改动进不了 core、也进不了 vsix**（esbuild 打包时读的是这些包的 `dist/`，不会重新编译 src）。

逐个重建有改动的包即可（用 `git status` 确认哪些变了，没变的跳过）：

```bash
# 例如 config-yaml 和 openai-adapters 改了：
npm run build --prefix packages/config-yaml
npm run build --prefix packages/openai-adapters
```

> 这一步**必须在 ① core build 之前**跑，且之后接 ① core build + ④ esbuild 才能让改动真正进入扩展。

#### ① 构建 core

```bash
cd core && npm run build && cd ..
```

#### ② 构建 gui

```bash
cd gui && npm run build && cd ..
```

#### ③ prepackage（复制 gui/dist + native 二进制到 vscode 扩展目录）

```bash
cd extensions/vscode && node scripts/prepackage.js --target win32-x64 && cd ..
```

> `prepackage.js` 会把 `gui/dist` 复制到 `extensions/vscode/gui/`，并复制 native 二进制文件（onnxruntime、sqlite3、lancedb 等）。**第一次构建或大版本更新后必须跑一次。**

#### ④ esbuild（编译 vscode 扩展源码 → `out/extension.js`）

```bash
cd extensions/vscode && npm run esbuild && cd ..
```

> 改了 `extensions/vscode/src/` 下的任何文件（如 `activate.ts`）都必须重新 esbuild，否则改动进不了 vsix。`package.js` 只调 `vsce package`、本身不编译；虽然打包时 `vsce` 会触发 `vscode:prepublish`（`esbuild --minify`），但**显式跑一次 `npm run esbuild` 能提前暴露编译错误**，更稳妥。

#### 完整示例：core + gui + vscode src 都改了（最常见）

```bash
cd core && npm run build && cd ..
cd gui && npm run build && cd ..
cd extensions/vscode && node scripts/prepackage.js --target win32-x64 && cd ..
cd extensions/vscode && npm run esbuild && cd ..
```

> 若 `packages/` 也改了，在开头补 ⓪（先 `npm run build --prefix packages/<改动的包>`），再从 `cd core && npm run build` 接着跑。

#### 注意：修改 3（扩展 ID 硬编码）涉及 core 目录

修改 3 的文件 3 在 `core/` 下，改完后必须重新 `cd core && npm run build`，然后再 esbuild。

### Step 4: 打包 VSIX

```bash
cd extensions/vscode
node scripts/package.js --target win32-x64
```

生成的 VSIX 在：`extensions/vscode/build/continue-apf-win32-x64-1.0.0.vsix`

> ⚠️ `package.js` 打印的 `continue-1.0.0.vsix` 是**写死的提示文案、不准**。带了 `--target` 后真实文件名带平台后缀 `continue-apf-win32-x64-1.0.0.vsix`（`package.json` 的 `name` + target + version），且会**覆盖**上一次的同名文件。Step 5 安装时认这个真实文件名。

### Step 5: 安装

```bash
code --install-extension extensions/vscode/build/continue-apf-win32-x64-1.0.0.vsix
```

安装前先卸载旧版：`code --uninstall-extension YiChen.continue-apf`

---

## 注意事项

- Node.js 版本**官方要求 v20.20.1**（`.nvmrc`），用 `nvm use` 切换。**本机实测**：`nvm` 未在 PATH，直接用当前 Node v24.12.0 也能跑通整条构建链（core/gui/prepackage/esbuild/package 全程无报错）；遇到诡异错误再装 nvm-windows 切回 v20.20.1 即可。
- `npm link` 步骤很重要，它让 `extensions/vscode` 和 `gui` 能引用本地 `core`
- 如果遇到 `PUPPETEER_SKIP_DOWNLOAD` 相关问题：`$env:PUPPETEER_SKIP_DOWNLOAD='true'`（PowerShell）
- Windows 上运行 `install-dependencies.sh` 需要 bash（Git Bash 即可），或手动按顺序执行其中的命令
- **用 Claude Code 的 Bash 工具执行时**：`cd` 会跨命令持久化工作目录，连续 `cd core` 后下一条 `cd gui` 会报 `No such file or directory`。跨步骤一律用绝对路径（如 `cd /e/AI/Continue/continue/gui && ...`），或每条命令先回仓库根再 cd。
