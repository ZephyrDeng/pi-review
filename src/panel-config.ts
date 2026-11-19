// Resolve and validate panel execution configuration from parsed CLI options
// and named panel presets. Called from the orchestration path after the pure
// argument parser has already rejected syntactically invalid input; this layer
// validates combinations that require the loaded preset (reviewer counts,
// impossible quorum, concurrency bounds).

import { ArgsParseError } from "./args.js";
import { isValidReviewerId, type LoadedPanelArtifact } from "./panel-artifacts.js";
import {
  CONSENSUS_POLICIES,
  DEFAULT_CONSENSUS_RETRIES,
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
  consensusRetries: number;
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
 * Persona labels for anonymous `--reviewers N` panels.
 * Mix of rappers, AI-circle KOLs, and sports stars — distinct at a glance,
 * shuffled per run so successive panels don't always look the same.
 */
const GENERIC_REVIEWER_ROLES = [
  // Rappers
  "Kendrick Lamar",
  "Drake",
  "J. Cole",
  "Travis Scott",
  "Eminem",
  "Nas",
  "Jay-Z",
  "Tyler, the Creator",
  // AI KOLs
  "Andrej Karpathy",
  "Sam Altman",
  "Demis Hassabis",
  "Yann LeCun",
  "Fei-Fei Li",
  "Andrew Ng",
  "Ilya Sutskever",
  "Jim Fan",
  // Sports stars
  "LeBron James",
  "Stephen Curry",
  "Lionel Messi",
  "Cristiano Ronaldo",
  "Kobe Bryant",
  "Serena Williams",
  "Yao Ming",
  "Shohei Ohtani",
] as const;

/**
 * Pick `count` distinct-looking roles from the persona pool.
 * Shuffles each call so successive runs don't always show the same order;
 * when count > pool size, suffixes with 2/3… to keep labels unique.
 */
export function assignGenericReviewerRoles(count: number): string[] {
  const pool = [...GENERIC_REVIEWER_ROLES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = a;
  }
  return Array.from({ length: count }, (_, index) => {
    const base = pool[index % pool.length]!;
    const cycle = Math.floor(index / pool.length);
    return cycle === 0 ? base : `${base} ${cycle + 1}`;
  });
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

/**
 * Split a trailing `:thinking` suffix from a model token.
 * Preserves provider colons such as `px:openai/agnes-2.0-flash:low` →
 * model=`px:openai/agnes-2.0-flash`, thinking=`low`.
 */
export function splitModelThinking(value: string): { model: string; thinking?: string } {
  const idx = value.lastIndexOf(":");
  if (idx <= 0) return { model: value };
  const after = value.slice(idx + 1).trim().toLowerCase();
  // Thinking suffixes are bare levels, never path-like fragments containing `/`.
  if (!after || after.includes("/") || !THINKING_LEVELS.has(after)) return { model: value };
  return { model: value.slice(0, idx), thinking: after };
}

/**
 * Extract the provider prefix from a `provider/model` model token.
 * `px:openai/agnes-2.0-flash` → `px:openai`; `gpt-5.6-sol` → undefined.
 * Glob patterns such as `anthropic/*` resolve to `anthropic`, which is the
 * intended scope for provider-availability probing.
 */
export function splitModelProvider(model: string): string | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return model.slice(0, slash);
}

export type ReviewerModelOverride = { model: string; thinking?: string };

/** Parse `id=provider/model[:thinking]` overrides; last write wins for duplicate ids. */
export function parseReviewerModelOverrides(values: string[] | undefined): Map<string, ReviewerModelOverride> {
  const map = new Map<string, ReviewerModelOverride>();
  for (const raw of values ?? []) {
    const eq = raw.indexOf("=");
    if (eq <= 0 || eq === raw.length - 1) {
      throw new ArgsParseError(`--reviewer-model must look like id=provider/model[:thinking]; got ${raw}`);
    }
    const id = raw.slice(0, eq).trim();
    const token = raw.slice(eq + 1).trim();
    if (!isValidReviewerId(id) || !token) {
      throw new ArgsParseError(`--reviewer-model must look like id=provider/model[:thinking]; got ${raw}`);
    }
    map.set(id, splitModelThinking(token));
  }
  return map;
}

function applyReviewerModelOverrides(
  reviewers: PanelReviewerSpec[],
  overrides: Map<string, ReviewerModelOverride>,
): PanelReviewerSpec[] {
  if (overrides.size === 0) return reviewers;
  const known = new Set(reviewers.map((reviewer) => reviewer.id));
  for (const id of overrides.keys()) {
    if (!known.has(id)) {
      throw new ArgsParseError(
        `--reviewer-model unknown reviewer id "${id}"; expected one of ${[...known].join(", ")}`,
      );
    }
  }
  return reviewers.map((reviewer) => {
    const override = overrides.get(reviewer.id);
    if (!override) return reviewer;
    // Per-reviewer :thinking must win over shared --thinking / preset thinking.
    return {
      ...reviewer,
      model: override.model,
      ...(override.thinking ? { thinking: override.thinking } : {}),
    };
  });
}

/**
 * Resolve the effective model + thinking for a reviewer.
 * - Strips a trailing `:thinking` suffix from the model token (so display and
 *   child args never show `model:low · high`).
 * - Preference: per-reviewer thinking field → `:suffix` on per-reviewer model →
 *   shared thinking → `:suffix` on shared model.
 */
export function resolveReviewerModelThinking(
  reviewer: { model?: string; thinking?: string },
  shared: { model?: string; thinking?: string } = {},
): { model?: string; thinking?: string } {
  const raw = reviewer.model ?? shared.model;
  const fromRaw: { model?: string; thinking?: string } = raw ? splitModelThinking(raw) : {};
  const fromReviewerModel: { model?: string; thinking?: string } = reviewer.model ? splitModelThinking(reviewer.model) : {};
  const fromSharedModel: { model?: string; thinking?: string } = !reviewer.model && shared.model ? splitModelThinking(shared.model) : {};
  const thinking =
    reviewer.thinking ??
    fromReviewerModel.thinking ??
    shared.thinking ??
    fromSharedModel.thinking;
  return {
    ...(fromRaw.model ? { model: fromRaw.model } : {}),
    ...(thinking ? { thinking } : {}),
  };
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
  let consensusRetries: number | undefined;
  let concurrency: number | undefined;

  if (parsed.panel) {
    presetName = parsed.panel;
    const preset = panelPresets[parsed.panel];
    if (!preset) {
      throw new ArgsParseError(
        `unknown panel preset: ${parsed.panel}. Available: ${Object.keys(panelPresets).join(", ") || "(none)"}`,
      );
    }
    if (!Array.isArray(preset.reviewers) || preset.reviewers.length < 2) {
      throw new ArgsParseError(`panel preset ${parsed.panel} must define at least two reviewers`);
    }
    if (preset.reviewers.length > MAX_REVIEWERS) {
      throw new ArgsParseError(
        `panel preset ${parsed.panel} defines ${preset.reviewers.length} reviewers (max ${MAX_REVIEWERS})`,
      );
    }
    const seenReviewerIds = new Set<string>();
    for (const reviewer of preset.reviewers) {
      if (!reviewer?.id || !reviewer?.role) {
        throw new ArgsParseError(`panel preset ${parsed.panel} has a reviewer missing id or role`);
      }
      if (seenReviewerIds.has(reviewer.id)) {
        throw new ArgsParseError(`panel preset ${parsed.panel} has duplicate reviewer id: ${reviewer.id}`);
      }
      if (!isValidReviewerId(reviewer.id)) {
        throw new ArgsParseError(`panel preset ${parsed.panel} reviewer id "${reviewer.id}" must be a safe alphanumeric identifier`);
      }
      seenReviewerIds.add(reviewer.id);
    }
    if (preset.consensus !== undefined && !isPolicy(preset.consensus)) {
      throw new ArgsParseError(
        `panel preset ${parsed.panel} has unknown consensus: ${preset.consensus}. Available: ${CONSENSUS_POLICIES.join(", ")}`,
      );
    }
    if (preset.minAgree !== undefined && (!Number.isSafeInteger(preset.minAgree) || preset.minAgree < 1)) {
      throw new ArgsParseError(`panel preset ${parsed.panel} minAgree must be a positive integer`);
    }
    if (
      preset.consensusRetries !== undefined &&
      (!Number.isSafeInteger(preset.consensusRetries) || preset.consensusRetries < 0)
    ) {
      throw new ArgsParseError(`panel preset ${parsed.panel} consensusRetries must be a non-negative integer`);
    }
    const presetConsensus = (explicitConsensus ?? preset.consensus ?? "quorum") as ConsensusPolicy;
    if (preset.minAgree !== undefined && presetConsensus !== "quorum") {
      throw new ArgsParseError(
        `panel preset ${parsed.panel} sets minAgree but effective consensus is ${presetConsensus}; minAgree is only meaningful with quorum`,
      );
    }
    reviewers = preset.reviewers;
    consensus = (explicitConsensus ?? preset.consensus ?? "quorum") as ConsensusPolicy;
    // Only inherit a preset/default minAgree when the effective policy is quorum;
    // a non-quorum override must not carry a stale quorum threshold.
    const inheritMinAgree = consensus === "quorum" ? preset.minAgree : undefined;
    minAgree = parsed.minAgree ?? inheritMinAgree ?? defaultMinAgree(consensus);
    consensusModel = parsed.consensusModel ?? preset.consensusModel;
    consensusRetries = parsed.consensusRetries ?? preset.consensusRetries ?? DEFAULT_CONSENSUS_RETRIES;
    concurrency = parsed.concurrency ?? preset.concurrency;
  } else {
    // Generic panel: --reviewers N (parser guarantees N in 2..MAX). Shared
    // --model is the default; --reviewer-model rK=... overrides individuals.
    // Roles are distinct persona names (not all "Independent reviewer") so the
    // live panel / dashboard can tell reviewers apart at a glance.
    const count = parsed.reviewers!;
    const roles = assignGenericReviewerRoles(count);
    reviewers = Array.from({ length: count }, (_, index) => ({
      id: `r${index + 1}`,
      role: roles[index]!,
    }));
    consensus = (explicitConsensus ?? "quorum") as ConsensusPolicy;
    minAgree = parsed.minAgree ?? defaultMinAgree(consensus);
    consensusModel = parsed.consensusModel;
    consensusRetries = parsed.consensusRetries ?? DEFAULT_CONSENSUS_RETRIES;
    concurrency = parsed.concurrency;
  }

  return finalizePanelConfig({
    presetName,
    reviewers: applyReviewerModelOverrides(reviewers, parseReviewerModelOverrides(parsed.reviewerModels)),
    consensus,
    minAgree,
    consensusModel,
    consensusRetries,
    concurrency,
  });
}

/** Resolve panel configuration from a persisted run artifact plus CLI overrides. */
export function resolveReusedPanelConfig(
  parsed: ParsedArgs,
  artifact: LoadedPanelArtifact,
  panelPresets: Record<string, PanelPreset> = {},
): ResolvedPanelConfig {
  const explicitConsensus = parsed.consensus;
  if (explicitConsensus !== undefined && !isPolicy(explicitConsensus)) {
    throw new ArgsParseError(
      `unknown consensus policy: ${explicitConsensus}. Available: ${CONSENSUS_POLICIES.join(", ")}`,
    );
  }

  const artifactById = new Map(artifact.manifest.reviewers.map((r) => [r.id, r]));

  if (parsed.panel) {
    const base = resolvePanelConfig(parsed, panelPresets);
    if (parsed.panel !== artifact.manifest.panelPreset) {
      return base;
    }
    const consensus = (explicitConsensus ?? artifact.manifest.consensusPolicy ?? base.consensus) as ConsensusPolicy;
    const inheritMinAgree = consensus === "quorum" ? (artifact.manifest.minAgree ?? base.minAgree) : undefined;
    const minAgree = parsed.minAgree ?? inheritMinAgree ?? defaultMinAgree(consensus);
    const consensusModel = parsed.consensusModel ?? artifact.manifest.consensusModel ?? base.consensusModel;
    const consensusRetries =
      parsed.consensusRetries ?? artifact.manifest.consensusRetries ?? base.consensusRetries;
    const overrides = parseReviewerModelOverrides(parsed.reviewerModels);
    const mergedReviewers = applyReviewerModelOverrides(
      base.reviewers.map((spec) => {
        const prev = artifactById.get(spec.id);
        return prev ? { ...spec, ...prev } : spec;
      }),
      overrides,
    );
    return finalizePanelConfig({
      presetName: base.presetName,
      reviewers: mergedReviewers,
      consensus,
      minAgree,
      consensusModel,
      consensusRetries,
      concurrency: parsed.concurrency ?? base.concurrency,
    });
  }

  if (parsed.reviewers !== undefined) {
    const count = parsed.reviewers;
    const fallbackRoles = assignGenericReviewerRoles(count);
    const baseSpecs: PanelReviewerSpec[] = Array.from({ length: count }, (_, index) => {
      const id = `r${index + 1}`;
      const prev = artifactById.get(id);
      if (prev) return { ...prev };
      return { id, role: fallbackRoles[index]! };
    });
    const consensus = (explicitConsensus ?? artifact.manifest.consensusPolicy) as ConsensusPolicy;
    const inheritMinAgree = consensus === "quorum" ? artifact.manifest.minAgree : undefined;
    const minAgree = parsed.minAgree ?? inheritMinAgree ?? defaultMinAgree(consensus);
    const consensusModel = parsed.consensusModel ?? artifact.manifest.consensusModel;
    const consensusRetries =
      parsed.consensusRetries ?? artifact.manifest.consensusRetries ?? DEFAULT_CONSENSUS_RETRIES;
    return finalizePanelConfig({
      reviewers: applyReviewerModelOverrides(baseSpecs, parseReviewerModelOverrides(parsed.reviewerModels)),
      consensus,
      minAgree,
      consensusModel,
      consensusRetries,
      concurrency: parsed.concurrency,
    });
  }

  const consensus = (explicitConsensus ?? artifact.manifest.consensusPolicy) as ConsensusPolicy;
  const inheritMinAgree = consensus === "quorum" ? artifact.manifest.minAgree : undefined;
  const minAgree = parsed.minAgree ?? inheritMinAgree ?? defaultMinAgree(consensus);
  const consensusModel = parsed.consensusModel ?? artifact.manifest.consensusModel;
  const consensusRetries =
    parsed.consensusRetries ?? artifact.manifest.consensusRetries ?? DEFAULT_CONSENSUS_RETRIES;
  const reviewers = applyReviewerModelOverrides(
    artifact.manifest.reviewers,
    parseReviewerModelOverrides(parsed.reviewerModels),
  );

  return finalizePanelConfig({
    presetName: artifact.manifest.panelPreset,
    reviewers,
    consensus,
    minAgree,
    consensusModel,
    consensusRetries,
    concurrency: parsed.concurrency,
  });
}

function finalizePanelConfig(input: {
  presetName?: string;
  reviewers: PanelReviewerSpec[];
  consensus: ConsensusPolicy;
  minAgree?: number;
  consensusModel?: string;
  consensusRetries: number;
  concurrency?: number;
}): ResolvedPanelConfig {
  const { presetName, reviewers, consensus, minAgree, consensusModel, consensusRetries, concurrency } = input;

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

  if (!Number.isSafeInteger(consensusRetries) || consensusRetries < 0) {
    throw new ArgsParseError("--consensus-retries must be a non-negative integer");
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
    consensusRetries,
    concurrency: effectiveConcurrency,
  };
}
