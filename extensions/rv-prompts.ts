/** /rv → parent-agent task text; child review uses resources/review-presets.json */

export const RV_MODES = ["code", "plan", "challenge"] as const;
export type RvMode = (typeof RV_MODES)[number];

const FLAGS_REQUIRING_VALUE = ["--mode", "--model", "--continue"] as const;

export type RvParsed = {
  mode: string;
  model?: string;
  keepSession: boolean;
  noStream: boolean;
  continueHandle?: string;
  modelsOnly: boolean;
  target: string;
};

export type RvValidation =
  | { ok: true }
  | { ok: false; message: string };

export function parseRvArgs(raw: string): RvParsed {
  const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const cleaned = tokens.map((t) => t.replace(/^['"]|['"]$/g, ""));

  let mode = "code";
  let model: string | undefined;
  let keepSession = false;
  let noStream = false;
  let continueHandle: string | undefined;
  let modelsOnly = false;
  const rest: string[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const t = cleaned[i];
    if (t === "models" && rest.length === 0 && i === cleaned.length - 1) {
      modelsOnly = true;
      continue;
    }
    if (t === "--keep-session") {
      keepSession = true;
      continue;
    }
    if (t === "--no-stream") {
      noStream = true;
      continue;
    }
    if (t === "--mode") {
      const m = cleaned[i + 1];
      if (!m || m.startsWith("--")) {
        rest.push(t);
        continue;
      }
      mode = cleaned[++i];
      continue;
    }
    if (t === "--model") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        rest.push(t);
        continue;
      }
      model = cleaned[++i];
      continue;
    }
    if (t === "--continue") {
      const v = cleaned[i + 1];
      if (!v || v.startsWith("--")) {
        rest.push(t);
        continue;
      }
      continueHandle = cleaned[++i];
      continue;
    }
    rest.push(t);
  }

  return {
    mode,
    model,
    keepSession,
    noStream,
    continueHandle,
    modelsOnly,
    target: rest.join(" ").trim(),
  };
}

export function validateRvParsed(parsed: RvParsed): RvValidation {
  if (parsed.keepSession && parsed.continueHandle) {
    return { ok: false, message: "--keep-session and --continue cannot be used together." };
  }
  for (const flag of FLAGS_REQUIRING_VALUE) {
    if (parsed.target === flag) {
      return { ok: false, message: `Missing value for ${flag}.` };
    }
  }
  return { ok: true };
}

/** Same optional flags for initial review and --continue follow-up (all optional). */
export function buildPiReviewArgv(parsed: RvParsed, target: string): string[] {
  const parts = ["pi-review"];
  if (parsed.continueHandle) {
    parts.push("--continue", parsed.continueHandle);
  } else if (parsed.keepSession) {
    parts.push("--keep-session");
  }
  if (parsed.mode !== "code") parts.push("--mode", parsed.mode);
  if (parsed.model) parts.push("--model", parsed.model);
  if (parsed.noStream) parts.push("--no-stream");
  parts.push("--", target);
  return parts;
}

function piHostRules(): string {
  return [
    "Follow the pi-review skill.",
    "Host: Pi interactive session (/rv).",
    "Run pi-review in an isolated child session; return the review conclusion (Markdown sections) plus the ASCII pi-review footer.",
    "CLI defaults: stream child output live. Do NOT add --no-stream or --progress-log unless the user explicitly asked.",
    "Do not edit, patch, commit, or implement findings unless the user asks separately.",
    "After pi-review exits, show the user the ASCII footer (lines starting with ── pi-review). Do not paste PI_REVIEW_META_JSON to the user; use Session from the footer for /rv --continue.",
  ].join(" ");
}

export function buildRvOrchestrationPrompt(parsed: RvParsed): string {
  if (parsed.modelsOnly) {
    return [
      "Run the pi-review model catalog step.",
      piHostRules(),
      "Execute: pi-review models",
      "Summarize briefly: provider count and 2–3 model IDs that fit code review vs plan/challenge.",
      "Do not start a review until the user supplies a target (@path or text).",
    ].join("\n\n");
  }

  const followUpDefault = "follow up on the previous review";
  const target = parsed.target || (parsed.continueHandle ? followUpDefault : "");

  if (!target && !parsed.continueHandle) {
    return [
      "/rv needs a review target.",
      "Usage: /rv [--mode code|plan|challenge] [--model provider/model] [--keep-session] @files-or-brief",
      "Continue: /rv --continue <handle> [--mode ...] [--model ...] [follow-up text]",
      "Examples: /rv @src/foo.ts | /rv --mode challenge @docs/design.md | /rv models",
    ].join("\n\n");
  }

  const modeBlock: Record<string, string> = {
    code: [
      "Mode: code (default).",
      "Focus: correctness, regressions, security, concurrency, API contracts, edge cases, tests.",
      "Use read-only inspection via pi-review; no file mutations.",
    ].join(" "),
    plan: [
      "Mode: plan.",
      "Review architecture, design, or strategy through engineering, product, security, QA, ops, and DX lenses.",
      "Identify fatal flaws, trade-offs, sequencing risks, and minimal changes to de-risk the plan.",
    ].join(" "),
    challenge: [
      "Mode: challenge (adversarial).",
      "Pressure-test assumptions, boundaries, dependencies, failure modes, migration, and missing evidence.",
      "One-shot conclusion; do not run a live Q&A interview.",
    ].join(" "),
  };

  const cliLine = buildPiReviewArgv(parsed, target).join(" ");

  const modelStep = parsed.model
    ? `Use model exactly as given: ${parsed.model} (must appear in pi-review models output).`
    : "Run pi-review models first if needed; pick a suitable listed ID or omit --model for Pi default.";

  const continueNote = parsed.continueHandle
    ? "Continuing an existing review session. Optional --mode and --model match the same flags as an initial /rv run."
    : parsed.keepSession
      ? "Use --keep-session so the user can follow up with /rv --continue <handle>."
      : "";

  return [
    parsed.continueHandle ? "Continue a prior pi-review session." : "Run pi-review for the target below.",
    piHostRules(),
    modeBlock[parsed.mode] ??
      `Mode: ${parsed.mode}. Follow the preset named in review-presets.json when present.`,
    modelStep,
    continueNote,
    `Execute:\n${cliLine}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const RV_COMPLETIONS: { value: string; hint: string }[] = [
  { value: "@", hint: "file path after @ (e.g. @src/foo.ts)" },
  { value: "models", hint: "list pi-review models only" },
  { value: "--mode code", hint: "code / diff / MR review" },
  { value: "--mode plan", hint: "architecture or plan review" },
  { value: "--mode challenge", hint: "adversarial plan review" },
  { value: "--model ", hint: "provider/model from pi-review models" },
  { value: "--keep-session", hint: "persist session for follow-up" },
  { value: "--no-stream", hint: "rare: buffer until exit (not default in Pi)" },
  { value: "--continue ", hint: "resume session; same optional flags as initial /rv" },
];