import { streamResponse } from "@continuedev/fetch";
import { v4 as uuidv4 } from "uuid";
import {
  AssistantChatMessage,
  ChatMessage,
  CompletionOptions,
  LLMOptions,
  MessagePart,
  TextMessagePart,
  ToolCallDelta,
} from "../../index.js";
import { safeParseToolCallArgs } from "../../tools/parseArgs.js";
import { renderChatMessage, stripImages } from "../../util/messageContent.js";
import { extractBase64FromDataUrl } from "../../util/url.js";
import { BaseLLM } from "../index.js";
import { LlmApiRequestType } from "../openaiTypeConverters.js";
import {
  GeminiChatContent,
  GeminiChatContentPart,
  GeminiChatRequestBody,
  GeminiChatResponse,
  GeminiGenerationConfig,
  GeminiToolFunctionDeclaration,
  convertContinueToolToGeminiFunction,
  mergeConsecutiveGeminiMessages,
} from "./gemini-types";

interface GeminiToolCallDelta extends ToolCallDelta {
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
}

/**
 * [APF] 解析环境变量 GEMINI_CLI_CUSTOM_HEADERS，把自定义 HTTP header 注入到
 * 所有 Gemini 请求中（流量统计等用途）。
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

class Gemini extends BaseLLM {
  static providerName = "gemini";

  static defaultOptions: Partial<LLMOptions> = {
    model: "gemini-3.5-flash",
    apiBase: "https://generativelanguage.googleapis.com/v1beta/",
    maxStopWords: 5,
    maxEmbeddingBatchSize: 100,
  };

  // [APF] 如果用户未在 config 中配置 apiKey，从环境变量读取
  constructor(options: LLMOptions) {
    super(options);
    if (!this.apiKey) {
      this.apiKey = process.env.GOOGLE_API_KEY;
    }
  }

  /**
   * [APF] 校验 Gemini 请求所需的配置（项目规约）。缺失时抛出醒目错误以阻断请求。
   *
   * 必需项：
   * - apiKey（来自 config 或 GOOGLE_API_KEY 环境变量，二选一）
   * - GEMINI_CLI_CUSTOM_HEADERS（流量统计规约，强制）
   *
   * 刻意不在 constructor 抛出 —— load.ts 构造模型时无 try-catch，constructor
   * 抛错会让整个 config 加载失败（所有模型都不可用）。改为在请求入口校验，
   * 既阻断该次请求，又不影响模型列表加载；错误会冒泡到 Chat UI 醒目显示。
   */
  private ensureGeminiConfigured(): void {
    const missing: string[] = [];
    if (!this.apiKey) {
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

  protected useOpenAIAdapterFor: (LlmApiRequestType | "*")[] = [
    "chat",
    "embed",
    "list",
    "rerank",
    "streamChat",
    "streamFim",
  ];

  // Function to convert completion options to Gemini format
  public convertArgs(options: CompletionOptions): GeminiGenerationConfig {
    // should be public for use within VertexAI
    const finalOptions: any = {}; // Initialize an empty object

    // Map known options
    if (options.topK) {
      finalOptions.topK = options.topK;
    }
    if (options.topP) {
      finalOptions.topP = options.topP;
    }
    if (options.temperature !== undefined && options.temperature !== null) {
      finalOptions.temperature = options.temperature;
    }
    if (options.maxTokens) {
      finalOptions.maxOutputTokens = options.maxTokens;
    }
    if (options.stop) {
      finalOptions.stopSequences = options.stop
        .filter((x) => x.trim() !== "")
        .slice(0, this.maxStopWords ?? Gemini.defaultOptions.maxStopWords);
    }

    // [APF] Map Continue's reasoning controls to Gemini's thinkingConfig.
    // - reasoning: false          -> thinkingBudget: 0 (disable thinking entirely)
    // - reasoningBudgetTokens: N  -> thinkingBudget: N
    // Disabling thinking is what makes Gemini viable for low-latency autocomplete.
    if (options.reasoning === false) {
      finalOptions.thinkingConfig = { thinkingBudget: 0 };
    } else if (options.reasoningBudgetTokens !== undefined) {
      finalOptions.thinkingConfig = {
        thinkingBudget: options.reasoningBudgetTokens,
      };
    }

    return finalOptions;
  }

  protected async *_streamComplete(
    prompt: string,
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    // [APF] Autocomplete (single-prompt completion) should never pay the
    // latency cost of Gemini thinking. Default to reasoning: false unless the
    // caller explicitly requested reasoning. This is the main lever for
    // reducing autocomplete delay on Gemini 2.5/3.5 Flash.
    const completionOptions: CompletionOptions = {
      ...options,
      reasoning: options.reasoning ?? false,
    };

    for await (const message of this._streamChat(
      [{ content: prompt, role: "user" }],
      signal,
      completionOptions,
    )) {
      yield renderChatMessage(message);
    }
  }

  /**
   * Removes the system message and merges it with the next user message if present.
   * @param messages Array of chat messages
   * @returns Modified array with system message merged into user message if applicable
   */
  public removeSystemMessage(messages: ChatMessage[]): ChatMessage[] {
    // If no messages or first message isn't system, return copy of original messages
    if (messages.length === 0 || messages[0]?.role !== "system") {
      return [...messages];
    }

    // Extract system message
    const systemMessage: ChatMessage = messages[0];

    // Extract system content based on its type
    let systemContent = "";

    if (typeof systemMessage.content === "string") {
      systemContent = systemMessage.content;
    } else if (Array.isArray(systemMessage.content)) {
      const contentArray: Array<MessagePart> =
        systemMessage.content as Array<MessagePart>;

      const concatenatedText = contentArray
        .filter((part): part is TextMessagePart => part.type === "text")
        .map((part) => part.text)
        .join(" ");

      systemContent = concatenatedText ? concatenatedText : "";
    } else if (
      systemMessage.content &&
      typeof systemMessage.content === "object"
    ) {
      const typedContent = systemMessage.content as TextMessagePart;
      systemContent = typedContent?.text || "";
    }

    // Create new array without the system message
    const remainingMessages: ChatMessage[] = messages.slice(1);

    // Check if there's a user message to merge with
    if (remainingMessages.length > 0 && remainingMessages[0].role === "user") {
      const userMessage: ChatMessage = remainingMessages[0];
      const prefix = `System message - follow these instructions in every response: ${systemContent}\n\n---\n\n`;

      // Merge based on user content type
      if (typeof userMessage.content === "string") {
        userMessage.content = prefix + userMessage.content;
      } else if (Array.isArray(userMessage.content)) {
        const contentArray: Array<MessagePart> =
          userMessage.content as Array<MessagePart>;
        const textPart = contentArray.find((part) => part.type === "text") as
          | TextMessagePart
          | undefined;

        if (textPart) {
          textPart.text = prefix + textPart.text;
        } else {
          userMessage.content.push({
            type: "text",
            text: prefix,
          } as TextMessagePart);
        }
      } else if (
        userMessage.content &&
        typeof userMessage.content === "object"
      ) {
        const typedContent = userMessage.content as TextMessagePart;
        userMessage.content = [
          {
            type: "text",
            text: prefix + (typedContent.text || ""),
          } as TextMessagePart,
        ];
      }
    }

    return remainingMessages;
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    this.ensureGeminiConfigured();
    const isV1API = /\/v1\/(?!beta)/.test(this.apiBase ?? "");

    const convertedMsgs = isV1API
      ? this.removeSystemMessage(messages)
      : messages;

    if (options.model.includes("bison")) {
      for await (const message of this.streamChatBison(
        convertedMsgs,
        signal,
        options,
      )) {
        yield message;
      }
    } else {
      for await (const message of this.streamChatGemini(
        convertedMsgs,
        signal,
        options,
      )) {
        yield message;
      }
    }
  }

  continuePartToGeminiPart(part: MessagePart): GeminiChatContentPart {
    if (part.type === "text") {
      return {
        text: part.text,
      };
    }

    let data = "";
    if (part.imageUrl?.url) {
      const extracted = extractBase64FromDataUrl(part.imageUrl.url);
      if (extracted) {
        data = extracted;
      } else {
        console.warn(
          "Gemini: skipping image with invalid data URL format",
          part.imageUrl.url,
        );
      }
    }

    return {
      inlineData: {
        mimeType: "image/jpeg",
        data,
      },
    };
  }

  public prepareBody(
    messages: ChatMessage[],
    options: CompletionOptions,
    isV1API: boolean,
    includeToolIds: boolean,
  ): GeminiChatRequestBody {
    const toolCallIdToNameMap = new Map<string, string>();
    messages.forEach((msg) => {
      if (msg.role === "assistant" && msg.toolCalls) {
        msg.toolCalls.forEach((call) => {
          if (call.id && call.function?.name) {
            toolCallIdToNameMap.set(call.id, call.function.name);
          }
        });
      }
    });
    const systemMessage = messages.find(
      (msg) => msg.role === "system",
    )?.content;

    const body: GeminiChatRequestBody = {
      contents: messages
        .filter((msg) => !(msg.role === "system" && isV1API))
        .map((msg) => {
          if (msg.role === "tool") {
            let functionName = toolCallIdToNameMap.get(msg.toolCallId);
            if (!functionName) {
              console.warn(
                "Sending tool call response for unidentified tool call",
              );
            }
            return {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    id: includeToolIds ? msg.toolCallId : undefined,
                    name: functionName || "unknown",
                    response: {
                      output: msg.content, // "output" key is opinionated - not all functions will output objects
                    },
                  },
                },
              ],
            };
          }
          if (msg.role === "assistant") {
            const assistantMsg: GeminiChatContent = {
              role: "model",
              parts:
                typeof msg.content === "string"
                  ? [{ text: msg.content }]
                  : msg.content.map(this.continuePartToGeminiPart),
            };

            if (msg.toolCalls && msg.toolCalls.length) {
              (msg.toolCalls as GeminiToolCallDelta[]).forEach(
                (toolCall, index) => {
                  if (toolCall.function?.name) {
                    const signatureForCall =
                      toolCall?.extra_content?.google?.thought_signature;

                    let thoughtSignature: string | undefined;
                    if (index === 0) {
                      if (typeof signatureForCall === "string") {
                        thoughtSignature = signatureForCall;
                      } else {
                        // Fallback per https://ai.google.dev/gemini-api/docs/thought-signatures
                        // for histories that were not generated by Gemini or are missing signatures.
                        thoughtSignature = "skip_thought_signature_validator";
                      }
                    }

                    assistantMsg.parts.push({
                      functionCall: {
                        name: toolCall.function.name,
                        args: safeParseToolCallArgs(toolCall),
                      },
                      ...(thoughtSignature && { thoughtSignature }),
                    });
                  }
                },
              );
            }

            return assistantMsg;
          }
          return {
            role: "user",
            parts:
              typeof msg.content === "string"
                ? [{ text: msg.content }]
                : msg.content.map(this.continuePartToGeminiPart),
          };
        }),
    };

    body.contents = mergeConsecutiveGeminiMessages(body.contents);
    if (options) {
      body.generationConfig = this.convertArgs(options);
    }

    // https://ai.google.dev/gemini-api/docs/api-versions
    if (!isV1API) {
      if (systemMessage) {
        body.systemInstruction = {
          parts: [{ text: stripImages(systemMessage) }],
        };
      }
      // Convert and add tools if present
      if (options.tools?.length) {
        // Choosing to map all tools to the functionDeclarations of one tool
        // Rather than map each tool to its own tool + functionDeclaration
        // Same difference
        const functions: GeminiToolFunctionDeclaration[] = [];
        options.tools.forEach((tool) => {
          try {
            functions.push(convertContinueToolToGeminiFunction(tool));
          } catch (e) {
            console.warn(
              `Failed to convert tool to gemini function definition. Skipping: ${JSON.stringify(tool, null, 2)}`,
            );
          }
        });
        if (functions.length) {
          body.tools = [
            {
              functionDeclarations: functions,
            },
          ];
        }
      }
    }
    return body;
  }

  public async *processGeminiResponse(
    stream: AsyncIterable<string>,
  ): AsyncGenerator<ChatMessage> {
    let buffer = "";
    for await (const chunk of stream) {
      buffer += chunk;
      if (buffer.startsWith("[")) {
        buffer = buffer.slice(1);
      }
      if (buffer.endsWith("]")) {
        buffer = buffer.slice(0, -1);
      }
      if (buffer.startsWith(",")) {
        buffer = buffer.slice(1);
      }

      const parts = buffer.split("\n,");

      let foundIncomplete = false;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        let data: GeminiChatResponse;
        try {
          data = JSON.parse(part) as GeminiChatResponse;
        } catch (e) {
          foundIncomplete = true;
          continue; // yo!
        }

        if ("error" in data) {
          throw new Error(data.error.message);
        }

        // In case of max tokens reached, gemini will sometimes return content with no parts, even though that doesn't match the API spec
        const contentParts = data?.candidates?.[0]?.content?.parts;
        if (contentParts) {
          const textParts: MessagePart[] = [];
          const toolCalls: ToolCallDelta[] = [];

          for (const part of contentParts) {
            if ("text" in part) {
              textParts.push({ type: "text", text: part.text });
            } else if ("functionCall" in part) {
              const thoughtSignature = part.thoughtSignature;
              toolCalls.push({
                type: "function",
                id: part.functionCall.id ?? uuidv4(),
                function: {
                  name: part.functionCall.name,
                  arguments:
                    typeof part.functionCall.args === "string"
                      ? part.functionCall.args
                      : JSON.stringify(part.functionCall.args),
                },
                ...(thoughtSignature && {
                  extra_content: {
                    google: {
                      thought_signature: thoughtSignature,
                    },
                  },
                }),
              });
            } else {
              // Note: function responses shouldn't be streamed, images not supported
              console.warn("Unsupported gemini part type received", part);
            }
          }

          const assistantMessage: AssistantChatMessage = {
            role: "assistant",
            content: textParts.length ? textParts : "",
          };
          if (toolCalls.length > 0) {
            assistantMessage.toolCalls = toolCalls;
          }
          if (textParts.length || toolCalls.length) {
            yield assistantMessage;
          }
        } else {
          // Handle the case where the expected data structure is not found
          console.warn("Unexpected response format:", data);
        }
      }
      if (foundIncomplete) {
        buffer = parts[parts.length - 1];
      } else {
        buffer = "";
      }
    }
  }

  private async *streamChatGemini(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    const apiURL = new URL(
      `models/${options.model}:streamGenerateContent`,
      this.apiBase,
    );

    const isV1API = /\/v1\/(?!beta)/.test(this.apiBase ?? "");

    // Convert chat messages to contents
    const body = this.prepareBody(messages, options, isV1API, true);

    const response = await this.fetch(apiURL, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
      headers: {
        // [APF] 自定义 header 在前，认证/Content-Type 在后覆盖，避免破坏认证
        ...getGeminiCliCustomHeaders(),
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey ?? "",
      },
    });
    for await (const message of this.processGeminiResponse(
      streamResponse(response),
    )) {
      yield message;
    }
  }
  private async *streamChatBison(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    const msgList = [];
    for (const message of messages) {
      msgList.push({ content: message.content });
    }

    const apiURL = new URL(
      `models/${options.model}:generateMessage?key=${this.apiKey}`,
      this.apiBase,
    );
    const body = { prompt: { messages: msgList } };
    const response = await this.fetch(apiURL, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
      // [APF] 追加自定义统计 header（认证仍走 URL 的 ?key= 参数，保持不变）
      headers: getGeminiCliCustomHeaders(),
    });
    if (response.status === 499) {
      return; // Aborted by user
    }
    const data = await response.json();
    yield { role: "assistant", content: data.candidates[0].content };
  }

  async _embed(batch: string[]): Promise<number[][]> {
    this.ensureGeminiConfigured();
    // Batch embed endpoint: https://ai.google.dev/api/embeddings?authuser=1#EmbedContentRequest
    const requests = batch.map((text) => ({
      model: this.model,
      content: {
        role: "user",
        parts: [{ text }],
      },
    }));

    const resp = await this.fetch(
      new URL(`${this.model}:batchEmbedContents`, this.apiBase),
      {
        method: "POST",
        body: JSON.stringify({
          requests,
        }),
        headers: {
          // [APF] 自定义 header 在前，认证/Content-Type 在后覆盖
          ...getGeminiCliCustomHeaders(),
          "x-goog-api-key": this.apiKey,
          "Content-Type": "application/json",
        } as any,
      },
    );

    if (!resp.ok) {
      throw new Error(await resp.text());
    }

    const data = (await resp.json()) as any;

    return data.embeddings.map((embedding: any) => embedding.values);
  }
}

export default Gemini;
