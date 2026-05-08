import { extractLastTurns, formatTranscript, type TranscriptMessage } from "./content.js";
import type { HindsightClientWrapper } from "./hindsight-client.js";
import type { DebugLogger } from "./debug.js";
import {
  getLastRetainedTurn,
  getOrResolveAgentConfig,
  getOrFetchSessionMeta,
  getSessionMeta,
  setLastRetainedTurn,
  type OpenCodeClientLike,
} from "./state.js";
import type { ResolvedAgentConfig } from "./types.js";

export interface OpenCodeMessagesClientLike {
  session: {
    messages(options: { path: { id: string }; url: "/session/{id}/message" }): Promise<unknown> | unknown;
    get?: OpenCodeClientLike["session"]["get"];
  };
}

export async function handleAutoRetainEvent(
  input: { event: unknown },
  client: OpenCodeMessagesClientLike,
  hindsightClient: HindsightClientWrapper,
  debug: Pick<DebugLogger, "error"> = NOOP_DEBUG
): Promise<void> {
  const sessionID = getIdleSessionID(input.event);
  if (!sessionID) return;

  const meta = await getCachedOrFetchedSessionMeta(sessionID, client);
  if (!meta || meta.isChild) return;

  const config = getOrResolveAgentConfig(meta.agent);
  if (!config?.autoRetainBank) return;

  const messages = await fetchSessionMessages(client, sessionID, debug);
  const currentTurns = countUserTurns(messages);
  const lastRetained = getLastRetainedTurn(sessionID);

  if (currentTurns - lastRetained < config.retainEveryNTurns) return;

  const retained = await performRetain(sessionID, messages, config, hindsightClient);
  if (retained) setLastRetainedTurn(sessionID, currentTurns);
}

export async function handleCompactionRetain(
  sessionID: string | undefined,
  client: OpenCodeMessagesClientLike,
  config: ResolvedAgentConfig | undefined,
  hindsightClient: HindsightClientWrapper,
  debug: Pick<DebugLogger, "error"> = NOOP_DEBUG
): Promise<boolean> {
  if (!sessionID || !config?.autoRetainBank) return false;

  const messages = await fetchSessionMessages(client, sessionID, debug);
  const transcript = formatTranscript(messages);
  if (!transcript) return false;

  const result = await hindsightClient.retain({
    bankId: config.autoRetainBank,
    content: transcript,
    documentId: sessionID,
  });

  if (result.success) {
    setLastRetainedTurn(sessionID, 0);
    return true;
  }

  return false;
}

export async function handleCompactionRetainForSession(
  sessionID: string | undefined,
  client: OpenCodeMessagesClientLike,
  hindsightClient: HindsightClientWrapper,
  debug: Pick<DebugLogger, "error"> = NOOP_DEBUG
): Promise<void> {
  if (!sessionID) return;

  const meta = await getCachedOrFetchedSessionMeta(sessionID, client);
  if (!meta || meta.isChild) return;

  await handleCompactionRetain(sessionID, client, getOrResolveAgentConfig(meta.agent), hindsightClient, debug);
}

export async function performRetain(
  sessionID: string,
  messages: TranscriptMessage[],
  config: ResolvedAgentConfig,
  hindsightClient: HindsightClientWrapper
): Promise<boolean> {
  if (!config.autoRetainBank) return false;

  const retainedMessages =
    config.retainMode === "last-turn" ? extractLastTurns(messages, config.retainEveryNTurns) : messages;
  const transcript = formatTranscript(retainedMessages);
  if (!transcript) return false;

  const documentId = config.retainMode === "last-turn" ? generateRetainDocumentId(sessionID) : sessionID;
  const result = await hindsightClient.retain({
    bankId: config.autoRetainBank,
    content: transcript,
    documentId,
  });

  return result.success;
}

export function countUserTurns(messages: TranscriptMessage[]): number {
  return messages.filter((message) => getRole(message) === "user").length;
}

export async function fetchSessionMessages(
  client: OpenCodeMessagesClientLike,
  sessionID: string,
  debug: Pick<DebugLogger, "error"> = NOOP_DEBUG
): Promise<TranscriptMessage[]> {
  try {
    const result = await client.session.messages({ path: { id: sessionID }, url: "/session/{id}/message" });
    const data = isRecord(result) && "data" in result ? result.data : result;
    return Array.isArray(data) ? (data as TranscriptMessage[]) : [];
  } catch (error) {
    debug.error(`Failed to fetch session messages for "${sessionID}": ${formatError(error)}`);
    return [];
  }
}

export async function getCachedOrFetchedSessionMeta(
  sessionID: string,
  client: OpenCodeMessagesClientLike
) {
  const cached = getSessionMeta(sessionID);
  if (cached) return cached;

  if (typeof client.session.get !== "function") return undefined;

  return getOrFetchSessionMeta(sessionID, { session: { get: client.session.get } });
}

const NOOP_DEBUG: Pick<DebugLogger, "error"> = { error: () => {} };

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function getIdleSessionID(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== "session.status") return undefined;

  const properties = event.properties;
  if (!isRecord(properties)) return undefined;

  const status = properties.status;
  if (!isRecord(status) || status.type !== "idle") return undefined;

  const info = properties.info;
  if (!isRecord(info) || typeof info.id !== "string") return undefined;

  return info.id;
}

function getRole(message: TranscriptMessage): string | undefined {
  if ("info" in message) return message.info.role;
  return message.role;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function generateRetainDocumentId(sessionID: string): string {
  return `${sessionID}-${Date.now()}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}
