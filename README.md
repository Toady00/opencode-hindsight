# opencode Hindsight

An opencode plugin for integrating with Vectorize Hindsight, an AI agent
memory system. The plugin gives each opencode agent its own configurable memory
behavior, including separate banks for automatic retention, automatic recall,
and manual tool usage.

> **Status:** `0.1.2` is an alpha bugfix release. Expect rough edges and test
> with non-critical memory banks before relying on it for important workflows.

## Features

- Per-agent Hindsight configuration via `agent.<name>.options.hindsight`.
- Global defaults with per-agent overrides.
- `applyMode: "all"` and `applyMode: "opt-in"` support.
- Automatic memory recall at root session start.
- Automatic transcript retention on `session.status` idle events.
- Pre-compaction retention and recall support.
- Manual tools:
  - `hindsight_retain`
  - `hindsight_recall`
  - `hindsight_reflect`
- Multi-bank recall with bank-labeled system prompt injection.
- Root-session-only automatic behavior, while manual tools remain available to
  configured child agents.
- Graceful degradation when disabled, unconfigured, or when Hindsight/API calls
  fail.

## Requirements

- Bun 1.3.10 or newer compatible runtime for development.
- opencode with `@opencode-ai/plugin` `>=1.14.41`.
- A running Hindsight API endpoint.
- Optional Hindsight API token, depending on your Hindsight deployment.

## Installation

After the package is published to npm, install it in the environment where
opencode loads plugins:

```bash
bun add @toady00/opencode-hindsight
```

For local development from this repository:

```bash
bun install
bun run build
```

Then reference the package from your opencode configuration.

If you are testing from a local checkout before publishing, build the package
first and use your package manager's local-link workflow from the opencode
configuration environment.

## Basic opencode Configuration

Add the plugin to `opencode.json`:

```jsonc
{
  "plugin": [
    [
      "@toady00/opencode-hindsight",
      {
        "hindsightApiUrl": "http://localhost:8888",
        "hindsightApiToken": "optional-token",
        "applyMode": "all",
        "defaults": {
          "autoRetainBank": "project",
          "retainBanks": ["project"],
          "autoRecallBanks": ["project"],
          "recallBanks": ["project"],
          "retainMode": "full-session",
          "retainEveryNTurns": 3
        }
      }
    ]
  ]
}
```

You can also configure the Hindsight endpoint via environment variables:

```bash
export HINDSIGHT_API_URL="http://localhost:8888"
export HINDSIGHT_API_TOKEN="optional-token"
export HINDSIGHT_DEBUG="true"
```

Environment variables are used when the equivalent plugin options are omitted.

## Quick Start

For a single shared project memory bank, this is the smallest useful setup:

```jsonc
{
  "plugin": [
    [
      "@toady00/opencode-hindsight",
      {
        "hindsightApiUrl": "http://localhost:8888",
        "defaults": {
          "autoRetainBank": "project",
          "retainBanks": ["project"],
          "autoRecallBanks": ["project"],
          "recallBanks": ["project"]
        }
      }
    ]
  ]
}
```

With this configuration, root sessions automatically recall from `project` at
startup, retain transcripts to `project` as the session goes idle, and expose
manual retain/recall/reflect tools for configured agents.

By default, automatic retention waits for three new user turns before retaining.
Set `retainEveryNTurns` to `1` while smoke-testing if you want the first idle
event after a prompt to retain immediately.

## Plugin Options

| Option | Description | Default |
| --- | --- | --- |
| `enabled` | Set to `false` to disable the plugin entirely. | `true` |
| `hindsightApiUrl` | Hindsight API URL. Required unless `HINDSIGHT_API_URL` is set. | none |
| `hindsightApiToken` | Optional API token. Can also use `HINDSIGHT_API_TOKEN`. | none |
| `applyMode` | `"all"` applies defaults to every agent; `"opt-in"` only enables agents with explicit `hindsight` config. | `"all"` |
| `debug` | Enable debug logging. Can also use `HINDSIGHT_DEBUG`. | `false` |
| `defaults` | Agent Hindsight defaults shared by all enabled agents. | built-in defaults |

If `enabled` is `false`, the plugin returns no hooks. If no Hindsight API URL is
configured, it logs an error and returns no hooks so opencode can continue.

## Agent Hindsight Configuration

Agent settings live under each agent's `options.hindsight` field:

```jsonc
{
  "agent": {
    "build": {
      "options": {
        "hindsight": {
          "autoRetainBank": "build-session-memory",
          "retainBanks": ["build-session-memory", "implementation-notes"],
          "autoRecallBanks": ["project-context", "implementation-notes"],
          "recallBanks": ["project-context", "implementation-notes"],
          "retainMode": "last-turn",
          "retainEveryNTurns": 2
        }
      }
    },
    "review": {
      "options": {
        "hindsight": {
          "autoRecallBanks": ["project-context", "review-findings"],
          "recallBanks": ["project-context", "review-findings"],
          "retainBanks": []
        }
      }
    },
    "plan": {
      "options": {
        "hindsight": {
          "enabled": false
        }
      }
    }
  }
}
```

