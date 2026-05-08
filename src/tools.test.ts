import { Effect } from "effect";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { beforeEach, describe, expect, it } from "vitest";

import type { HindsightClientWrapper } from "./hindsight-client.js";
import { clearStateForTests, initState, setAgentConfig, setSessionMeta } from "./state.js";
import { createManualTools } from "./tools.js";
import type { ResolvedAgentConfig } from "./types.js";

function config(overrides: Partial<ResolvedAgentConfig> = {}): ResolvedAgentConfig {
  return {
    autoRetainBank: undefined,
    retainBanks: ["retain-bank"],
    autoRecallBanks: [],
    recallBanks: ["recall-bank"],
    retainMode: "full-session",
    retainEveryNTurns: 3,
    ...overrides,
  };
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "session-1",
    messageID: "message-1",
    agent: "build",
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: () => Effect.void,
    ...overrides,
  };
}

function fakeClient(overrides: Partial<HindsightClientWrapper> = {}) {
  const calls: Array<{ method: string; options: unknown }> = [];
  const client: HindsightClientWrapper = {
    retain: (options) => {
      calls.push({ method: "retain", options });
      return Promise.resolve({ success: true, data: undefined });
    },
    recall: (options) => {
      calls.push({ method: "recall", options });
      return Promise.resolve({ success: true, data: ["first", "second"] });
    },
    reflect: (options) => {
      calls.push({ method: "reflect", options });
      return Promise.resolve({ success: true, data: "answer" });
    },
    ...overrides,
  };

  return { client, calls };
}

describe("manual Hindsight tools", () => {
  beforeEach(() => {
    clearStateForTests();
    initState({ applyMode: "opt-in", logger: { warn: () => {} } });
  });

  it("requires a retain bank and lists retain banks", async () => {
    setAgentConfig("build", config({ retainBanks: ["retain-a", "retain-b"], recallBanks: ["recall-a"] }));
    const { client, calls } = fakeClient();
    const tools = createManualTools(client);

    await expect(tools.hindsight_retain.execute({ content: "remember this" }, context())).resolves.toBe(
      "You must specify a bank. Available retain banks: [retain-a, retain-b]."
    );
    expect(calls).toEqual([]);
  });

  it("rejects invalid retain banks and retains to valid banks", async () => {
    setAgentConfig("build", config({ retainBanks: ["team/alpha::shared bank"], recallBanks: ["recall-a"] }));
    const { client, calls } = fakeClient();
    const tools = createManualTools(client);

    await expect(
      tools.hindsight_retain.execute({ content: "remember this", bank: "recall-a" }, context())
    ).resolves.toBe("Invalid bank 'recall-a'. Available retain banks: [team/alpha::shared bank].");

    await expect(
      tools.hindsight_retain.execute(
        { content: "remember this", bank: "team/alpha::shared bank", context: "manual note" },
        context()
      )
    ).resolves.toBe('Memory stored in bank "team/alpha::shared bank".');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "retain",
      options: {
        bankId: "team/alpha::shared bank",
        content: "remember this",
        documentId: expect.stringMatching(/^manual-/),
        metadata: { context: "manual note" },
      },
    });
  });

  it("preserves configured bank IDs with surrounding spaces", async () => {
    setAgentConfig("build", config({ retainBanks: [" bank with spaces "], recallBanks: [" recall bank "] }));
    const { client, calls } = fakeClient();
    const tools = createManualTools(client);

    await expect(
      tools.hindsight_retain.execute({ content: "remember this", bank: " bank with spaces " }, context())
    ).resolves.toBe('Memory stored in bank " bank with spaces ".');

    expect(calls[0]).toMatchObject({
      method: "retain",
      options: { bankId: " bank with spaces " },
    });
  });

  it("validates recall and reflect against recall banks", async () => {
    setAgentConfig("build", config({ retainBanks: ["retain-only"], recallBanks: ["recall-only"] }));
    const { client, calls } = fakeClient();
    const tools = createManualTools(client);

    await expect(tools.hindsight_recall.execute({ query: "what changed?" }, context())).resolves.toBe(
      "You must specify a bank. Available recall banks: [recall-only]."
    );
    await expect(
      tools.hindsight_reflect.execute({ query: "summarize", bank: "retain-only" }, context())
    ).resolves.toBe("Invalid bank 'retain-only'. Available recall banks: [recall-only].");

    await expect(
      tools.hindsight_recall.execute({ query: "what changed?", bank: "recall-only" }, context())
    ).resolves.toContain("Found 2 memories");
    await expect(
      tools.hindsight_reflect.execute({ query: "summarize", bank: "recall-only", context: "now" }, context())
    ).resolves.toBe("answer");
    expect(calls.map((call) => call.method)).toEqual(["recall", "reflect"]);
  });

  it("rejects empty content and query without calling the API", async () => {
    setAgentConfig("build", config());
    const { client, calls } = fakeClient();
    const tools = createManualTools(client);

    await expect(tools.hindsight_retain.execute({ content: " ", bank: "retain-bank" }, context())).resolves.toBe(
      "Content cannot be empty."
    );
    await expect(tools.hindsight_recall.execute({ query: " ", bank: "recall-bank" }, context())).resolves.toBe(
      "Query cannot be empty."
    );
    await expect(tools.hindsight_reflect.execute({ query: " ", bank: "recall-bank" }, context())).resolves.toBe(
      "Query cannot be empty."
    );
    expect(calls).toEqual([]);
  });

  it("returns not configured for agents without resolved config", async () => {
    const { client } = fakeClient();
    const tools = createManualTools(client);

    await expect(
      tools.hindsight_recall.execute({ query: "what changed?", bank: "recall-bank" }, context({ agent: "plan" }))
    ).resolves.toBe("Hindsight is not configured for this agent.");
  });

  it("allows child sessions when the child agent has config", async () => {
    setAgentConfig("subagent", config());
    setSessionMeta("child-session", { agent: "subagent", isChild: true });
    const { client, calls } = fakeClient();
    const tools = createManualTools(client);

    await expect(
      tools.hindsight_recall.execute(
        { query: "what changed?", bank: "recall-bank" },
        context({ agent: "subagent", sessionID: "child-session" })
      )
    ).resolves.toContain("Found 2 memories");
    expect(calls).toHaveLength(1);
  });

  it("returns API failure messages without throwing", async () => {
    setAgentConfig("build", config());
    const { client } = fakeClient({
      retain: () => Promise.resolve({ success: false, error: "retain unavailable" }),
      recall: () => Promise.resolve({ success: false, error: "recall unavailable" }),
      reflect: () => Promise.resolve({ success: false, error: "reflect unavailable" }),
    });
    const tools = createManualTools(client);

    await expect(tools.hindsight_retain.execute({ content: "x", bank: "retain-bank" }, context())).resolves.toBe(
      "retain unavailable"
    );
    await expect(tools.hindsight_recall.execute({ query: "x", bank: "recall-bank" }, context())).resolves.toBe(
      "recall unavailable"
    );
    await expect(tools.hindsight_reflect.execute({ query: "x", bank: "recall-bank" }, context())).resolves.toBe(
      "reflect unavailable"
    );
  });
});
