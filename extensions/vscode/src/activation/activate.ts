import { getContinueRcPath, getTsConfigPath } from "core/util/paths";
import * as vscode from "vscode";

import { VsCodeExtension } from "../extension/VsCodeExtension";
import { isUnsupportedPlatform } from "../util/util";

import { GlobalContext } from "core/util/GlobalContext";
import { VsCodeContinueApi } from "./api";
import setupInlineTips from "./InlineTipManager";

export async function activateExtension(context: vscode.ExtensionContext) {
  // [APF] SDK（含 1.46.0）在 httpOptions.baseUrl 未提供（即 config 未填
  // apiBase）时，会 fallback 读取此环境变量作为 Gemini base URL（见 SDK
  // getBaseUrl：httpOptions.baseUrl > setDefaultBaseUrls > 环境变量）。这里
  // 设默认值，使「config 不填 apiBase」的 Chat 配置也能命中内网代理；若
  // config 已填 apiBase，则 httpOptions.baseUrl 优先级更高，此变量不生效。
  if (!process.env.GOOGLE_GEMINI_BASE_URL) {
    process.env.GOOGLE_GEMINI_BASE_URL =
      "https://172.26.133.12/api/user/vertexai-gemini-proxy";
  }
  // [APF] SDK 内部用 undici fetch，不走 Continue 的 requestOptions，且
  // httpOptions 不支持 TLS 配置，故只能通过此环境变量禁用 TLS 验证
  //（公司内网自签名 CA）。该变量是 Node 原生行为，core 子进程 spawn 时
  // 会继承父进程环境，所以仍能生效。
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const platformCheck = isUnsupportedPlatform();
  const globalContext = new GlobalContext();
  const hasShownUnsupportedPlatformWarning = globalContext.get(
    "hasShownUnsupportedPlatformWarning",
  );

  if (platformCheck.isUnsupported && !hasShownUnsupportedPlatformWarning) {
    const platformTarget = "windows-arm64";

    globalContext.update("hasShownUnsupportedPlatformWarning", true);
    void vscode.window.showInformationMessage(
      `Continue detected that you are using ${platformTarget}. Due to native dependencies, Continue may not be able to start`,
    );
  }

  // [APF] 检查 Gemini 内网代理所需的环境变量（项目规约）。缺失则在激活时
  // 提前弹窗提醒（core/adapter 在请求时会再次校验并阻断）。注意 apiKey 也可
  // 在模型 config 中配置；本提示针对依赖环境变量的场景。用 globalState 去重，
  // 每个环境只弹一次。
  const missingGeminiEnv: string[] = [];
  if (!process.env.GOOGLE_API_KEY) missingGeminiEnv.push("GOOGLE_API_KEY");
  if (!process.env.GEMINI_CLI_CUSTOM_HEADERS)
    missingGeminiEnv.push("GEMINI_CLI_CUSTOM_HEADERS");
  if (missingGeminiEnv.length > 0) {
    if (!context.globalState.get("hasShownMissingGeminiEnvWarning")) {
      void context.globalState.update("hasShownMissingGeminiEnvWarning", true);
      void vscode.window.showErrorMessage(
        "[Continue APF] 未检测到环境变量：" +
          missingGeminiEnv.join("、") +
          "。Gemini 在内网代理下需要它们" +
          "（GOOGLE_API_KEY 也可在模型 config 中设置 apiKey）。请设置后重启 VS Code。",
      );
    }
  }

  // Add necessary files
  getTsConfigPath();
  getContinueRcPath();

  // Register commands and providers
  setupInlineTips(context);

  const vscodeExtension = new VsCodeExtension(context);

  // Load Continue configuration
  if (!context.globalState.get("hasBeenInstalled")) {
    void context.globalState.update("hasBeenInstalled", true);
  }

  // Register config.yaml schema by removing old entries and adding new one (uri.fsPath changes with each version)
  const yamlMatcher = ".continue/**/*.yaml";
  const yamlConfig = vscode.workspace.getConfiguration("yaml");
  const yamlSchemas = yamlConfig.get<object>("schemas", {});

  const newPath = vscode.Uri.joinPath(
    context.extension.extensionUri,
    "config-yaml-schema.json",
  ).toString();

  try {
    await yamlConfig.update(
      "schemas",
      {
        ...yamlSchemas,
        [newPath]: [yamlMatcher],
      },
      vscode.ConfigurationTarget.Global,
    );
  } catch (error) {
    console.error(
      "Failed to register Continue config.yaml schema, most likely, YAML extension is not installed",
      error,
    );
  }

  const api = new VsCodeContinueApi(vscodeExtension);
  const continuePublicApi = {
    registerCustomContextProvider: api.registerCustomContextProvider.bind(api),
  };

  // 'export' public api-surface
  // or entire extension for testing
  return process.env.NODE_ENV === "test"
    ? {
        ...continuePublicApi,
        extension: vscodeExtension,
      }
    : continuePublicApi;
}
