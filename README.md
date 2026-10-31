# opencode-goal-plugin

[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](./LICENSE)
[![OpenCode v2](https://img.shields.io/badge/OpenCode-v2-black)](https://opencode.ai)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)](https://www.typescriptlang.org)

Persistent **goal mode** for OpenCode v2. You describe a goal together with how to implement it and how to accept it;
the plugin keeps the session working until a **persistent independent reviewer** — a separate session the executor
cannot see or influence — actually passes the result.

English | [简体中文](./README.zh-CN.md)

## What it does

`/goal` turns a free-form request into two explicit sections — *implementation requirements* and *acceptance
requirements* — extracted by the model and confirmed by you in an editable dialog. Once activated, every time the goal
session stops, the plugin checks the stop, runs a review round, and either continues the work with the reviewer's feedback
or closes the goal as complete / impossible.

The executing model is never asked to judge its own work.

## Features

- **Two-part goal contract** — implementation + acceptance requirements, extracted by the LLM and confirmed before the
  goal starts.
- **Auto-continue loop** — on every stop of an activated goal, the plugin decides whether to continue, verify or stop.
- **Persistent independent reviewer** — one child session per goal, reused across all rounds, with its own context,
  agent and optional dedicated model; write-class permissions are denied.
- **Two-stage review** — a cheap delivery-note gate first (no tools), then a detailed workspace inspection only when the
  note claims completion or impossibility.
- **Impossibility adjudication** — an "impossible" claim is verified independently, not taken at face value.
- **False-stop suppression** — stops with too little output are treated as accidental and continued.
- **Progress reports** — periodic btw-style summaries generated transiently (they do not enter the context).
- **Guard rails** — consecutive verifier / prompt / execution failures auto-pause instead of spinning forever.
- **Restart recovery** — active goals are persisted and resumed; in-flight reviews are reattached.
- **Multi-instance safety** — storage is the source of truth; exactly one leader per location drives a goal.
- **TUI sidebar** — status, phase, requirements and latest progress, with collapsible sections and a scrollable dialog.

> The goal prompts and TUI strings are currently in Chinese.

## Requirements

- OpenCode v2 with plugin + TUI support. Built against `@opencode/plugin` 2.0.18 and tested with OpenCode 2.2.3.
- A subagent-capable agent for the reviewer (default: `general`).
- The `/goal` command needs the TUI plugin, which ships in this package and loads through the `./tui` export.

## Installation

### From GitHub

```bash
opencode plugin add github:itheamyvalgulious/opencode-goal-plugin
opencode reload
```

### With options

`opencode plugin add` writes a plain string entry. To pass options, use the object form in
`~/.config/opencode/opencode.json` instead — and do not keep both entries:

```jsonc
{
  "plugins": [
    {
      "package": "github:itheamyvalgulious/opencode-goal-plugin",
      "options": {
        "verify_model": "anthropic/claude-opus-4-6",
        "verify_agent": "general",
        "verify_timeout_minutes": 30
      }
    }
  ]
}
```

### From a local clone

```bash
git clone https://github.com/itheamyvalgulious/opencode-goal-plugin.git \
  ~/.config/opencode/plugins/opencode-goal-plugin
```

```jsonc
{
  "plugins": [
    {
      "package": "/home/you/.config/opencode/plugins/opencode-goal-plugin",
      "options": { "verify_model": "anthropic/claude-opus-4-6" }
    }
  ]
}
```

## Usage

| Command | Effect |
| --- | --- |
| `/goal <description>` | Extract implementation + acceptance requirements, show them for confirmation/editing, then activate the goal. The description should say **how** to implement and **how** to verify. |
| `/goal` | Show the current goal: status, stats, phase, requirements and latest progress. Long content opens in a scrollable dialog. |
| `/goal pause` | Pause the loop (`paused`). |
| `/goal resume` | Resume a paused goal (`activated`). |
| `/goal clear` | Delete the goal for this session. |

Goal status values: `activated`, `paused`, `complete`, `impossible`.

## The execution loop

While a goal is `activated`, the plugin reacts to every time the goal session settles (stops):

1. **False-stop check** — if the stop output has fewer than `min_text_chars` non-whitespace characters, it is treated as
   an accidental stop (e.g. high reasoning effort producing an empty turn) and the session is continued directly.
2. **Verification round** — otherwise the goal's persistent reviewer handles a two-stage round:
   - **Stage 1 — delivery-note gate.** The reviewer reads only the executor's last message (its delivery note) and uses
     no tools.
     - Note admits unfinished work / remaining issues / TODO → `FAIL` immediately; the note is sent back for more work
       **without** a detailed inspection.
     - Note claims the goal is impossible and gives reasons → stage 2 runs an **impossibility adjudication**.
     - Note claims completion → stage 2 runs a **detailed acceptance check**.
   - **Stage 2 — detailed inspection.** The reviewer reads the workspace and runs commands as needed, checking every
     implementation and acceptance item. It may reuse findings from earlier rounds, but any evidence that changed must be
     re-checked.
     - `VERDICT: PASS` → goal becomes `complete`.
     - `VERDICT: FAIL` → the verdict is fed back to the executor, which continues.
     - `VERDICT: IMPOSSIBLE` → goal becomes `impossible`.
3. **Impossibility rounds** — the reviewer independently confirms whether the constraints are real and whether a viable
   path exists. Only then may it answer `IMPOSSIBLE`; otherwise it answers `FAIL` and points at a viable direction, so the
   executor tries again instead of repeating "impossible".
4. **No verdict** — timeout, crash or malformed answer counts as a verifier failure and the session continues. After
   `max_verify_errors` consecutive failures the goal auto-pauses to avoid a loop.
5. **Progress reports** — every `progress_interval_minutes` the plugin generates a 200–300 character progress summary from
   the session context via a transient generation, which does not touch the conversation history.
6. **Restart recovery** — after a server restart or plugin reload, every activated goal is recovered. An in-flight review
   is reattached and its verdict consumed; a lost current step is re-sent in the same reviewer session.

### Reviewer independence

- The reviewer is an OpenCode child session of the goal session, created once per goal and **reused for every round**, so
  it keeps a continuous memory of the workspace instead of re-reading everything from scratch.
- It runs in its own session, its own context and its own agent; the executor never sees the review prompts and is never
  asked to self-check.
- Write-class tools (`write` / `edit` / `patch`) are denied: the reviewer inspects, it does not repair. The review prompt
  also forbids modifying the workspace.
- The model is **not** auto-selected: use `verify_model` if set, otherwise the main session's model. It is fixed when the
  reviewer session is created. Independence comes from the separate session/context and read-only permissions, not from
  switching models.

## Sidebar

The `sidebar.content` slot shows:

- goal status (`activated` / `paused` / `complete` / `impossible`) and statistics;
- current phase — working, gate, detailed review, impossibility adjudication — and the reviewer model;
- goal content (implementation + acceptance requirements), collapsed by default, click to expand;
- latest progress, expanded by default, click to collapse.

## Configuration

Options are passed through the plugin entry (`plugins[].options`):

| Option | Default | Description |
| --- | --- | --- |
| `verify_model` | same as main session | Reviewer model, `provider/model` or `provider/model#variant`. Empty → use the main session's model. |
| `verify_agent` | `general` | OpenCode agent used by the persistent reviewer session. |
| `verify_timeout_minutes` | `30` | Timeout for one review stage, in minutes. |
| `max_verify_errors` | `2` | Consecutive "no verdict" rounds before auto-pause. |
| `progress_interval_minutes` | `10` | Progress report interval, in minutes. |
| `min_text_chars` | `20` | Non-whitespace character threshold for the false-stop check. |
| `max_prompt_failures` | `3` | Consecutive prompt admission failures before auto-pause. |
| `max_exec_failures` | `3` | Consecutive execution failures before auto-pause. |
| `max_turns` | `0` (unlimited) | Auto-continuation limit; exceeding it auto-pauses the goal. |

## Persistence and multi-instance safety

- Goal state lives in plugin storage under `goals.v2` and is the single source of truth; all mutations are read-modify-
  write against storage.
- The host loads one plugin instance per location, and leaked instances of previous plugin generations can stay alive.
  Each location elects a leader through a storage heartbeat (3 s interval, 12 s stale): the newest generation takes over
  immediately, and a dead leader is replaced. Only the leader that owns the session drives the loop.
- RPC operations (`extract` / `activate` / `control`) work from any instance because they write straight to storage.
- Before a review starts, the phase is atomically set to `verifying` with the stage recorded, so concurrent settles or a
  plugin reload cannot start a duplicate round.
- The reviewer session id is persisted; recovery reattaches to it. `lastVerifyAt` prevents a repeated settle with no new
  output from triggering another review.

## Troubleshooting

- **`/goal` is not available** — the TUI plugin did not load. Check `opencode plugin list`, make sure the plugin entry is
  present, then `opencode reload`.
- **A goal seems stuck** — inspect `/tmp/opencode/goal-diag.log`; it records settle, prompt, persist, leadership and
  verdict events.
- **The reviewer cannot edit files** — intended: write-class permissions are denied so the reviewer cannot "fix" what it
  reviews.
- **Verification keeps failing** — the goal auto-pauses after `max_verify_errors`; fix the underlying problem (or the
  reviewer configuration) and run `/goal resume`.
- **Need a new goal** — `complete` and `impossible` are terminal; run `/goal clear` first.

## Files

| File | Role |
| --- | --- |
| `index.ts` | Server plugin: execution loop, persistent reviewer (gate + detail), progress scanner, restart recovery, RPC. |
| `tui.ts` | TUI plugin: `/goal` command (extract → confirm → activate), scrollable dialogs, sidebar, lifecycle toasts. |
| `rpc.ts` | Shared RPC contract (`extract` / `activate` / `control` / `state` + `updated` event). |
| `prompts.ts` | All LLM-facing prompt text. |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
```

There is no build step — the plugin host consumes the TypeScript sources directly. For local development, point the
plugin config at this directory and run `opencode reload`.

## License

GPL-3.0-only. See [LICENSE](./LICENSE).
