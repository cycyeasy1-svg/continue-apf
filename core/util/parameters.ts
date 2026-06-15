import { TabAutocompleteOptions } from "../index.js";

export const DEFAULT_AUTOCOMPLETE_OPTS: TabAutocompleteOptions = {
  disable: false,
  maxPromptTokens: 1024,
  // [APF] Show more leading context (0.3 -> 0.4) for better single-line/multiline
  // completion accuracy. Slightly larger prompt, but negligible vs. the latency
  // saved by disabling Gemini thinking.
  prefixPercentage: 0.4,
  maxSuffixPercentage: 0.2,
  // [APF] Faster trigger after the user stops typing (350 -> 250ms). Pure
  // latency win, no effect on completion quality.
  debounceDelay: 250,
  modelTimeout: 150,
  multilineCompletions: "auto",
  // @deprecated TO BE REMOVED
  slidingWindowPrefixPercentage: 0.75,
  // @deprecated TO BE REMOVED
  slidingWindowSize: 500,
  useCache: true,
  onlyMyCode: true,
  useRecentlyEdited: true,
  useRecentlyOpened: true,
  disableInFiles: undefined,
  useImports: true,
  transform: true,
  showWhateverWeHaveAtXMs: 300,
  // Experimental options: true = enabled, false = disabled, number = enabled w priority
  experimental_includeClipboard: false,
  experimental_includeRecentlyVisitedRanges: true,
  experimental_includeRecentlyEditedRanges: true,
  experimental_includeDiff: true,
  experimental_enableStaticContextualization: false,
};

export const COUNT_COMPLETION_REJECTED_AFTER = 10_000;
export const DO_NOT_COUNT_REJECTED_BEFORE = 250;

export const RETRIEVAL_PARAMS = {
  rerankThreshold: 0.3,
  nFinal: 20,
  nRetrieve: 50,
  bm25Threshold: -2.5,
  nResultsToExpandWithEmbeddings: 5,
  nEmbeddingsExpandTo: 5,
};
