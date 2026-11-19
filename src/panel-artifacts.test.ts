import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  artifactsEnabled,
  createPanelRunStore,
  loadPanelArtifact,
  PANEL_ARTIFACT_SCHEMA_VERSION,
  panelRunsRoot,
  safeReviewerIdForFile,
} from "./panel-artifacts.js";
import { REVIEW_META_VERSION, type PanelReviewMeta, type ReviewerSubmission } from "./types.js";

let tempDir = "";
afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function sampleSubmission(id: string, summary: string): ReviewerSubmission {
  return {
    reviewerId: id,
    role: `${id} role`,
    model: "fake/model",
    startedAt: 1000,
    completedAt: 1500,
    durationMs: 500,
    result: {
      status: "has_findings",
      verdict: "request_changes",
      verdictSource: "parsed",
      actionableCount: 1,
      findings: [
        {
          id: "F1",
          severity: "high",
          path: "src/cli.ts",
          summary,
          actionable: true,
          details: "Evidence: sk-secret-token-12345678\n\nImpact: leak.",
          recommendation: "Redact.",
          location: { startLine: 10, endLine: 20, side: "base" },
        },
      ],
    },
  };
}

test("panelRunsRoot and artifactsEnabled honor env vars", () => {
  assert.equal(panelRunsRoot({ PI_REVIEW_PANEL_RUNS_DIR: "/tmp/custom-runs" }), path.resolve("/tmp/custom-runs"));
  assert.equal(artifactsEnabled({}), true);
  assert.equal(artifactsEnabled({ PI_REVIEW_PANEL_ARTIFACTS: "0" }), false);
  assert.equal(artifactsEnabled({ PI_REVIEW_PANEL_ARTIFACTS: "false" }), false);
  assert.equal(artifactsEnabled({ PI_REVIEW_PANEL_ARTIFACTS: "0" }, "/tmp/explicit"), true);
});

test("safeReviewerIdForFile blocks path traversal, leading dots/dashes, and prototype keys", () => {
  assert.equal(safeReviewerIdForFile("security"), "security");
  assert.equal(safeReviewerIdForFile("r1"), "r1");
  for (const bad of [
    "",
    ".",
    "..",
    "../etc/passwd",
    "a/b",
    "a\\b",
    "-flag",
    ".hidden",
    "__proto__",
    "constructor",
    "prototype",
    "toString",
  ]) {
    assert.throws(() => safeReviewerIdForFile(bad), /unsafe reviewer id/);
  }
});

test("createPanelRunStore writes atomic redacted files and loadPanelArtifact round-trips a run directory", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-artifacts-"));
  const runDir = path.join(tempDir, "run-1");
  const store = createPanelRunStore({ runId: "run-1", runDir })!;
  assert.ok(store);

  store.writeManifest({
    schemaVersion: PANEL_ARTIFACT_SCHEMA_VERSION,
    runId: "run-1",
    createdAt: "2026-11-19T00:00:00.000Z",
    mode: "plan",
    panelPreset: "code-experts",
    reviewers: [
      { id: "r1", role: "r1 role" },
      { id: "r2", role: "r2 role" },
    ],
    consensusPolicy: "quorum",
    minAgree: 2,
    consensusRetries: 1,
    matcherBaseDir: "/tmp/repo",
    target: "@src",
  });
  store.writeReviewer(sampleSubmission("r1", "First issue"));
  store.writeReviewer(sampleSubmission("r2", "Second issue"));

  // Permissions are owner-only (0o700 dir, 0o600 files).
  assert.equal(fs.statSync(runDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(runDir, "reviewers", "r1.json")).mode & 0o777, 0o600);

  const loaded = loadPanelArtifact(runDir);
  assert.equal(loaded.sourceKind, "run-dir");
  assert.equal(loaded.manifest.mode, "plan");
  assert.equal(loaded.manifest.panelPreset, "code-experts");
  assert.equal(loaded.manifest.minAgree, 2);
  assert.equal(loaded.manifest.matcherBaseDir, "/tmp/repo");
  assert.equal(loaded.submissionsById.size, 2);

  const r1 = loaded.submissionsById.get("r1")!;
  assert.equal(r1.startedAt, 1000);
  assert.equal(r1.completedAt, 1500);
  // Secrets were redacted before persistence.
  assert.doesNotMatch(r1.result.findings[0]!.details!, /sk-secret-token/);
  assert.match(r1.result.findings[0]!.details!, /\[REDACTED\]/);
});

