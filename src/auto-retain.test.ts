import { beforeEach, describe, expect, it } from "vitest";

import {
  countUserTurns,
  handleAutoRetainEvent,
  handleCompactionRetainForSession,
  performRetain,
  type OpenCodeMessagesClientLike,
} from "./auto-retain.js";
import type { TranscriptMessage } from "./content.js";
import type { HindsightClientWrapper } from "./hindsight-client.js";
import {
  clearStateForTests,
  createStateConfigHook,
  getLastRetainedTurn,
  handleSessionEvent,
  initState,
  setAgentConfig,
  setLastRetainedTurn,
  setSessionMeta,
} from "./state.js";
import type { ResolvedAgentConfig } from "./types.js";

function message(role: "user" | "assistant", content: string): TranscriptMessage {
  return { role, content };
}

function config(overrides: Partial<ResolvedAgentConfig> = {}): ResolvedAgentConfig {
  return {
    autoRetainBank: "auto-bank",
    retainBanks: [],
    autoRecallBanks: [],
    recallBanks: [],
    retainMode: "full-session",
    retainEveryNTurns: 2,
    ...overrides,
  };
}

function messagesClient(messages: TranscriptMessage[]): OpenCodeMessagesClientLike {
  return {
    session: {
      messages: () => Promise.resolve({ data: messages }),
    },
  };
}

function hindsightClient() {
  const calls: Array<{ bankId: string; content: string; documentId: string }> = [];
  const client: HindsightClientWrapper = {
    retain: (options) => {
      calls.push(options);
      return Promise.resolve({ success: true, data: undefined });
    },
    recall: () => Promise.resolve({ success: true, data: [] }),
    reflect: () => Promise.resolve({ success: true, data: "" }),
  };

  return { client, calls };
}

function idleEvent(sessionID: string) {
  return {
    event: {
      type: "session.status",
      properties: {
        sessionID,
        status: { type: "idle" },
      },
    },
  };
}

function deprecatedIdleEvent(sessionID: string) {
  return {
    event: {
      type: "session.idle",
      properties: { sessionID },
    },
  };
}

