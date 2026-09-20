// Jev (TypeSafe System One) typed-decision backend — enhancement mode.
//
// pi-review keeps generation with the big models: reviewers produce findings,
// evidence, and prose. The typed micro-decisions that used to require a whole
// review-only Pi child session route to Jev instead. Today that is panel
// consensus adjudication: deciding which same-path findings describe the same
// underlying issue. Jev never sees the repository — only the structured
// candidate findings the deterministic matcher could not separate — and its
// probabilities flow through the same confidence threshold the LLM
// adjudicator's merges used (SemanticMatcher re-validates every merge).

import type {
  AdjudicationRequest,
  AdjudicationResponse,
  SemanticAdjudicator,
} from "./matcher.js";
import type { ConfigSource, PiReviewConfig } from "./pi-config.js";

export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 15_000;

/** Effective on/off decision for the Jev enhancement layer. */
export interface JevDecision {
  enabled: boolean;
  source: ConfigSource;
}

/** True when a TypeSafe API key is available in the environment. */
export function hasJevApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TYPESAFE_API_KEY?.trim());
}

/**
 * Enhancement mode resolution, mirroring resolveChildExtensions:
 * PI_REVIEW_JEV (1/true/on enable, any other set value disables) overrides the
 * config file `jev` key, which overrides the default of "on when
 * TYPESAFE_API_KEY is present".
 */
export function resolveJev(env: NodeJS.ProcessEnv, cfg: PiReviewConfig): JevDecision {
  const raw = env.PI_REVIEW_JEV?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on") return { enabled: true, source: "env" };
  if (raw !== undefined && raw !== "") return { enabled: false, source: "env" };
  if (cfg.jev !== undefined) return { enabled: cfg.jev, source: "config" };
  return { enabled: hasJevApiKey(env), source: "default" };
}

/** Connection parameters for the TypeSafe System One API. */
export interface JevConnection {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * Resolve connection parameters, or undefined when no key is configured.
 * The key comes from TYPESAFE_API_KEY only; it is never logged or persisted.
 * TYPESAFE_BASE_URL allows pointing at a compatible endpoint (e.g. an
 * openjev-style local server), PI_REVIEW_JEV_MODEL pins the model id.
 */
export function resolveJevConnection(env: NodeJS.ProcessEnv = process.env): JevConnection | undefined {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return undefined;
  return {
    apiKey,
    baseUrl: env.TYPESAFE_BASE_URL?.trim() || DEFAULT_JEV_BASE_URL,
    model: env.PI_REVIEW_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL,
  };
}

export class JevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevError";
  }
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface JevNoulResult {
  /** Per-question probability that the answer is "yes"; ids with a missing or malformed answer are absent. */
  probabilities: Record<string, number>;
  /** Question ids the API omitted or returned in an unexpected shape. */
  missing: string[];
  usage?: JevUsage;
  model?: string;
}

export type JevFetch = typeof fetch;

const NOUL_CRITERIA = {
  true: "Both findings describe the same underlying issue (same root cause), even if worded differently.",
  false: "The findings are distinct issues, or merely share a file or symptom category.",
} as const;

interface SystemOneEnvelope {
  answers: Record<string, unknown>;
  usage?: JevUsage;
  model?: string;
}

