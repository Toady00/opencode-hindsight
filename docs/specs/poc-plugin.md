# Proof of Concept Plugin: @toady00/opencode-hindsight

## Overview

Build an opencode plugin that integrates [Hindsight](https://github.com/vectorize-io/hindsight)
long-term memory with per-agent configuration. Unlike the official
`@vectorize-io/opencode-hindsight` plugin (which applies a single memory bank
globally), this plugin lets each opencode agent use its own memory banks —
with independent control over auto-retain, auto-recall, manual retain, and
manual recall bank sets.

The official plugin serves as inspiration. This plugin reuses the same
Hindsight client SDK (`@vectorize-io/hindsight-client`) and opencode plugin SDK
(`@opencode-ai/plugin`) but provides its own configuration, routing, and
content-processing layers.

### Goals

- **Per-agent memory routing**: Different agents retain to and recall from
  different Hindsight memory banks.
- **Flexible bank topology**: Four independent bank roles — auto-retain (one),
  manual retain (many), auto-recall (many), and manual recall (many) — give
  fine-grained control over what goes where.
- **Opt-in / opt-out control**: Enable or disable hindsight per agent, with a
  global toggle for the default behavior.
- **Agent frontmatter configuration**: Configure hindsight directly in an
  agent's markdown frontmatter (`.opencode/agents/*.md`), avoiding deeply
  nested YAML.
- **Subagent filtering**: Child/subagent sessions do NOT participate in
  auto-retain or auto-recall. Important information should be surfaced to the
  parent session.
- **Prove feasibility**: Validate that the opencode plugin API exposes enough
  context (agent name, session parentage, hook timing) to support per-agent
  memory routing.

### Non-Goals (Future Work)

- Bank bootstrapping / mission configuration (hindsight manages this directly)
- TUI plugin component
- Multi-server support (all banks on one Hindsight instance)
- `~/.hindsight/opencode.json` config file support
- Per-agent env var overrides
- Coexistence with `@vectorize-io/opencode-hindsight` (this is a replacement,
  not a companion — running both will cause double-retain, tool collisions, and
  duplicated recall injection)
- Dynamic bank ID derivation (`dynamicBankId`, `dynamicBankGranularity`) —
  auto-suffixing bank names with project/git/channel/user context
- Bank ID prefix (`bankIdPrefix`) — prepending a string to all bank IDs
- Recall budget and token limits (`recallBudget`, `recallMaxTokens`) — tuning
  parameters for Hindsight recall API calls
- State map size caps / eviction strategies — defensive limits on in-memory
  maps for long-running processes

---

## Requirements

### R1: Plugin Structure

- **R1.1**: The plugin is an npm package named `@toady00/opencode-hindsight`,
  written in TypeScript, built with `tsup`, using Bun as the runtime (per
  `mise.toml`).
- **R1.2**: The plugin default-exports a `PluginModule` object
  (`{ server: Plugin }`) compatible with `@opencode-ai/plugin`. The `server`
  function receives `PluginInput` and optional `PluginOptions`, and returns
  a `Hooks` object.
- **R1.3**: The plugin depends on `@vectorize-io/hindsight-client` for
  Hindsight API calls and `@opencode-ai/plugin` as a peer dependency.
- **R1.4**: The plugin's internal module structure is at the implementer's
  discretion. The official hindsight plugin's source (at
  `~/code/clones/hindsight/main/hindsight-integrations/opencode/`) may be used
  as inspiration for patterns, but does not need to be mirrored.
- **R1.5**: Content-processing utilities (memory tag stripping, transcript
  formatting, recall query composition) should be implemented within this
  plugin. The official plugin's `content.ts` may be used as reference for
  the logic, but the implementation should be self-contained — no runtime
  dependency on the official plugin.

### R2: Configuration

#### R2.1: Plugin-Level Configuration

Plugin options are passed via the opencode.json plugin tuple:

