// Persistent panel run artifacts and artifact loader for reaggregation and
// partial reviewer reruns.
//
// Each panel run writes (best-effort by default, or fail-fast with --run-dir)
// a self-contained directory containing:
//   - manifest.json      (panel shape, consensus policy, target/payload/baseDir)
//   - reviewers/<id>.json (each reviewer's ReviewerSubmission as it completes)
//   - meta.json          (final redacted PanelReviewMeta)
//
// Artifacts can be reloaded by directory path or from a standalone meta.json /
// stderr log carrying `PI_REVIEW_META_JSON: ...` so consensus adjudication can
// be retried with a different model/policy or failed reviewers can be rerun
// selectively without repeating healthy reviewer sessions.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { redactReviewMetaPayload } from "./review-events.js";
import {
  CONSENSUS_POLICIES,
  REVIEW_STATUSES,
  VERDICTS,
  type ConsensusPolicy,
  type PanelReviewMeta,
  type PanelReviewerSpec,
  type ReviewFinding,
  type ReviewerOutcome,
  type ReviewerSubmission,
  type SourceFinding,
  type StructuredReviewResult,
} from "./types.js";
import { expandMaybeHome } from "./utils.js";

export const PANEL_ARTIFACT_SCHEMA_VERSION = 1 as const;

const REVIEWER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const RESERVED_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
]);
const DISABLED_ENV_VALUES = new Set(["0", "false", "off", "no"]);
const VERDICT_SOURCES = new Set(["parsed", "fallback", "runtime_error", "config_error"]);

export interface PanelRunManifest {
  schemaVersion: typeof PANEL_ARTIFACT_SCHEMA_VERSION;
  runId: string;
  createdAt: string;
  mode: string;
  panelPreset?: string;
  reviewers: PanelReviewerSpec[];
  consensusPolicy: ConsensusPolicy;
  minAgree?: number;
  consensusModel?: string;
  consensusRetries: number;
  sharedModel?: string;
  sharedProvider?: string;
  sharedThinking?: string;
  matcherBaseDir?: string;
  target?: string;
  payload?: string[];
  reusedFrom?: string;
  rerunReviewerIds?: string[];
}

export interface LoadedPanelArtifact {
  sourcePath: string;
  sourceKind: "run-dir" | "meta-file";
  manifest: {
    mode: string;
    panelPreset?: string;
    reviewers: PanelReviewerSpec[];
    consensusPolicy: ConsensusPolicy;
    minAgree?: number;
    consensusModel?: string;
    consensusRetries?: number;
    sharedModel?: string;
    sharedProvider?: string;
    sharedThinking?: string;
    matcherBaseDir?: string;
    target?: string;
    payload?: string[];
  };
  submissionsById: Map<string, ReviewerSubmission>;
  /** Diagnostic messages for corrupted reviewer files that could not be recovered from meta.json. */
  corruptReviewers?: Map<string, string>;
}

export interface PanelRunStore {
  runDir: string;
  writeManifest(manifest: PanelRunManifest): void;
  writeReviewer(submission: ReviewerSubmission): void;
  writeMeta(meta: PanelReviewMeta): void;
}

/** Root directory where automatic panel run artifacts are stored. */
export function panelRunsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_REVIEW_PANEL_RUNS_DIR?.trim();
  if (override) return path.resolve(expandMaybeHome(override)!);
  return path.join(os.homedir(), ".pi", "pi-review", "panel-runs");
}

/** Whether panel artifact persistence is enabled for this process. */
export function artifactsEnabled(env: NodeJS.ProcessEnv = process.env, explicitRunDir?: string): boolean {
  if (explicitRunDir !== undefined) return true;
  const raw = env.PI_REVIEW_PANEL_ARTIFACTS?.trim().toLowerCase();
  return raw === undefined || !DISABLED_ENV_VALUES.has(raw);
}

/** True when `id` is a safe, non-reserved reviewer identifier. */
export function isValidReviewerId(reviewerId: string): boolean {
  return (
    Boolean(reviewerId) &&
    !reviewerId.includes("..") &&
    !RESERVED_OBJECT_KEYS.has(reviewerId) &&
    REVIEWER_ID_RE.test(reviewerId)
  );
}

/** Validate a reviewer ID before using it as a filename stem or object key. */
export function safeReviewerIdForFile(reviewerId: string): string {
  if (!isValidReviewerId(reviewerId)) {
    throw new Error(`unsafe reviewer id for artifact path: ${JSON.stringify(reviewerId)}`);
  }
  return reviewerId;
}

