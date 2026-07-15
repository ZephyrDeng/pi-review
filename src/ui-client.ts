// Browser renderer for the loopback dashboard (issue #4). Loaded as a plain
// ES module; resolves its sibling reducer and events endpoint relative to its
// own script URL so the page needs no server-injected config. All dynamic
// content is written through textContent (markdown goes through the safe DOM
// writer in ui-markdown.ts), never innerHTML.

import { createPanelViewState, reducePanelEvent } from "./panel-view.js";
import type { PanelReviewerView, PanelViewState, ReviewerViewStatus } from "./panel-view.js";
import type { ReviewEvent } from "./review-events.js";
import type { FindingCluster, TokenUsage } from "./types.js";
import { renderInlineMarkdownInto, renderMarkdownInto } from "./ui-markdown.js";

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "–";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function formatUsage(usage: TokenUsage | undefined): string {
  if (!usage) return "– tokens";
  return `${usage.totalTokens.toLocaleString("en-US")} tokens`;
}

/** Compact token counter: 950 → "950", 12_345 → "12.3K", 1_234_567 → "1.23M". */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}K`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(2)}M`;
}

export function statusClass(status: ReviewerViewStatus): string {
  return `status status-${status}`;
}

/** Pure header summary line; kept separate from DOM writes so it is unit-testable. */
export function headerSummary(state: PanelViewState, now: number): string {
  const elapsed = state.startedAt !== undefined ? formatDuration((state.completedAt ?? now) - state.startedAt) : "–";
  const parts = [
    state.mode,
    state.phase,
    `${state.aggregate.completed}/${state.aggregate.total} completed`,
    elapsed,
    formatUsage(state.aggregate.usage),
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

export function headerTitle(state: PanelViewState): string {
  return state.target ? `pi-review panel — ${state.target}` : "pi-review panel";
}

/** Pure reviewer detail line; excludes recent activity, which renders as its own block. */
export function reviewerDetailLine(reviewer: PanelReviewerView, now: number): string {
  const durationMs = reviewer.startedAt !== undefined ? (reviewer.completedAt ?? now) - reviewer.startedAt : undefined;
  const activityAgeMs = reviewer.status === "running" && reviewer.activityAt !== undefined ? now - reviewer.activityAt : undefined;
  return [
    reviewer.model ?? "default model",
    reviewer.thinking,
    reviewer.activeTool ? `tool: ${reviewer.activeTool}` : undefined,
    durationMs !== undefined ? formatDuration(durationMs) : undefined,
    formatUsage(reviewer.usage),
    activityAgeMs !== undefined ? `active ${formatDuration(activityAgeMs)} ago` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

export function findingDetailLine(cluster: FindingCluster): string {
  const support = cluster.supportingReviewerIds.length > 0
    ? `${cluster.supportCount} reviewer(s): ${cluster.supportingReviewerIds.join(", ")}`
    : `${cluster.supportCount} reviewer(s)`;
  return [cluster.severity, cluster.path, support].filter((part): part is string => Boolean(part)).join(" · ");
}

export function resultsSummary(meta: PanelViewState["meta"]): string {
  if (!meta) return "";
  return `Result: ${meta.status} (${meta.panelHealth})`;
}

// ---------------------------------------------------------------------------
// Client-only derived state: counters the shared reducer does not track.
// ---------------------------------------------------------------------------

export interface ClientExtras {
  /** reviewer.tool.started count per reviewer. */
  toolCalls: Record<string, number>;
  /** Full accumulated review prose per reviewer (the reducer keeps only a rolling window). */
  fullText: Record<string, string>;
}

export function createClientExtras(): ClientExtras {
  return { toolCalls: {}, fullText: {} };
}

export function reduceClientExtras(extras: ClientExtras, event: ReviewEvent): ClientExtras {
  if (event.type === "reviewer.tool.started") {
    return {
      ...extras,
      toolCalls: { ...extras.toolCalls, [event.reviewerId]: (extras.toolCalls[event.reviewerId] ?? 0) + 1 },
    };
  }
  if (event.type === "reviewer.text.delta") {
    return {
      ...extras,
      fullText: { ...extras.fullText, [event.reviewerId]: (extras.fullText[event.reviewerId] ?? "") + event.text },
    };
  }
  return extras;
}

export function totalToolCalls(extras: ClientExtras): number {
  return Object.values(extras.toolCalls).reduce((sum, n) => sum + n, 0);
}

export type ConnectionState = "connecting" | "live" | "reconnecting";

export interface Headline {
  text: string;
  tone: "" | "ok" | "danger";
}

/** The big masthead word: run phase while working, gate status once completed. */
export function statusHeadline(state: PanelViewState, connection: ConnectionState): Headline {
  if (state.phase === "completed" && state.meta) {
    switch (state.meta.status) {
      case "clean":
        return { text: "Clean", tone: "ok" };
      case "has_findings":
        return { text: "Has findings", tone: "danger" };
      case "needs_human":
        return { text: "Needs human", tone: "danger" };
      default:
        return { text: "Blocked", tone: "danger" };
    }
  }
  if (state.phase === "aggregating") return { text: "Aggregating", tone: "" };
  if (state.phase === "running") return { text: "Reviewing", tone: "" };
  return { text: connection === "connecting" ? "Connecting" : "Waiting for run", tone: "" };
}

const CHIP_LABELS: Record<ReviewerViewStatus, string> = {
  queued: "queued",
  running: "running",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
};

function severityChipClass(severity: string | undefined): string {
  const s = (severity ?? "").toLowerCase();
  if (s === "critical" || s === "high") return "chip chip-failed";
  if (s === "medium") return "chip chip-warn";
  return "chip chip-neutral";
}

// ---------------------------------------------------------------------------
// DOM glue — only executed inside a real browser.
// ---------------------------------------------------------------------------

const COUNTDOWN_SECONDS = 60;
const TWEEN_MS = 600;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  return node;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/** Animated numeric text: rAF count-up toward the latest target, formatted per frame. */
class NumberTicker {
  private shown = 0;
  private target = 0;
  private from = 0;
  private startedAt = 0;
  private raf: number | undefined;

  constructor(
    private readonly node: HTMLElement,
    private readonly fmt: (n: number) => string,
  ) {
    this.node.textContent = this.fmt(0);
  }

  set(target: number): void {
    if (target === this.target) return;
    this.target = target;
    if (prefersReducedMotion()) {
      this.shown = target;
      this.node.textContent = this.fmt(target);
      return;
    }
    this.from = this.shown;
    this.startedAt = performance.now();
    if (this.raf === undefined) this.raf = requestAnimationFrame(this.step);
  }

  private readonly step = (now: number): void => {
    const t = Math.min(1, (now - this.startedAt) / TWEEN_MS);
    this.shown = this.from + (this.target - this.from) * easeOutExpo(t);
    this.node.textContent = this.fmt(this.shown);
    this.raf = t < 1 ? requestAnimationFrame(this.step) : undefined;
    if (this.raf === undefined) {
      this.shown = this.target;
      this.node.textContent = this.fmt(this.target);
    }
  };
}

interface StatRefs {
  reviewers: HTMLElement;
  elapsed: HTMLElement;
  tokens: NumberTicker;
  tools: NumberTicker;
}

interface CardRefs {
  root: HTMLElement;
  chip: HTMLElement;
  chipLabel: Text;
  role: HTMLElement;
  model: HTMLElement;
  duration: HTMLElement;
  tokens: NumberTicker;
  tools: NumberTicker;
  turn: HTMLElement;
  tool: HTMLElement;
  log: HTMLElement;
  error: HTMLElement;
  verdict: HTMLElement;
  lastStatus?: ReviewerViewStatus;
}

function buildStat(label: string): { wrap: HTMLElement; value: HTMLElement } {
  const wrap = el("div", { className: "stat" });
  const value = el("div", { className: "stat-value", text: "–" });
  wrap.append(value, el("div", { className: "stat-label", text: label }));
  return { wrap, value };
}

function buildStatStrip(container: HTMLElement): StatRefs {
  const reviewers = buildStat("Reviewers");
  const elapsed = buildStat("Elapsed");
  const tokens = buildStat("Tokens");
  const tools = buildStat("Tool calls");
  container.replaceChildren(reviewers.wrap, elapsed.wrap, tokens.wrap, tools.wrap);
  return {
    reviewers: reviewers.value,
    elapsed: elapsed.value,
    tokens: new NumberTicker(tokens.value, formatCompact),
    tools: new NumberTicker(tools.value, (n) => String(Math.round(n))),
  };
}

function buildCard(reviewer: PanelReviewerView): CardRefs {
  const root = el("article", { className: "card" });

  const head = el("div", { className: "card-head" });
  const id = el("div", { className: "card-id" });
  const role = el("h2", { className: "card-role", text: reviewer.role });
  const model = el("div", { className: "card-model" });
  id.append(role, model);
  const chip = el("span", { className: "chip chip-queued" });
  const chipDot = el("span", { className: "chip-dot" });
  const chipLabel = document.createTextNode(CHIP_LABELS.queued);
  chip.append(chipDot, chipLabel);
  head.append(id, chip);

  const stats = el("div", { className: "card-stats" });
  const duration = el("span", { text: "–" });
  const tokensNode = el("span");
  const toolsNode = el("span");
  const turn = el("span", { className: "dim" });
  stats.append(duration, tokensNode, toolsNode, turn);

  const tool = el("div", { className: "card-tool" });
  const log = el("pre", { className: "card-log" });
  const error = el("div", { className: "card-error" });
  error.hidden = true;
  const verdict = el("div", { className: "card-verdict" });
  verdict.hidden = true;

  root.append(head, stats, tool, log, error, verdict);

  const tokensValue = el("span");
  tokensNode.append(tokensValue, document.createTextNode(" tok"));
  const toolsValue = el("span");
  toolsNode.append(toolsValue, document.createTextNode(" tools"));

  return {
    root,
    chip,
    chipLabel,
    role,
    model,
    duration,
    tokens: new NumberTicker(tokensValue, formatCompact),
    tools: new NumberTicker(toolsValue, (n) => String(Math.round(n))),
    turn,
    tool,
    log,
    error,
    verdict,
  };
}

function updateCard(refs: CardRefs, reviewer: PanelReviewerView, toolCalls: number, now: number): void {
  refs.role.textContent = reviewer.role;
  refs.model.textContent = [reviewer.model ?? "default model", reviewer.thinking]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  if (refs.lastStatus !== reviewer.status) {
    refs.lastStatus = reviewer.status;
    refs.chip.className = `chip chip-${reviewer.status}`;
    refs.chipLabel.textContent = CHIP_LABELS[reviewer.status];
    refs.root.classList.toggle("is-running", reviewer.status === "running");
    refs.root.classList.toggle("is-done", reviewer.status === "completed");
  }

  const durationMs = reviewer.startedAt !== undefined ? (reviewer.completedAt ?? now) - reviewer.startedAt : undefined;
  refs.duration.textContent = durationMs !== undefined ? formatDuration(durationMs) : "–";
  refs.tokens.set(reviewer.usage?.totalTokens ?? 0);
  refs.tools.set(toolCalls);
  refs.turn.textContent = reviewer.turns > 0 ? `turn ${reviewer.turns}` : "";

  const toolText = reviewer.activeTool
    ? `${reviewer.activeTool}${reviewer.activeToolSummary ? `: ${reviewer.activeToolSummary}` : ""}`
    : "";
  refs.tool.textContent = toolText;
  refs.tool.classList.toggle("has-tool", toolText.length > 0);

  const logText =
    reviewer.recentActivity.length > 0
      ? reviewer.recentActivity.join("\n")
      : reviewer.status === "queued"
        ? "waiting to start…"
        : reviewer.status === "running"
          ? "working…"
          : "";
  if (refs.log.textContent !== logText) refs.log.textContent = logText;

  refs.error.hidden = !reviewer.error;
  if (reviewer.error) refs.error.textContent = reviewer.error;

  if (reviewer.status === "completed" && reviewer.submission && refs.verdict.hidden) {
    refs.verdict.hidden = false;
    const verdict = reviewer.submission.result.verdict;
    const chip = el("span", {
      className: verdict === "approve" ? "chip chip-completed" : "chip chip-warn",
      text: verdict.replace(/_/g, " "),
    });
    const findings = reviewer.submission.result.findings.length;
    const actionable = reviewer.submission.result.actionableCount;
    refs.verdict.replaceChildren(chip, el("span", { text: `${findings} findings · ${actionable} actionable` }));
  }
}

function renderFindingCluster(cluster: FindingCluster, advisory: boolean): HTMLElement {
  const wrapper = el("div", { className: advisory ? "finding advisory" : "finding" });
  const head = el("div", { className: "finding-head" });
  head.append(el("span", { className: severityChipClass(cluster.severity), text: cluster.severity ?? "advisory" }));
  if (cluster.path) head.append(el("span", { className: "finding-path", text: cluster.path }));
  const summary = el("div", { className: "finding-summary" });
  renderInlineMarkdownInto(summary, cluster.summary);
  const support = el("div", {
    className: "finding-support",
    text:
      cluster.supportingReviewerIds.length > 0
        ? `${cluster.supportCount} reviewer(s): ${cluster.supportingReviewerIds.join(", ")}`
        : `${cluster.supportCount} reviewer(s)`,
  });
  wrapper.append(head, summary, support);
  return wrapper;
}

function renderResults(state: PanelViewState, extras: ClientExtras): void {
  const results = document.getElementById("results");
  const meta = state.meta;
  if (!results || !meta) return;

  results.replaceChildren();

  const clean = meta.status === "clean";
  const gate = el("div", { className: clean ? "gate gate-clean" : "gate gate-findings" });
  // The masthead already carries the gate word; the banner adds the count.
  const confirmedCount = meta.confirmedClusters.length;
  const gateText = clean
    ? "No confirmed findings"
    : `${confirmedCount} confirmed finding${confirmedCount === 1 ? "" : "s"}`;
  gate.append(el("div", { className: "gate-status", text: gateText }));
  const subParts = [
    meta.panelHealth,
    `${meta.confirmedClusters.length} confirmed`,
    `${meta.advisories.length} advisories`,
    state.startedAt !== undefined && state.completedAt !== undefined
      ? formatDuration(state.completedAt - state.startedAt)
      : undefined,
    meta.usage ? `${formatCompact(meta.usage.totalTokens)} tokens` : undefined,
  ].filter((part): part is string => Boolean(part));
  gate.append(el("div", { className: "gate-sub", text: subParts.join(" · ") }));
  results.append(gate);

  if (meta.confirmedClusters.length > 0) {
    const heading = el("h2", { className: "results-heading", text: "Confirmed findings " });
    heading.append(el("span", { className: "count", text: String(meta.confirmedClusters.length) }));
    results.append(heading, ...meta.confirmedClusters.map((cluster) => renderFindingCluster(cluster, false)));
  }
  if (meta.advisories.length > 0) {
    const heading = el("h2", { className: "results-heading", text: "Advisories " });
    heading.append(el("span", { className: "count", text: String(meta.advisories.length) }));
    results.append(heading, ...meta.advisories.map((cluster) => renderFindingCluster(cluster, true)));
  }

  const reports = Object.values(state.reviewers).filter((reviewer) => (extras.fullText[reviewer.reviewerId] ?? "").trim().length > 0);
  if (reports.length > 0) {
    results.append(el("h2", { className: "results-heading", text: "Reviewer reports" }));
    for (const reviewer of reports) {
      const details = el("details", { className: "review-full" });
      const summary = el("summary");
      summary.append(
        el("span", { text: reviewer.role }),
        el("span", { className: "finding-path", text: reviewer.model ?? "" }),
      );
      const prose = el("div", { className: "prose" });
      renderMarkdownInto(prose, extras.fullText[reviewer.reviewerId]!);
      details.append(summary, prose);
      results.append(details);
    }
  }
}

// ---------------------------------------------------------------------------
// Countdown closer: shutdown + close once the run completes.
// ---------------------------------------------------------------------------

const RING_CIRCUMFERENCE = 2 * Math.PI * 10.5;

class Closer {
  private cancelled = false;
  private started = false;
  private deadline = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly root = document.getElementById("closer");
  private readonly text = document.getElementById("closer-text");
  private readonly ring = this.root?.querySelector<SVGCircleElement>(".ring-fill") ?? null;

  constructor(private readonly shutdownUrl: string) {
    const keep = document.getElementById("closer-keep");
    keep?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.cancel();
    });
  }

  start(): void {
    if (this.started || !this.root || !this.text) return;
    this.started = true;
    this.deadline = performance.now() + COUNTDOWN_SECONDS * 1000;
    this.root.classList.add("is-visible");
    if (this.ring) {
      this.ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);
    }
    const onInteract = (): void => this.cancel();
    for (const type of ["pointerdown", "keydown", "wheel", "touchstart"] as const) {
      window.addEventListener(type, onInteract, { once: true, passive: true });
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), 200);
  }

  private tick(): void {
    if (this.cancelled || !this.text) return;
    const remainingMs = this.deadline - performance.now();
    if (remainingMs <= 0) {
      this.finish();
      return;
    }
    const seconds = Math.ceil(remainingMs / 1000);
    this.text.replaceChildren(
      document.createTextNode("Review complete · closing in "),
      el("span", { className: "num", text: `${seconds}s` }),
    );
    if (this.ring) {
      this.ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - remainingMs / (COUNTDOWN_SECONDS * 1000)));
    }
  }

  cancel(): void {
    if (this.cancelled || !this.started) return;
    this.cancelled = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.text) this.text.textContent = "Staying open · you can close this tab any time";
    const root = this.root;
    if (root) {
      root.querySelector("#closer-ring")?.remove();
      root.querySelector("#closer-keep")?.remove();
      setTimeout(() => root.classList.remove("is-visible"), 4000);
    }
  }

  requestShutdown(): void {
    try {
      if (typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(this.shutdownUrl);
        return;
      }
    } catch {
      /* fall through to fetch */
    }
    void fetch(this.shutdownUrl, { method: "POST", keepalive: true }).catch(() => {});
  }

  private finish(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.requestShutdown();
    setTimeout(() => {
      window.close();
      // window.close() is a no-op when the browser refuses (e.g. user navigated);
      // fall back to an honest final message.
      setTimeout(() => {
        if (this.text) this.text.textContent = "Server stopped · you can close this tab";
        this.root?.querySelector("#closer-ring")?.remove();
        this.root?.querySelector("#closer-keep")?.remove();
      }, 400);
    }, 120);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function bootstrap(): void {
  let state = createPanelViewState();
  let extras = createClientExtras();
  let connection: ConnectionState = "connecting";

  const runTitle = document.getElementById("run-title");
  const runTarget = document.getElementById("run-target");
  const runMeta = document.getElementById("run-meta");
  const reviewersRoot = document.getElementById("reviewers");
  const stats = runMeta ? buildStatStrip(runMeta) : undefined;
  const cards = new Map<string, CardRefs>();

  const eventsUrl = new URL("../events", import.meta.url).toString();
  const shutdownUrl = new URL("../shutdown", import.meta.url).toString();
  const closer = new Closer(shutdownUrl);
  let resultsRendered = false;

  const waiting = el("div", { className: "waiting" });
  waiting.append(document.createTextNode("Waiting for reviewers"));
  const ellipsis = el("span", { className: "ellipsis" });
  ellipsis.append(el("span", { text: "." }), el("span", { text: "." }), el("span", { text: "." }));
  waiting.append(ellipsis);
  reviewersRoot?.append(waiting);

  const render = (): void => {
    const now = Date.now();
    document.title = headerTitle(state);

    if (runTitle) {
      const headline = statusHeadline(state, connection);
      if (runTitle.textContent !== headline.text) runTitle.textContent = headline.text;
      runTitle.className = headline.tone ? `tone-${headline.tone}` : "";
    }
    if (runTarget && state.target && runTarget.textContent !== state.target) runTarget.textContent = state.target;

    if (stats) {
      stats.reviewers.textContent = state.aggregate.total > 0 ? `${state.aggregate.completed}/${state.aggregate.total}` : "–";
      stats.elapsed.textContent =
        state.startedAt !== undefined ? formatDuration((state.completedAt ?? now) - state.startedAt) : "–";
      stats.tokens.set(state.aggregate.usage?.totalTokens ?? 0);
      stats.tools.set(totalToolCalls(extras));
    }

    const reviewers = Object.values(state.reviewers);
    if (reviewers.length > 0 && waiting.isConnected) waiting.remove();
    for (const reviewer of reviewers) {
      let refs = cards.get(reviewer.reviewerId);
      if (!refs) {
        refs = buildCard(reviewer);
        cards.set(reviewer.reviewerId, refs);
        reviewersRoot?.append(refs.root);
      }
      updateCard(refs, reviewer, extras.toolCalls[reviewer.reviewerId] ?? 0, now);
    }

    if (state.phase === "completed" && state.meta && !resultsRendered) {
      resultsRendered = true;
      renderResults(state, extras);
      closer.start();
    }
  };

  // Wall-clock tick keeps elapsed/durations moving between SSE events.
  setInterval(() => {
    if (state.phase === "running" || state.phase === "aggregating") render();
  }, 1000);

  const source = new EventSource(eventsUrl);
  source.onopen = () => {
    connection = "live";
    document.body.classList.add("is-live");
    document.body.classList.remove("is-reconnecting");
    render();
  };
  source.onmessage = (message) => {
    let event: ReviewEvent;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    state = reducePanelEvent(state, event);
    extras = reduceClientExtras(extras, event);
    render();
  };
  source.onerror = () => {
    connection = "reconnecting";
    document.body.classList.add("is-reconnecting");
    document.body.classList.remove("is-live");
    render();
  };

  render();
}

if (typeof document !== "undefined") bootstrap();
