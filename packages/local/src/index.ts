export {
  LocalModel,
  LocalModelUnavailable,
  LocalModelError,
  assertLocalEndpoint,
  resolveLocalConfig,
  parseLooseJson,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  type LocalClientOptions,
  type LocalMessage,
  type LocalCompletion,
} from "./client.js";

export {
  rewritePrompt,
  extractTerms,
  redactProse,
  describeDataset,
  type RewriteResult,
} from "./tasks.js";