describe("auto-retain", () => {
  beforeEach(() => {
    clearStateForTests();
  });

  it("counts user turns", () => {
    expect(countUserTurns([message("user", "one"), message("assistant", "two"), message("user", "three")])).toBe(2);
  });

  it("routes root idle sessions to each agent autoRetainBank", async () => {
    setSessionMeta("s1", { agent: "build", isChild: false });
    setSessionMeta("s2", { agent: "plan", isChild: false });
    setAgentConfig("build", config({ autoRetainBank: "build-bank", retainEveryNTurns: 1 }));
    setAgentConfig("plan", config({ autoRetainBank: "plan-bank", retainEveryNTurns: 1 }));
    const { client, calls } = hindsightClient();
    const openCode = messagesClient([message("user", "hi"), message("assistant", "hello")]);

    await handleAutoRetainEvent(idleEvent("s1"), openCode, client);
    await handleAutoRetainEvent(idleEvent("s2"), openCode, client);

    expect(calls.map((call) => call.bankId)).toEqual(["build-bank", "plan-bank"]);
  });

  it("auto-retains with opt-in mode and configured plugin defaults", async () => {
    initState({
      applyMode: "opt-in",
      defaults: {
        autoRetainBank: "stacked-chips-infrastructure",
        retainBanks: ["stacked-chips-infrastructure"],
        autoRecallBanks: ["stacked-chips-infrastructure"],
        recallBanks: ["stacked-chips-infrastructure"],
      },
      logger: { warn: () => {} },
    });
    await createStateConfigHook()({ agent: { build: {}, plan: {} } });
    handleSessionEvent({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "session-1",
            agent: "build",
          },
        },
      },
    });
    const { client, calls } = hindsightClient();
    const openCode = messagesClient([
      message("user", "one"),
      message("assistant", "done"),
      message("user", "two"),
      message("assistant", "done"),
      message("user", "three"),
      message("assistant", "done"),
    ]);

    await handleAutoRetainEvent(idleEvent("session-1"), openCode, client);

    expect(calls).toEqual([
      {
        bankId: "stacked-chips-infrastructure",
        content: "User: one\n\nAssistant: done\n\nUser: two\n\nAssistant: done\n\nUser: three\n\nAssistant: done",
        documentId: "session-1",
      },
    ]);
  });

  it("skips missing banks, child sessions, and premature throttled sessions", async () => {
    setSessionMeta("missing-bank", { agent: "build", isChild: false });
    setSessionMeta("child", { agent: "build", isChild: true });
    setSessionMeta("throttled", { agent: "build", isChild: false });
    setAgentConfig("build", config({ autoRetainBank: undefined, retainEveryNTurns: 3 }));
    const { client, calls } = hindsightClient();
    const openCode = messagesClient([message("user", "hi")]);

    await handleAutoRetainEvent(idleEvent("missing-bank"), openCode, client);
    setAgentConfig("build", config({ retainEveryNTurns: 3 }));
    await handleAutoRetainEvent(idleEvent("child"), openCode, client);
    await handleAutoRetainEvent(idleEvent("throttled"), openCode, client);

    expect(calls).toEqual([]);
  });

  it("full-session mode upserts stripped transcript with session ID", async () => {
    setSessionMeta("session-1", { agent: "build", isChild: false });
    setAgentConfig("build", config({ retainEveryNTurns: 1 }));
    const { client, calls } = hindsightClient();
    const openCode = messagesClient([
      message("user", "Question <hindsight_memories>ignore</hindsight_memories>"),
      message("assistant", "Answer"),
    ]);

    await handleAutoRetainEvent(idleEvent("session-1"), openCode, client);

    expect(calls).toEqual([
      {
        bankId: "auto-bank",
        content: "User: Question\n\nAssistant: Answer",
        documentId: "session-1",
      },
    ]);
    expect(getLastRetainedTurn("session-1")).toBe(1);
  });

  it("accepts deprecated session.idle events for compatibility", async () => {
    setSessionMeta("session-1", { agent: "build", isChild: false });
    setAgentConfig("build", config({ retainEveryNTurns: 1 }));
    const { client, calls } = hindsightClient();
    const openCode = messagesClient([message("user", "hi"), message("assistant", "hello")]);

    await handleAutoRetainEvent(deprecatedIdleEvent("session-1"), openCode, client);

    expect(calls).toEqual([{ bankId: "auto-bank", content: "User: hi\n\nAssistant: hello", documentId: "session-1" }]);
  });

  it("last-turn mode retains only the recent window with a unique document ID", async () => {
    const { client, calls } = hindsightClient();

    await performRetain(
      "session-1",
      [
        message("user", "u1"),
        message("assistant", "a1"),
        message("user", "u2"),
        message("assistant", "a2"),
      ],
      config({ retainMode: "last-turn", retainEveryNTurns: 1 }),
      client
    );

    expect(calls[0]?.content).toBe("User: u2\n\nAssistant: a2");
    expect(calls[0]?.documentId).toMatch(/^session-1-/);
  });

  it("compaction retain bypasses throttle and mode with full session document ID", async () => {
    setSessionMeta("session-1", { agent: "build", isChild: false });
    setAgentConfig("build", config({ retainMode: "last-turn", retainEveryNTurns: 99 }));
    setLastRetainedTurn("session-1", 10);
    const { client, calls } = hindsightClient();
    const openCode = messagesClient([message("user", "u1"), message("assistant", "a1")]);

    await handleCompactionRetainForSession("session-1", openCode, client);

    expect(calls).toEqual([{ bankId: "auto-bank", content: "User: u1\n\nAssistant: a1", documentId: "session-1" }]);
    expect(getLastRetainedTurn("session-1")).toBe(0);
  });

  it("logs message fetch failures and skips automatic retain without throwing", async () => {
    setSessionMeta("session-1", { agent: "build", isChild: false });
    setAgentConfig("build", config({ retainEveryNTurns: 1 }));
    const { client, calls } = hindsightClient();
    const errors: string[] = [];
    const openCode = {
      session: {
        messages: () => Promise.reject(new Error("network down")),
      },
    } satisfies OpenCodeMessagesClientLike;

    await expect(
      handleAutoRetainEvent(idleEvent("session-1"), openCode, client, { error: (message) => errors.push(message) })
    ).resolves.toBeUndefined();
    await expect(
      handleCompactionRetainForSession("session-1", openCode, client, { error: (message) => errors.push(message) })
    ).resolves.toBeUndefined();

    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("network down");
  });

  it("fetches missing session metadata before auto-retain", async () => {
    setAgentConfig("build", config({ retainEveryNTurns: 1 }));
    const { client, calls } = hindsightClient();
    const openCode = {
      session: {
        get: () => Promise.resolve({ data: { id: "preexisting", agent: "build" } }),
        messages: () => Promise.resolve({ data: [message("user", "hi"), message("assistant", "hello")] }),
      },
    } satisfies OpenCodeMessagesClientLike;

    await handleAutoRetainEvent(idleEvent("preexisting"), openCode, client);

    expect(calls).toEqual([{ bankId: "auto-bank", content: "User: hi\n\nAssistant: hello", documentId: "preexisting" }]);
  });
});