```json
{
  "plugin": [
    ["@toady00/opencode-hindsight", {
      "enabled": true,
      "hindsightApiUrl": "http://localhost:8888",
      "hindsightApiToken": "optional-api-key",
      "applyMode": "all",
      "debug": false,
      "defaults": {
        "autoRetainBank": "general",
        "retainBanks": ["general"],
        "autoRecallBanks": ["general"],
        "recallBanks": ["general"],
        "retainMode": "full-session",
        "retainEveryNTurns": 3
      }
    }]
  ]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Global kill switch. If `false`, the plugin logs that hindsight is disabled and returns empty hooks; no tools are registered and no per-agent config is read. |
| `hindsightApiUrl` | `string` | — | Hindsight API base URL. **Required.** Also settable via `HINDSIGHT_API_URL` env var. |
| `hindsightApiToken` | `string` | `null` | API key for authentication. Also settable via `HINDSIGHT_API_TOKEN` env var. |
| `applyMode` | `"all" \| "opt-in"` | `"all"` | Controls default behavior (see R2.3). |
| `debug` | `boolean` | `false` | Enable debug logging via `console.error`. Also settable via `HINDSIGHT_DEBUG` env var. |
| `defaults` | `AgentHindsightDefaults` | *(see below)* | Default per-agent bank and retain behavior. If omitted, built-in defaults configure no banks and no auto behavior. |

The example above explicitly configures a `general` bank. It is not the built-in
default. If `defaults` is omitted entirely, the built-in per-agent defaults are:
`autoRetainBank: undefined`, `retainBanks: []`, `autoRecallBanks: []`,
`recallBanks: []`, `retainMode: "full-session"`, and
`retainEveryNTurns: 3`.

#### R2.2: Per-Agent Configuration (AgentHindsightConfig)

Per-agent config is specified in `opencode.json` under
`agent.<name>.hindsight` or in agent markdown frontmatter under a `hindsight:`
key. Plugin-level `defaults` use the same bank and retention fields, but do
**not** use `enabled`; `defaults.enabled` is ignored and logged as a warning if
present. Per-agent `enabled` is only an opt-out flag for that agent. The
top-level plugin `enabled` option is the only global kill switch.

```typescript
interface AgentHindsightDefaults {
  autoRetainBank?: string;      // default: undefined (no auto-retain)
  retainBanks?: string[];       // default: []
  autoRecallBanks?: string[];   // default: [] (no auto-recall)
  recallBanks?: string[];       // default: []
  retainMode?: "full-session" | "last-turn";  // default: "full-session"
  retainEveryNTurns?: number;   // default: 3
}

interface AgentHindsightConfig extends AgentHindsightDefaults {
  enabled?: boolean;            // per-agent opt-out only; default: true
}
```

**Bank taxonomy — four independent roles:**

| Field | Cardinality | Purpose | Example use |
|-------|-------------|---------|-------------|
| `autoRetainBank` | single, optional | The ONE bank that automatically receives the session transcript on idle and pre-compaction. If unset, no auto-retain occurs. | `"tester-memory"` — this agent's sessions are automatically saved here |
| `retainBanks` | list | Banks the agent can manually retain to via the `hindsight_retain` tool. The agent chooses which bank based on content (e.g., a technical fact vs. a user preference). `autoRetainBank` MUST appear in this list. | `["tester-memory", "technical", "user-preferences"]` |
| `autoRecallBanks` | list | Banks that auto-inject memories into the system prompt on session start and after compaction. If empty, no auto-recall occurs. | `["tester-memory", "general", "product"]` |
| `recallBanks` | list | Banks the agent can manually recall or reflect from via the `hindsight_recall` and `hindsight_reflect` tools. May include read-only banks the agent queries on demand. | `["tester-memory", "general", "platform-rules"]` |

These four lists are **independent** — a bank can appear in any combination:
- A bank in `retainBanks` but not `recallBanks` is write-only for this agent.
- A bank in `recallBanks` but not `retainBanks` is read-only for this agent.
- A bank in `autoRecallBanks` but not `recallBanks` auto-injects but isn't
  manually queryable (unusual but valid).
- A bank in both `retainBanks` and `autoRecallBanks` is one the agent writes
  to manually and auto-reads from.

**Validation rules** (checked at config resolution time):
- `defaults.enabled` is ignored and logged as a warning; use top-level
  `enabled: false` to disable the whole plugin.
- `autoRetainBank` (if set) must appear in `retainBanks`. If not, log a
  warning and auto-append it.
- Empty or whitespace-only bank names are invalid. Drop them from bank lists,
  ignore them as `autoRetainBank`, and log a warning. Other bank names are
  passed through exactly as configured, including internal or surrounding spaces.
- Duplicate bank names within each bank list are de-duplicated while preserving
  first-seen order.
- `retainEveryNTurns` is clamped to a minimum of 1.

**Agent markdown frontmatter** example (`.opencode/agents/tester.md`):

```yaml
---
description: Testing agent
mode: primary
hindsight:
  autoRetainBank: tester-memory
  retainBanks:
    - tester-memory
    - technical
    - user-preferences
  autoRecallBanks:
    - tester-memory
    - general
  recallBanks:
    - tester-memory
    - general
    - platform-rules
