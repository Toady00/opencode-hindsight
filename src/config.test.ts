import { describe, expect, it } from "vitest";

import {
  agentConfigs,
  buildBaseDefaults,
  createConfigHook,
  initializeConfigResolution,
  resolveAgentConfig,
  resolveOnTheFly,
  validateConfig,
  type ConfigLogger,
  type HindsightConfigShape,
} from "./config.js";
import type { AgentHindsightDefaults } from "./types.js";
import type { ResolvedAgentConfig } from "./types.js";

function captureWarnings(): { logger: ConfigLogger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    logger: { warn: (message: string) => warnings.push(message) },
    warnings,
  };
}

describe("configuration resolution", () => {
  it("uses built-in defaults when plugin defaults are omitted", () => {
    const { logger, warnings } = captureWarnings();

    expect(buildBaseDefaults(undefined, logger)).toEqual({
      autoRetainBank: undefined,
      retainBanks: [],
      autoRecallBanks: [],
      recallBanks: [],
      retainMode: "full-session",
      retainEveryNTurns: 3,
    });
    expect(warnings).toEqual([]);
  });

  it("ignores defaults.enabled with a warning", () => {
    const { logger, warnings } = captureWarnings();
    const defaults = { enabled: false, retainBanks: ["team"] } satisfies AgentHindsightDefaults & {
      enabled: boolean;
    };

    expect(buildBaseDefaults(defaults, logger).retainBanks).toEqual(["team"]);
    expect(warnings).toContain(
      "defaults.enabled is ignored; use per-agent hindsight.enabled to opt agents out."
    );
  });

  it("skips agents without config in opt-in mode", () => {
    const { logger } = captureWarnings();
    const baseDefaults = buildBaseDefaults({ retainBanks: ["base"] }, logger);

    expect(resolveAgentConfig(undefined, baseDefaults, "opt-in", logger)).toBeUndefined();
  });

  it("skips agents that explicitly disable hindsight", () => {
    const { logger } = captureWarnings();
    const baseDefaults = buildBaseDefaults({ retainBanks: ["base"] }, logger);

    expect(resolveAgentConfig({ enabled: false }, baseDefaults, "all", logger)).toBeUndefined();
  });

  it("validates banks, appends auto-retain banks, and clamps retain turns", () => {
    const { logger, warnings } = captureWarnings();

    expect(
      validateConfig(
        {
          autoRetainBank: " auto ",
          retainBanks: ["team", "", "team", "  docs  "],
          autoRecallBanks: ["", "recall", "recall"],
          recallBanks: ["mem", " ", "mem"],
          retainMode: "last-turn",
          retainEveryNTurns: 0,
        },
        logger
      )
    ).toEqual({
      autoRetainBank: " auto ",
      retainBanks: ["team", "  docs  ", " auto "],
      autoRecallBanks: ["recall"],
      recallBanks: ["mem"],
      retainMode: "last-turn",
      retainEveryNTurns: 1,
    });

    expect(warnings).toEqual(
      expect.arrayContaining([
        "Dropping empty bank name from retainBanks.",
        "Dropping empty bank name from autoRecallBanks.",
        "Dropping empty bank name from recallBanks.",
        'autoRetainBank " auto " was not present in retainBanks; appending it.',
        "retainEveryNTurns must be at least 1; clamping to 1.",
      ])
    );
  });

  it("reads agent.options.hindsight in the config hook", async () => {
    const { logger } = captureWarnings();
    const cache = new Map<string, ResolvedAgentConfig>();
    const hook = createConfigHook({
      agentConfigs: cache,
      baseDefaults: buildBaseDefaults(undefined, logger),
      applyMode: "opt-in",
      logger,
    });
    const input = {
      agent: {
        build: {
          options: {
            hindsight: {
              retainBanks: ["build-bank"],
            },
          },
        },
        plan: {},
      },
    } satisfies HindsightConfigShape;

    await hook(input);

    expect(cache.get("build")?.retainBanks).toEqual(["build-bank"]);
    expect(cache.has("plan")).toBe(false);
  });

  it("resolves and caches unknown agents on the fly", () => {
    const { logger } = captureWarnings();
    initializeConfigResolution({ defaults: { retainBanks: ["base"] }, applyMode: "all", logger });

    expect(resolveOnTheFly("late-agent", undefined)?.retainBanks).toEqual(["base"]);
    expect(agentConfigs.get("late-agent")?.retainBanks).toEqual(["base"]);
  });
});
