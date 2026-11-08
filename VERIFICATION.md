# Verification

Host: Pi 1.5.0, Pi-Bolt 1.1.3, Linux x64.
Development types: `@earendil-works/pi-coding-agent` and `pi-tui` 1.5.0.

- `npm test`: **23 passed**, 0 failed.
- `npm run typecheck`: passed.
- `npm pack --dry-run`: passed; extension entry point and all source modules included.
- Isolated temporary agent directory, explicit extension load:
  `pi-bolt -ne --no-mcp -ns -np -nc --offline -e ./index.ts --model tier/medium --no-session -p '/model-profile status'`
  selected the virtual model and printed unconfigured mappings without inference.
- `--list-models tier` listed large, medium, small.

Real interactive smoke used Python PTY/subprocess, temporary HOME and agent
directory, no credential environment, and a watchdog:

```sh
pi-bolt -ne --no-mcp -ns -np -nc --offline \
  -e /absolute/path/to/index.ts --model tier/large
```

Confirmed:

- Extension starts, selects tier/large, shows first-run guidance.
- Ctrl+Alt+P encoded as `ESC[112;7u` invokes quick picker behavior and reports no
  profiles; the next command works, confirming editor focus.
- `/model-profiles` → Create opens name input. Escape cancels creation, then
  Escape closes management. No configuration file is written.
- Native `/model` lists all three tier models and marks large selected.
  Filtering and Escape work.
- Child was terminated and reaped; no process remained.

The host printed catalog-refresh messages even with offline flags; absence of
network traffic was not independently traced.

## Remaining manual checks

Automated tests exercise profile CRUD, activation, cycling, wraparound,
branch persistence, errors and routing through mocks. Actual paid inference,
authenticated Codex/Anthropic switching, live tool/retry sequences, real session
resume/tree navigation, and a populated quick picker/cycling shortcut were not
tested end-to-end. Other terminals' modifier encoding and user-defined shortcut
conflicts remain environment-dependent.

For final acceptance in your terminal:

1. Create two authenticated profiles with all three mappings using management.
2. Select tier/large through `/model`, switch with Ctrl+Alt+P, and send a prompt.
   Verify the native footer dispatch changes but the selected alias does not.
3. Repeat with medium/small and Ctrl+Alt+Shift+P; verify sorted wraparound.
4. Switch during a tool sequence: continuations must keep the previous physical
   model; the next user request must use the new profile.
5. Save edits, duplicate/rename/delete, and cancel an edit.
6. Restart, resume, and navigate session branches with different saved profiles.
7. Remove credentials or invalidate a target and verify an explicit error with
   no fallback. Restore valid configuration afterward.
