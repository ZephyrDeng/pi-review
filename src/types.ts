export const VERDICTS = ["approve", "request_changes", "needs_clarification", "blocked"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const REVIEW_STATUSES = ["clean", "has_findings", "needs_human", "blocked"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface ReviewFinding {
  id?: string;
  severity?: string;
  path?: string;
  summary: string;
  actionable: boolean;
}

export interface StructuredReviewResult extends VerdictInfo {
  status: ReviewStatus;
  findings: ReviewFinding[];
  actionableCount: number;
}

export interface ParsedArgs {
  command: "review" | "loop" | "models" | "install" | "install-skill" | "uninstall-skill" | "update";
  /** For `install`: run `pi install npm:@zephyrdeng/pi-review` */
  installPi?: boolean;
  /** For `install`: run agent skill install (skills CLI / Claude fallback) */
  installAgents?: boolean;
  extraArgs?: string[];
  mode: string;
  skills: string[];
  payload: string[];
  keepSession: boolean;
  /** When false, buffer child output and print after exit (legacy / scripting). Default: stream. */
  stream: boolean;
  /** When set, run the child in --mode json and stream its event log to this file path. */
  progressLog?: string;
  /** Review budget for the loop command (hard ceiling). */
  maxRounds?: number;
  /** True when the user explicitly passed --max-rounds (vs default). */
  maxRoundsExplicit?: boolean;
  /**
   * Loop stop goal. `clean` means keep reviewing until the gate is clean
   * (or escalate / exhaust the hard max-rounds budget).
   */
  until?: "clean";
  continueHandle?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  tools?: string;
  name?: string;
  search?: string[];
  /** Panel: number of independent reviewers (generic same-model panel). */
  reviewers?: number;
  /** Panel: named expert-panel preset. */
  panel?: string;
  /** Panel: consensus policy (any | quorum | majority | unanimous). */
  consensus?: string;
  /** Panel: minimum agreement for quorum consensus. */
  minAgree?: number;
  /** Panel: model used for semantic consensus adjudication. */
  consensusModel?: string;
  /** Panel: bounded reviewer concurrency. */
  concurrency?: number;
  /**
   * Per-reviewer model overrides: `r1=provider/model` or `security=provider/model`.
   * Generic panels use r1..rN; named panels use preset reviewer ids.
   */
  reviewerModels?: string[];
  /** Panel: normalized machine event stream for renderer adapters. */
  outputFormat?: "events-jsonl";
  /** Panel: start a loopback web dashboard for live progress (issue #4). Only "web" is supported. */
  ui?: "web";
  /** Panel: also write the dashboard URL to this file path (written atomically). */
  uiUrlFile?: string;
  /** Panel: override the dashboard's post-completion idle TTL, in seconds (default: 900). */
  uiTtlSeconds?: number;
  /** Panel: auto-open the dashboard URL in the default browser (default: true; --no-ui-open sets false). */
  uiOpen?: boolean;
}

export interface ReviewPreset {
  description: string;
  tools?: string[] | string;
  thinking?: string;
  instructions?: string;
  provider?: string;
  model?: string;
  skillPaths?: string[];
}

export interface VerdictInfo {
  verdict: Verdict;
  verdictSource: "parsed" | "fallback" | "runtime_error";
  parseError?: string;
}

export interface ReviewMeta extends StructuredReviewResult {
  reviewMode: string;
  durationMs: number;
  model: string | null;
  /** Thinking level requested for this review (off|minimal|low|medium|high|xhigh|max), if any. */
  thinking?: string;
  /** Token usage from the child pi --mode json stream, when available. */
  usage?: TokenUsage;
  sessionHandle?: string;
}

export interface ReviewRunResult {
  meta: ReviewMeta;
  exitCode: number;
}

export interface SplitPayload {
  fileRefs: string[];
  userText: string;
  /** Absolute/relative path targets that must be inspected with tools, not attached as Pi files. */
  pathTargets?: string[];
  /** File refs safe to pass as Pi `@file` attachments (never directories). */
  attachableFileRefs?: string[];
}

// ---------------------------------------------------------------------------
// Panel review
// ---------------------------------------------------------------------------

export const CONSENSUS_POLICIES = ["any", "quorum", "majority", "unanimous"] as const;
export type ConsensusPolicy = (typeof CONSENSUS_POLICIES)[number];

/** Token usage accumulated across completed requests in one review run. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  costTotal?: number;
}

/** Documented initial maximum number of reviewers in one panel. */
export const MAX_REVIEWERS = 8;

/** Hard capability boundary for every panel reviewer. */
export const PANEL_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/** Default minimum agreement for a multi-reviewer quorum panel. */
export const DEFAULT_PANEL_MIN_AGREE = 2;

/** Confidence at or above which a semantic adjudicator match merges clusters. */
export const SEMANTIC_MATCH_CONFIDENCE_THRESHOLD = 0.6;

/** A raw finding tagged with reviewer identity and a globally-unique source ID. */
export interface SourceFinding {
  /** Globally unique id scoped to reviewer identity, e.g. "r1#F1". */
  id: string;
  reviewerId: string;
  finding: ReviewFinding;
}

/**
 * A cluster of findings that represent the same underlying issue.
 * `confirmed` is true only when actionable support meets the consensus
 * threshold; otherwise the cluster is a non-blocking advisory.
 */
export interface FindingCluster {
  /** Stable cluster id within one panel evaluation, e.g. "C1". */
  id: string;
  summary: string;
  severity?: string;
  path?: string;
  confirmed: boolean;
  /** Distinct reviewers contributing any finding to this cluster. */
  supportCount: number;
  /** Distinct reviewers contributing an actionable finding. */
  actionableSupportCount: number;
  supportingReviewerIds: string[];
  sourceFindingIds: string[];
}

export type PanelHealth = "healthy" | "needs_human" | "blocked";

/** Per-reviewer provenance recorded in the aggregate panel metadata. */
export interface ReviewerOutcome {
  reviewerId: string;
  role?: string;
  model?: string | null;
  thinking?: string;
  usage?: TokenUsage;
  durationMs: number;
  status: ReviewStatus;
  verdict: Verdict;
  verdictSource: VerdictInfo["verdictSource"];
  /** True when this reviewer contributed parseable findings to aggregation. */
  contributed: boolean;
  runtimeError?: string;
  parseError?: string;
}

/** Additive panel fields shared by the aggregation result and the review meta. */
export interface PanelFields {
  strategy: "panel";
  panelPreset?: string;
  configuredReviewers: number;
  successfulReviewers: number;
  consensusPolicy: ConsensusPolicy;
  consensusThreshold: number;
  panelHealth: PanelHealth;
  confirmedClusters: FindingCluster[];
  advisories: FindingCluster[];
  reviewers: ReviewerOutcome[];
  adjudicationUsed: boolean;
  adjudicationErrors?: string[];
}

/** Pure aggregate panel result (no Pi, no I/O). */
export interface PanelAggregationResult extends StructuredReviewResult, PanelFields {}

/** Review metadata for a panel evaluation; additive over ReviewMeta. */
export interface PanelReviewMeta extends ReviewMeta, PanelFields {}

/** A reviewer's structured submission fed to the pure aggregation seam. */
export interface ReviewerSubmission {
  reviewerId: string;
  role?: string;
  model?: string | null;
  thinking?: string;
  usage?: TokenUsage;
  durationMs: number;
  result: StructuredReviewResult;
}

/** One reviewer definition inside a named panel preset. */
export interface PanelReviewerSpec {
  id: string;
  role: string;
  provider?: string;
  model?: string;
  thinking?: string;
}

/** A named expert-panel preset. */
export interface PanelPreset {
  description: string;
  reviewers: PanelReviewerSpec[];
  consensus?: ConsensusPolicy;
  minAgree?: number;
  consensusModel?: string;
  concurrency?: number;
}
