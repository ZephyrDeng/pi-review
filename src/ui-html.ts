// Pure HTML shell for the loopback dashboard (issue #4). No inline <script>;
// the page loads one CSP-safe module script that renders everything. The
// visual system lives here as design tokens + component classes; ui-client.ts
// only toggles class names and writes textContent.

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** Warm-light dot, matching the accent token below. */
const FAVICON_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="7" fill="oklch(87%25 0.06 80)"/></svg>',
  );

export interface DashboardHtmlOptions {
  /** The capability-token path, e.g. "/run/<token>". Used to build absolute asset URLs. */
  runPath: string;
  title?: string;
}

export function renderDashboardHtml(opts: DashboardHtmlOptions): string {
  const title = opts.title ?? "pi-review panel";
  const scriptSrc = `${opts.runPath}/static/ui-client.js`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${FAVICON_SVG}" />
<style>
  :root {
    --bg: oklch(15.5% 0.008 75);
    --bg-raise: oklch(18.5% 0.009 75);
    --bg-raise-2: oklch(22% 0.01 75);
    --bg-sunken: oklch(13.5% 0.008 75);
    --line: oklch(27% 0.012 75);
    --line-strong: oklch(34% 0.014 75);
    --text: oklch(93% 0.006 80);
    --text-2: oklch(73% 0.01 78);
    --text-3: oklch(57% 0.01 78);
    --accent: oklch(87% 0.06 80);
    --accent-soft: oklch(87% 0.06 80 / 0.13);
    --ok: oklch(76% 0.12 152);
    --ok-soft: oklch(76% 0.12 152 / 0.11);
    --danger: oklch(70% 0.16 24);
    --danger-soft: oklch(70% 0.16 24 / 0.11);
    --warn: oklch(80% 0.1 78);
    --warn-soft: oklch(80% 0.1 78 / 0.11);
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    color-scheme: dark;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 350 1rem/1.55 var(--sans);
    letter-spacing: 0.011em;
    -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(56rem 22rem at 50% -8rem, oklch(30% 0.022 80 / 0.42), transparent 70%);
  }

  .shell {
    position: relative;
    max-width: 46rem;
    margin: 0 auto;
    padding: 3.5rem 1.5rem 7rem;
  }

  /* ---- masthead ------------------------------------------------------- */
  .eyebrow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font: 500 0.6875rem/1 var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .eyebrow-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-3);
    transition: background 0.3s var(--ease-out);
  }
  .is-live .eyebrow-dot { background: var(--accent); animation: pulse 1.8s ease-in-out infinite; }
  .eyebrow-conn { margin-left: auto; letter-spacing: 0.08em; text-transform: none; color: var(--warn); opacity: 0; transition: opacity 0.3s var(--ease-out); }
  .is-reconnecting .eyebrow-conn { opacity: 1; }

  #run-title {
    margin: 1.1rem 0 0;
    font-size: 2.125rem;
    font-weight: 640;
    line-height: 1.12;
    letter-spacing: -0.022em;
    text-wrap: balance;
    transition: color 0.4s var(--ease-out);
  }
  #run-title.tone-ok { color: var(--ok); }
  #run-title.tone-danger { color: var(--danger); }

  #run-target {
    margin: 0.55rem 0 0;
    max-width: 60ch;
    font-size: 0.875rem;
    color: var(--text-2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  #run-meta {
    display: flex;
    flex-wrap: wrap;
    margin-top: 1.75rem;
    padding-top: 1.1rem;
    border-top: 1px solid var(--line);
  }
  .stat { padding-right: 1.5rem; margin-right: 1.5rem; border-right: 1px solid var(--line); }
  .stat:last-child { border-right: 0; margin-right: 0; padding-right: 0; }
  .stat-value {
    font: 500 1rem/1.3 var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .stat-label {
    margin-top: 0.15rem;
    font: 500 0.65rem/1 var(--sans);
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-3);
  }

  /* ---- reviewer cards -------------------------------------------------- */
  #reviewers { margin-top: 2.75rem; display: grid; gap: 0.75rem; }

  .card {
    position: relative;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--bg-raise);
    padding: 1rem 1.25rem 1.1rem;
    animation: rise 0.32s var(--ease-out) both;
  }
  .card::after {
    content: "";
    position: absolute;
    inset: -1px;
    border-radius: 12px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.4s var(--ease-out);
    box-shadow:
      0 0 0 1px oklch(87% 0.06 80 / 0.28),
      0 0 26px oklch(87% 0.06 80 / 0.07),
      inset 0 0 14px oklch(87% 0.06 80 / 0.045);
  }
  .card.is-running::after { opacity: 1; animation: breathe 2.8s ease-in-out infinite; }
  .card.is-done { background: var(--bg); }
  .card.is-done .card-log { display: none; }

  .card-head { display: flex; align-items: flex-start; gap: 1rem; }
  .card-id { min-width: 0; }
  .card-role {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    letter-spacing: -0.005em;
    line-height: 1.35;
  }
  .card-model {
    margin-top: 0.1rem;
    font: 400 0.71875rem/1.4 var(--mono);
    color: var(--text-3);
    overflow-wrap: anywhere;
  }
  .card-head .chip { margin-left: auto; flex-shrink: 0; }

  .card-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1.1rem;
    margin-top: 0.75rem;
    font: 400 0.75rem/1.5 var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--text-2);
  }
  .card-stats .dim { color: var(--text-3); }

  .card-tool {
    display: none;
    margin-top: 0.6rem;
    font: 400 0.75rem/1.5 var(--mono);
    color: var(--accent);
    overflow-wrap: anywhere;
  }
  .card.is-running .card-tool.has-tool { display: block; }
  .card-tool::before { content: "▸ "; color: var(--text-3); }

  .card-log {
    margin: 0.75rem 0 0;
    padding: 0;
    font: 400 0.71875rem/1.65 var(--mono);
    color: var(--text-3);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 8.5rem;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    mask-image: linear-gradient(to bottom, transparent 0, black 1.75rem);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 1.75rem);
  }

  .card-error {
    margin-top: 0.6rem;
    font-size: 0.8125rem;
    color: var(--danger);
    overflow-wrap: anywhere;
  }

  .card-verdict { margin-top: 0.75rem; display: flex; gap: 0.5rem; align-items: center; font-size: 0.8125rem; color: var(--text-2); }

  /* ---- chips ------------------------------------------------------------ */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.65rem;
    border-radius: 999px;
    border: 1px solid transparent;
    font: 600 0.65rem/1 var(--sans);
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  .chip-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .chip-queued { color: var(--text-3); border-color: var(--line-strong); }
  .chip-running { color: var(--accent); background: var(--accent-soft); }
  .chip-running .chip-dot { animation: pulse 1.6s ease-in-out infinite; }
  .chip-completed { color: var(--ok); background: var(--ok-soft); }
  .chip-failed, .chip-cancelled { color: var(--danger); background: var(--danger-soft); }
  .chip-warn { color: var(--warn); background: var(--warn-soft); }
  .chip-neutral { color: var(--text-2); border-color: var(--line-strong); }

  /* ---- results ----------------------------------------------------------- */
  #results { margin-top: 3rem; }
  #results:empty { display: none; }

  .gate {
    border: 1px solid var(--line-strong);
    border-radius: 14px;
    padding: 1.35rem 1.5rem;
    animation: rise 0.4s var(--ease-out) both;
  }
  .gate-clean { border-color: oklch(76% 0.12 152 / 0.4); background: linear-gradient(180deg, var(--ok-soft), transparent 80%); }
  .gate-findings { border-color: oklch(70% 0.16 24 / 0.4); background: linear-gradient(180deg, var(--danger-soft), transparent 80%); }
  .gate-status { font-size: 1.375rem; font-weight: 650; letter-spacing: -0.015em; line-height: 1.2; }
  .gate-clean .gate-status { color: var(--ok); }
  .gate-findings .gate-status { color: var(--danger); }
  .gate-sub { margin-top: 0.3rem; font: 400 0.78125rem/1.5 var(--mono); color: var(--text-2); }

  .results-heading {
    margin: 2.25rem 0 0.85rem;
    font-size: 0.8125rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-2);
  }
  .results-heading .count { color: var(--text-3); font-weight: 500; }

  .finding {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--bg-raise);
    padding: 0.85rem 1.1rem;
    margin-bottom: 0.6rem;
    animation: rise 0.32s var(--ease-out) both;
  }
  .finding.advisory { background: transparent; }
  .finding-head { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 0.45rem; }
  .finding-path { font: 400 0.71875rem/1.4 var(--mono); color: var(--text-3); overflow-wrap: anywhere; }
  .finding-summary { font-size: 0.875rem; line-height: 1.55; color: var(--text); }
  .finding-summary code { background: var(--bg-raise-2); border: 1px solid var(--line); border-radius: 4px; padding: 0.08em 0.3em; font: 400 0.85em var(--mono); }
  .finding-support { margin-top: 0.45rem; font: 400 0.71875rem/1.4 var(--mono); color: var(--text-3); }

  .review-full {
    border: 1px solid var(--line);
    border-radius: 10px;
    margin-bottom: 0.6rem;
    overflow: hidden;
  }
  .review-full > summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.8rem 1.1rem;
    font-size: 0.8125rem;
    color: var(--text-2);
    transition: background 0.2s var(--ease-out), color 0.2s var(--ease-out);
  }
  .review-full > summary::-webkit-details-marker { display: none; }
  .review-full > summary::before {
    content: "";
    width: 0.4rem;
    height: 0.4rem;
    border-right: 1.5px solid var(--text-3);
    border-bottom: 1.5px solid var(--text-3);
    transform: rotate(-45deg);
    transition: transform 0.25s var(--ease-out);
    flex-shrink: 0;
  }
  .review-full[open] > summary::before { transform: rotate(45deg); }
  .review-full > summary:hover { background: var(--bg-raise); color: var(--text); }
  .review-full > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .review-full .prose { padding: 0.25rem 1.25rem 1.1rem; }

  /* ---- prose (rendered markdown) ---------------------------------------- */
  .prose { font-size: 0.875rem; line-height: 1.65; color: var(--text-2); max-width: 68ch; }
  .prose > :first-child { margin-top: 0.5rem; }
  .prose h1, .prose h2, .prose h3, .prose h4, .prose h5, .prose h6 {
    color: var(--text);
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.3;
    margin: 1.4em 0 0.45em;
    text-wrap: balance;
  }
  .prose h1 { font-size: 1.125rem; }
  .prose h2 { font-size: 1rem; }
  .prose h3 { font-size: 0.9375rem; }
  .prose h4, .prose h5, .prose h6 { font-size: 0.875rem; }
  .prose p { margin: 0.7em 0; }
  .prose code { background: var(--bg-raise-2); border: 1px solid var(--line); border-radius: 4px; padding: 0.08em 0.3em; font: 400 0.85em var(--mono); font-variant-ligatures: none; }
  .prose pre { background: var(--bg-sunken); border: 1px solid var(--line); border-radius: 8px; padding: 0.8rem 1rem; overflow-x: auto; margin: 0.9em 0; }
  .prose pre code { background: none; border: 0; padding: 0; font-size: 0.75rem; line-height: 1.6; color: var(--text-2); }
  .prose ul, .prose ol { margin: 0.7em 0; padding-left: 1.35em; }
  .prose li { margin: 0.3em 0; }
  .prose li::marker { color: var(--text-3); }
  .prose blockquote { margin: 0.9em 0; padding-left: 0.9em; border-left: 1px solid var(--line-strong); color: var(--text-3); }
  .prose blockquote p { margin: 0.3em 0; }
  .prose hr { border: 0; border-top: 1px solid var(--line); margin: 1.4em 0; }
  .prose a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line-strong); transition: text-decoration-color 0.2s var(--ease-out); }
  .prose a:hover { text-decoration-color: var(--accent); }
  .prose strong { color: var(--text); font-weight: 600; }

  /* ---- countdown closer --------------------------------------------------- */
  #closer {
    position: fixed;
    left: 50%;
    bottom: 1.5rem;
    transform: translate(-50%, 0);
    display: none;
    align-items: center;
    gap: 0.8rem;
    padding: 0.65rem 0.8rem 0.65rem 1rem;
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    background: oklch(21% 0.01 78 / 0.9);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    box-shadow: 0 12px 34px oklch(0% 0 0 / 0.42);
    animation: rise 0.4s var(--ease-out) both;
    z-index: 10;
  }
  #closer.is-visible { display: flex; }
  #closer-ring { flex-shrink: 0; transform: rotate(-90deg); }
  #closer-ring .ring-track { stroke: var(--line-strong); }
  #closer-ring .ring-fill { stroke: var(--accent); transition: stroke-dashoffset 0.25s linear; }
  #closer-text { font: 400 0.8125rem/1.3 var(--sans); color: var(--text-2); }
  #closer-text .num { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--text); }
  #closer-keep {
    appearance: none;
    border: 1px solid var(--line-strong);
    background: transparent;
    color: var(--text);
    font: 500 0.75rem/1 var(--sans);
    letter-spacing: 0.01em;
    padding: 0.5rem 0.85rem;
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.15s var(--ease-out), border-color 0.15s var(--ease-out);
  }
  #closer-keep:hover { background: var(--bg-raise-2); border-color: var(--text-3); }
  #closer-keep:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ---- empty / waiting ---------------------------------------------------- */
  .waiting {
    margin-top: 2.75rem;
    border: 1px dashed var(--line-strong);
    border-radius: 12px;
    padding: 2.25rem 1.5rem;
    text-align: center;
    color: var(--text-3);
    font-size: 0.875rem;
  }
  .waiting .ellipsis span { animation: pulse 1.4s ease-in-out infinite; display: inline-block; }
  .waiting .ellipsis span:nth-child(2) { animation-delay: 0.2s; }
  .waiting .ellipsis span:nth-child(3) { animation-delay: 0.4s; }

  /* ---- motion -------------------------------------------------------------- */
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @keyframes breathe { 50% { opacity: 0.45; } }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
  }

  @media (max-width: 560px) {
    .shell { padding-top: 2.25rem; }
    #run-title { font-size: 1.625rem; }
    #run-meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.9rem 1rem; }
    .stat, .stat:last-child { border-right: 0; padding-right: 0; margin-right: 0; }
    .card-head { flex-wrap: wrap; }
    .card-head .chip { margin-left: 0; order: -1; }
    #closer { left: 1rem; right: 1rem; transform: none; justify-content: space-between; }
    #closer-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    #closer-keep { flex-shrink: 0; }
  }
</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="eyebrow">
      <span class="eyebrow-dot"></span>
      <span>pi-review panel</span>
      <span class="eyebrow-conn">reconnecting…</span>
    </div>
    <h1 id="run-title">Connecting</h1>
    <p id="run-target"></p>
    <div id="run-meta" aria-label="Run metrics"></div>
  </header>
  <section id="reviewers" aria-label="Reviewers" aria-live="polite"></section>
  <section id="results" aria-label="Results"></section>
</div>
<div id="closer" role="status">
  <svg id="closer-ring" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
    <circle class="ring-track" cx="13" cy="13" r="10.5" fill="none" stroke-width="2" />
    <circle class="ring-fill" cx="13" cy="13" r="10.5" fill="none" stroke-width="2" stroke-linecap="round" />
  </svg>
  <span id="closer-text"></span>
  <button id="closer-keep" type="button">Keep open</button>
</div>
<script type="module" src="${escapeHtml(scriptSrc)}"></script>
</body>
</html>
`;
}
