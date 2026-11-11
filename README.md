# Pi Model Alias

Stable native Pi virtual models: `tier/large`, `tier/medium`, and `tier/small`.
Each resolves to exactly one configured physical model in the active profile.
No classifier, fallback, proxy, provider replacement, or core modifications.
Unlike classifier-based routers, the alias always uses the mapping you choose;
switch profiles explicitly to change those mappings. Other Pi model-alias
packages exist; this extension additionally provides switchable profiles.

## Installation

Requires a Pi version supporting virtual models (tested with Pi 1.5.0).
Configure and authenticate each physical model's provider in Pi before
activating a profile. An alias does not supply provider credentials.

```sh
pi install npm:@mevsgame/pi-model-alias-profiles
```

## First use

Run `/model-profiles`, choose **Create**, enter a name, and select a physical
model for each alias. The model picker searches readable names and exact
provider/model IDs, supports multiple search terms and pagination, and marks
authentication availability. Models from different providers can share a profile.
Choose **Save**, then **Activate**. No example model IDs are installed.

```text
/model-profile work
/tier large
/model tier/medium
/model-profile personal
```

Switching profiles never changes the selected alias. Requests beginning a new
user turn use the new mapping. Tool continuations keep their previous physical
model; retries retain the failed physical model. Thinking selection is preserved
and Pi clamps it to the physical model's capabilities.

### Commands and keys

| Command | Action |
|---|---|
| `/model-profile` | Quick picker, active profile marked |
| `/model-profile NAME` | Activate immediately |
| `/model-profile next` | Cycle sorted profile names, wrap and skip invalid profiles |
| `/model-profile status` | Active profile and mappings |
| `/model-profiles` | Create, edit, duplicate, rename, delete, set default, explicit disk reload |
| `/tier [large\|medium\|small]` | Select alias, or open alias picker |

`Ctrl+Alt+P` opens the quick picker; `Ctrl+Alt+Shift+P` cycles profiles.
Dialogs support up/down, Enter to select, and Escape to cancel and restore the
editor. These bindings do not replace Pi's built-in model-selection shortcuts.
Modifier reporting varies by terminal: use `/hotkeys` to inspect conflicts, and
use the commands if your terminal cannot distinguish these combinations. No
global keybindings are modified.

Management uses nested native dialogs rather than a bespoke full-screen editor.
Edits remain private until Save. Cancelling creation/editing does not write.
Incomplete drafts may be saved but cannot activate. Active profiles must remain
valid when edited, and deleting the active profile requires a valid replacement
and confirmation. Profile names are case-sensitive, 1–64 ASCII letters/digits/
`._-`, starting with a letter/digit; `next`, `status`, and prototype names are
reserved.

Direct physical-model selection is unaffected; the profile status indicator is
hidden in that case. Named activation, cycling, status, and named `/tier`
selection work without a terminal. Management and profile pickers require TUI.

## Persistence and safety

Configuration lives at `<agent-dir>/model-profiles.json`, resolved with Pi's
`getAgentDir()` (including `PI_CODING_AGENT_DIR`). Format:

```json
{
  "version": 1,
  "defaultProfile": "work",
  "profiles": {
    "work": {
      "large": "provider/exact-large-model-id",
      "medium": "provider/exact-medium-model-id",
      "small": "another-provider/exact-small-model-id"
    }
  }
}
```

These are illustrative placeholders, **not valid installed mappings**. Use the
in-Pi registry picker to choose actual configured models. No credentials are
stored here. Availability checks detect configured authentication, not whether a
remote server will accept an expired/revoked credential; provider errors remain
visible and never trigger fallback.

The active profile is per working directory, so each git worktree or project
can run a different profile. The choices live in one file in the agent dir,
`<agent-dir>/model-profile-directories.json`, mapping each directory's real path
to a profile (or `null` for an explicit no-profile state):

```json
{
  "version": 1,
  "directories": {
    "/home/me/project": "work",
    "/home/me/project-feature": "personal"
  }
}
```

The key is the directory Pi started in, resolved with `realpath`, so symlinked
paths share one entry. Switching a profile rewrites only its own key under an
exclusive lock, keeping the other entries. Git never sees this file. A directory
with no saved choice uses the valid global `defaultProfile`. Set it with
**Set default** in `/model-profiles`.