function assertNotSymlink(targetPath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to follow symlink for ${label}: ${targetPath}`);
  }
}

function ensurePrivateDir(dirPath: string, forcePrivateMode: boolean): void {
  assertNotSymlink(dirPath, "artifact directory");
  const existed = fs.existsSync(dirPath);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  assertNotSymlink(dirPath, "artifact directory");
  if (!existed || forcePrivateMode) {
    fs.chmodSync(dirPath, 0o700);
  }
}

/** Atomically write JSON with owner-only file permissions, rejecting symlinks. */
function writeJsonAtomic(filePath: string, value: unknown): void {
  const parentDir = path.dirname(filePath);
  assertNotSymlink(parentDir, "artifact directory");
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  assertNotSymlink(filePath, "artifact file");
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup errors */
    }
    throw error;
  }
}

export interface CreatePanelRunStoreOptions {
  runId: string;
  runDir?: string;
  env?: NodeJS.ProcessEnv;
  onWarning?: (message: string) => void;
}

/**
 * Create a per-run artifact store. Explicit `--run-dir` failures throw so the
 * caller fails fast; automatic run directory failures degrade to a warning so
 * artifact persistence never blocks a review.
 */
export function createPanelRunStore(options: CreatePanelRunStoreOptions): PanelRunStore | undefined {
  const env = options.env ?? process.env;
  if (!artifactsEnabled(env, options.runDir)) return undefined;

  const explicit = options.runDir !== undefined;
  if (explicit && !options.runDir!.trim()) {
    throw new Error("--run-dir cannot be empty");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rootDir = explicit ? undefined : panelRunsRoot(env);
  const targetDir = explicit
    ? path.resolve(expandMaybeHome(options.runDir!.trim())!)
    : path.join(rootDir!, `${stamp}_${process.pid}_${options.runId.slice(0, 8)}`);
  const reviewersDir = path.join(targetDir, "reviewers");

  try {
    if (rootDir) {
      ensurePrivateDir(rootDir, true);
    }
    // Only force chmod 0o700 on newly created explicit dirs or auto-owned run dirs;
    // never mutate permissions on a pre-existing directory such as `--run-dir .`.
    ensurePrivateDir(targetDir, !explicit);
    ensurePrivateDir(reviewersDir, !explicit);
  } catch (error) {
    if (explicit) {
      throw new Error(`cannot create --run-dir ${targetDir}: ${(error as Error).message}`);
    }
    options.onWarning?.(`panel artifacts unavailable at ${targetDir}: ${(error as Error).message}`);
    return undefined;
  }

  const handleWriteError = (label: string, error: unknown): void => {
    if (explicit) {
      throw new Error(`failed to write ${label} in ${targetDir}: ${(error as Error).message}`);
    }
    options.onWarning?.(`failed to write ${label} in ${targetDir}: ${(error as Error).message}`);
  };

  return {
    runDir: targetDir,
    writeManifest(manifest: PanelRunManifest): void {
      try {
        writeJsonAtomic(path.join(targetDir, "manifest.json"), redactReviewMetaPayload(manifest));
      } catch (error) {
        handleWriteError("manifest.json", error);
      }
    },
    writeReviewer(submission: ReviewerSubmission): void {
      try {
        const safeId = safeReviewerIdForFile(submission.reviewerId);
        writeJsonAtomic(path.join(reviewersDir, `${safeId}.json`), redactReviewMetaPayload(submission));
      } catch (error) {
        handleWriteError(`reviewers/${submission.reviewerId}.json`, error);
      }
    },
    writeMeta(meta: PanelReviewMeta): void {
      try {
        writeJsonAtomic(path.join(targetDir, "meta.json"), redactReviewMetaPayload(meta));
      } catch (error) {
        handleWriteError("meta.json", error);
      }
    },
  };
}

function assertValidConsensusPolicy(value: unknown, context: string): ConsensusPolicy {
  if (typeof value !== "string" || !(CONSENSUS_POLICIES as readonly string[]).includes(value)) {
    throw new Error(`${context}: invalid consensus policy ${JSON.stringify(value)}`);
  }
  return value as ConsensusPolicy;
}

function validateReviewerSpec(raw: unknown, context: string): PanelReviewerSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${context}: reviewer entry must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.role !== "string" || !r.role) {
    throw new Error(`${context}: reviewer entry is missing id or role`);
  }
  safeReviewerIdForFile(r.id);
  return {
    id: r.id,
    role: r.role,
    ...(typeof r.provider === "string" && r.provider ? { provider: r.provider } : {}),
    ...(typeof r.model === "string" && r.model ? { model: r.model } : {}),
    ...(typeof r.thinking === "string" && r.thinking ? { thinking: r.thinking } : {}),
  };
}

function validateFindingEntry(raw: unknown, context: string): ReviewFinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${context}: finding entry must be an object`);
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.summary !== "string") {
    throw new Error(`${context}: finding entry is missing string summary`);
  }
  if (typeof f.actionable !== "boolean") {
    throw new Error(`${context}: finding entry is missing boolean actionable`);
  }
  return raw as ReviewFinding;
}

