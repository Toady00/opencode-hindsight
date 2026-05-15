import type { Session as V2Session } from "@opencode-ai/sdk/v2";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearStateForTests,
  consumeRecall,
  createStateConfigHook,
  getAgentConfig,
  getLastRetainedTurn,
  getOrFetchSessionMeta,
  getOrResolveAgentConfig,
  getSessionMeta,
  handleSessionEvent,
  hasAgentConfig,
  initState,
  isAgentDisabled,
  isMarkedForRecall,
  markForRecall,
  setAgentConfig,
  setLastRetainedTurn,
  setSessionMeta,
  extractAgentHindsightConfig,
  type OpenCodeClientLike,
  type SessionCreatedEventInput,
} from "./state.js";
import type { ResolvedAgentConfig, SessionMeta } from "./types.js";

function session(overrides: Partial<V2Session> = {}): V2Session {
  return {
    id: "session-1",
    slug: "session-1",
    projectID: "project-1",
    directory: "/tmp/project",
    title: "Test session",
    version: "0.0.0",
    time: {
      created: 1,
      updated: 1,
    },
    ...overrides,
  };
}

function eventFor(info: V2Session): SessionCreatedEventInput {
  return {
    event: {
      type: "session.created",
      properties: { info },
    },
  };
}

function resolvedConfig(overrides: Partial<ResolvedAgentConfig> = {}): ResolvedAgentConfig {
  return {
    autoRetainBank: undefined,
    retainBanks: [],
    autoRecallBanks: [],
    recallBanks: [],
    retainMode: "full-session",
    retainEveryNTurns: 3,
    ...overrides,
  };
}

describe("state management", () => {
  beforeEach(() => {
    clearStateForTests();
  });

  it("maintains state through accessor functions", () => {
    const config = resolvedConfig({ retainBanks: ["team"] });
    const meta: SessionMeta = { agent: "build", isChild: false };

    setAgentConfig("build", config);
    setSessionMeta("session-1", meta);
    markForRecall("session-1");
    setLastRetainedTurn("session-1", 4);

    expect(hasAgentConfig("build")).toBe(true);
    expect(getAgentConfig("build")).toEqual(config);
    expect(getSessionMeta("session-1")).toEqual(meta);
    expect(isMarkedForRecall("session-1")).toBe(true);
    expect(getLastRetainedTurn("session-1")).toBe(4);

    consumeRecall("session-1");
    expect(isMarkedForRecall("session-1")).toBe(false);
  });

  it("identifies child sessions from parentID and does not mark them for recall", () => {
    initState({ defaults: { autoRecallBanks: ["memories"] }, applyMode: "all", logger: { warn: () => {} } });

    handleSessionEvent(eventFor(session({ id: "child", parentID: "root", agent: "build" })));

    expect(getSessionMeta("child")).toEqual({ agent: "build", isChild: true });
    expect(isMarkedForRecall("child")).toBe(false);
  });

  it("marks root sessions with auto-recall banks for recall", () => {
    initState({ defaults: { autoRecallBanks: ["memories"] }, applyMode: "all", logger: { warn: () => {} } });

    handleSessionEvent(eventFor(session({ id: "root", agent: "build" })));

    expect(getSessionMeta("root")).toEqual({ agent: "build", isChild: false });
    expect(isMarkedForRecall("root")).toBe(true);
  });

  it("resolves unknown agent config on the fly and caches it", () => {
    initState({ defaults: { retainBanks: ["team"] }, applyMode: "all", logger: { warn: () => {} } });

    expect(getOrResolveAgentConfig("late-agent")?.retainBanks).toEqual(["team"]);
    expect(getAgentConfig("late-agent")?.retainBanks).toEqual(["team"]);
  });

  it("uses configured defaults for session-created agents in opt-in mode", () => {
    initState({
      defaults: { autoRetainBank: "project", retainBanks: ["project"] },
      applyMode: "opt-in",
      logger: { warn: () => {} },
    });

    handleSessionEvent(eventFor(session({ id: "root", agent: "build" })));

    expect(getAgentConfig("build")?.autoRetainBank).toBe("project");
  });

  it("uses raw agent hindsight config from dynamic session events in opt-in mode", () => {
    initState({ applyMode: "opt-in", logger: { warn: () => {} } });
    const dynamicSession = {
      ...session({ id: "dynamic-session", agent: "dynamic-agent" }),
      agentConfig: {
        options: {
          hindsight: {
            autoRecallBanks: ["dynamic-recall"],
          },
        },
      },
    } satisfies V2Session & { agentConfig: { options: { hindsight: { autoRecallBanks: string[] } } } };

    handleSessionEvent(eventFor(dynamicSession));

    expect(getAgentConfig("dynamic-agent")?.autoRecallBanks).toEqual(["dynamic-recall"]);
    expect(isMarkedForRecall("dynamic-session")).toBe(true);
    expect(extractAgentHindsightConfig(dynamicSession)?.autoRecallBanks).toEqual(["dynamic-recall"]);
  });

  it("remembers explicit agent opt-outs from the config hook", async () => {
    initState({ defaults: { retainBanks: ["base"] }, applyMode: "all", logger: { warn: () => {} } });
    const hook = createStateConfigHook();

    await hook({
      agent: {
        disabled: { options: { hindsight: { enabled: false } } },
      },
    });

    expect(isAgentDisabled("disabled")).toBe(true);
    expect(getAgentConfig("disabled")).toBeUndefined();
    expect(getOrResolveAgentConfig("disabled")).toBeUndefined();
  });

  it("fetches and caches missing session metadata through the client", async () => {
    const client = {
      session: {
        get: () => Promise.resolve({ data: session({ id: "older", parentID: "root", agent: "plan" }) }),
      },
    } satisfies OpenCodeClientLike;

    await expect(getOrFetchSessionMeta("older", client)).resolves.toEqual({ agent: "plan", isChild: true });
    expect(getSessionMeta("older")).toEqual({ agent: "plan", isChild: true });
  });

  it("returns undefined when fallback session fetch fails", async () => {
    const client = {
      session: {
        get: () => Promise.reject(new Error("not found")),
      },
    } satisfies OpenCodeClientLike;

    await expect(getOrFetchSessionMeta("missing", client)).resolves.toBeUndefined();
  });
});
