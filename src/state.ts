import type { Hooks } from "@opencode-ai/plugin";
import type { Session as V2Session } from "@opencode-ai/sdk/v2";

import {
  BUILT_IN_DEFAULTS,
  buildBaseDefaults,
  createConfigHook,
  resolveAgentConfig,
  type ApplyMode,
  type ConfigLogger,
} from "./config.js";
import type { AgentHindsightConfig, ResolvedAgentConfig, SessionMeta } from "./types.js";

type EventHookInput = Parameters<NonNullable<Hooks["event"]>>[0];
type EventHook = NonNullable<Hooks["event"]>;

export interface OpenCodeClientLike {
  session: {
    get(options: { path: { id: string }; url: "/session/{id}" }): Promise<unknown> | unknown;
  };
}

export interface SessionCreatedEventInput {
  event: {
    type: "session.created";
    properties: {
      info: V2Session;
    };
  };
}

const agentConfigCache = new Map<string, ResolvedAgentConfig>();
const disabledAgents = new Set<string>();
const sessionMeta = new Map<string, SessionMeta>();
const recalledSessions = new Set<string>();
const lastRetainedTurn = new Map<string, number>();

const DEFAULT_LOGGER: ConfigLogger = {
  warn: (message: string) => console.error(`[Hindsight] warn: ${message}`),
};

let baseDefaults: ResolvedAgentConfig = {
  autoRetainBank: BUILT_IN_DEFAULTS.autoRetainBank,
  retainBanks: [],
  autoRecallBanks: [],
  recallBanks: [],
  retainMode: BUILT_IN_DEFAULTS.retainMode,
  retainEveryNTurns: BUILT_IN_DEFAULTS.retainEveryNTurns,
};
let applyMode: ApplyMode = "all";
let logger: ConfigLogger = DEFAULT_LOGGER;

export function initState(options: {
  baseDefaults?: ResolvedAgentConfig;
  defaults?: Parameters<typeof buildBaseDefaults>[0];
  applyMode?: ApplyMode;
  logger?: ConfigLogger;
}): void {
  logger = options.logger ?? DEFAULT_LOGGER;
  baseDefaults = options.baseDefaults ?? buildBaseDefaults(options.defaults, logger);
  applyMode = options.applyMode ?? "all";
}

export function getAgentConfig(agent: string): ResolvedAgentConfig | undefined {
  return agentConfigCache.get(agent);
}

export function setAgentConfig(agent: string, config: ResolvedAgentConfig): void {
  agentConfigCache.set(agent, cloneResolvedConfig(config));
}

export function hasAgentConfig(agent: string): boolean {
  return agentConfigCache.has(agent);
}

export function isAgentDisabled(agent: string): boolean {
  return disabledAgents.has(agent);
}

export function disableAgentConfig(agent: string): void {
  agentConfigCache.delete(agent);
  disabledAgents.add(agent);
}

export function getSessionMeta(sessionID: string): SessionMeta | undefined {
  return sessionMeta.get(sessionID);
}

export function setSessionMeta(sessionID: string, meta: SessionMeta): void {
  sessionMeta.set(sessionID, meta);
}

export function markForRecall(sessionID: string): void {
  recalledSessions.add(sessionID);
}

export function isMarkedForRecall(sessionID: string): boolean {
  return recalledSessions.has(sessionID);
}

export function consumeRecall(sessionID: string): void {
  recalledSessions.delete(sessionID);
}

export function getLastRetainedTurn(sessionID: string): number {
  return lastRetainedTurn.get(sessionID) ?? 0;
}

export function setLastRetainedTurn(sessionID: string, turn: number): void {
  lastRetainedTurn.set(sessionID, turn);
}

export function getOrResolveAgentConfig(
  agentName: string,
  agentRawConfig?: AgentHindsightConfig
): ResolvedAgentConfig | undefined {
  if (disabledAgents.has(agentName)) return undefined;

  if (agentRawConfig?.enabled === false) {
    disableAgentConfig(agentName);
    return undefined;
  }

  const cached = getAgentConfig(agentName);
  if (cached) return cached;

  const resolved = resolveAgentConfig(agentRawConfig, baseDefaults, applyMode, logger);
  if (resolved) {
    setAgentConfig(agentName, resolved);
  }

  return resolved;
}

