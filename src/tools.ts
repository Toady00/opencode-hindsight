import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin/tool";

import type { HindsightClientWrapper } from "./hindsight-client.js";
import { getOrResolveAgentConfig } from "./state.js";
import type { ResolvedAgentConfig } from "./types.js";

export interface HindsightTools extends Record<string, ToolDefinition> {
  hindsight_retain: ToolDefinition;
  hindsight_recall: ToolDefinition;
  hindsight_reflect: ToolDefinition;
}

export function createManualTools(hindsightClient: HindsightClientWrapper): HindsightTools {
  return {
    hindsight_retain: tool({
      description: "Store information in long-term memory. You must specify which bank to retain to.",
      args: {
        content: tool.schema
          .string()
          .describe("The information to remember. Be specific and self-contained."),
        bank: tool.schema.string().optional().describe("Target memory bank to store in."),
        context: tool.schema.string().optional().describe("Optional context about the source of this information."),
      },
      async execute(args, context) {
        const config = resolveToolAgentConfig(context);
        if (!config) return "Hindsight is not configured for this agent.";

        const content = args.content.trim();
        if (!content) return "Content cannot be empty.";

        const bank = validateBank(args.bank, config.retainBanks, "retain");
        if (!bank.success) return bank.error;

        const result = await hindsightClient.retain({
          bankId: bank.bankId,
          content,
          documentId: generateUniqueId(),
          metadata: args.context ? { context: args.context } : undefined,
        });

        if (!result.success) return result.error;
        return `Memory stored in bank "${bank.bankId}".`;
      },
    }),

    hindsight_recall: tool({
      description: "Search long-term memory. You must specify which bank to recall from.",
      args: {
        query: tool.schema.string().describe("Natural language search query. Be specific about what you need to know."),
        bank: tool.schema.string().optional().describe("Target memory bank to search."),
      },
      async execute(args, context) {
        const config = resolveToolAgentConfig(context);
        if (!config) return "Hindsight is not configured for this agent.";

        const query = args.query.trim();
        if (!query) return "Query cannot be empty.";

        const bank = validateBank(args.bank, config.recallBanks, "recall");
        if (!bank.success) return bank.error;

        const result = await hindsightClient.recall({ bankId: bank.bankId, query });
        if (!result.success) return result.error;

        if (result.data.length === 0) return `No memories found in bank "${bank.bankId}".`;
        return formatRecallResults(result.data);
      },
    }),

    hindsight_reflect: tool({
      description: "Synthesize an answer using long-term memory. You must specify which bank to reflect from.",
      args: {
        query: tool.schema.string().describe("The question to answer using long-term memory."),
        bank: tool.schema.string().optional().describe("Target memory bank to use."),
        context: tool.schema.string().optional().describe("Optional additional context to guide the reflection."),
      },
      async execute(args, context) {
        const config = resolveToolAgentConfig(context);
        if (!config) return "Hindsight is not configured for this agent.";

        const query = args.query.trim();
        if (!query) return "Query cannot be empty.";

        const bank = validateBank(args.bank, config.recallBanks, "recall");
        if (!bank.success) return bank.error;

        const result = await hindsightClient.reflect({ bankId: bank.bankId, query, context: args.context });
        if (!result.success) return result.error;

        return result.data || "No relevant information found to reflect on.";
      },
    }),
  };
}

function resolveToolAgentConfig(context: ToolContext): ResolvedAgentConfig | undefined {
  return getOrResolveAgentConfig(context.agent);
}

function validateBank(
  bank: string | undefined,
  availableBanks: string[],
  purpose: "retain" | "recall"
): { success: true; bankId: string } | { success: false; error: string } {
  const hasBank = bank !== undefined && !!bank.trim();
  const available = formatBankList(availableBanks);

  if (!hasBank) {
    return { success: false, error: `You must specify a bank. Available ${purpose} banks: ${available}.` };
  }

  if (!availableBanks.includes(bank)) {
    return { success: false, error: `Invalid bank '${bank}'. Available ${purpose} banks: ${available}.` };
  }

  return { success: true, bankId: bank };
}

function formatBankList(banks: string[]): string {
  return `[${banks.join(", ")}]`;
}

function formatRecallResults(memories: string[]): string {
  return `Found ${memories.length} memories:\n\n${memories.map((memory, index) => `${index + 1}. ${memory}`).join("\n")}`;
}

function generateUniqueId(): string {
  return `manual-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
