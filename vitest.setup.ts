import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Test hermeticity: never let the developer machine's real
// ~/.pi/pi-review/config.json (e.g. { childExtensions: true }) leak into
// isolation assertions. Set before any test module runs so the memoized
// currentConfig() and spawned CLI children (which inherit process.env) both
// see the pinned path.
process.env.PI_REVIEW_CONFIG ||= "/tmp/pi-review-test-no-such-dir/config.json";

// Redirect automatic panel run artifacts away from ~/.pi/pi-review/panel-runs.
// Give each Vitest worker/suite its own directory so afterAll cleanup in one
// suite cannot delete another concurrent suite's active run directory.
if (!process.env.PI_REVIEW_PANEL_RUNS_DIR || process.env.PI_REVIEW_TEST_OWNED_RUNS_DIR === "1") {
  const suiteRunsDir = path.join(os.tmpdir(), `pi-review-test-panel-runs-${process.pid}-${randomUUID()}`);
  process.env.PI_REVIEW_PANEL_RUNS_DIR = suiteRunsDir;
  process.env.PI_REVIEW_TEST_OWNED_RUNS_DIR = "1";
  afterAll(() => {
    fs.rmSync(suiteRunsDir, { recursive: true, force: true });
  });
}

// The Claude Code plugin exports PI_REVIEW_UI=pane into its session's shells;
// a test run from such a shell must still exercise the default --ui paths.
delete process.env.PI_REVIEW_UI;