function validateSubmission(raw: unknown, filePath: string, expectedId?: string): ReviewerSubmission {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`invalid reviewer artifact ${filePath}: expected JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.reviewerId !== "string" || !obj.reviewerId) {
    throw new Error(`invalid reviewer artifact ${filePath}: missing reviewerId`);
  }
  safeReviewerIdForFile(obj.reviewerId);
  if (expectedId !== undefined && obj.reviewerId !== expectedId) {
    throw new Error(
      `invalid reviewer artifact ${filePath}: reviewerId "${obj.reviewerId}" does not match expected "${expectedId}"`,
    );
  }
  if (typeof obj.durationMs !== "number" || !Number.isFinite(obj.durationMs)) {
    throw new Error(`invalid reviewer artifact ${filePath}: missing numeric durationMs`);
  }
  const res = obj.result as Record<string, unknown> | undefined;
  if (!res || typeof res !== "object" || Array.isArray(res)) {
    throw new Error(`invalid reviewer artifact ${filePath}: missing result object`);
  }
  if (typeof res.status !== "string" || !(REVIEW_STATUSES as readonly string[]).includes(res.status)) {
    throw new Error(`invalid reviewer artifact ${filePath}: invalid result.status`);
  }
  if (typeof res.verdict !== "string" || !(VERDICTS as readonly string[]).includes(res.verdict)) {
    throw new Error(`invalid reviewer artifact ${filePath}: invalid result.verdict`);
  }
  if (typeof res.verdictSource !== "string" || !VERDICT_SOURCES.has(res.verdictSource)) {
    throw new Error(`invalid reviewer artifact ${filePath}: invalid result.verdictSource`);
  }
  if (!Array.isArray(res.findings)) {
    throw new Error(`invalid reviewer artifact ${filePath}: result.findings must be an array`);
  }
  for (const item of res.findings) {
    validateFindingEntry(item, `reviewer artifact ${filePath}`);
  }
  if (typeof res.actionableCount !== "number" || !Number.isFinite(res.actionableCount)) {
    throw new Error(`invalid reviewer artifact ${filePath}: missing numeric result.actionableCount`);
  }
  return raw as ReviewerSubmission;
}

function parseMetaPayload(text: string, sourcePath: string): PanelReviewMeta {
  const metaLines = text.split("\n").filter((line) => line.startsWith("PI_REVIEW_META_JSON: "));
  const rawJson =
    metaLines.length > 0
      ? metaLines[metaLines.length - 1]!.slice("PI_REVIEW_META_JSON: ".length).trim()
      : text.trim();
  if (!rawJson) {
    throw new Error(`empty panel meta artifact at ${sourcePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`cannot parse panel meta JSON in ${sourcePath}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid panel meta artifact at ${sourcePath}: expected JSON object`);
  }
  const meta = parsed as Partial<PanelReviewMeta>;
  if (meta.strategy !== "panel") {
    throw new Error(`artifact ${sourcePath} is not a panel review meta (strategy=${JSON.stringify(meta.strategy)})`);
  }
  if (!Array.isArray(meta.reviewers) || meta.reviewers.length < 2) {
    throw new Error(`invalid panel meta artifact at ${sourcePath}: reviewers must have at least two entries`);
  }
  assertValidConsensusPolicy(meta.consensusPolicy, `panel meta ${sourcePath}`);
  return meta as PanelReviewMeta;
}

