// Plugin-level options (from opencode.json plugin tuple)
export interface PluginOptions {
  enabled?: boolean; // default: true
  hindsightApiUrl?: string; // required (or HINDSIGHT_API_URL env)
  hindsightApiToken?: string; // optional (or HINDSIGHT_API_TOKEN env)
  applyMode?: "all" | "opt-in"; // default: "all"
  debug?: boolean; // default: false (or HINDSIGHT_DEBUG env)
  defaults?: AgentHindsightDefaults;
}

// Defaults that apply to all agents (no "enabled" field)
export interface AgentHindsightDefaults {
  autoRetainBank?: string;
  retainBanks?: string[];
  autoRecallBanks?: string[];
  recallBanks?: string[];
  retainMode?: "full-session" | "last-turn";
  retainEveryNTurns?: number;
}

// Per-agent config (extends defaults with opt-out "enabled")
export interface AgentHindsightConfig extends AgentHindsightDefaults {
  enabled?: boolean;
}

// Fully resolved per-agent config (all fields guaranteed)
export interface ResolvedAgentConfig {
  autoRetainBank?: string;
  retainBanks: string[];
  autoRecallBanks: string[];
  recallBanks: string[];
  retainMode: "full-session" | "last-turn";
  retainEveryNTurns: number;
}

// Session metadata cached on session.created
export interface SessionMeta {
  agent: string;
  isChild: boolean;
}