test("loadPanelArtifact reconstructs submissions from meta.json and stderr log files", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-artifacts-meta-"));
  const meta: PanelReviewMeta = {
    metaVersion: REVIEW_META_VERSION,
    strategy: "panel",
    reviewMode: "challenge",
    panelPreset: "code-experts",
    verdict: "needs_clarification",
    verdictSource: "parsed",
    status: "needs_human",
    findings: [],
    actionableCount: 0,
    durationMs: 2500,
    model: "fake/model",
    configuredReviewers: 2,
    successfulReviewers: 2,
    consensusPolicy: "quorum",
    consensusThreshold: 2,
    panelHealth: "needs_human",
    confirmedClusters: [],
    advisories: [],
    adjudicationUsed: true,
    adjudicationErrors: ["invented id"],
    reviewers: [
      {
        reviewerId: "r1",
        role: "One",
        model: "fake/model",
        startedAt: 10,
        completedAt: 1010,
        durationMs: 1000,
        status: "has_findings",
        verdict: "request_changes",
        verdictSource: "parsed",
        contributed: true,
      },
      {
        reviewerId: "r2",
        role: "Two",
        model: "fake/model",
        startedAt: 20,
        completedAt: 1520,
        durationMs: 1500,
        status: "clean",
        verdict: "approve",
        verdictSource: "parsed",
        contributed: true,
      },
    ],
    sourceFindings: [
      {
        id: "r1#F1",
        reviewerId: "r1",
        finding: sampleSubmission("r1", "Loop bug").result.findings[0]!,
      },
    ],
  };

  const metaJsonPath = path.join(tempDir, "meta.json");
  fs.writeFileSync(metaJsonPath, JSON.stringify(meta));
  const fromJson = loadPanelArtifact(metaJsonPath);
  assert.equal(fromJson.sourceKind, "meta-file");
  assert.equal(fromJson.manifest.mode, "challenge");
  assert.equal(fromJson.manifest.consensusPolicy, "quorum");
  assert.equal(fromJson.manifest.minAgree, 2);
  assert.equal(fromJson.submissionsById.get("r1")!.result.findings[0]!.summary, "Loop bug");
  assert.deepEqual(fromJson.submissionsById.get("r1")!.result.findings[0]!.location, {
    startLine: 10,
    endLine: 20,
    side: "base",
  });
  assert.equal(fromJson.submissionsById.get("r2")!.result.findings.length, 0);

  const logPath = path.join(tempDir, "stderr.log");
  fs.writeFileSync(
    logPath,
    `some warning\nPI_REVIEW_META_JSON: ${JSON.stringify(meta)}\n`,
  );
  const fromLog = loadPanelArtifact(logPath);
  assert.equal(fromLog.submissionsById.get("r1")!.result.findings.length, 1);
});

test("loadPanelArtifact rejects meta files missing sourceFindings when a reviewer had findings", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-artifacts-old-"));
  const metaPath = path.join(tempDir, "old-meta.json");
  fs.writeFileSync(
    metaPath,
    JSON.stringify({
      strategy: "panel",
      reviewMode: "code",
      consensusPolicy: "quorum",
      consensusThreshold: 2,
      reviewers: [
        {
          reviewerId: "r1",
          durationMs: 10,
          status: "has_findings",
          verdict: "request_changes",
          verdictSource: "parsed",
          contributed: true,
        },
        {
          reviewerId: "r2",
          durationMs: 10,
          status: "clean",
          verdict: "approve",
          verdictSource: "parsed",
          contributed: true,
        },
      ],
    }),
  );
  assert.throws(() => loadPanelArtifact(metaPath), /predates sourceFindings/);
});

