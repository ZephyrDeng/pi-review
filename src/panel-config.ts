// Resolve and validate panel execution configuration from parsed CLI options
// and named panel presets. Called from the orchestration path after the pure
// argument parser has already rejected syntactically invalid input; this layer
// validates combinations that require the loaded preset (reviewer counts,
// impossible quorum, concurrency bounds).

import { ArgsParseError } from "./args.js";
import {
  CONSENSUS_POLICIES,
  DEFAULT_PANEL_MIN_AGREE,
  MAX_REVIEWERS,
  type ConsensusPolicy,
  type PanelPreset,
  type PanelReviewerSpec,
  type ParsedArgs,
} from "./types.js";

export interface ResolvedPanelConfig {
  presetName?: string;
  reviewers: PanelReviewerSpec[];
  reviewerCount: number;
  consensus: ConsensusPolicy;
  minAgree?: number;
  consensusModel?: string;
  concurrency: number;
  /** True when a consensus model enables semantic adjudication. */
  semanticEnabled: boolean;
}

function isPolicy(value: string): value is ConsensusPolicy {
  return (CONSENSUS_POLICIES as readonly string[]).includes(value);
}

function defaultMinAgree(policy: ConsensusPolicy): number | undefined {
  return policy === "quorum" ? DEFAULT_PANEL_MIN_AGREE : undefined;
}

/**
 * Resolve a panel configuration. `panelPresets` is supplied by the caller (the
 * orchestrator loads the file), so this function stays pure and testable with
 * fixture presets.
 */
export function resolvePanelConfig(
  parsed: ParsedArgs,
  panelPresets: Record<string, PanelPreset>,
): ResolvedPanelConfig {
  const explicitConsensus = parsed.consensus;
  if (explicitConsensus !== undefined && !isPolicy(explicitConsensus)) {
    throw new ArgsParseError(
      `unknown consensus policy: ${explicitConsensus}. Available: ${CONSENSUS_POLICIES.join(", ")}`,
    );
  }

  let presetName: string | undefined;
  let reviewers: PanelReviewerSpec[];
  let consensus: ConsensusPolicy;
  let minAgree: number | undefined;
  let consensusModel: string | undefined;
  let concurrency: number | undefined;

  if (parsed.panel) {
    presetName = parsed.panel;
    const preset = panelPresets[parsed.panel];
    if (!preset) {
      throw new ArgsParseError(
        `unknown panel preset: ${parsed.panel}. Available: ${Object.keys(panelPresets).join(", ") || "(none)"}`,
      );
    }
    if (!Array.isArray(preset.reviewers) || preset.reviewers.length < 1) {
      throw new ArgsParseError(`panel preset ${parsed.panel} must define at least one reviewer`);
    }
    if (preset.reviewers.length > MAX_REVIEWERS) {
      throw new ArgsParseError(
        `panel preset ${parsed.panel} defines ${preset.reviewers.length} reviewers (max ${MAX_REVIEWERS})`,
      );
    }
    for (const reviewer of preset.reviewers) {
      if (!reviewer?.id || !reviewer?.role) {
        throw new ArgsParseError(`panel preset ${parsed.panel} has a reviewer missing id or role`);
      }
    }
    reviewers = preset.reviewers;
    consensus = (explicitConsensus ?? preset.consensus ?? "quorum") as ConsensusPolicy;
    minAgree = parsed.minAgree ?? preset.minAgree ?? defaultMinAgree(consensus);
    consensusModel = parsed.consensusModel ?? preset.consensusModel;
    concurrency = parsed.concurrency ?? preset.concurrency;
  } else {
    // Generic same-model panel: --reviewers N (parser guarantees N in 2..MAX).
    const count = parsed.reviewers!;
    reviewers = Array.from({ length: count }, (_, index) => ({
      id: `r${index + 1}`,
      role: "Independent reviewer",
    }));
    consensus = (explicitConsensus ?? "quorum") as ConsensusPolicy;
    minAgree = parsed.minAgree ?? defaultMinAgree(consensus);
    consensusModel = parsed.consensusModel;
    concurrency = parsed.concurrency;
  }

  if (minAgree !== undefined) {
    if (!Number.isSafeInteger(minAgree) || minAgree < 1) {
      throw new ArgsParseError("--min-agree must be a positive integer");
    }
    if (minAgree > reviewers.length) {
      throw new ArgsParseError(
        `--min-agree ${minAgree} cannot exceed reviewer count ${reviewers.length}`,
      );
    }
    if (consensus !== "quorum") {
      throw new ArgsParseError("--min-agree is only meaningful with --consensus quorum");
    }
  }

  const reviewerCount = reviewers.length;
  const effectiveConcurrency = concurrency ?? reviewerCount;
  if (!Number.isSafeInteger(effectiveConcurrency) || effectiveConcurrency < 1) {
    throw new ArgsParseError("--concurrency must be a positive integer");
  }
  if (effectiveConcurrency > reviewerCount) {
    throw new ArgsParseError(
      `--concurrency ${effectiveConcurrency} cannot exceed reviewer count ${reviewerCount}`,
    );
  }

  return {
    ...(presetName ? { presetName } : {}),
    reviewers,
    reviewerCount,
    consensus,
    ...(minAgree !== undefined ? { minAgree } : {}),
    ...(consensusModel ? { consensusModel, semanticEnabled: true } : { semanticEnabled: false }),
    concurrency: effectiveConcurrency,
  };
}