export async function getOrFetchSessionMeta(
  sessionID: string,
  client: OpenCodeClientLike
): Promise<SessionMeta | undefined> {
  const cached = getSessionMeta(sessionID);
  if (cached) return cached;

  try {
    const result = await client.session.get({ path: { id: sessionID }, url: "/session/{id}" });
    const session = extractSession(result);
    if (!session) return undefined;

    const meta = sessionToMeta(session);
    setSessionMeta(sessionID, meta);
    return meta;
  } catch {
    return undefined;
  }
}

export function createStateConfigHook(): NonNullable<Hooks["config"]> {
  return createConfigHook({
    agentConfigs: agentConfigCache,
    disabledAgents,
    baseDefaults,
    applyMode,
    logger,
  });
}

export function createSessionEventHandler(): EventHook {
  return async (input: EventHookInput): Promise<void> => {
    handleSessionEvent(input);
  };
}

export function handleSessionEvent(input: EventHookInput | SessionCreatedEventInput): void {
  const session = getSessionCreatedInfo(input.event);
  if (!session) return;

  const sessionID = session.id;
  const meta = sessionToMeta(session);
  const rawAgentConfig = extractAgentHindsightConfig(session);
  setSessionMeta(sessionID, meta);

  if (!meta.isChild) {
    const config = getOrResolveAgentConfig(meta.agent, rawAgentConfig);
    if (config && config.autoRecallBanks.length > 0) {
      markForRecall(sessionID);
    }
  }
}

export function clearStateForTests(): void {
  agentConfigCache.clear();
  disabledAgents.clear();
  sessionMeta.clear();
  recalledSessions.clear();
  lastRetainedTurn.clear();
  baseDefaults = {
    autoRetainBank: BUILT_IN_DEFAULTS.autoRetainBank,
    retainBanks: [],
    autoRecallBanks: [],
    recallBanks: [],
    retainMode: BUILT_IN_DEFAULTS.retainMode,
    retainEveryNTurns: BUILT_IN_DEFAULTS.retainEveryNTurns,
  };
  applyMode = "all";
  logger = DEFAULT_LOGGER;
}

function sessionToMeta(session: V2Session): SessionMeta {
  const agent = (session as V2Session).agent;

  return {
    agent: agent ?? "undefined",
    isChild: !!session.parentID,
  };
}

export function extractAgentHindsightConfig(session: unknown): AgentHindsightConfig | undefined {
  if (!isRecord(session)) return undefined;

  return (
    readHindsightConfig(session) ??
    readHindsightConfig(session.agentConfig) ??
    readHindsightConfig(session.agentDef) ??
    readHindsightConfig(session.config)
  );
}

function readHindsightConfig(value: unknown): AgentHindsightConfig | undefined {
  if (!isRecord(value)) return undefined;

  const direct = value.hindsight;
  if (isRecord(direct)) return direct as AgentHindsightConfig;

  const options = value.options;
  if (!isRecord(options)) return undefined;

  const hindsight = options.hindsight;
  return isRecord(hindsight) ? (hindsight as AgentHindsightConfig) : undefined;
}

function getSessionCreatedInfo(event: unknown): V2Session | undefined {
  if (!isRecord(event) || event.type !== "session.created") return undefined;

  const properties = event.properties;
  if (!isRecord(properties)) return undefined;

  const info = properties.info;
  if (!isRecord(info) || typeof info.id !== "string") return undefined;

  return info as V2Session;
}

function extractSession(result: unknown): V2Session | undefined {
  const candidate = isRecord(result) && "data" in result ? result.data : result;
  if (!isRecord(candidate) || typeof candidate.id !== "string") return undefined;

  return candidate as V2Session;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneResolvedConfig(config: ResolvedAgentConfig): ResolvedAgentConfig {
  return {
    ...config,
    retainBanks: [...config.retainBanks],
    autoRecallBanks: [...config.autoRecallBanks],
    recallBanks: [...config.recallBanks],
  };
}
