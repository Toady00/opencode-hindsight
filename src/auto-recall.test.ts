import { beforeEach, describe, expect, it } from "vitest";

import {
  handleCompactionRecallForSession,
  handleSystemTransformRecall,
  recallFromBanks,
} from "./auto-recall.js";
import type { HindsightClientWrapper } from "./hindsight-client.js";
import type { OpenCodeMessagesClientLike } from "./auto-retain.js";
import {
  clearStateForTests,
  isMarkedForRecall,
  markForRecall,
  setAgentConfig,
  setSessionMeta,
} from "./state.js";
import type { ResolvedAgentConfig } from "./types.js";

function config(overrides: Partial<ResolvedAgentConfig> = {}): ResolvedAgentConfig {
  return {
    autoRetainBank: undefined,
    retainBanks: [],
    autoRecallBanks: ["bank-a", "bank-b"],
    recallBanks: [],
    retainMode: "full-session",
    retainEveryNTurns: 3,
    ...overrides,
  };
}

function client(results: Record<string, string[] | Error>) {
  const queries: Array<{ bankId: string; query: string }> = [];
  const hindsight: HindsightClientWrapper = {
    retain: () => Promise.resolve({ success: true, data: undefined }),
    recall: ({ bankId, query }) => {
      queries.push({ bankId, query });
      const result = results[bankId];
      if (result instanceof Error) return Promise.resolve({ success: false, error: result.message });
      return Promise.resolve({ success: true, data: result ?? [] });
    },
    reflect: () => Promise.resolve({ success: true, data: "" }),
  };

  return { hindsight, queries };
}

function messagesClient(): OpenCodeMessagesClientLike {
  return {
    session: {
      messages: () =>
        Promise.resolve({
          data: [
            { role: "user", content: "How should we continue?" },
            { role: "assistant", content: "With care." },
          ],
        }),
    },
  };
}

describe("auto-recall", () => {
  beforeEach(() => {
    clearStateForTests();
  });

  it("appends multi-bank recall results to the system prompt", async () => {
    setSessionMeta("session-1", { agent: "build", isChild: false });
    setAgentConfig("build", config());
    markForRecall("session-1");
    const { hindsight, queries } = client({ "bank-a": ["A memory"], "bank-b": ["B memory"] });
    const output = { system: ["existing"] };

    await handleSystemTransformRecall({ sessionID: "session-1" }, output, hindsight, { error: () => {} });

    expect(output.system[0]).toBe("existing");
    expect(output.system[1]).toContain("## Bank: bank-a");
    expect(output.system[1]).toContain("## Bank: bank-b");
    expect(queries.map((query) => query.query)).toEqual([
      "Relevant project context, user preferences, and recent work for this agent.",
      "Relevant project context, user preferences, and recent work for this agent.",
    ]);
    expect(isMarkedForRecall("session-1")).toBe(false);
  });

  it("skips missing sessionID, empty banks, and child sessions", async () => {
    setSessionMeta("empty", { agent: "build", isChild: false });
    setSessionMeta("child", { agent: "build", isChild: true });
    setAgentConfig("build", config({ autoRecallBanks: [] }));
    markForRecall("empty");
    markForRecall("child");
    const { hindsight, queries } = client({});
    const output = { system: [] };

    await handleSystemTransformRecall({}, output, hindsight, { error: () => {} });
    await handleSystemTransformRecall({ sessionID: "empty" }, output, hindsight, { error: () => {} });
    setAgentConfig("build", config({ autoRecallBanks: ["bank-a"] }));
    await handleSystemTransformRecall({ sessionID: "child" }, output, hindsight, { error: () => {} });

    expect(output.system).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("keeps retry marker when all banks fail", async () => {
    setSessionMeta("session-1", { agent: "build", isChild: false });
    setAgentConfig("build", config({ autoRecallBanks: ["bank-a"] }));
    markForRecall("session-1");
    const { hindsight } = client({ "bank-a": new Error("unavailable") });
    const output = { system: [] };

    await handleSystemTransformRecall({ sessionID: "session-1" }, output, hindsight, { error: () => {} });

    expect(output.system).toEqual([]);
    expect(isMarkedForRecall("session-1")).toBe(true);
  });

  it("keeps retry marker when system transform lacks cached metadata", async () => {
    markForRecall("session-1");
    const { hindsight } = client({ "bank-a": ["memory"] });
    const output = { system: [] };

    await handleSystemTransformRecall({ sessionID: "session-1" }, output, hindsight, { error: () => {} });

    expect(output.system).toEqual([]);
    expect(isMarkedForRecall("session-1")).toBe(true);
  });

  it("consumes retry marker when at least one bank succeeds with zero results", async () => {
    setSessionMeta("session-1", { agent: "build", isChild: false });
    setAgentConfig("build", config({ autoRecallBanks: ["bank-a", "bank-b"] }));
    markForRecall("session-1");
    const { hindsight } = client({ "bank-a": [], "bank-b": new Error("unavailable") });
    const output = { system: [] };

    await handleSystemTransformRecall({ sessionID: "session-1" }, output, hindsight, { error: () => {} });

    expect(output.system).toEqual([]);
    expect(isMarkedForRecall("session-1")).toBe(false);
  });

  it("injects compaction recall into context using recent conversation query", async () => {
    setSessionMeta("session-1", { agent: "build", isChild: false });
    setAgentConfig("build", config({ autoRecallBanks: ["bank-a"] }));
    const { hindsight, queries } = client({ "bank-a": ["Compaction memory"] });
    const output = { context: [] };

    await handleCompactionRecallForSession("session-1", messagesClient(), hindsight, output, { error: () => {} });

    expect(queries[0]?.query).toContain("Last user message:\nHow should we continue?");
    expect(queries[0]?.query).toContain("Recent conversation context:");
    expect(output.context[0]).toContain("Compaction memory");
  });

  it("fetches missing session metadata before compaction recall", async () => {
    setAgentConfig("build", config({ autoRecallBanks: ["bank-a"] }));
    const { hindsight } = client({ "bank-a": ["Compaction memory"] });
    const openCode = {
      session: {
        get: () => Promise.resolve({ data: { id: "preexisting", agent: "build" } }),
        messages: () =>
          Promise.resolve({ data: [{ role: "user", content: "Question" }, { role: "assistant", content: "Answer" }] }),
      },
    } satisfies OpenCodeMessagesClientLike;
    const output = { context: [] };

    await handleCompactionRecallForSession("preexisting", openCode, hindsight, output, { error: () => {} });

    expect(output.context[0]).toContain("Compaction memory");
  });

  it("reports all-failed when no bank recall succeeds", async () => {
    const { hindsight } = client({ a: new Error("a"), b: new Error("b") });

    await expect(recallFromBanks(["a", "b"], "query", hindsight, { error: () => {} })).resolves.toEqual({
      allFailed: true,
      bankMemories: [],
    });
  });
});
