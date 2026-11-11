# Changelog

## Unreleased

- **Breaking:** the active profile is now per working directory, stored in one
  agent-dir file (`model-profile-directories.json`) keyed by the directory's real
  path, instead of the global `lastActiveProfile` and session-scoped selection.
  Directories without a saved choice use `defaultProfile`. Git never sees it.
- Switching profiles no longer writes `model-profiles.json`, so it no longer
  conflicts with profile edits in other windows.
- `lastActiveProfile` is ignored on load and dropped on the next save.
- Session `model-profiles.selection` entries are history only.

## 0.1.0

- Initial release: deterministic `tier/large`, `tier/medium`, and `tier/small`
  aliases backed by explicitly switchable profiles.
- Manage profiles in Pi's terminal UI, with branch-local selection and
  persistent profile definitions.
- Preserve physical model choice for continuations and retries; no classifier
  or automatic fallback.