function loadFromMetaText(
  text: string,
  sourcePath: string,
  sourceKind: "run-dir" | "meta-file",
): LoadedPanelArtifact {
  const meta = parseMetaPayload(text, sourcePath);
  if (meta.sourceFindings !== undefined && !Array.isArray(meta.sourceFindings)) {
    throw new Error(`invalid panel meta artifact at ${sourcePath}: sourceFindings must be an array`);
  }
  const hadAnyFindings =
    meta.reviewers.some((r) => r?.contributed && r?.status === "has_findings") ||
    (Array.isArray(meta.confirmedClusters) && meta.confirmedClusters.length > 0) ||
    (Array.isArray(meta.advisories) && meta.advisories.length > 0);
  if (meta.sourceFindings === undefined && hadAnyFindings) {
    throw new Error(
      `panel meta ${sourcePath} predates sourceFindings and cannot reconstruct reviewer findings; pass a panel run directory or a meta produced with sourceFindings`,
    );
  }

  const findingsByReviewer = new Map<string, SourceFinding[]>();
  for (const rawSf of meta.sourceFindings ?? []) {
    if (!rawSf || typeof rawSf !== "object" || Array.isArray(rawSf)) {
      throw new Error(`invalid panel meta artifact at ${sourcePath}: sourceFindings entry must be an object`);
    }
    const sf = rawSf as SourceFinding;
    if (typeof sf.reviewerId !== "string" || !sf.reviewerId) {
      throw new Error(`invalid panel meta artifact at ${sourcePath}: sourceFindings entry missing reviewerId`);
    }
    validateFindingEntry(sf.finding, `panel meta ${sourcePath}`);
    const list = findingsByReviewer.get(sf.reviewerId);
    if (list) list.push(sf);
    else findingsByReviewer.set(sf.reviewerId, [sf]);
  }

  const submissionsById = new Map<string, ReviewerSubmission>();
  const reviewerSpecs: PanelReviewerSpec[] = [];
  const seenIds = new Set<string>();

  for (const r of meta.reviewers as ReviewerOutcome[]) {
    if (!r || typeof r.reviewerId !== "string" || !r.reviewerId) {
      throw new Error(`invalid panel meta artifact at ${sourcePath}: reviewer entry missing reviewerId`);
    }
    safeReviewerIdForFile(r.reviewerId);
    if (seenIds.has(r.reviewerId)) {
      throw new Error(`invalid panel meta artifact at ${sourcePath}: duplicate reviewerId "${r.reviewerId}"`);
    }
    seenIds.add(r.reviewerId);
    if (typeof r.status !== "string" || !(REVIEW_STATUSES as readonly string[]).includes(r.status)) {
      throw new Error(`invalid panel meta artifact at ${sourcePath}: invalid status for reviewer ${r.reviewerId}`);
    }
    if (typeof r.verdict !== "string" || !(VERDICTS as readonly string[]).includes(r.verdict)) {
      throw new Error(`invalid panel meta artifact at ${sourcePath}: invalid verdict for reviewer ${r.reviewerId}`);
    }
    if (typeof r.verdictSource !== "string" || !VERDICT_SOURCES.has(r.verdictSource)) {
      throw new Error(`invalid panel meta artifact at ${sourcePath}: invalid verdictSource for reviewer ${r.reviewerId}`);
    }
    const reviewerFindings = (findingsByReviewer.get(r.reviewerId) ?? []).map((sf) => sf.finding);
    const actionableCount = reviewerFindings.filter((f) => f.actionable).length;
    const parseError = r.runtimeError ?? r.parseError;
    const result: StructuredReviewResult = {
      status: r.status,
      verdict: r.verdict,
      verdictSource: r.verdictSource,
      findings: reviewerFindings,
      actionableCount,
      ...(parseError ? { parseError } : {}),
    };
    submissionsById.set(r.reviewerId, {
      reviewerId: r.reviewerId,
      ...(r.role ? { role: r.role } : {}),
      model: r.model ?? null,
      ...(r.responseModel ? { responseModel: r.responseModel } : {}),
      ...(r.thinking ? { thinking: r.thinking } : {}),
      ...(r.usage ? { usage: r.usage } : {}),
      ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {}),
      ...(r.completedAt !== undefined ? { completedAt: r.completedAt } : {}),
      durationMs: typeof r.durationMs === "number" && Number.isFinite(r.durationMs) ? r.durationMs : 0,
      result,
      ...(r.extensionHint ? { extensionHint: r.extensionHint } : {}),
    });
    reviewerSpecs.push({
      id: r.reviewerId,
      role: r.role || r.reviewerId,
      ...(typeof r.model === "string" && r.model ? { model: r.model } : {}),
      ...(r.thinking ? { thinking: r.thinking } : {}),
    });
  }

  return {
    sourcePath,
    sourceKind,
    manifest: {
      mode: typeof meta.reviewMode === "string" && meta.reviewMode ? meta.reviewMode : "code",
      ...(typeof meta.panelPreset === "string" && meta.panelPreset ? { panelPreset: meta.panelPreset } : {}),
      reviewers: reviewerSpecs,
      consensusPolicy: meta.consensusPolicy,
      ...(meta.consensusPolicy === "quorum" && typeof meta.consensusThreshold === "number"
        ? { minAgree: meta.consensusThreshold }
        : {}),
      ...(typeof meta.matcherBaseDir === "string" && meta.matcherBaseDir
        ? { matcherBaseDir: meta.matcherBaseDir }
        : {}),
    },
    submissionsById,
  };
}

