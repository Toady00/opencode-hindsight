import { describe, expect, it } from "vitest";

import { createHindsightClient, type HindsightSdkClient } from "./hindsight-client.js";
import type { DebugLogger } from "./debug.js";

function debugRecorder(): { debug: DebugLogger; errors: string[] } {
  const errors: string[] = [];
  return {
    debug: {
      debug: () => {},
      warn: () => {},
      error: (message: string) => errors.push(message),
    },
    errors,
  };
}

describe("hindsight client wrapper", () => {
  it("initializes the SDK client with URL and optional token", async () => {
    const { debug } = debugRecorder();
    const client = createHindsightClient({ apiUrl: "http://localhost:8888", apiToken: "token", debug });

    expect(client).toEqual(
      expect.objectContaining({
        retain: expect.any(Function),
        recall: expect.any(Function),
        reflect: expect.any(Function),
      })
    );
  });

  it("passes retain bank names through unchanged", async () => {
    const { debug } = debugRecorder();
    const calls: Array<{ bankId: string; content: string; options?: unknown }> = [];
    const sdk = {
      retain: (bankId, content, options) => {
        calls.push({ bankId, content, options });
        return Promise.resolve({});
      },
      recall: () => Promise.resolve({ results: [] }),
      reflect: () => Promise.resolve({ text: "" }),
    } satisfies HindsightSdkClient;
    const client = createHindsightClient({ apiUrl: "http://example", debug, client: sdk });

    await expect(
      client.retain({
        bankId: "team/alpha::shared bank",
        content: "memory",
        documentId: "session-1",
        metadata: { agent: "build" },
      })
    ).resolves.toEqual({ success: true, data: undefined });

    expect(calls).toEqual([
      {
        bankId: "team/alpha::shared bank",
        content: "memory",
        options: {
          documentId: "session-1",
          metadata: { agent: "build" },
          updateMode: "replace",
        },
      },
    ]);
  });

  it("returns recall memory strings", async () => {
    const { debug } = debugRecorder();
    const sdk = {
      retain: () => Promise.resolve({}),
      recall: (bankId, query) =>
        Promise.resolve({
          results: [
            { id: "1", text: `${bankId}: ${query}` },
            { id: "2", text: "second memory" },
          ],
        }),
      reflect: () => Promise.resolve({ text: "" }),
    } satisfies HindsightSdkClient;

    await expect(
      createHindsightClient({ apiUrl: "http://example", debug, client: sdk }).recall({
        bankId: "team/alpha::shared bank",
        query: "what changed?",
      })
    ).resolves.toEqual({
      success: true,
      data: ["team/alpha::shared bank: what changed?", "second memory"],
    });
  });

  it("returns reflected text", async () => {
    const { debug } = debugRecorder();
    const sdk = {
      retain: () => Promise.resolve({}),
      recall: () => Promise.resolve({ results: [] }),
      reflect: (bankId, query, options) => Promise.resolve({ text: `${bankId}: ${query}: ${options?.context}` }),
    } satisfies HindsightSdkClient;

    await expect(
      createHindsightClient({ apiUrl: "http://example", debug, client: sdk }).reflect({
        bankId: "team/alpha::shared bank",
        query: "summarize",
        context: "current work",
      })
    ).resolves.toEqual({ success: true, data: "team/alpha::shared bank: summarize: current work" });
  });

  it("returns user-friendly error results and logs technical details", async () => {
    const { debug, errors } = debugRecorder();
    const sdk = {
      retain: () => Promise.reject(new Error("connection refused")),
      recall: () => Promise.reject(new Error("timeout")),
      reflect: () => Promise.reject(new Error("bad gateway")),
    } satisfies HindsightSdkClient;
    const client = createHindsightClient({ apiUrl: "http://example", debug, client: sdk });

    await expect(client.retain({ bankId: "bank", content: "memory", documentId: "doc" })).resolves.toEqual({
      success: false,
      error: 'Failed to retain to bank "bank". The Hindsight server may be unavailable.',
    });
    await expect(client.recall({ bankId: "bank", query: "query" })).resolves.toEqual({
      success: false,
      error: 'Failed to recall from bank "bank". The Hindsight server may be unavailable.',
    });
    await expect(client.reflect({ bankId: "bank", query: "query" })).resolves.toEqual({
      success: false,
      error: 'Failed to reflect from bank "bank". The Hindsight server may be unavailable.',
    });
    expect(errors).toHaveLength(3);
    expect(errors.join("\n")).toContain("connection refused");
    expect(errors.join("\n")).toContain("timeout");
    expect(errors.join("\n")).toContain("bad gateway");
  });
});