---
```

Opencode automatically places unknown frontmatter keys into
`agent.options.hindsight`. The plugin reads this via the `config` hook.

**opencode.json** example:

```json
{
  "agent": {
    "tester": {
      "hindsight": {
        "autoRetainBank": "tester-memory",
        "retainBanks": ["tester-memory", "technical", "user-preferences"],
        "autoRecallBanks": ["tester-memory", "general"],
        "recallBanks": ["tester-memory", "general", "platform-rules"]
      }
    }
  }
}
```

Opencode's config system merges both sources before the plugin sees them, so
the plugin always reads from `agent.<name>.options.hindsight`.

#### R2.3: Apply Mode and Config Resolution

The top-level `enabled` setting controls whether the plugin does anything at
all. If `enabled: false`, the plugin returns empty hooks and no tools are
registered, regardless of `applyMode` or per-agent config.

When the plugin is globally enabled, `applyMode` controls which agents get
hindsight behavior:

- **`"all"`** (default): Every agent uses hindsight with `defaults` unless it
  has per-agent config that overrides specific fields. An agent can opt out by
  setting `hindsight.enabled: false` in its config.
- **`"opt-in"`**: Only agents with an explicit `hindsight` key in their config
  get hindsight behavior. The per-agent config is shallow-merged with
  `defaults` (agent values win). An explicit empty object (`hindsight: {}`) is
  enough to opt in and use defaults.

**Resolution algorithm:**

```
if pluginOptions.enabled === false:
  → disable plugin entirely: return empty hooks and register no tools

baseDefaults = built-in defaults shallow-merged with pluginOptions.defaults
if pluginOptions.defaults.enabled exists:
  → ignore it and log a warning

for each agent:
  agentConfig = agent.options.hindsight   // may be undefined

  if agentConfig exists AND agentConfig.enabled === false:
    → skip this agent entirely (no defaults applied)

  if applyMode === "all":
    → resolvedConfig = shallow merge(baseDefaults, (agentConfig without enabled) ?? {})
  
  if applyMode === "opt-in":
    if agentConfig is undefined:
      → skip this agent entirely
    else:
      → resolvedConfig = shallow merge(baseDefaults, agentConfig without enabled)

  validate resolvedConfig:
    - drop invalid bank names and de-duplicate bank lists
    - if autoRetainBank is set, ensure autoRetainBank ∈ retainBanks
    - clamp retainEveryNTurns to minimum of 1
