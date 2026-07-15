import assert from "node:assert/strict";
import { test } from "node:test";
import { PANEL_READ_ONLY_TOOLS, resolvePanelReviewerTools } from "./panel.js";

test("panel reviewers default to the hard read-only allowlist", () => {
  assert.equal(resolvePanelReviewerTools(undefined), PANEL_READ_ONLY_TOOLS.join(","));
});

test("panel reviewers reject shell and mutation-capable tools at the boundary", () => {
  for (const tool of ["bash", "edit", "write", "apply_patch"]) {
    assert.throws(() => resolvePanelReviewerTools(`read,${tool}`), /panel reviewers only allow/);
  }
});
