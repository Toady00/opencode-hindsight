# Changelog

## 0.1.2

- Fix `applyMode: "opt-in"` with configured plugin defaults so default banks apply
  to agents without per-agent `options.hindsight` blocks.
- Add auto-retain debug diagnostics for skip reasons and throttle state.
- Document the default three-turn retention threshold for smoke testing.

## 0.1.1

- Fix automatic retention for current opencode `session.status` idle events.
- Keep compatibility with deprecated `session.idle` events.

## 0.0.1

- Initial alpha release with per-agent Hindsight retention, recall, and manual tools.