/** Shared transport: one POST to /v1/systemone with the given typed questions. */
async function callSystemOne(
  connection: JevConnection,
  state: unknown,
  questionBody: Record<string, unknown>,
  fetchImpl: JevFetch,
): Promise<SystemOneEnvelope> {
  let response: Response;
  try {
    response = await fetchImpl(`${connection.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: connection.model, state, questions: questionBody }),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
  } catch (error) {
    throw new JevError(`typesafe api request failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new JevError(`typesafe api http ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new JevError("typesafe api returned non-JSON body");
  }
  const record = body as Record<string, unknown>;
  const answers = record.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new JevError("typesafe api response is missing the answers object");
  }
  const usageRaw = record.usage as Record<string, unknown> | undefined;
  const usage =
    usageRaw && typeof usageRaw.input_tokens === "number"
      ? { inputTokens: usageRaw.input_tokens, outputTokens: typeof usageRaw.output_tokens === "number" ? usageRaw.output_tokens : 0 }
      : undefined;
  return {
    answers: answers as Record<string, unknown>,
    ...(usage ? { usage } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
  };
}

/**
 * One System One call fanning out every Noul question in parallel. Throws
 * JevError on transport, HTTP, or envelope-level failures; individual missing
 * answers are reported in `missing` instead (treated as "no" by callers).
 */
export async function evaluateNouls(
  connection: JevConnection,
  state: unknown,
  questions: Record<string, string>,
  fetchImpl: JevFetch = fetch,
): Promise<JevNoulResult> {
  const questionBody = Object.fromEntries(
    Object.entries(questions).map(([id, instructions]) => [
      id,
      { type: "noul", instructions, criteria: { ...NOUL_CRITERIA } },
    ]),
  );
  const envelope = await callSystemOne(connection, state, questionBody, fetchImpl);
  const probabilities: Record<string, number> = {};
  const missing: string[] = [];
  for (const id of Object.keys(questions)) {
    const answer = envelope.answers[id] as Record<string, unknown> | undefined;
    const noul = answer?.noul;
    if (answer?.type === "noul" && typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1) {
      probabilities[id] = noul;
    } else {
      missing.push(id);
    }
  }
  return {
    probabilities,
    missing,
    ...(envelope.usage ? { usage: envelope.usage } : {}),
    ...(envelope.model ? { model: envelope.model } : {}),
  };
}

/** One Choice answer: the selected option plus its probability distribution peak. */
export interface JevChoiceAnswer {
  choice: string;
  confidence: number;
}

export interface JevChoiceResult {
  /** Per-question selected option; ids with a missing or malformed answer are absent. */
  answers: Record<string, JevChoiceAnswer>;
  /** Question ids the API omitted or returned in an unexpected shape. */
  missing: string[];
  usage?: JevUsage;
  model?: string;
}

/**
 * One System One call fanning out Choice questions. `criteria` maps each
 * option id to its plain-language description; an explicit escape option
 * (e.g. "other") belongs in the caller's criteria, per the Jev docs' advice.
 */
export async function evaluateChoices(
  connection: JevConnection,
  state: unknown,
  questions: Record<string, { instructions: string; criteria: Record<string, string> }>,
  fetchImpl: JevFetch = fetch,
): Promise<JevChoiceResult> {
  const questionBody = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [
      id,
      { type: "choice", instructions: question.instructions, criteria: question.criteria },
    ]),
  );
  const envelope = await callSystemOne(connection, state, questionBody, fetchImpl);
  const answers: Record<string, JevChoiceAnswer> = {};
  const missing: string[] = [];
  for (const id of Object.keys(questions)) {
    const answer = envelope.answers[id] as Record<string, unknown> | undefined;
    const choice = answer?.choice;
    const confidence = answer?.confidence;
    if (
      answer?.type === "choice" &&
      typeof choice === "string" &&
      choice in questions[id]!.criteria &&
      typeof confidence === "number" &&
      Number.isFinite(confidence) &&
      confidence >= 0 &&
      confidence <= 1
    ) {
      answers[id] = { choice, confidence };
    } else {
      missing.push(id);
    }
  }
  return {
    answers,
    missing,
    ...(envelope.usage ? { usage: envelope.usage } : {}),
    ...(envelope.model ? { model: envelope.model } : {}),
  };
}

/**
 * Jev-backed SemanticAdjudicator. Every unordered finding pair inside a
 * candidate group becomes one Noul question; all pairs across all groups go
 * out in a single System One call. Each pair above the no-merge floor becomes
 * a proposed merge whose confidence is the pair probability — the matcher's
 * union-find and SEMANTIC_MATCH_CONFIDENCE_THRESHOLD stay the single policy
 * point, and its provenance validation re-checks every id we emit.
 */
export function createJevAdjudicator(
  connection: JevConnection,
  options: { fetchImpl?: JevFetch } = {},
): SemanticAdjudicator {
  return {
    async adjudicate(request: AdjudicationRequest): Promise<AdjudicationResponse> {
      const questions: Record<string, string> = {};
      // question id -> [aId, bId]; pairs never span candidate groups, so no
      // merge can cross a path anchor by construction.
      const pairs = new Map<string, [string, string]>();
      request.candidates.forEach((candidate, groupIndex) => {
        const findings = candidate.findings;
        for (let i = 0; i < findings.length; i += 1) {
          for (let j = i + 1; j < findings.length; j += 1) {
            const a = findings[i]!;
            const b = findings[j]!;
            const id = `g${groupIndex}p${i}_${j}`;
            questions[id] =
              `Do findings ${a.id} and ${b.id} describe the same underlying issue? ` +
              "Merge only when they share a root cause, not when they merely mention the same file or symptom category.";
            pairs.set(id, [a.id, b.id]);
          }
        }
      });
      if (pairs.size === 0) return { merges: [] };

      const state = {
        candidates: request.candidates.map((candidate) => ({
          anchorPath: candidate.anchorPath,
          findings: candidate.findings.map((sf) => ({
            id: sf.id,
            reviewer: sf.reviewerId,
            path: sf.finding.path ?? null,
            summary: sf.finding.summary,
            actionable: sf.finding.actionable,
          })),
        })),
      };
      const result = await evaluateNouls(connection, state, questions, options.fetchImpl);
      const merges = [];
      for (const [questionId, [aId, bId]] of pairs) {
        const probability = result.probabilities[questionId];
        if (probability === undefined) continue; // missing answer: conservative no-merge
        merges.push({ sourceFindingIds: [aId, bId], confidence: probability });
      }
      return { merges };
    },
  };
}

/** Adjudicator wrapper with its runtime-resolved engine and fallback note. */
export interface AdjudicatorWithEngine {
  adjudicator: SemanticAdjudicator;
  engine(): "jev" | "pi";
  note(): string | undefined;
}

/**
 * Enhancement wrapper: try the Jev adjudicator first; on any failure degrade
 * to the Pi adjudicator so a Jev outage can never make a panel worse than the
 * pre-Jev behavior. The engine/note getters settle after adjudication ran.
 */
export function withAdjudicationFallback(
  primary: SemanticAdjudicator,
  fallback: SemanticAdjudicator,
  onFallback?: (message: string) => void,
): AdjudicatorWithEngine {
  let engine: "jev" | "pi" = "jev";
  let note: string | undefined;
  return {
    engine: () => engine,
    note: () => note,
    adjudicator: {
      async adjudicate(request: AdjudicationRequest): Promise<AdjudicationResponse> {
        try {
          return await primary.adjudicate(request);
        } catch (error) {
          engine = "pi";
          note = `jev adjudication failed (${(error as Error).message}); fell back to the Pi adjudicator`;
          onFallback?.(note);
          return fallback.adjudicate(request);
        }
      },
    },
  };
}
