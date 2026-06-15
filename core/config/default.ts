import { ConfigYaml } from "@continuedev/config-yaml";

// [APF] 内置公司 Gemini 模型配置，新用户首次启动时自动创建
export const defaultConfig = {
  name: "Main Config",
  version: "1.0.0",
  schema: "v1",
  models: [
    {
      provider: "gemini",
      name: "Company Gemini",
      model: "gemini-3.5-flash",
      apiKey: "",
      // [APF] SDK 1.46+ 经 httpOptions.baseUrl 覆盖此地址；根地址不含
      // /v1beta（SDK 会自动拼接 apiVersion，默认 v1beta）。
      apiBase: "https://172.26.133.12/api/user/vertexai-gemini-proxy",
    },
  ],
  tabAutocompleteModel: {
    provider: "gemini",
    name: "Company Gemini Autocomplete",
    model: "gemini-3.5-flash",
    apiKey: "",
    apiBase:
      "https://172.26.133.12/api/user/vertexai-gemini-proxy/v1beta1/publishers/google/",
    requestOptions: {
      verifySsl: false,
    },
  },
  requestOptions: {
    verifySsl: false,
  },
} as ConfigYaml;