```

**Configuration priority** (highest wins):

1. Plugin-level `defaults` (lowest)
2. Per-agent config from opencode.json / agent frontmatter (merged by opencode
   before the plugin sees it)
3. Environment variables for connection settings only: `HINDSIGHT_API_URL`,
   `HINDSIGHT_API_TOKEN`, `HINDSIGHT_DEBUG` (highest)

### R3: Auto-Recall (Memory Injection)

- **R3.1**: On `session.created`, if the session is a root session (no
  `parentID`) and the agent's
  `autoRecallBanks` is non-empty, the plugin marks the session for recall
  injection. The actual recall API calls and injection happen in the
  `experimental.chat.system.transform` hook (which fires when the system
  prompt is assembled for the first message).
- **R3.2**: Each bank in `autoRecallBanks` is queried via a separate Hindsight
  API call. On session start, the recall query MUST be:
  `Relevant project context, user preferences, and recent work for this agent.`
- **R3.3**: Results are injected into the system prompt via the
  `experimental.chat.system.transform` hook, formatted with bank labels:

  ```
  <hindsight_memories>
  Relevant memories from past conversations. Only use memories that are
  directly useful; ignore the rest.
  Current time: 2026-05-07T12:00:00 UTC

  ## Bank: general
  [memory 1]
  [memory 2]

  ## Bank: tester-memory
  [memory 3]
  </hindsight_memories>
  ```

- **R3.4**: Recall is attempted once per session (tracked by session ID). If
  ALL bank API calls fail (network error), the session is kept in the retry
  set so it will be retried on the next system transform invocation. If at
  least one bank succeeds (even with zero results), the session is consumed
  from the retry set — partial results are injected, failures are logged. If
  all successful banks return zero memories, no `<hindsight_memories>` block is
  injected.
- **R3.5**: On `experimental.session.compacting`, recall is also performed
  (from the agent's `autoRecallBanks`) and injected into the compaction
  context. The recall query is composed from the last user message plus
  formatted recent conversation context.
- **R3.6**: The `experimental.chat.system.transform` hook receives
  `{ sessionID?: string; model: Model }`. If `sessionID` is undefined, the
  hook returns immediately without injecting anything.

### R4: Auto-Retain

- **R4.1**: On the `session.status` event with `status.type === "idle"`, if
  the session is a root session
  and the agent's `autoRetainBank` is configured, the plugin retains the
  conversation transcript to `autoRetainBank`.
  (Note: the deprecated `session.idle` event is NOT used.)
- **R4.2**: Retention respects `retainMode`:
  - `"full-session"`: The entire session transcript is upserted (same document
    ID = session ID, so each retain overwrites the previous).
  - `"last-turn"`: Only the last `retainEveryNTurns` user turns (and their
    corresponding assistant responses) are retained as a new document (unique
    document ID per retain). This captures a sliding window of recent
    conversation rather than the full history.
- **R4.3**: Idle-event retention respects `retainEveryNTurns` (minimum value:
  1): only retains when enough new user turns have accumulated since the last
  retain for this session.
- **R4.4**: On `experimental.session.compacting`, a pre-compaction retain is
  performed to the agent's `autoRetainBank` (if configured) before the
  conversation is truncated. This compaction retain bypasses
  `retainEveryNTurns` and always retains the full pre-compaction transcript
  using the session ID as the document ID, regardless of `retainMode`. The
  turn counter is reset after compaction.
- **R4.5**: Session messages are fetched via the opencode SDK client
  (`client.session.messages`).
- **R4.6**: Before retaining, the plugin strips `<hindsight_memories>` and
  `<relevant_memories>` XML blocks from the transcript to prevent recall
  feedback loops (previously injected memories being re-retained as
  conversation content).

### R5: Manual Tools

The plugin registers three tools available to all agents that have hindsight
enabled. Tool descriptions are **static** (registered once at plugin init) and
describe the `bank` parameter generically. Bank validation happens at
execution time.

**No implicit bank defaults for tools.** If the agent omits the `bank`
parameter, the tool returns an error listing the agent's valid banks for
that operation. This forces the agent to make a deliberate choice about
where to read from or write to.

#### R5.1: `hindsight_retain`

Store information in long-term memory.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `content` | `string` | yes | The information to remember. Be specific and self-contained. |
| `bank` | `string` | no | Target bank. Must be one of the agent's configured `retainBanks`. If omitted, an error is returned listing valid retain banks. |
| `context` | `string` | no | Optional context about the source of this information. |

- If `content` is empty or whitespace-only, return an error and do not call
  Hindsight.
- If `bank` is omitted, return an error: "You must specify a bank. Available
  retain banks: [list]."
- If `bank` is provided but not in the agent's `retainBanks`, return an error:
  "Invalid bank '[name]'. Available retain banks: [list]."
- If the Hindsight API call fails, return a user-friendly error message rather
  than throwing.

#### R5.2: `hindsight_recall`

Search long-term memory.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `query` | `string` | yes | Natural language search query. |
| `bank` | `string` | no | Bank to search. Must be one of the agent's configured `recallBanks`. If omitted, an error is returned listing valid recall banks. |

- If `query` is empty or whitespace-only, return an error and do not call
  Hindsight.
- Same bank error behavior as `hindsight_retain` but referencing `recallBanks`.
- If the Hindsight API call fails, return a user-friendly error message rather
  than throwing.

#### R5.3: `hindsight_reflect`

Generate a synthesized answer from long-term memory.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `query` | `string` | yes | Question to answer using memory. |
| `bank` | `string` | no | Bank to use. Must be one of the agent's configured `recallBanks`. If omitted, an error is returned listing valid recall banks. |
| `context` | `string` | no | Additional context to guide reflection. |

- If `query` is empty or whitespace-only, return an error and do not call
  Hindsight.
- Same bank error behavior as `hindsight_recall`.
- If the Hindsight API call fails, return a user-friendly error message rather
  than throwing.

#### R5.4: Tool Agent Resolution

The tool's `execute` function receives a `ToolContext` which includes
`context.agent` (the agent name) and `context.sessionID`. The plugin uses
`context.agent` to look up the resolved `AgentHindsightConfig` and determine
the allowed bank sets.

If the agent has no hindsight config (due to `applyMode` or `enabled: false`),
the tools return an error message: "Hindsight is not configured for this
agent."

#### R5.5: Available Banks for Tools

Each tool validates the `bank` parameter against a **different** bank list:

| Tool | Validates against | Error lists |
|------|-------------------|-------------|
| `hindsight_retain` | `retainBanks` | "Available retain banks: [...]" |
| `hindsight_recall` | `recallBanks` | "Available recall banks: [...]" |
| `hindsight_reflect` | `recallBanks` | "Available recall banks: [...]" |

### R6: Subagent Filtering

- **R6.1**: The plugin tracks session parentage from the `session.created`
  event. If `event.properties.info.parentID` is defined, the session is a
  child session.
- **R6.2**: Child sessions are excluded from auto-retain, auto-recall, and
  compaction hooks. Important information should be surfaced to the parent
  agent's session through normal conversation flow.
- **R6.3**: Manual tools still function in child sessions IF the subagent has
  a resolved hindsight config (per R2.3). If the subagent has no config (e.g.,
  `applyMode` is `"opt-in"` and it lacks a `hindsight` key), the tools return
  the standard "not configured" error.

### R7: Bank ID Resolution

- **R7.1**: Configured bank names are used as literal Hindsight bank IDs.
  No transformation, prefix, or suffix is applied. The bank name in the
  agent's config is the exact bank ID passed to the Hindsight API.
- **R7.2**: Bank names may contain any characters except they must not be empty
  or whitespace-only. Valid bank names are passed through exactly as configured;
  URL-path encoding is the responsibility of `@vectorize-io/hindsight-client`,
  not this plugin.

### R8: Graceful Degradation

- **R8.1**: If top-level `enabled` is `false`, the plugin logs that hindsight
  is disabled and returns empty hooks. No tools are registered. The host
  application functions normally.
- **R8.2**: If `hindsightApiUrl` is not configured (and `HINDSIGHT_API_URL` is
  not set), the plugin logs an error and returns empty hooks. No tools are
  registered. The host application functions normally.
- **R8.3**: If a Hindsight API call fails (network error, server error), the
  failure is logged (debug mode). Automatic operations are silently skipped;
  manual tool operations return user-friendly error messages. The plugin never
  throws errors that would disrupt opencode.
- **R8.4**: If the `config` hook fails to read agent configurations, the
  plugin falls back to treating all agents as having default config (if
  `applyMode` is `"all"`) or no config (if `"opt-in"`).
- **R8.5**: Hooks that require a `sessionID` (system transform, compaction)
  return immediately if `sessionID` is undefined.

### R9: State Management

- **R9.1**: Module-level state persists across sessions within a single
  opencode server process. The state tracks:
  - `agentConfigs: Map<string, ResolvedAgentConfig>` — resolved per-agent
    configs, populated in the `config` hook.
  - `sessionMeta: Map<string, { agent: string; isChild: boolean }>` —
    agent name and parentage for each session, populated on
    `session.created`.
  - `recalledSessions: Set<string>` — sessions pending recall injection.
  - `lastRetainedTurn: Map<string, number>` — turn counter for auto-retain
    deduplication.
- **R9.2**: If a session's agent is not found in `agentConfigs` (e.g., agent
  markdown file was created after plugin init), the plugin resolves config
  on-the-fly using the `applyMode` algorithm with defaults, rather than
  erroring.

---

## Acceptance Criteria

### AC1: Per-Agent Auto-Retain Routing
Given two agents (`build` and `tester`) with different `autoRetainBank`
values, when each agent's session goes idle, then each session's transcript
is retained to its respective bank (verified by checking Hindsight API calls).

### AC2: Multi-Bank Auto-Recall Injection
Given an agent with `autoRecallBanks: ["bank-a", "bank-b"]`, when a new root
session starts, then the system prompt contains recalled memories from both
banks, labeled by source bank name.

### AC3: No Auto-Retain Without Bank
Given an agent with no `autoRetainBank` configured,
when the session goes idle, then no auto-retain occurs.

### AC4: No Auto-Recall With Empty Banks
Given an agent with `autoRecallBanks: []` (or unset), when a new
session starts, then no auto-recall injection occurs.

### AC5: Opt-In Mode
Given `applyMode: "opt-in"` and an agent with no `hindsight` key, when that
agent's session starts, then no recall is performed and no auto-retain occurs.

### AC6: Explicit Disable
Given an agent with `hindsight: { enabled: false }`, regardless of
`applyMode`, when that agent's session starts, then no recall, retain, or
tools are active for that agent.

### AC7: Manual Retain — Bank Required
When the agent calls `hindsight_retain` without a `bank` argument, the tool
returns an error listing the agent's configured `retainBanks`.

### AC8: Manual Retain — Bank Validation
Given an agent with `retainBanks: ["technical", "user-preferences"]`, when the
agent calls `hindsight_retain` with `bank: "technical"`, the content is
retained to the `technical` bank. When called with `bank: "nonexistent"`, an
error is returned listing valid retain banks.

### AC9: Manual Recall — Separate Bank List
Given an agent with `recallBanks: ["general", "platform-rules"]` and
`retainBanks: ["technical"]`, the agent can recall from `platform-rules` but
cannot retain to it.

### AC10: Subagent Exclusion
Given a child session (one with a `parentID`), auto-retain and auto-recall
do not fire, regardless of the agent's hindsight config.

### AC11: Compaction Memory Preservation
When a session compacts, the plugin retains the pre-compaction transcript to
`autoRetainBank` and injects recalled memories from `autoRecallBanks` into
the compaction context, ensuring memories survive context window trimming.

### AC12: Retain Mode — Full Session
Given `retainMode: "full-session"` (default), when auto-retain fires for a
session, the transcript is upserted using the session ID as the document ID,
so each retain overwrites the previous version in the bank.

### AC13: Graceful Degradation — No URL
Given no `hindsightApiUrl` configured, the plugin initializes without error
and opencode functions normally with no hindsight tools registered.

### AC14: Graceful Degradation — API Failure
Given a configured `hindsightApiUrl` that is unreachable, tool calls return
a user-friendly error message. Auto-retain and auto-recall skip silently
without disrupting the session.

### AC15: Frontmatter Configuration
Given an agent markdown file with a `hindsight:` frontmatter key, the plugin
reads and applies that configuration for sessions using that agent.

### AC16: Feedback Loop Prevention
Given a session where auto-recall injected `<hindsight_memories>` into the
system prompt, when the session goes idle and auto-retain fires, the retained
transcript does NOT contain the `<hindsight_memories>` block.

### AC17: Bank Validation — autoRetainBank
Given an agent where `autoRetainBank` is not in `retainBanks` in the raw
config, when the plugin resolves config, it auto-appends `autoRetainBank` to
`retainBanks` and logs a warning.

### AC18: Retain Mode — Last Turn
Given `retainMode: "last-turn"` and `retainEveryNTurns: 3`, when auto-retain
fires, only the last 3 user turns (and their assistant responses) are retained
as a new document with a unique ID — not the full session transcript.

### AC19: Turn Throttling
Given `retainEveryNTurns: 5`, when the session goes idle after only 2 new
user turns since the last retain, no auto-retain fires. When 5 or more new
turns have accumulated, auto-retain fires.

### AC20: On-the-Fly Agent Resolution
Given an agent whose config was not present when the plugin initialized (e.g.,
agent markdown file added after startup), when that agent's session triggers
a hook, the plugin resolves its config on-the-fly using the `applyMode`
algorithm with defaults, rather than returning an error.


### AC21: Built-In Defaults Are No-Op
Given plugin `defaults` is omitted and top-level `enabled` is not false, when an
agent is configured by `applyMode: "all"` with no per-agent banks, then no
auto-retain or auto-recall occurs and manual tools report no available banks.

### AC22: Top-Level Disable
Given top-level plugin `enabled: false`, when the plugin initializes, then it
returns empty hooks, registers no tools, and performs no Hindsight API calls.

### AC23: Defaults Enabled Is Ignored
Given `defaults.enabled` is present, when config is resolved, then the value is
ignored, a warning is logged, and it does not enable or disable the plugin or
any agent.

### AC24: Auto-Recall Retry and Zero Results
Given auto-recall is pending for a session, when all bank calls fail, then the
session remains pending for retry. When at least one bank call succeeds but all
successful calls return zero memories, then the session is consumed and no
`<hindsight_memories>` block is injected.

### AC25: Compaction Retain Bypasses Throttle and Mode
Given `retainMode: "last-turn"` and insufficient new turns for
`retainEveryNTurns`, when compaction occurs, then the plugin still retains the
full pre-compaction transcript to `autoRetainBank` using the session ID as the
document ID.

### AC26: Manual Recall and Reflect Bank Validation
Given an agent with `recallBanks: ["general"]`, when it calls
`hindsight_recall` or `hindsight_reflect` with `bank: "general"`, then the
corresponding Hindsight API is called. When it omits `bank` or uses another
bank, the tool returns an error listing valid recall banks.

### AC27: Empty Manual Tool Inputs
When `hindsight_retain` receives empty or whitespace-only `content`, or
`hindsight_recall`/`hindsight_reflect` receives empty or whitespace-only
`query`, then the tool returns a validation error and does not call Hindsight.

### AC28: Bank Name Validation and De-Duplication
Given config containing duplicate bank names and empty or whitespace-only bank
names, when config is resolved, then empty/whitespace-only names are dropped,
duplicates are de-duplicated in first-seen order, and warnings are logged for
invalid names.

### AC29: Literal Bank IDs
Given a valid bank name containing special characters such as `/`, `::`, or
spaces, when the plugin calls Hindsight, then it passes the configured bank name
unchanged to `@vectorize-io/hindsight-client`.

### AC30: Child Session Manual Tools
Given a child session whose agent has a resolved hindsight config, when it uses
manual tools with valid banks, then the tools work even though auto-retain,
auto-recall, and compaction behavior are skipped for that child session.

### AC31: Missing Session ID No-Op
Given a system-transform or compaction hook invocation with no `sessionID`, when
the hook runs, then it returns without injecting, retaining, or throwing.

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Agent switches mid-session (via `switchAgent`) | The session retains the original agent assignment from `session.created`. Auto-retain and auto-recall use the original agent's config. Future iteration may handle agent switching. |
| Session created with no agent field | Treated as agent name `undefined`. If `applyMode` is `"all"`, defaults apply. If `"opt-in"`, skipped. |
| `autoRetainBank` not in `retainBanks` | Auto-appended to `retainBanks` with a warning during config validation. |
| `autoRetainBank` not set | No auto-retain occurs. This is valid — the agent may only use manual retain. |
| `autoRecallBanks` empty (explicitly `[]`) | No auto-recall on session start or compaction. Manual recall tools still work against `recallBanks`. |
| `retainBanks` empty | Agent cannot manually retain. `hindsight_retain` always returns an error. If `autoRetainBank` is also unset, no retention of any kind occurs. |
| `recallBanks` empty | Agent cannot manually recall or reflect. `hindsight_recall`/`hindsight_reflect` always return an error. Auto-recall (from `autoRecallBanks`) still functions. |
| All bank lists empty, no `autoRetainBank` | Agent has hindsight enabled but no banks. All tools return errors. No auto operations. Effectively a no-op. Log a warning. |
| Same bank in `retainBanks` and `recallBanks` | Valid — the agent can both write to and read from this bank via tools. |
| Bank in `autoRecallBanks` but not in `recallBanks` | Valid — auto-injects but isn't manually queryable. This is unusual but not an error. |
| Tool called without `bank` parameter | Error returned with list of valid banks for that operation (retain or recall). |
| Plugin loaded but Hindsight server unreachable | All API calls fail silently (logged in debug mode). Tools return user-friendly error messages. Auto operations are skipped. |
| Multiple opencode plugins modifying `experimental.chat.system.transform` | Hooks run in sequence per plugin load order. This plugin appends to `output.system[]`; it does not replace existing entries. |
| Very long conversation retained | Token limits are handled by the Hindsight API. The plugin sends whatever the transcript formatter produces. |
| `config` hook sees agent added by another plugin | Works — the config hook receives the fully merged config including plugin-added agents. |
| Agent has `hindsight` key with only partial config | Shallow-merged with `defaults`. Missing fields inherit from defaults. |
| Session deleted or archived | No special handling. Stale entries in `sessionMeta` persist until process restart. |
| Recall feedback loop | `<hindsight_memories>` and `<relevant_memories>` XML blocks are stripped from transcripts before retention (R4.6). |
| Concurrent auto-recall — partial bank failure | Inject results from banks that succeeded. Log failures. Consume session from retry set (don't retry if at least one bank succeeded). |
| Agent not in `agentConfigs` at runtime | Resolve on-the-fly using `applyMode` logic with defaults (R9.2). |
| `retainEveryNTurns` set to 0 or negative | Clamped to minimum of 1 during config validation. |
| Bank name contains special characters (`/`, `::`, spaces) | Passed through as-is. URL-path encoding is `hindsight-client`'s responsibility (R7.2). |
| `sessionID` undefined in system transform or compaction hook | Hook returns immediately, no action taken (R8.5). |
| Plugin `defaults` omitted | Built-in defaults configure no banks and no auto behavior. In `applyMode: "all"`, agents have hindsight enabled but no operations available until banks are configured. |
| Top-level `enabled: false` | Plugin disables itself entirely: empty hooks, no tools, no API calls. |
| `defaults.enabled` present | Ignored with a warning. It does not affect global or per-agent enablement. |
| Empty or whitespace-only bank name | Invalid. Dropped from bank lists, ignored as `autoRetainBank`, warning logged. |
| Duplicate bank names in a bank list | De-duplicated while preserving first-seen order. |
| Manual tool called with empty `content` or `query` | Validation error returned; no Hindsight API call is made. |
| Auto-recall succeeds but returns zero memories | Session is consumed from retry set; no empty `<hindsight_memories>` block is injected. |
| Compaction occurs before `retainEveryNTurns` threshold | Pre-compaction retain still runs if `autoRetainBank` is configured, bypassing throttle and retaining the full transcript. |
| Official `@vectorize-io/opencode-hindsight` loaded alongside this plugin | Undefined behavior — tool name collision, double-retain. Documented as unsupported in Non-Goals. |

---

## Open Questions

*None — all questions have been resolved through the specification conversation.*

---

## Appendix A: Reference Architecture

### Hook Wiring

| Hook | Purpose |
|------|---------|
| `config` | Read `cfg.agent[name].options.hindsight` for all agents. Build `agentConfigs` map. Validate bank names, de-duplicate bank lists, and validate bank relationships. |
| `event` (`session.created`) | Cache session metadata (agent, isChild). Mark session for recall if eligible. |
| `event` (`session.status`, type=`idle`) | Auto-retain to agent's `autoRetainBank` (root sessions only, if configured). |
| `experimental.chat.system.transform` | Inject recalled memories from agent's `autoRecallBanks` (root sessions only, once per session). |
| `experimental.session.compacting` | Pre-compaction retain to `autoRetainBank` + recall injection from `autoRecallBanks` (root sessions only). |
| `tool` | Register `hindsight_retain`, `hindsight_recall`, `hindsight_reflect`. |

### Tool Context

The `ToolContext` (from `@opencode-ai/plugin/tool`) provides:
- `context.agent` — the agent name (used to look up config)
- `context.sessionID` — the session ID
- `context.directory` / `context.worktree` — project paths

This eliminates the need for indirect agent resolution in tool handlers.

### Session Agent Resolution in Event Hooks

Event hooks (`session.created`, `session.status`) and compaction hooks receive
`sessionID` but not `agent` directly. The plugin resolves the agent by:

1. On `session.created`: extracting `agent` from the v2 `Session` object
   (`event.properties.info.agent`) and caching `sessionID → { agent, isChild }`
   in `sessionMeta`. **Note:** The plugin SDK's `event` hook types reference
   the v1 `Session` type (which lacks `agent`), but the opencode server sends
   the v2 `Session` shape at runtime. The implementation should use a type
   assertion to access `agent` (e.g., cast to `Session` from
   `@opencode-ai/sdk/v2`). Requires `@opencode-ai/plugin` ≥ 1.14.41.
2. On subsequent hooks: looking up the agent from `sessionMeta`.
3. Fallback: if `sessionMeta` has no entry (e.g., session existed before
   plugin loaded), use the opencode SDK client to fetch session info.

### Data Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ opencode.json   │     │ agent frontmatter │     │ env vars         │
│ plugin options  │     │ hindsight: {...}  │     │ HINDSIGHT_API_*  │
└────────┬────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                       │                         │
         ▼                       ▼                         │
    ┌─────────┐           ┌────────────┐                   │
    │ defaults│           │ agent.opts │                   │
    │         │           │ .hindsight │                   │
    └────┬────┘           └─────┬──────┘                   │
         │                      │                          │
         ▼                      ▼                          ▼
    ┌──────────────────────────────────────────────────────────┐
    │              Config Resolution (per agent)               │
    │  applyMode → merge built-in defaults + plugin + agent cfg │
    │  validate: autoRetainBank ∈ retainBanks (if set)         │
    └────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
                   ┌───────────────────┐
                   │  agentConfigs Map │
                   │  agent → config   │
                   └─────────┬─────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│ Auto-Recall  │    │ Auto-Retain  │    │      Tools       │
│autoRecallBanks│   │autoRetainBank│    │retain→retainBanks│
│  (inject)    │    │  (one bank)  │    │recall→recallBanks│
└──────────────┘    └──────────────┘    └──────────────────┘
         │                   │                   │
         ▼                   ▼                   ▼
    ┌──────────────────────────────────────────────────┐
    │            Hindsight API Server                  │
    │       (one server, multiple banks)               │
    └──────────────────────────────────────────────────┘
```

## Appendix B: Official Plugin Differences

| Aspect | Official Plugin | This Plugin |
|--------|----------------|-------------|
| Bank routing | Single bank (static or dynamic) | Four independent bank roles per agent |
| Agent awareness | None (one config for all) | Per-agent configuration via frontmatter or JSON |
| Configuration source | Plugin options + env vars + `~/.hindsight/opencode.json` | Plugin options + agent frontmatter + env vars (connection only) |
| Idle detection | Deprecated `session.idle` event | `session.status` event (type=idle) |
| Subagent handling | No distinction | Skips child sessions for auto operations |
| Tool bank param | No bank param (fixed target) | Required `bank` param validated against per-operation bank list |
| Recall injection | Single bank | Multiple `autoRecallBanks`, labeled by source |
| Retain control | Auto-retain to same bank as everything | Separate `autoRetainBank` + `retainBanks` for manual |
| Bank ID derivation | Static or dynamic (prefix + project suffix) | Literal bank names only (dynamic deferred) |
| Bank mission | Supported | Deferred to future iteration |
| Coexistence | N/A | Cannot run alongside this plugin (replacement) |
