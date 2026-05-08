import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";

import { createStateConfigHook, createSessionEventHandler, initState } from "./state.js";
import { handleAutoRetainEvent, handleCompactionRetainForSession } from "./auto-retain.js";
import { handleCompactionRecallForSession, handleSystemTransformRecall } from "./auto-recall.js";
import { createDebugLogger } from "./debug.js";
import { createHindsightClient } from "./hindsight-client.js";
import { createManualTools } from "./tools.js";
import type { PluginOptions } from "./types.js";

type ProcessLike = {
  env?: Record<string, string | undefined>;
};

interface ResolvedPluginOptions extends PluginOptions {
  hindsightApiUrl?: string;
  hindsightApiToken?: string;
  debug: boolean;
}

function env(): Record<string, string | undefined> {
  const processLike = (globalThis as typeof globalThis & { process?: ProcessLike }).process;
  return processLike?.env ?? {};
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;

  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function resolveOptions(options: PluginOptions = {}): ResolvedPluginOptions {
  const environment = env();

  return {
    ...options,
    hindsightApiUrl: options.hindsightApiUrl ?? environment.HINDSIGHT_API_URL,
    hindsightApiToken: options.hindsightApiToken ?? environment.HINDSIGHT_API_TOKEN,
    debug: options.debug ?? parseBoolean(environment.HINDSIGHT_DEBUG) ?? false,
  };
}

function createStubHooks(
  input: PluginInput,
  hindsightClient: ReturnType<typeof createHindsightClient>,
  logger: ReturnType<typeof createDebugLogger>
): Hooks {
  const handleSessionCreated = createSessionEventHandler();

  return {
    config: createStateConfigHook(),
    event: async (eventInput) => {
      await handleSessionCreated(eventInput);
      await handleAutoRetainEvent(eventInput, input.client, hindsightClient, logger);
    },
    tool: createManualTools(hindsightClient),
    "experimental.chat.system.transform": async (transformInput, transformOutput) => {
      await handleSystemTransformRecall(transformInput, transformOutput, hindsightClient, logger);
    },
    "experimental.session.compacting": async (compactionInput, compactionOutput) => {
      await handleCompactionRetainForSession(compactionInput.sessionID, input.client, hindsightClient, logger);
      await handleCompactionRecallForSession(
        compactionInput.sessionID,
        input.client,
        hindsightClient,
        compactionOutput,
        logger
      );
    },
  };
}

export const server: Plugin = async (_input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  if (options?.enabled === false) {
    console.error("Hindsight plugin disabled");
    return {};
  }

  const resolvedOptions = resolveOptions(options);

  if (!resolvedOptions.hindsightApiUrl) {
    console.error(
      "[Hindsight] No hindsightApiUrl configured. Set HINDSIGHT_API_URL or pass hindsightApiUrl in plugin options."
    );
    return {};
  }

  const logger = createDebugLogger(resolvedOptions.debug);
  const configLogger = {
    warn: (message: string) => console.error(`[Hindsight] warn: ${message}`),
  };
  const client = createHindsightClient({
    apiUrl: resolvedOptions.hindsightApiUrl,
    apiToken: resolvedOptions.hindsightApiToken,
    debug: logger,
  });

  void client;
  initState({
    defaults: resolvedOptions.defaults,
    applyMode: resolvedOptions.applyMode ?? "all",
    logger: configLogger,
  });
  logger.debug("Plugin initialized with stub hooks");

  return createStubHooks(_input, client, logger);
};

const pluginModule: PluginModule = { server };

export default pluginModule;
export {
  findLastUserMessage,
  handleCompactionRecall,
  handleCompactionRecallForSession,
  handleSystemTransformRecall,
  recallFromBanks,
} from "./auto-recall.js";
export {
  countUserTurns,
  fetchSessionMessages,
  getCachedOrFetchedSessionMeta,
  handleAutoRetainEvent,
  handleCompactionRetain,
  handleCompactionRetainForSession,
  performRetain,
} from "./auto-retain.js";
export type { OpenCodeMessagesClientLike } from "./auto-retain.js";
export {
  SESSION_START_RECALL_QUERY,
  composeCompactionRecallQuery,
  extractLastTurns,
  formatRecallResults,
  formatTranscript,
  stripMemoryTags,
} from "./content.js";
export type { TranscriptMessage } from "./content.js";
export {
  BUILT_IN_DEFAULTS,
  buildBaseDefaults,
  createConfigHook,
  initializeConfigResolution,
  resolveAgentConfig,
  resolveOnTheFly,
  validateConfig,
} from "./config.js";
export { createHindsightClient } from "./hindsight-client.js";
export type {
  ApiResult,
  HindsightClientWrapper,
  HindsightSdkClient,
  RecallOptions,
  ReflectOptions,
  RetainOptions,
} from "./hindsight-client.js";
export { createManualTools } from "./tools.js";
export type { HindsightTools } from "./tools.js";
export {
  consumeRecall,
  createSessionEventHandler,
  createStateConfigHook,
  disableAgentConfig,
  getAgentConfig,
  getLastRetainedTurn,
  getOrFetchSessionMeta,
  getOrResolveAgentConfig,
  getSessionMeta,
  hasAgentConfig,
  initState,
  isAgentDisabled,
  isMarkedForRecall,
  markForRecall,
  extractAgentHindsightConfig,
  setAgentConfig,
  setLastRetainedTurn,
  setSessionMeta,
} from "./state.js";
export type {
  ApplyMode,
  ConfigAgentDefinition,
  ConfigHookInput,
  ConfigLogger,
  ConfigResolutionRuntime,
  HindsightConfigShape,
} from "./config.js";
export type { OpenCodeClientLike, SessionCreatedEventInput } from "./state.js";
export { createDebugLogger } from "./debug.js";
export type { DebugLogger } from "./debug.js";
export type {
  AgentHindsightConfig,
  AgentHindsightDefaults,
  PluginOptions,
  ResolvedAgentConfig,
  SessionMeta,
} from "./types.js";
