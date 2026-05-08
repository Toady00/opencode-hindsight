export interface DebugLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createDebugLogger(enabled: boolean): DebugLogger {
  const write = (level: "debug" | "warn" | "error", message: string) => {
    if (!enabled) return;
    console.error(`[Hindsight] ${level}: ${message}`);
  };

  return {
    debug: (message: string) => write("debug", message),
    warn: (message: string) => write("warn", message),
    error: (message: string) => write("error", message),
  };
}
