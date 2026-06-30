export const VERDICTS = ["approve", "request_changes", "needs_clarification", "blocked"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ParsedArgs {
  command: "review" | "models" | "install-skill" | "uninstall-skill" | "update";
  extraArgs?: string[];
  mode: string;
  skills: string[];
  payload: string[];
  keepSession: boolean;
  /** When false, buffer child output and print after exit (legacy / scripting). Default: stream. */
  stream: boolean;
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

export interface ReviewMeta {
  reviewMode: string;
  verdict: Verdict;
  verdictSource: string;
  durationMs: number;
  model: string | null;
  sessionHandle?: string;
  parseError?: string;
}

export interface SplitPayload {
  fileRefs: string[];
  userText: string;
}