### Agent Fields

| Field | Description |
| --- | --- |
| `enabled` | Per-agent opt-out. `false` disables all Hindsight behavior for that agent. |
| `autoRetainBank` | Bank used for automatic transcript retention. |
| `retainBanks` | Banks allowed for the manual `hindsight_retain` tool. |
| `autoRecallBanks` | Banks queried automatically at session start and compaction. |
| `recallBanks` | Banks allowed for manual `hindsight_recall` and `hindsight_reflect`. |
| `retainMode` | `"full-session"` or `"last-turn"`. |
| `retainEveryNTurns` | User-turn interval for idle auto-retain. Minimum is `1`. |

Bank names are passed through exactly as configured. Empty and whitespace-only
bank names are ignored; duplicate entries are de-duplicated while preserving
order.

## Apply Modes

### `applyMode: "all"`

Every agent receives the plugin defaults unless it opts out with:

```jsonc
{
  "options": {
    "hindsight": {
      "enabled": false
    }
  }
}
```

### `applyMode: "opt-in"`

Agents with explicit `options.hindsight` configuration receive Hindsight
behavior. If plugin-level `defaults` configure any banks, those defaults also
apply to agents without `options.hindsight`; otherwise, unconfigured agents are
skipped.

## Automatic Recall

For root sessions, the plugin marks a session for recall when the
`session.created` event arrives and the agent has non-empty `autoRecallBanks`.
On the next `experimental.chat.system.transform` hook, each auto-recall bank is
queried with this fixed query:

```text
Relevant project context, user preferences, and recent work for this agent.
```

Successful recall results are appended to the system prompt in a
`<hindsight_memories>` block with bank labels and an ISO timestamp. Existing
system prompt entries are preserved.

If every bank query fails, the session remains marked for recall so the plugin
can retry on the next system transform. If at least one bank succeeds but no
memories are returned, the recall marker is consumed and no memory block is
injected.

## Automatic Retention

Automatic retention runs on `session.status` events where
`status.type === "idle"`. The plugin also accepts the deprecated `session.idle`
event for compatibility with older event producers.

Auto-retain only runs for root sessions. Child sessions are skipped for
automatic retention.

### `retainMode: "full-session"`

The plugin fetches all session messages, formats them as a transcript, strips
any previously injected Hindsight memory blocks, and retains the transcript to
`autoRetainBank` using the session ID as the document ID. Repeated retains
overwrite the same session document.

### `retainMode: "last-turn"`

The plugin extracts the last `retainEveryNTurns` user turns and their assistant
responses, formats that window as a transcript, and retains it as a new unique
document.

### Compaction

Before compaction, the plugin always attempts to retain the full transcript to
`autoRetainBank` using the session ID as the document ID. This bypasses normal
turn throttling and `retainMode`. It then attempts compaction recall and appends
any recalled memory block to the compaction context.

## Manual Tools

Configured agents receive these tools:

### `hindsight_retain`

Stores information in a configured retain bank.

Parameters:

- `content` — required; cannot be empty.
- `bank` — required at execution time; must be in `retainBanks`.
- `context` — optional context stored as metadata.

Example request:

```json
{
  "content": "The project uses Bun and tsup for building the plugin.",
  "bank": "implementation-notes",
  "context": "Repository setup decision"
}
```

### `hindsight_recall`

Searches a configured recall bank and returns matching memories.

Parameters:

- `query` — required; cannot be empty.
- `bank` — required at execution time; must be in `recallBanks`.

### `hindsight_reflect`

Synthesizes an answer from a configured recall bank.

Parameters:

- `query` — required; cannot be empty.
- `bank` — required at execution time; must be in `recallBanks`.
- `context` — optional additional context for reflection.

Manual tools can be used in child sessions if the child agent has resolved
Hindsight configuration. There is no child-session restriction on manual tools.

## Development

Install dependencies:

```bash
bun install
```

Build the ESM bundle and declarations:

```bash
bun run build
```

Run tests:

```bash
bun run test
```

Watch build output during development:

```bash
bun run dev
```

## Issue Tracking

This project uses `bd` for issue tracking. After cloning the repository or
creating a new worktree, run this from the worktree root:

```bash
bd bootstrap
```

## Inspiration

This project uses the official Hindsight opencode plugin as a reference point
for the integration pattern while extending the configuration model for richer
per-agent and multi-bank workflows.
