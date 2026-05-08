import { describe, expect, it } from "vitest";

import {
  SESSION_START_RECALL_QUERY,
  composeCompactionRecallQuery,
  extractLastTurns,
  formatRecallResults,
  formatTranscript,
  stripMemoryTags,
  type TranscriptMessage,
} from "./content.js";

function message(role: "user" | "assistant", content: string): TranscriptMessage {
  return { role, content };
}

describe("content utilities", () => {
  it("strips hindsight and relevant memory blocks with whitespace variations", () => {
    const text = `Before

< hindsight_memories >
memory A
</ hindsight_memories >

Middle

<relevant_memories>
memory B
</relevant_memories>

After`;

    expect(stripMemoryTags(text)).toBe("Before\n\nMiddle\n\nAfter");
  });

  it("strips multiple multi-line blocks before transcript retention", () => {
    const transcript = formatTranscript([
      message("user", "Hello"),
      message("assistant", "<hindsight_memories>\nold memory\n</hindsight_memories>Answer"),
      message("user", "<relevant_memories>ignore</relevant_memories>Next"),
    ]);

    expect(transcript).toBe("User: Hello\n\nAssistant: Answer\n\nUser: Next");
  });

  it("formats user and assistant transcript messages from message parts", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", parts: [{ type: "text", text: "Question" }] },
      { role: "assistant", parts: [{ type: "text", text: "Answer" }] },
      { role: "system", content: "ignored" },
    ];

    expect(formatTranscript(messages)).toBe("User: Question\n\nAssistant: Answer");
  });

  it("formats recall results with bank labels", () => {
    const timestamp = new Date("2026-05-08T00:00:00.000Z");

    expect(
      formatRecallResults(
        [
          { bank: "project", memories: ["Memory one", "Memory two"] },
          { bank: "empty", memories: [] },
          { bank: "user", memories: ["Preference"] },
        ],
        timestamp
      )
    ).toBe(`<hindsight_memories>
Relevant memories from past conversations. Only use memories that are
directly useful; ignore the rest.
Current time: 2026-05-08T00:00:00.000Z

## Bank: project
Memory one

Memory two

## Bank: user
Preference
</hindsight_memories>`);
  });

  it("returns empty string for empty recall results", () => {
    expect(formatRecallResults([{ bank: "project", memories: [] }], new Date())).toBe("");
  });

  it("exports the exact session-start recall query", () => {
    expect(SESSION_START_RECALL_QUERY).toBe(
      "Relevant project context, user preferences, and recent work for this agent."
    );
  });

  it("composes compaction recall query from last user message and recent context", () => {
    expect(composeCompactionRecallQuery("Please continue", "User: earlier\n\nAssistant: context")).toBe(
      "Last user message:\nPlease continue\n\nRecent conversation context:\nUser: earlier\n\nAssistant: context"
    );
  });

  it("extracts the last N user turns with assistant responses", () => {
    const messages = [
      message("assistant", "orphan"),
      message("user", "u1"),
      message("assistant", "a1"),
      message("assistant", "a1b"),
      message("user", "u2"),
      message("assistant", "a2"),
      message("user", "u3"),
      message("assistant", "a3"),
    ];

    expect(extractLastTurns(messages, 2)).toEqual([
      message("user", "u2"),
      message("assistant", "a2"),
      message("user", "u3"),
      message("assistant", "a3"),
    ]);
  });
});
