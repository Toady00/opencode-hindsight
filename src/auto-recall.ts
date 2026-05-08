import {
  SESSION_START_RECALL_QUERY,
  composeCompactionRecallQuery,
  extractLastTurns,
  formatRecallResults,
  formatTranscript,
  type TranscriptMessage,
} from "./content.js";
import type { DebugLogger } from "./debug.js";
import type { HindsightClientWrapper } from "./hindsight-client.js";
import type { OpenCodeMessagesClientLike } from "./auto-retain.js";
import { fetchSessionMessages, getCachedOrFetchedSessionMeta } from "./auto-retain.js";
import {
  consumeRecall,
  getOrResolveAgentConfig,
  getSessionMeta,
  isMarkedForRecall,
} from "./state.js";
import type { ResolvedAgentConfig } from "./types.js";

export async function handleSystemTransformRecall(
  input: { sessionID?: string },
  output: { system: string[] },
  hindsightClient: HindsightClientWrapper,
  debug: Pick<DebugLogger, "error">
): Promise<void> {
  const { sessionID } = input;
  if (!sessionID || !isMarkedForRecall(sessionID)) return;

  const meta = getSessionMeta(sessionID);
  if (!meta) {
    return;
  }

  if (meta.isChild) {
    consumeRecall(sessionID);
    return;
  }

  const config = getOrResolveAgentConfig(meta.agent);
  if (!config || config.autoRecallBanks.length === 0) {
    consumeRecall(sessionID);
    return;
  }

  const recall = await recallFromBanks(config.autoRecallBanks, SESSION_START_RECALL_QUERY, hindsightClient, debug);
  if (recall.allFailed) return;

  consumeRecall(sessionID);
  const formatted = formatRecallResults(recall.bankMemories, new Date());
  if (formatted) output.system.push(formatted);
}

export async function handleCompactionRecall(
  sessionID: string | undefined,
  client: OpenCodeMessagesClientLike,
  config: ResolvedAgentConfig | undefined,
  hindsightClient: HindsightClientWrapper,
  output: { context: string[] },
  debug: Pick<DebugLogger, "error">
): Promise<void> {
  if (!sessionID || !config || config.autoRecallBanks.length === 0) return;

  const messages = await fetchSessionMessages(client, sessionID, debug);
  const query = composeCompactionRecallQuery(findLastUserMessage(messages), formatTranscript(extractLastTurns(messages, 3)));
  const recall = await recallFromBanks(config.autoRecallBanks, query, hindsightClient, debug);
  const formatted = formatRecallResults(recall.bankMemories, new Date());
  if (formatted) output.context.push(formatted);
}

export async function handleCompactionRecallForSession(
  sessionID: string | undefined,
  client: OpenCodeMessagesClientLike,
  hindsightClient: HindsightClientWrapper,
  output: { context: string[] },
  debug: Pick<DebugLogger, "error">
): Promise<void> {
  if (!sessionID) return;

  const meta = await getCachedOrFetchedSessionMeta(sessionID, client);
  if (!meta || meta.isChild) return;

  await handleCompactionRecall(sessionID, client, getOrResolveAgentConfig(meta.agent), hindsightClient, output, debug);
}

export async function recallFromBanks(
  banks: string[],
  query: string,
  hindsightClient: HindsightClientWrapper,
  debug: Pick<DebugLogger, "error">
): Promise<{ allFailed: boolean; bankMemories: Array<{ bank: string; memories: string[] }> }> {
  const settled = await Promise.allSettled(
    banks.map(async (bank) => ({ bank, result: await hindsightClient.recall({ bankId: bank, query }) }))
  );

  const bankMemories: Array<{ bank: string; memories: string[] }> = [];
  let successCount = 0;

  for (const result of settled) {
    if (result.status === "rejected") {
      debug.error(`Hindsight recall promise rejected: ${formatError(result.reason)}`);
      continue;
    }

    if (!result.value.result.success) {
      debug.error(`Hindsight recall failed for bank "${result.value.bank}": ${result.value.result.error}`);
      continue;
    }

    successCount += 1;
    if (result.value.result.data.length > 0) {
      bankMemories.push({ bank: result.value.bank, memories: result.value.result.data });
    }
  }

  return { allFailed: banks.length > 0 && successCount === 0, bankMemories };
}

export function findLastUserMessage(messages: TranscriptMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const formatted = formatTranscript([message]);
    if (formatted.startsWith("User: ")) return formatted.slice("User: ".length);
  }

  return "";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