function loadManifestFile(manifestPath: string): PanelRunManifest {
  assertNotSymlink(manifestPath, "manifest file");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot parse panel manifest ${manifestPath}: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`invalid panel manifest ${manifestPath}: expected JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== PANEL_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported panel manifest schemaVersion ${JSON.stringify(obj.schemaVersion)} in ${manifestPath}`,
    );
  }
  if (!Array.isArray(obj.reviewers) || obj.reviewers.length < 2) {
    throw new Error(`invalid panel manifest ${manifestPath}: reviewers must have at least two entries`);
  }
  const reviewers = obj.reviewers.map((entry) => validateReviewerSpec(entry, `manifest ${manifestPath}`));
  const seenIds = new Set<string>();
  for (const r of reviewers) {
    if (seenIds.has(r.id)) {
      throw new Error(`invalid panel manifest ${manifestPath}: duplicate reviewer id "${r.id}"`);
    }
    seenIds.add(r.id);
  }
  const consensusPolicy = assertValidConsensusPolicy(obj.consensusPolicy, `manifest ${manifestPath}`);
  let consensusRetries = 1;
  if (obj.consensusRetries !== undefined) {
    if (
      typeof obj.consensusRetries !== "number" ||
      !Number.isSafeInteger(obj.consensusRetries) ||
      obj.consensusRetries < 0
    ) {
      throw new Error(`invalid panel manifest ${manifestPath}: consensusRetries must be a non-negative integer`);
    }
    consensusRetries = obj.consensusRetries;
  }
  const payload =
    Array.isArray(obj.payload) && obj.payload.every((item): item is string => typeof item === "string")
      ? obj.payload
      : undefined;

  return {
    schemaVersion: PANEL_ARTIFACT_SCHEMA_VERSION,
    runId: typeof obj.runId === "string" ? obj.runId : "",
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : "",
    mode: typeof obj.mode === "string" && obj.mode ? obj.mode : "code",
    ...(typeof obj.panelPreset === "string" && obj.panelPreset ? { panelPreset: obj.panelPreset } : {}),
    reviewers,
    consensusPolicy,
    ...(typeof obj.minAgree === "number" ? { minAgree: obj.minAgree } : {}),
    ...(typeof obj.consensusModel === "string" && obj.consensusModel
      ? { consensusModel: obj.consensusModel }
      : {}),
    consensusRetries,
    ...(typeof obj.sharedModel === "string" && obj.sharedModel ? { sharedModel: obj.sharedModel } : {}),
    ...(typeof obj.sharedProvider === "string" && obj.sharedProvider ? { sharedProvider: obj.sharedProvider } : {}),
    ...(typeof obj.sharedThinking === "string" && obj.sharedThinking ? { sharedThinking: obj.sharedThinking } : {}),
    ...(typeof obj.matcherBaseDir === "string" && obj.matcherBaseDir
      ? { matcherBaseDir: obj.matcherBaseDir }
      : {}),
    ...(typeof obj.target === "string" ? { target: obj.target } : {}),
    ...(payload ? { payload } : {}),
  };
}

/**
 * Load persisted reviewer conclusions from either a panel run directory
 * (`manifest.json` + `reviewers/*.json`, with per-reviewer fallback to `meta.json`)
 * or a standalone `meta.json` / log file containing `PI_REVIEW_META_JSON: ...`.
 */
