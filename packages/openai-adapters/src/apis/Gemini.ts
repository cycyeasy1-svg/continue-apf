// IMPORTANT: Import nativeFetch FIRST to preserve native fetch before any pollution
import { withNativeFetch } from "../util/nativeFetch.js";
import { GoogleGenAI } from "@google/genai";
import { OpenAI } from "openai/index";
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPartImage,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  Completion,
  CompletionCreateParamsNonStreaming,
  CompletionCreateParamsStreaming,
  CompletionUsage,
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
  Model,
} from "openai/resources/index";

import { v4 as uuidv4 } from "uuid";
import { GeminiConfig } from "../types.js";
import {
  chatChunk,
  chatChunkFromDelta,
  customFetch,
  embedding,
  usageChatChunk,
} from "../util.js";
import {
  convertOpenAIToolToGeminiFunction,
  GeminiChatContent,
  GeminiChatContentPart,
  GeminiToolFunctionDeclaration,
  mergeConsecutiveGeminiMessages,
} from "../util/gemini-types.js";
import { safeParseArgs } from "../util/parseArgs.js";
import {
  BaseLlmApi,
  CreateRerankResponse,
  FimCreateParamsStreaming,
  RerankCreateParams,
} from "./base.js";

type UsageInfo = Pick<
  CompletionUsage,
  "total_tokens" | "completion_tokens" | "prompt_tokens"
>;

interface GeminiToolCall
  extends OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall {
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
}

interface GeminiToolDelta
  extends OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta {
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
}

/**
 * [APF] 解析环境变量 GEMINI_CLI_CUSTOM_HEADERS，把自定义 HTTP header 注入到
 * 所有 Gemini 请求中（流量统计等用途）。与 core/llm/llms/Gemini.ts 保持一致。
 *
 * 格式为 `header-name:header-value`；多个 header 用换行分隔。
 * 示例：`x-summary-key:LDNavi/UI-renewal`
 *
 * 仅按第一个冒号拆分（value 中允许出现 `:` / `/` 等字符），首尾空白会被 trim。
 * 无法解析的行（无冒号或 name 为空）会被忽略。未设置环境变量时返回空对象。
 */
