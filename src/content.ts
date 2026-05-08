import type { Message as SdkMessage, Part } from "@opencode-ai/sdk";

export const SESSION_START_RECALL_QUERY =
  "Relevant project context, user preferences, and recent work for this agent.";

export type TranscriptMessage =
  | SdkMessage
  | { info: SdkMessage; parts?: Part[] }
  | {
      role: "user" | "assistant" | string;
      content?: string;
      text?: string;
      parts?: Array<{ type?: string; text?: string }>;
    };

export function stripMemoryTags(text: string): string {
  return text
    .replace(/<\s*hindsight_memories\b[^>]*>[\s\S]*?<\s*\/\s*hindsight_memories\s*>/gi, "")
    .replace(/<\s*relevant_memories\b[^>]*>[\s\S]*?<\s*\/\s*relevant_memories\s*>/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatTranscript(messages: TranscriptMessage[]): string {
  const entries = messages
    .map((message) => {
      const role = getMessageRole(message);
      if (role !== "user" && role !== "assistant") return undefined;

      const content = getMessageContent(message).trim();
      if (!content) return undefined;

      return `${role === "user" ? "User" : "Assistant"}: ${content}`;
    })
    .filter((entry): entry is string => entry !== undefined);

  return stripMemoryTags(entries.join("\n\n"));
}

export function formatRecallResults(
  bankResults: Array<{ bank: string; memories: string[] }>,
  timestamp: Date
): string {
  const populatedResults = bankResults.filter((result) => result.memories.length > 0);
  if (populatedResults.length === 0) return "";

  const banks = populatedResults
    .map((result) => `## Bank: ${result.bank}\n${result.memories.join("\n\n")}`)
    .join("\n\n");

  return `<hindsight_memories>\nRelevant memories from past conversations. Only use memories that are\ndirectly useful; ignore the rest.\nCurrent time: ${timestamp.toISOString()}\n\n${banks}\n</hindsight_memories>`;
}

export function composeCompactionRecallQuery(lastUserMessage: string, recentContext: string): string {
  const userMessage = stripMemoryTags(lastUserMessage).trim() || "(none)";
  const context = stripMemoryTags(recentContext).trim() || "(none)";

  return `Last user message:\n${userMessage}\n\nRecent conversation context:\n${context}`;
}

export function extractLastTurns(messages: TranscriptMessage[], turnCount: number): TranscriptMessage[] {
  if (turnCount <= 0) return [];

  const turns: TranscriptMessage[][] = [];
  let currentTurn: TranscriptMessage[] = [];

  for (const message of messages) {
    const role = getMessageRole(message);

    if (role === "user") {
      if (currentTurn.length > 0) turns.push(currentTurn);
      currentTurn = [message];
      continue;
    }

    if (role === "assistant" && currentTurn.length > 0) {
      currentTurn.push(message);
    }
  }

  if (currentTurn.length > 0) turns.push(currentTurn);

  return turns.slice(-turnCount).flat();
}

function getMessageRole(message: TranscriptMessage): string | undefined {
  if ("info" in message) return message.info.role;
  return message.role;
}

function getMessageContent(message: TranscriptMessage): string {
  const parts = "parts" in message ? message.parts : undefined;
  const partText = parts
    ?.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();

  if (partText) return partText;
  if ("content" in message && typeof message.content === "string") return message.content;
  if ("text" in message && typeof message.text === "string") return message.text;
  if ("info" in message && message.info.role === "user" && message.info.system) return message.info.system;

  return "";
}