export function loadPanelArtifact(rawPath: string): LoadedPanelArtifact {
  const expanded = expandMaybeHome(rawPath.trim());
  if (!expanded) {
    throw new Error("panel artifact path cannot be empty");
  }
  const sourcePath = path.resolve(expanded);
  assertNotSymlink(sourcePath, "panel artifact");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourcePath);
  } catch (error) {
    throw new Error(`cannot access panel artifact ${sourcePath}: ${(error as Error).message}`);
  }

  if (stat.isDirectory()) {
    const manifestPath = path.join(sourcePath, "manifest.json");
    const metaPath = path.join(sourcePath, "meta.json");
    const reviewersDir = path.join(sourcePath, "reviewers");

    if (!fs.existsSync(manifestPath)) {
      if (fs.existsSync(metaPath)) {
        assertNotSymlink(metaPath, "meta file");
        return loadFromMetaText(fs.readFileSync(metaPath, "utf8"), sourcePath, "run-dir");
      }
      throw new Error(`panel artifact directory ${sourcePath} has neither manifest.json nor meta.json`);
    }

    const manifest = loadManifestFile(manifestPath);
    const submissionsById = new Map<string, ReviewerSubmission>();
    const corruptReviewers = new Map<string, string>();

    if (fs.existsSync(reviewersDir)) {
      assertNotSymlink(reviewersDir, "reviewers directory");
      if (fs.statSync(reviewersDir).isDirectory()) {
        for (const spec of manifest.reviewers) {
          const filePath = path.join(reviewersDir, `${spec.id}.json`);
          if (!fs.existsSync(filePath)) continue;
          // Symlink is a security violation: always throw immediately.
          assertNotSymlink(filePath, "reviewer artifact");
          try {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const sub = validateSubmission(parsed, filePath, spec.id);
            submissionsById.set(spec.id, sub);
          } catch (error) {
            corruptReviewers.set(spec.id, (error as Error).message);
          }
        }
      }
    }

    // Per-reviewer backfill from meta.json when any declared reviewer is missing
    // or had a damaged individual file while meta.json succeeded.
    const anyMissing = manifest.reviewers.some((spec) => !submissionsById.has(spec.id));
    if (anyMissing && fs.existsSync(metaPath)) {
      assertNotSymlink(metaPath, "meta file");
      try {
        const fromMeta = loadFromMetaText(fs.readFileSync(metaPath, "utf8"), sourcePath, "run-dir");
        for (const spec of manifest.reviewers) {
          if (!submissionsById.has(spec.id) && fromMeta.submissionsById.has(spec.id)) {
            submissionsById.set(spec.id, fromMeta.submissionsById.get(spec.id)!);
            corruptReviewers.delete(spec.id);
          }
        }
      } catch {
        /* ignore fallback meta parse errors; caller checks missing/corrupt reviewers */
      }
    }

    return {
      sourcePath,
      sourceKind: "run-dir",
      manifest: {
        mode: manifest.mode,
        ...(manifest.panelPreset ? { panelPreset: manifest.panelPreset } : {}),
        reviewers: manifest.reviewers,
        consensusPolicy: manifest.consensusPolicy,
        ...(manifest.minAgree !== undefined ? { minAgree: manifest.minAgree } : {}),
        ...(manifest.consensusModel ? { consensusModel: manifest.consensusModel } : {}),
        consensusRetries: manifest.consensusRetries,
        ...(manifest.sharedModel ? { sharedModel: manifest.sharedModel } : {}),
        ...(manifest.sharedProvider ? { sharedProvider: manifest.sharedProvider } : {}),
        ...(manifest.sharedThinking ? { sharedThinking: manifest.sharedThinking } : {}),
        ...(manifest.matcherBaseDir ? { matcherBaseDir: manifest.matcherBaseDir } : {}),
        ...(manifest.target !== undefined ? { target: manifest.target } : {}),
        ...(manifest.payload ? { payload: manifest.payload } : {}),
      },
      submissionsById,
      ...(corruptReviewers.size > 0 ? { corruptReviewers } : {}),
    };
  }

  if (stat.isFile()) {
    return loadFromMetaText(fs.readFileSync(sourcePath, "utf8"), sourcePath, "meta-file");
  }

  throw new Error(`panel artifact path must be a directory or file: ${sourcePath}`);
}