function getGeminiCliCustomHeaders(): Record<string, string> {
  const raw = process.env.GEMINI_CLI_CUSTOM_HEADERS;
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry) continue;
    const sep = entry.indexOf(":");
    if (sep <= 0) continue;
    const name = entry.slice(0, sep).trim();
    const value = entry.slice(sep + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

export class GeminiApi implements BaseLlmApi {
  apiBase: string = "https://generativelanguage.googleapis.com/v1beta/";
  private genAI: GoogleGenAI;

  static maxStopSequences = 5;

  constructor(protected config: GeminiConfig) {
    this.apiBase = config.apiBase ?? this.apiBase;
    // [APF] 与 core/llm/llms/Gemini.ts 保持一致：config 未填 apiKey 时从环境
    // 变量读取，使"设 GOOGLE_API_KEY 即可用"对 SDK（Chat）路径也生效。
    // 否则 default.ts 中 apiKey 为空时，SDK 用空 key 请求公司代理 → 401。
    if (!this.config.apiKey) {
      this.config.apiKey = process.env.GOOGLE_API_KEY ?? "";
    }
    // Create GoogleGenAI with native fetch to avoid pollution
    // from Vercel AI SDK packages that can break stream handling
    this.genAI = withNativeFetch(() => {
      // [APF] @google/genai 1.46+ 不再读取 GOOGLE_GEMINI_BASE_URL 环境变量，
      // 非 vertex 模式下 baseUrl 被 SDK 硬编码为 Google 官方域名（见 SDK
      // ApiClient 构造函数）。这里通过 httpOptions.baseUrl 显式覆盖（SDK
      // 优先级最高），使内网代理地址从 config.apiBase 生效。
      const baseUrl = this.config.apiBase
        ? GeminiApi.normalizeBaseUrl(this.config.apiBase)
        : undefined;
      // [APF] 注入 GEMINI_CLI_CUSTOM_HEADERS 自定义 header（流量统计等用途），
      // 与旧代码路径(core/llm/llms/Gemini.ts)保持一致。SDK 会将其作为默认
      // header 合并到每个请求（认证 header 仍由 SDK 自身添加，不受影响）。
      const customHeaders = getGeminiCliCustomHeaders();
      const httpOptions: {
        baseUrl?: string;
        headers?: Record<string, string>;
      } = {};
      if (baseUrl) httpOptions.baseUrl = baseUrl;
      if (Object.keys(customHeaders).length > 0)
        httpOptions.headers = customHeaders;
      return new GoogleGenAI({
        apiKey: this.config.apiKey,
        ...(Object.keys(httpOptions).length > 0 ? { httpOptions } : {}),
      });
    });
  }

  /**
   * [APF] 校验 Gemini 请求所需的配置（项目规约）。与 core/llm/llms/Gemini.ts
   * 一致：缺失时抛错阻断。不在 constructor 抛出（避免搞坏 config 加载），改为
   * 在请求入口校验，错误冒泡到 Chat UI 醒目显示。
   *
   * 必需项：
   * - apiKey（来自 config 或 GOOGLE_API_KEY 环境变量，二选一）
   * - GEMINI_CLI_CUSTOM_HEADERS（流量统计规约，强制）
   */
  private ensureGeminiConfigured(): void {
    const missing: string[] = [];
    if (!this.config.apiKey) {
      missing.push("apiKey（config 的 apiKey 或环境变量 GOOGLE_API_KEY）");
    }
    if (Object.keys(getGeminiCliCustomHeaders()).length === 0) {
      missing.push("GEMINI_CLI_CUSTOM_HEADERS");
    }
    if (missing.length > 0) {
      throw new Error(
        "[Continue APF] Gemini 配置缺失：" +
          missing.join("、") +
          "。请设置对应环境变量（或在 config 填写 apiKey）后重启 VS Code。",
      );
    }
  }

  /**
   * SDK 会自动拼接 apiVersion（默认 v1beta），baseUrl 必须是根地址。
   * 去掉末尾斜杠与 /v1beta、/v1beta1、/v1 等版本段，避免 URL 重复。
   */
  private static normalizeBaseUrl(apiBase: string): string {
    return apiBase.replace(/\/+$/, "").replace(/\/v\d+(beta\d*)?$/i, "");
  }

  private _oaiPartToGeminiPart(
    part:
      | OpenAI.Chat.Completions.ChatCompletionContentPart
      | OpenAI.Chat.Completions.ChatCompletionContentPartRefusal,
  ): GeminiChatContentPart {
    switch (part.type) {
      case "refusal":
        return {
          text: part.refusal,
        };
      case "text":
        return {
          text: part.text,
        };
      case "input_audio":
        throw new Error("Unsupported part type: input_audio");
      case "image_url":
      default:
        return {
          inlineData: {
            mimeType: "image/jpeg",
            data: (part as ChatCompletionContentPartImage).image_url?.url.split(
              ",",
            )[1],
          },
        };
    }
  }

  public _convertBody(
    oaiBody: ChatCompletionCreateParams,
    isV1API: boolean,
    includeToolCallIds: boolean,
  ) {
    const generationConfig: any = {};

    if (oaiBody.top_p) {
      generationConfig.topP = oaiBody.top_p;
    }
    if (oaiBody.temperature !== undefined && oaiBody.temperature !== null) {
      generationConfig.temperature = oaiBody.temperature;
    }
    if (oaiBody.max_tokens) {
      generationConfig.maxOutputTokens = oaiBody.max_tokens;
    }
    if (oaiBody.stop) {
      const stop = Array.isArray(oaiBody.stop) ? oaiBody.stop : [oaiBody.stop];
      generationConfig.stopSequences = stop.filter((x) => x.trim() !== "");
    }

    const toolCallIdToNameMap = new Map<string, string>();
    oaiBody.messages.forEach((msg) => {
      if (msg.role === "assistant" && msg.tool_calls) {
        msg.tool_calls.forEach((call) => {
          // Type guard for function tool calls
          if (call.type === "function" && "function" in call) {
            toolCallIdToNameMap.set(call.id, call.function.name);
          }
        });
      }
    });

    const contents = oaiBody.messages
      .map((msg) => {
        if (msg.role === "system" && !isV1API) {
          return null; // Don't include system message in contents
        }

        if (msg.role === "assistant" && msg.tool_calls?.length) {
          for (const toolCall of msg.tool_calls) {
            // Type guard for function tool calls
            if (toolCall.type === "function" && "function" in toolCall) {
              toolCallIdToNameMap.set(toolCall.id, toolCall.function.name);
            }
          }

          return {
            role: "model" as const,
            parts: (msg.tool_calls as GeminiToolCall[]).map(
              (toolCall, index) => {
                if (toolCall.type === "function" && "function" in toolCall) {
                  let thoughtSignature: string | undefined;
                  if (index === 0) {
                    const rawSignature =
                      toolCall?.extra_content?.google?.thought_signature;

                    if (
                      typeof rawSignature === "string" &&
                      rawSignature.length > 0
                    ) {
                      thoughtSignature = rawSignature;
                    } else {
                      // Fallback per https://ai.google.dev/gemini-api/docs/thought-signatures
                      // for histories that were not generated by Gemini or are missing signatures.
                      thoughtSignature = "skip_thought_signature_validator";
                    }
                  }

                  return {
                    functionCall: {
                      id: includeToolCallIds ? toolCall.id : undefined,
                      name: toolCall.function.name,
                      args: safeParseArgs(
                        toolCall.function.arguments,
                        `Call: ${toolCall.function.name} ${toolCall.id}`,
                      ),
                    },
                    ...(thoughtSignature && { thoughtSignature }),
                  };
                }
                throw new Error(
                  `Unsupported tool call type in Gemini: ${toolCall.type}`,
                );
              },
            ),
          };
        }

        if (msg.role === "tool") {
          const functionName = toolCallIdToNameMap.get(msg.tool_call_id);
          return {
            role: "user" as const,
            parts: [
              {
                functionResponse: {
                  id: includeToolCallIds ? msg.tool_call_id : undefined,
                  name: functionName ?? "unknown",
                  response: {
                    content:
                      typeof msg.content === "string"
                        ? msg.content
                        : msg.content.map((part) => part.text).join(""),
                  },
                },
              },
            ],
          };
        }

        if (!msg.content) {
          return null;
        }

        return {
          role:
            msg.role === "assistant" ? ("model" as const) : ("user" as const),
          parts:
            typeof msg.content === "string"
              ? [{ text: msg.content }]
              : msg.content.map(this._oaiPartToGeminiPart),
        };
      })
      .filter((c) => c !== null) as GeminiChatContent[];

    const mergedContents = mergeConsecutiveGeminiMessages(contents);

    const sysMsg = oaiBody.messages.find((msg) => msg.role === "system");
    const finalBody: any = {
      generationConfig,
      contents: mergedContents,
      // if there is a system message, reformat it for Gemini API
      ...(sysMsg &&
        !isV1API && {
          systemInstruction: { parts: [{ text: sysMsg.content }] },
        }),
    };

    if (!isV1API) {
      // Convert and add tools if present
      if (oaiBody.tools?.length) {
        // Choosing to map all tools to the functionDeclarations of one tool
        // Rather than map each tool to its own tool + functionDeclaration
        // Same difference
        const functions: GeminiToolFunctionDeclaration[] = [];
        oaiBody.tools.forEach((tool) => {
          try {
            functions.push(convertOpenAIToolToGeminiFunction(tool));
          } catch (e) {
            console.warn(
              `Failed to convert tool to gemini function definition. Skipping: ${JSON.stringify(tool, null, 2)}`,
            );
          }
        });

        if (functions.length) {
          finalBody.tools = [
            {
              functionDeclarations: functions,
            },
          ];
        }
      }
    }

    return finalBody;
  }

  async chatCompletionNonStream(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    let completion = "";
    let usage: UsageInfo | undefined = undefined;
    for await (const chunk of this.chatCompletionStream(
      {
        ...body,
        stream: true,
      },
      signal,
    )) {
      if (chunk.choices.length > 0) {
        completion += chunk.choices[0].delta.content || "";
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }
    return {
      id: "",
      object: "chat.completion",
      model: body.model,
      created: Date.now(),
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: completion,
            refusal: null,
          },
        },
      ],
      usage,
    };
  }

  private async *processStreamResponse(
    response: AsyncIterable<any>,
    model: string,
  ): AsyncGenerator<ChatCompletionChunk> {
    let usage: UsageInfo | undefined = undefined;

    for await (const chunk of response) {
      if (chunk.usageMetadata) {
        usage = {
          prompt_tokens: chunk.usageMetadata.promptTokenCount || 0,
          completion_tokens: chunk.usageMetadata.candidatesTokenCount || 0,
          total_tokens: chunk.usageMetadata.totalTokenCount || 0,
        };
      }

      const contentParts = chunk?.candidates?.[0]?.content?.parts;
      if (contentParts) {
        for (const part of contentParts) {
          if (part.text !== undefined) {
            const thoughtSignature = (part as any)?.thoughtSignature;
            if (thoughtSignature) {
              yield chatChunkFromDelta({
                model,
                delta: {
                  role: "assistant",
                  extra_content: {
                    google: {
                      thought_signature: thoughtSignature,
                    },
                  },
                } as GeminiToolDelta,
              });
            }

            yield chatChunk({
              content: part.text,
              model,
            });
          } else if (part.functionCall) {
            const thoughtSignature = (part as any)?.thoughtSignature;
            yield chatChunkFromDelta({
              model,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: (part.functionCall as any).id ?? uuidv4(),
                    type: "function",
                    function: {
                      name: part.functionCall.name ?? "",
                      arguments: JSON.stringify(part.functionCall.args ?? {}),
                    },
                    ...(thoughtSignature && {
                      extra_content: {
                        google: {
                          thought_signature: thoughtSignature,
                        },
                      },
                    }),
                  },
                ],
              },
            });
          }
        }
      }
    }

    if (usage) {
      yield usageChatChunk({
        model,
        usage,
      });
    }
  }

  /**generates stream from @google/genai sdk */
  private async generateStream(
    genAI: GoogleGenAI,
    model: string,
    convertedBody: ReturnType<typeof this._convertBody>,
  ) {
    // Use native fetch temporarily for stream operation to get proper ReadableStream
    // The withNativeFetch wrapper restores native fetch, makes the call, then reverts
    return withNativeFetch(() =>
      genAI.models.generateContentStream({
        model,
        contents: convertedBody.contents,
        config: {
          systemInstruction: convertedBody.systemInstruction,
          tools: convertedBody.tools,
          ...convertedBody.generationConfig,
        },
      }),
    );
  }

  async *chatCompletionStream(
    body: ChatCompletionCreateParamsStreaming,
    _signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    this.ensureGeminiConfigured();
    const convertedBody = this._convertBody(
      body,
      this.apiBase.includes("/v1/"),
      true,
    );
    const response = await this.generateStream(
      this.genAI,
      body.model,
      convertedBody,
    );
    yield* this.processStreamResponse(response, body.model);
  }

  async *streamWithGenAI(
    genAI: GoogleGenAI,
    body: ChatCompletionCreateParamsStreaming,
  ): AsyncGenerator<ChatCompletionChunk> {
    const convertedBody = this._convertBody(body, false, true);
    const response = await this.generateStream(
      genAI,
      body.model,
      convertedBody,
    );
    yield* this.processStreamResponse(response, body.model);
  }

  completionNonStream(
    _body: CompletionCreateParamsNonStreaming,
  ): Promise<Completion> {
    throw new Error("Method not implemented.");
  }
  completionStream(
    body: CompletionCreateParamsStreaming,
  ): AsyncGenerator<Completion> {
    throw new Error("Method not implemented.");
  }
  fimStream(
    body: FimCreateParamsStreaming,
  ): AsyncGenerator<ChatCompletionChunk> {
    throw new Error("Method not implemented.");
  }
  async rerank(body: RerankCreateParams): Promise<CreateRerankResponse> {
    throw new Error("Method not implemented.");
  }

  async embed(body: EmbeddingCreateParams): Promise<CreateEmbeddingResponse> {
    this.ensureGeminiConfigured();
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const response = await customFetch(this.config.requestOptions)(
      new URL(`${body.model}:batchEmbedContents`, this.apiBase),
      {
        method: "POST",
        body: JSON.stringify({
          requests: inputs.map((input) => ({
            model: body.model,
            content: {
              role: "user",
              parts: [{ text: input }],
            },
          })),
        }),
        headers: {
          // [APF] 自定义 header 在前，认证/Content-Type 在后覆盖
          ...getGeminiCliCustomHeaders(),
          // eslint-disable-next-line @typescript-eslint/naming-convention
          "x-goog-api-key": this.config.apiKey,
          // eslint-disable-next-line @typescript-eslint/naming-convention
          "Content-Type": "application/json",
        },
      },
    );

    const data = (await response.json()) as any;
    return embedding({
      model: body.model,
      usage: {
        total_tokens: data.total_tokens,
        prompt_tokens: data.prompt_tokens,
      },
      data: data.batchEmbedContents.map((embedding: any) => embedding.values),
    });
  }

  list(): Promise<Model[]> {
    throw new Error("Method not implemented.");
  }
}