test("loadPanelArtifact rejects unsafe reviewer ids in meta files", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-artifacts-badid-"));
  const metaPath = path.join(tempDir, "bad-meta.json");
  fs.writeFileSync(
    metaPath,
    JSON.stringify({
      strategy: "panel",
      reviewMode: "code",
      consensusPolicy: "quorum",
      consensusThreshold: 2,
      sourceFindings: [],
      reviewers: [
        {
          reviewerId: "../evil",
          durationMs: 10,
          status: "clean",
          verdict: "approve",
          verdictSource: "parsed",
          contributed: true,
        },
        {
          reviewerId: "r2",
          durationMs: 10,
          status: "clean",
          verdict: "approve",
          verdictSource: "parsed",
          contributed: true,
        },
      ],
    }),
  );
  assert.throws(() => loadPanelArtifact(metaPath), /unsafe reviewer id/);
});

test("loadPanelArtifact refuses symlinks and backfills damaged reviewer files from meta.json", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-artifacts-backfill-"));
  const runDir = path.join(tempDir, "run-1");
  const store = createPanelRunStore({ runId: "run-1", runDir })!;
  store.writeManifest({
    schemaVersion: PANEL_ARTIFACT_SCHEMA_VERSION,
    runId: "run-1",
    createdAt: "2026-11-19T00:00:00.000Z",
    mode: "code",
    reviewers: [
      { id: "r1", role: "One" },
      { id: "r2", role: "Two" },
    ],
    consensusPolicy: "quorum",
    minAgree: 2,
    consensusRetries: 1,
  });
  store.writeReviewer(sampleSubmission("r1", "Healthy r1"));
  // Corrupt r2.json on disk, but provide a valid meta.json that includes r2.
  fs.writeFileSync(path.join(runDir, "reviewers", "r2.json"), "{corrupt-json");
  store.writeMeta({
    metaVersion: REVIEW_META_VERSION,
    strategy: "panel",
    reviewMode: "code",
    verdict: "request_changes",
    verdictSource: "parsed",
    status: "clean",
    findings: [],
    actionableCount: 0,
    durationMs: 500,
    model: "fake/model",
    configuredReviewers: 2,
    successfulReviewers: 2,
    consensusPolicy: "quorum",
    consensusThreshold: 2,
    panelHealth: "healthy",
    confirmedClusters: [],
    advisories: [],
    adjudicationUsed: false,
    reviewers: [
      {
        reviewerId: "r1",
        role: "One",
        model: "fake/model",
        durationMs: 500,
        status: "has_findings",
        verdict: "request_changes",
        verdictSource: "parsed",
        contributed: true,
      },
      {
        reviewerId: "r2",
        role: "Two",
        model: "fake/model",
        durationMs: 400,
        status: "clean",
        verdict: "approve",
        verdictSource: "parsed",
        contributed: true,
      },
    ],
    sourceFindings: [
      {
        id: "r1#F1",
        reviewerId: "r1",
        finding: sampleSubmission("r1", "Healthy r1").result.findings[0]!,
      },
    ],
  });

  const loaded = loadPanelArtifact(runDir);
  assert.equal(loaded.submissionsById.size, 2);
  assert.equal(loaded.corruptReviewers, undefined);
  assert.equal(loaded.submissionsById.get("r2")!.result.status, "clean");

  const symlinkDir = path.join(tempDir, "symlink-run");
  fs.symlinkSync(runDir, symlinkDir);
  assert.throws(() => loadPanelArtifact(symlinkDir), /refusing to follow symlink/);
  assert.throws(() => createPanelRunStore({ runId: "run-2", runDir: symlinkDir }), /refusing to follow symlink/);
});
