import type { Config } from "@opencode-ai/plugin";

import type {
  AgentHindsightConfig,
  AgentHindsightDefaults,
  PluginOptions,
  ResolvedAgentConfig,
} from "./types.js";

export type ApplyMode = NonNullable<PluginOptions["applyMode"]>;

export interface ConfigLogger {
  warn(message: string): void;
}

export const BUILT_IN_DEFAULTS: Required<Omit<AgentHindsightDefaults, "autoRetainBank">> & {
  autoRetainBank: undefined;
} = {
  autoRetainBank: undefined,
  retainBanks: [],
  autoRecallBanks: [],
  recallBanks: [],
  retainMode: "full-session",
  retainEveryNTurns: 3,
};

export const agentConfigs = new Map<string, ResolvedAgentConfig>();

const DEFAULT_LOGGER: ConfigLogger = {
  warn: (message: string) => console.error(`[Hindsight] warn: ${message}`),
};

let activeBaseDefaults: ResolvedAgentConfig = {
  autoRetainBank: undefined,
  retainBanks: [],
  autoRecallBanks: [],
  recallBanks: [],
  retainMode: "full-session",
  retainEveryNTurns: 3,
};
let activeApplyMode: ApplyMode = "all";
let activeLogger: ConfigLogger = DEFAULT_LOGGER;

type DefaultsWithIgnoredEnabled = AgentHindsightDefaults & { enabled?: unknown };

export function buildBaseDefaults(
  pluginDefaults?: DefaultsWithIgnoredEnabled,
  logger: ConfigLogger = DEFAULT_LOGGER
): ResolvedAgentConfig {
  if (pluginDefaults && "enabled" in pluginDefaults) {
    logger.warn('defaults.enabled is ignored; use per-agent hindsight.enabled to opt agents out.');
  }

  const { enabled: _ignoredEnabled, ...defaultsWithoutEnabled } = pluginDefaults ?? {};
  return validateConfig({ ...BUILT_IN_DEFAULTS, ...defaultsWithoutEnabled }, logger, { warnOnNoop: false });
}

export function resolveAgentConfig(
  agentConfig: AgentHindsightConfig | undefined,
  baseDefaults: ResolvedAgentConfig,
  applyMode: ApplyMode,
  logger: ConfigLogger = DEFAULT_LOGGER
): ResolvedAgentConfig | undefined {
  if (agentConfig?.enabled === false) return undefined;

  const { enabled: _ignoredEnabled, ...agentConfigWithoutEnabled } = agentConfig ?? {};

  if (applyMode === "opt-in" && agentConfig === undefined && !hasConfiguredBehavior(baseDefaults)) {
    return undefined;
  }

  return validateConfig({ ...baseDefaults, ...agentConfigWithoutEnabled }, logger);
}

export function validateConfig(
  config: AgentHindsightDefaults,
  logger: ConfigLogger = DEFAULT_LOGGER,
  options: { warnOnNoop?: boolean } = {}
): ResolvedAgentConfig {
  const retainBanks = validateBankList("retainBanks", config.retainBanks, logger);
  const autoRecallBanks = validateBankList("autoRecallBanks", config.autoRecallBanks, logger);
  const recallBanks = validateBankList("recallBanks", config.recallBanks, logger);
  const autoRetainBank = validateAutoRetainBank(config.autoRetainBank, logger);
  const retainEveryNTurns = validateRetainEveryNTurns(config.retainEveryNTurns, logger);

  if (autoRetainBank && !retainBanks.includes(autoRetainBank)) {
    retainBanks.push(autoRetainBank);
    logger.warn(`autoRetainBank "${autoRetainBank}" was not present in retainBanks; appending it.`);
  }

  if (options.warnOnNoop !== false && !autoRetainBank && retainBanks.length === 0 && autoRecallBanks.length === 0 && recallBanks.length === 0) {
    logger.warn("Agent has hindsight enabled but no banks configured.");
  }

  return {
    autoRetainBank,
    retainBanks,
    autoRecallBanks,
    recallBanks,
    retainMode: config.retainMode ?? BUILT_IN_DEFAULTS.retainMode,
    retainEveryNTurns,
  };
}

export interface ConfigResolutionRuntime {
  agentConfigs?: Map<string, ResolvedAgentConfig>;
  disabledAgents?: Set<string>;
  baseDefaults?: ResolvedAgentConfig;
  applyMode?: ApplyMode;
  logger?: ConfigLogger;
}

export interface ConfigAgentDefinition {
  options?: {
    hindsight?: AgentHindsightConfig;
  };
}

export interface HindsightConfigShape {
  agent?: Record<string, ConfigAgentDefinition>;
}

export type ConfigHookInput = Config | HindsightConfigShape | { config?: Config | HindsightConfigShape };

