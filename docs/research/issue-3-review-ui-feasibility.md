# Issue #3: Review UI feasibility

Date: 2026-07-15

## Decision

The UI is feasible on both requested surfaces.

- **Pi:** implement a native TUI renderer with Pi's public extension and `pi-tui` component APIs. Keep the current `pi-review` child-process, parsing, and aggregation path.
- **Claude Code and Codex:** implement a loopback web dashboard. Claude Code and Codex desktop surfaces can open localhost directly; terminal hosts can open the same URL in the system browser.
- **Shared core:** introduce one versioned review-event protocol and one reducer/view model. The terminal text output, Pi TUI, and browser dashboard become renderers over the same state.

The current proposal in issue #3 should shift from “replace the Panel backend with `pi-subagents`” to “add native Pi and web renderers over the existing Panel backend.”

## Evidence

### Pi provides the required public UI seams

Pi custom tools receive a streaming `onUpdate` callback and may define `renderCall` and `renderResult` functions that return `Component` objects. Pi also exposes widgets, overlays, and custom components through the extension UI context.

- [Pi extension API: custom tool rendering](https://github.com/earendil-works/pi/blob/dcfe36c79702ec240b146c45f167ab75ecddd205/packages/coding-agent/docs/extensions.md#custom-rendering)
- [Pi TUI component API](https://github.com/earendil-works/pi/blob/dcfe36c79702ec240b146c45f167ab75ecddd205/packages/coding-agent/docs/tui.md)
- [Pi extension types: `ToolDefinition`, `onUpdate`, `renderCall`, and `renderResult`](https://github.com/earendil-works/pi/blob/dcfe36c79702ec240b146c45f167ab75ecddd205/packages/coding-agent/src/core/extensions/types.ts#L437-L485)

Pi's official subagent example already implements the interaction shape required by issue #3:

1. Spawn separate `pi --mode json -p --no-session` processes.
2. Parse their JSON event streams.
3. Run tasks with bounded concurrency.
4. Publish partial `details` through `onUpdate`.
5. Render parallel progress and expanded results with `renderResult`.

Source: [Pi official subagent example](https://github.com/earendil-works/pi/blob/dcfe36c79702ec240b146c45f167ab75ecddd205/packages/coding-agent/examples/extensions/subagent/index.ts#L275-L365) and its [parallel execution/rendering path](https://github.com/earendil-works/pi/blob/dcfe36c79702ec240b146c45f167ab75ecddd205/packages/coding-agent/examples/extensions/subagent/index.ts#L612-L815).

This matches `pi-review`'s current execution model closely. The installed environment used for this research runs Pi `0.80.6`; npm published `0.80.7` during the research snapshot. The cited upstream commit is `dcfe36c79702ec240b146c45f167ab75ecddd205` from 2026-07-14.

### `pi-subagents` is a useful reference and optional adapter

`pi-subagents` builds its live display with Pi's public tool-rendering APIs. Its versioned RPC can launch and inspect subagents, and its machine-readable artifacts include `status.json` and `events.jsonl`. The RPC `spawn` method is async-only, and its renderer is an internal module. Those properties make direct execution replacement more coupled than a native `pi-review` renderer.

The bundled `pi-subagents` reviewer currently declares `bash`, `edit`, and `write`. A direct adapter would therefore need an explicit hardened reviewer profile before it could satisfy `pi-review`'s review-only contract.

- [`pi-subagents` lifecycle artifacts and RPC v1](https://github.com/nicobailon/pi-subagents/blob/e0c3be91628feb99cdd5824b35503a7d428bcba8/README.md#where-running-subagents-show-up)
- [`pi-subagents` tool rendering implementation](https://github.com/nicobailon/pi-subagents/blob/e0c3be91628feb99cdd5824b35503a7d428bcba8/src/extension/index.ts#L446-L488)

`pi-subagents` remains valuable as:

- a reference for compact/expanded progress UI;
- an optional future integration for users who explicitly want its scheduling, background fleet, or nested-run features;
- a compatibility test target for the normalized event protocol.

### Claude Code can render localhost

Claude Code supports two suitable local browser surfaces:

- Claude Code Desktop opens a running application in its Browser pane, manages preview server commands, and supports DOM inspection and screenshots.
- Claude Code CLI and VS Code can use Claude in Chrome to open and test localhost routes.

Sources: [Claude Code Desktop preview](https://code.claude.com/docs/en/desktop#preview-your-app) and [Claude Code with Chrome](https://code.claude.com/docs/en/chrome#test-a-local-web-application).

### Codex can render localhost

The ChatGPT desktop app's built-in browser opens local web apps and supports inspection and interaction. Codex CLI and the Codex IDE extension use an external/system browser for this dashboard. The local dashboard therefore works across Codex surfaces, with richer in-app behavior in the desktop app.

Source: [OpenAI Browser documentation](https://learn.chatgpt.com/docs/browser#preview-a-page).

Codex App Server provides a deeper JSON-RPC integration for products that embed the Codex agent itself. The proposed dashboard displays `pi-review` events, so the localhost dashboard keeps the integration smaller and host-neutral. App Server remains a future option for a dedicated Codex client.

Source: [Codex App Server](https://learn.chatgpt.com/docs/app-server).

## Current repository seams

The repository already has most of the non-visual architecture:

- [`src/panel.ts`](../../src/panel.ts) runs isolated reviewer children with bounded concurrency and feeds each child through `JsonEventStream`.
- [`src/json-events.ts`](../../src/json-events.ts) parses Pi JSONL, emits text/milestone callbacks, and accumulates token usage.
- [`src/panel-aggregate.ts`](../../src/panel-aggregate.ts) is the pure aggregation seam for confirmed/advisory findings and panel health.
- [`src/meta-footer.ts`](../../src/meta-footer.ts) formats the final human and machine results.
- [`extensions/review.ts`](../../extensions/review.ts) already owns `/rv`, model discovery, argument completion, and Pi-host orchestration.

The main missing seam is a structured, versioned event callback. `JsonEventStream` currently turns rich events into human strings such as `pi-review: tool read started`. UI renderers need structured state such as reviewer id, lifecycle state, active tool, usage, elapsed time, partial text, and final structured result.

Two current implementation details also become acceptance-critical once a UI adds cancel controls and stronger security claims:

- `readOnlyTools()` removes named mutation tools while preserving `bash`. The current shell boundary is prompt-governed. A hard review-only contract needs a strict tool allowlist or a sandboxed read-only shell.
- `spawnStreamingChild()` has no AbortSignal input or process-tree termination path. Cancellation must reach every reviewer and the adjudicator before a UI exposes a cancel action.

## Recommended architecture

```text
reviewer Pi processes
        │ Pi JSONL
        ▼
JsonEventStream / normalizer
        │ ReviewEvent v1
        ├──────────────► JSONL artifact / replay
        ▼
PanelState reducer
        ├──────────────► existing CLI text renderer
        ├──────────────► Pi TUI renderer
        └──────────────► localhost SSE web renderer

reviewer submissions ─► aggregatePanel() ─► PanelReviewMeta
                                      └────► final event for every renderer
```

### 1. Versioned event protocol

Add a discriminated union such as:

```ts
type ReviewEvent =
  | { v: 1; seq: number; runId: string; type: "panel.started"; reviewers: ReviewerIdentity[] }
  | { v: 1; seq: number; runId: string; type: "reviewer.started"; reviewerId: string }
  | { v: 1; seq: number; runId: string; type: "reviewer.tool.started"; reviewerId: string; tool: string; summary?: string }
  | { v: 1; seq: number; runId: string; type: "reviewer.tool.finished"; reviewerId: string; tool: string }
  | { v: 1; seq: number; runId: string; type: "reviewer.text.delta"; reviewerId: string; text: string }
  | { v: 1; seq: number; runId: string; type: "reviewer.usage"; reviewerId: string; usage: TokenUsage }
  | { v: 1; seq: number; runId: string; type: "reviewer.completed"; reviewerId: string; submission: ReviewerSubmission }
  | { v: 1; seq: number; runId: string; type: "aggregation.started" }
  | { v: 1; seq: number; runId: string; type: "panel.completed"; meta: PanelReviewMeta };
```

Required protocol properties:

- monotonically increasing `seq` for deterministic replay;
- additive event evolution within major version `v`;
- unknown event tolerance;
- stable reviewer identity and role;
- final `PanelReviewMeta` identical to the CLI machine contract;
- explicit redaction/truncation rules for tool arguments and text deltas.

Expose the protocol in two ways:

- an internal `onEvent?: (event: ReviewEvent) => void` callback for library callers;
- an opt-in CLI JSONL stream for subprocess adapters and replay.

### 2. Shared reducer/view model

Implement a pure `reducePanelEvent(state, event)` function. Renderers consume `PanelViewState` and remain free of process and aggregation logic.

Suggested state per reviewer:

- `queued | running | completed | failed | blocked`;
- model, thinking level, and role;
- active tool and activity age;
- turns, tokens, cost, and duration;
- bounded recent output;
- final verdict, status, and findings.

Suggested aggregate state:

- completed/running/total count;
- aggregation phase;
- panel health and final status;
- confirmed findings with provenance;
- advisory findings;
- total usage and duration.

### 3. Pi TUI renderer

Register a dedicated `pi_review` custom tool in the existing extension.

- `execute` launches `pi-review` in its machine-event mode and maps events to partial tool `details` through `onUpdate`.
- `renderCall` shows the mode, target, reviewer count, and panel preset.
- `renderResult` uses `Container`, `Text`, `Markdown`, and `Spacer` from `@earendil-works/pi-tui`.
- Collapsed mode shows one line per reviewer: state, active tool, elapsed time, and token count.
- Expanded mode (`Ctrl+O`) shows bounded recent activity, reviewer result summaries, confirmed findings, advisories, provenance, and aggregate usage.
- Abort signals propagate to the CLI process and its child reviewers.
- `/rv` instructs the parent Pi agent to call `pi_review` directly for review runs.

The runtime component dependency should be declared explicitly as an optional peer dependency and as a development dependency for extension tests.

### 4. Local web renderer

Add an opt-in dashboard command or flag, for example:

```bash
pi-review --ui web --panel code-experts -- @src
```

Expected behavior:

1. Start a loopback-only dashboard service on an ephemeral port.
2. Print one machine-detectable URL line.
3. Open the URL when `--open` is set or let the host open it.
4. Stream `ReviewEvent v1` through Server-Sent Events.
5. Persist the same normalized JSONL for reconnect and replay.
6. Keep the completed result available for a bounded TTL, then stop the idle service and remove transient state according to retention settings.

The launcher must deliver the URL before the long-running review begins. Support a URL file or equivalent side channel for agent hosts that buffer shell stdout.

SSE fits the read-mostly v1 dashboard. A small authenticated `POST /cancel` endpoint can cover cancellation. WebSocket becomes useful when later versions add bidirectional steering.

Recommended browser layout:

- header: target, mode, overall status, elapsed time, total tokens;
- reviewer cards: role/model, state, current tool, activity tail, usage;
- result pane: confirmed findings first, advisories second, provenance on each finding;
- run history/replay: optional after the live view is stable.

### 5. Host behavior

| Host | Rendering path | Launch behavior |
|---|---|---|
| Pi interactive | Native Pi TUI | `/rv` calls the `pi_review` tool |
| Claude Code Desktop | Browser pane | start dashboard, open localhost |
| Claude Code CLI / VS Code | Claude in Chrome or system browser | start dashboard, print/open localhost URL |
| ChatGPT desktop Codex | Built-in browser | start dashboard, open localhost |
| Codex CLI / IDE | System browser | start dashboard, print/open localhost URL |
| CI / scripts | Existing text + JSON | default headless behavior |

## Security and privacy boundaries

The dashboard may contain source paths, tool arguments, model output, and findings. Use these defaults:

- bind only to `127.0.0.1` and `::1`;
- use a per-run high-entropy capability token and strict host/origin validation;
- serve all assets locally with a restrictive Content Security Policy;
- disable CORS and remote asset loading;
- render model text as escaped text or sanitized Markdown;
- redact secrets and cap tool argument/output sizes before events reach any renderer;
- keep write controls outside v1, except an authenticated cancel action;
- define explicit artifact retention and a cleanup command;
- preserve reviewer process isolation and read-only tool allowlists.
- treat browser disconnects as presentation events; the review continues and the CLI metadata, exit code, and result artifact remain authoritative.

## Options considered

| Option | Fit | Main trade-off |
|---|---|---|
| Replace Panel execution with `pi-subagents` | Medium | Fast Pi-only demo; async RPC, external dependency, and aggregation handoff add coupling |
| Add a Pi custom renderer over current Panel execution | High | Small Pi-specific adapter; exact current review and aggregation semantics |
| Add a localhost web renderer over current Panel execution | High | Cross-host UI; adds loopback service lifecycle and browser security work |
| Draw a multi-line TUI directly from the standalone CLI | Low | Terminal ownership, buffering, and concurrent output increase complexity |
| Build a dedicated Codex App Server client | Low for issue #3 | Deep Codex integration with a much larger product surface |

## Delivery plan

### Phase 1: event contract

- Add `ReviewEvent v1`, `PanelViewState`, and the pure reducer.
- Emit reviewer lifecycle/tool/usage/result events from the existing spawn path.
- Add opt-in normalized JSONL output and replay fixtures.
- Keep current stdout, stderr, footer, metadata, and exit-code contracts stable.

### Phase 2: Pi TUI

- Register `pi_review` in `extensions/review.ts` or a focused sibling module.
- Implement collapsed and expanded components using public Pi APIs.
- Route `/rv` review execution to the custom tool.
- Test partial updates, abort propagation, narrow terminals, and final rendering.

### Phase 3: localhost dashboard

- Add the loopback service, SSE endpoint, static assets, capability token, and idle shutdown.
- Implement live reviewer cards and final aggregate findings.
- Verify with Claude Code Desktop/Chrome and ChatGPT desktop Codex browser.

### Phase 4: optional integrations

- Add replay/run history.
- Evaluate a `pi-subagents` adapter for background fleet orchestration.
- Evaluate deeper host integrations only when the shared dashboard leaves a concrete workflow gap.

## Verification strategy

- **Protocol tests:** fixed Pi JSONL fixtures produce exact normalized events.
- **Reducer tests:** out-of-order, repeated, unknown, partial, failed, and completed events produce deterministic state.
- **Panel regression tests:** existing aggregate, matcher, exit-code, and machine-meta tests remain unchanged.
- **Read-only tests:** reviewer tool resolution rejects mutation-capable tools, including unrestricted shell execution.
- **Cancellation tests:** AbortSignal stops the full reviewer/adjudicator process tree and produces a stable blocked/cancelled terminal event.
- **Pi renderer tests:** assert observable rendered text for collapsed/expanded/partial/final states and terminal widths.
- **Web tests:** SSE replay, reconnect with `Last-Event-ID`, capability-token rejection, origin/host checks, CSP, XSS fixtures, cancel, and idle cleanup.
- **Process test:** fake reviewers drive both Pi and web adapters from the same event fixture and end with the same `PanelReviewMeta`.

## Recommended issue #3 scope

Issue #3 should cover Phase 1 and Phase 2. The browser dashboard should become a linked follow-up issue because it introduces an independent server lifecycle, web security boundary, and cross-host acceptance matrix.

Recommended issue #3 acceptance criteria:

1. Pi displays all reviewers concurrently through a native custom tool renderer.
2. Each row shows queued/running/completed/failed state, current tool, duration, and usage.
3. Expanded output shows reviewer summaries and final aggregate findings/provenance.
4. Pi and CLI execution share the same child-process and aggregation implementation.
5. The final `PanelReviewMeta`, exit code, read-only tools, and reviewer isolation remain identical across renderers.
6. The extension uses public Pi APIs and carries no runtime dependency on `pi-subagents`.
7. Reviewer execution enforces a hard read-only boundary, including shell commands.
8. Abort propagates through the CLI wrapper to every child process and produces one deterministic final event.

This scope is ready for an implementation brief after the event names, redaction policy, and browser follow-up boundary are accepted.