Branch-local `model-profiles.selection` custom session entries (not sent to the
LLM) are kept as history only; they do not choose the active profile. A
missing or renamed saved profile is reported, not silently substituted: select a
replacement explicitly. Definitions remain global; editing them affects future
requests in all directories. A legacy `lastActiveProfile` key is ignored and
removed the next time the global file is saved.

Writes use exclusive locks, content-based conflict detection, and atomic rename.
Failed writes do not update runtime selection. Malformed/unsupported config is
preserved and blocks writes/routing. Repair the file, then use management's
**Reload configuration from disk**. The same explicit reload accepts external
changes after a conflict; there is no automatic cross-process synchronization.
Other windows in the same directory share the choice; a switch in one window is
seen by the next session start or tree change in another. Switching does not
touch `model-profiles.json`, so it cannot conflict with profile edits in other
windows. After a process crash, a stale `.lock` (for the global file or the
directory map) may require removal after confirming no writer is active.
Local atomic-rename/lock semantics are assumed; network filesystems may differ.

## Prompt profiles

This package includes a modified, vendored copy of [pi-prompt-profiles](https://github.com/Yivas/pi-prompt-profiles) 0.11.1 by Yivas (MIT; see `src/prompt-profiles/LICENSE`). **The two plugins conflict:** disable or uninstall the standalone `pi-prompt-profiles` extension before loading this package, because both register `/sp` commands and prompt hooks. Existing `system-prompts` configuration, profiles, commands, flags and session selections are used by the bundled copy.

For `tier/*`, automatic prompt bindings match the current mapped physical model rather than the alias. Direct physical model selections continue to match normally. Switching model profiles changes the binding on the next run. The `/sp` status and diagnostics still display the selected virtual model; they do not report the physical binding identity. The bundled version is a snapshot and is not automatically updated when the standalone package is updated.

## Optional pi-usage integration

When `@narumitw/pi-usage` is installed, selecting a tier queries its mapped physical provider through `usage:query:v1`. The separate `model-profiles-usage` footer item is cleared when the tier changes or its report expires. Queries may perform network requests. Without pi-usage there is no usage item. The installed pi-usage settings have no global status enable switch: its Anthropic status is gated by `anthropicExtraUsage`, and xAI is menu-only. The bridge respects these gates and Codex percentage/countdown preferences in `pi-usage.json`. Its compact formatter currently covers percentage buckets and Anthropic remaining spend; it does not reproduce pi-usage's full provider-specific formatting or custom `statuslineDisplay` templates.

## Known limitations and troubleshooting

- Another extension registering `tier/large`, `tier/medium`, or `tier/small`
  can replace these virtual models. The `/model-profile`, `/model-profiles`,
  `/tier` commands and shortcuts may also conflict with other extensions.
- If activation fails, check all three mappings exist in Pi's model registry and
  their providers are authenticated. Provider errors do not trigger fallback.
- Child agents spawned in an isolated worktree start with that worktree's
  directory entry; without one they use the global `defaultProfile`. A moved or
  re-cloned directory has a new key and falls back to `defaultProfile`.
- If shortcuts do not work, inspect `/hotkeys` and use the slash commands; some
  terminals cannot distinguish the required modifiers.
- Profile management requires Pi's interactive terminal UI. End-to-end paid
  inference and some interactive scenarios remain unverified; see
  [VERIFICATION.md](VERIFICATION.md).

## Development and verification

```sh
npm ci
npm test
npm run typecheck
```

Tests cover configuration validation/conflicts/malformed data, atomic CRUD
cancellation, routing and authentication errors, sticky continuations/retries,
branch restoration, commands, shortcuts, and stable selection identity.
Installed Pi-Bolt smoke checks confirm extension loading, `--model tier/medium`,
and all three aliases in `--list-models tier` without sending model requests.
See `VERIFICATION.md` for exact results and remaining manual checks.

## Publishing

`.github/workflows/publish.yml` tests and publishes the package to npm when a
GitHub Release is published. Configure npm Trusted Publishing once for
`@mevsgame/pi-model-alias-profiles` with GitHub Actions, owner `mevsgame`,
repository `pi-model-alias-profiles`, and workflow `publish.yml` (no environment).
No npm token secret is needed. Stable releases publish under `latest`; GitHub
prereleases publish under `next`.

For each release, update `version` in `package.json` and `package-lock.json`,
push the change and a matching `vX.Y.Z` tag, then publish a GitHub Release for
that tag. The workflow checks the tag/version match before publishing.

## License and links

MIT. [Source and issues](https://github.com/mevsgame/pi-model-alias-profiles).
