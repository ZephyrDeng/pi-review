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
  /** Review budget for the loop command. */
  maxRounds?: number;
  continueHandle?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  tools?: string;
  name?: string;
  search?: string[];
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
  sessionHandle?: string;
}

export interface ReviewRunResult {
  meta: ReviewMeta;
  exitCode: number;
}

export interface SplitPayload {
  fileRefs: string[];
  userText: string;
}
