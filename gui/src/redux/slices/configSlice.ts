import { ConfigResult, ConfigValidationError } from "@continuedev/config-yaml";
import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import { BrowserSerializedContinueConfig } from "core";
import { DEFAULT_CONTEXT_LENGTH } from "core/llm/constants";

export type ConfigState = {
  configError: ConfigValidationError[] | undefined;
  config: BrowserSerializedContinueConfig;
  loading: boolean;
};

// [APF] Default-on UI settings for the chat experience.
// Normalized here at the GUI config boundary so every read site
// (settings toggles, Chat, markdown render, find/replace) sees the
// same default instead of scattering `?? true` across components.
// Explicit user values (including `false`) always win, and these
// defaults never get written back to config.json — only explicit
// user changes are persisted by the shared-config update path.
const DEFAULT_UI_CONFIG = {
  showSessionTabs: true,
  codeWrap: true,
  showChatScrollbar: true,
} as const;

function withDefaultUIConfig(
  config: BrowserSerializedContinueConfig,
): BrowserSerializedContinueConfig {
  if (!config) {
    return config;
  }
  return {
    ...config,
    ui: {
      ...config.ui,
      showSessionTabs:
        config.ui?.showSessionTabs ?? DEFAULT_UI_CONFIG.showSessionTabs,
      codeWrap: config.ui?.codeWrap ?? DEFAULT_UI_CONFIG.codeWrap,
      showChatScrollbar:
        config.ui?.showChatScrollbar ?? DEFAULT_UI_CONFIG.showChatScrollbar,
    },
  };
}

export const EMPTY_CONFIG: BrowserSerializedContinueConfig = {
  slashCommands: [],
  contextProviders: [],
  tools: [],
  mcpServerStatuses: [],
  modelsByRole: {
    chat: [],
    apply: [],
    edit: [],
    summarize: [],
    autocomplete: [],
    rerank: [],
    embed: [],
    subagent: [],
  },
  selectedModelByRole: {
    chat: null,
    apply: null,
    edit: null,
    summarize: null,
    autocomplete: null,
    rerank: null,
    embed: null,
    subagent: null,
  },
  rules: [],
};

export const INITIAL_CONFIG_SLICE: ConfigState = {
  configError: undefined,
  config: EMPTY_CONFIG,
  loading: false,
};

export const configSlice = createSlice({
  name: "config",
  initialState: INITIAL_CONFIG_SLICE,
  reducers: {
    setConfigResult: (
      state,
      {
        payload: result,
      }: PayloadAction<ConfigResult<BrowserSerializedContinueConfig>>,
    ) => {
      const { config, errors } = result;
      if (!errors || errors.length === 0) {
        state.configError = undefined;
      } else {
        state.configError = errors;
      }

      // If an error is found in config on save,
      // We must invalidate the GUI config too,
      // Since core won't be able to load config
      // Don't invalidate the loaded config
      if (!config) {
        state.config = EMPTY_CONFIG;
      } else {
        state.config = withDefaultUIConfig(config);
      }
      state.loading = false;
    },
    updateConfig: (
      state,
      { payload: config }: PayloadAction<BrowserSerializedContinueConfig>,
    ) => {
      state.config = withDefaultUIConfig(config);
    },
    setConfigLoading: (state, { payload: loading }: PayloadAction<boolean>) => {
      state.loading = loading;
    },
  },
  selectors: {
    selectSelectedChatModelContextLength: (state): number => {
      return (
        state.config.selectedModelByRole.chat?.contextLength ||
        DEFAULT_CONTEXT_LENGTH
      );
    },
    selectSelectedChatModel: (state) => {
      return state.config.selectedModelByRole.chat;
    },
    selectUIConfig: (state) => {
      return state.config?.ui ?? null;
    },
  },
});

export const { updateConfig, setConfigResult, setConfigLoading } =
  configSlice.actions;

export const {
  selectSelectedChatModelContextLength,
  selectUIConfig,
  selectSelectedChatModel,
} = configSlice.selectors;

export default configSlice.reducer;