export function initializeConfigResolution(options: {
  defaults?: DefaultsWithIgnoredEnabled;
  applyMode?: ApplyMode;
  logger?: ConfigLogger;
  agentConfigCache?: Map<string, ResolvedAgentConfig>;
}): void {
  activeLogger = options.logger ?? DEFAULT_LOGGER;
  activeBaseDefaults = buildBaseDefaults(options.defaults, activeLogger);
  activeApplyMode = options.applyMode ?? "all";

  if (options.agentConfigCache && options.agentConfigCache !== agentConfigs) {
    agentConfigs.clear();
    for (const [agentName, resolvedConfig] of options.agentConfigCache) {
      agentConfigs.set(agentName, resolvedConfig);
    }
    return;
  }

  agentConfigs.clear();
}

export function createConfigHook(runtime: ConfigResolutionRuntime = {}) {
  return async (input: ConfigHookInput): Promise<void> => {
    const cache = runtime.agentConfigs ?? agentConfigs;
    const disabledAgents = runtime.disabledAgents;
    const baseDefaults = runtime.baseDefaults ?? activeBaseDefaults;
    const applyMode = runtime.applyMode ?? activeApplyMode;
    const logger = runtime.logger ?? activeLogger;

    try {
      const cfg = readConfigInput(input);
      cache.clear();
      disabledAgents?.clear();

      for (const [agentName, agentDef] of Object.entries(cfg.agent ?? {})) {
        const agentHindsight = readAgentHindsightConfig(agentDef);
        if (agentHindsight?.enabled === false) {
          disabledAgents?.add(agentName);
          continue;
        }
        const resolved = resolveAgentConfig(agentHindsight, baseDefaults, applyMode, logger);

        if (resolved) {
          cache.set(agentName, resolved);
        }
      }
    } catch (error) {
      logger.warn(`Failed to resolve agent hindsight config; falling back gracefully. ${errorMessage(error)}`);
      cache.clear();
      disabledAgents?.clear();

      if (applyMode === "all") {
        const cfg = safeReadConfigInput(input);
        for (const agentName of Object.keys(cfg?.agent ?? {})) {
          cache.set(agentName, { ...baseDefaults, retainBanks: [...baseDefaults.retainBanks], autoRecallBanks: [...baseDefaults.autoRecallBanks], recallBanks: [...baseDefaults.recallBanks] });
        }
      }
    }
  };
}

export function resolveOnTheFly(
  agentName: string,
  agentConfig: AgentHindsightConfig | undefined
): ResolvedAgentConfig | undefined {
  const cached = agentConfigs.get(agentName);
  if (cached) return cached;

  const resolved = resolveAgentConfig(agentConfig, activeBaseDefaults, activeApplyMode, activeLogger);
  if (resolved) {
    agentConfigs.set(agentName, resolved);
  }

  return resolved;
}

function validateBankList(fieldName: string, banks: string[] | undefined, logger: ConfigLogger): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const bank of banks ?? []) {
    if (!bank.trim()) {
      logger.warn(`Dropping empty bank name from ${fieldName}.`);
      continue;
    }

    if (seen.has(bank)) continue;

    seen.add(bank);
    result.push(bank);
  }

  return result;
}

function validateAutoRetainBank(bank: string | undefined, logger: ConfigLogger): string | undefined {
  if (bank !== undefined && !bank.trim()) {
    logger.warn("Dropping empty autoRetainBank.");
    return undefined;
  }

  return bank;
}

function validateRetainEveryNTurns(value: number | undefined, logger: ConfigLogger): number {
  const candidate = value ?? BUILT_IN_DEFAULTS.retainEveryNTurns;

  if (!Number.isFinite(candidate) || candidate < 1) {
    logger.warn("retainEveryNTurns must be at least 1; clamping to 1.");
    return 1;
  }

  return candidate;
}

function hasConfiguredBehavior(config: ResolvedAgentConfig): boolean {
  return (
    !!config.autoRetainBank ||
    config.retainBanks.length > 0 ||
    config.autoRecallBanks.length > 0 ||
    config.recallBanks.length > 0
  );
}

function readConfigInput(input: ConfigHookInput): HindsightConfigShape {
  const config = "config" in input && input.config ? input.config : input;
  return config as HindsightConfigShape;
}

function safeReadConfigInput(input: ConfigHookInput): HindsightConfigShape | undefined {
  try {
    return readConfigInput(input);
  } catch {
    return undefined;
  }
}

function readAgentHindsightConfig(agentDef: unknown): AgentHindsightConfig | undefined {
  if (!agentDef || typeof agentDef !== "object") return undefined;

  const options = (agentDef as { options?: { hindsight?: AgentHindsightConfig } }).options;
  return options?.hindsight;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
