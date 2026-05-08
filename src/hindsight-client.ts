import { HindsightClient } from "@vectorize-io/hindsight-client";
import type { RecallResponse, ReflectResponse } from "@vectorize-io/hindsight-client";

import type { DebugLogger } from "./debug.js";

export type ApiResult<T> = { success: true; data: T } | { success: false; error: string };

export interface RetainOptions {
  bankId: string;
  content: string;
  documentId: string;
  metadata?: Record<string, string>;
}

export interface RecallOptions {
  bankId: string;
  query: string;
}

export interface ReflectOptions {
  bankId: string;
  query: string;
  context?: string;
}

export interface HindsightClientWrapper {
  retain(options: RetainOptions): Promise<ApiResult<void>>;
  recall(options: RecallOptions): Promise<ApiResult<string[]>>;
  reflect(options: ReflectOptions): Promise<ApiResult<string>>;
}

export interface HindsightSdkClient {
  retain(
    bankId: string,
    content: string,
    options?: { documentId?: string; metadata?: Record<string, string>; updateMode?: "replace" | "append" }
  ): Promise<unknown>;
  recall(bankId: string, query: string): Promise<RecallResponse>;
  reflect(bankId: string, query: string, options?: { context?: string }): Promise<ReflectResponse>;
}

export function createHindsightClient(options: {
  apiUrl: string;
  apiToken?: string;
  debug: DebugLogger;
  client?: HindsightSdkClient;
}): HindsightClientWrapper {
  const client =
    options.client ??
    new HindsightClient({
      baseUrl: options.apiUrl,
      apiKey: options.apiToken || undefined,
    });

  return new SafeHindsightClientWrapper(client, options.debug);
}

class SafeHindsightClientWrapper implements HindsightClientWrapper {
  constructor(
    private readonly client: HindsightSdkClient,
    private readonly debug: DebugLogger
  ) {}

  async retain(options: RetainOptions): Promise<ApiResult<void>> {
    try {
      await this.client.retain(options.bankId, options.content, {
        documentId: options.documentId,
        metadata: options.metadata,
        updateMode: "replace",
      });

      return { success: true, data: undefined };
    } catch (error) {
      this.debug.error(`Hindsight retain failed for bank "${options.bankId}": ${formatError(error)}`);
      return {
        success: false,
        error: `Failed to retain to bank "${options.bankId}". The Hindsight server may be unavailable.`,
      };
    }
  }

  async recall(options: RecallOptions): Promise<ApiResult<string[]>> {
    try {
      const response = await this.client.recall(options.bankId, options.query);
      return { success: true, data: response.results.map((result) => result.text) };
    } catch (error) {
      this.debug.error(`Hindsight recall failed for bank "${options.bankId}": ${formatError(error)}`);
      return {
        success: false,
        error: `Failed to recall from bank "${options.bankId}". The Hindsight server may be unavailable.`,
      };
    }
  }

  async reflect(options: ReflectOptions): Promise<ApiResult<string>> {
    try {
      const response = await this.client.reflect(options.bankId, options.query, { context: options.context });
      return { success: true, data: response.text };
    } catch (error) {
      this.debug.error(`Hindsight reflect failed for bank "${options.bankId}": ${formatError(error)}`);
      return {
        success: false,
        error: `Failed to reflect from bank "${options.bankId}". The Hindsight server may be unavailable.`,
      };
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
