// Pure HTML shell for the loopback dashboard (issue #4). No inline <script>;
// the page loads one CSP-safe module script that renders everything.

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

export interface DashboardHtmlOptions {
  /** The capability-token path, e.g. "/run/<token>". Used to build absolute asset URLs. */
  runPath: string;
  title?: string;
}

export function renderDashboardHtml(opts: DashboardHtmlOptions): string {
  const title = opts.title ?? "pi-review dashboard";
  const scriptSrc = `${opts.runPath}/static/ui-client.js`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0; padding: 1.5rem; background: Canvas; color: CanvasText; }
  h1 { font-size: 1.15rem; margin: 0 0 0.25rem; }
  header { margin-bottom: 1.25rem; }
  #run-meta { opacity: 0.75; font-size: 0.85rem; }
  .reviewer-card { border: 1px solid GrayText; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 0.6rem; }
  .reviewer-card h2 { margin: 0 0 0.35rem; font-size: 0.95rem; font-weight: 600; }
  .status { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.02em; color: #fff; }
  .status-queued { background: #6b7280; }
  .status-running { background: #2563eb; animation: pulse 1.4s ease-in-out infinite; }
  .status-completed { background: #16a34a; }
  .status-failed, .status-cancelled { background: #dc2626; }
  .reviewer-card.is-loading { border-color: #2563eb; }
  .reviewer-detail { font-size: 0.85rem; opacity: 0.85; margin: 0.15rem 0; }
  .activity { font-size: 0.8rem; opacity: 0.75; margin: 0.35rem 0 0; white-space: pre-wrap; }
  .loading-line::before { content: "⏳ "; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
  .finding { border-left: 3px solid #dc2626; padding-left: 0.6rem; margin-bottom: 0.6rem; }
  .finding.advisory { border-left-color: #d97706; }
  section h2 { font-size: 1rem; margin: 1.25rem 0 0.5rem; }
  section h3 { font-size: 0.9rem; margin: 0.75rem 0 0.4rem; }
</style>
</head>
<body>
<header>
  <h1 id="run-title">pi-review panel</h1>
  <div id="run-meta">connecting…</div>
</header>
<section id="reviewers" aria-label="Reviewers"></section>
<section id="results" aria-label="Results"></section>
<script type="module" src="${scriptSrc}"></script>
</body>
</html>
`;
}
