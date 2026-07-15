import assert from "node:assert/strict";
import { test } from "vitest";
import { renderDashboardHtml } from "./ui-html.js";

test("dashboard HTML references the client script under the run's own token path", () => {
  const html = renderDashboardHtml({ runPath: "/run/abc123" });
  assert.match(html, /<script type="module" src="\/run\/abc123\/static\/ui-client\.js"><\/script>/);
});

test("dashboard HTML has exactly one script tag and no inline event handlers", () => {
  const html = renderDashboardHtml({ runPath: "/run/abc123" });
  const scriptTags = html.match(/<script/g) ?? [];
  assert.equal(scriptTags.length, 1);
  assert.doesNotMatch(html, /\son\w+\s*=/i);
});

test("dashboard HTML escapes an untrusted title", () => {
  const html = renderDashboardHtml({ runPath: "/run/abc123", title: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("dashboard HTML declares the render containers", () => {
  const html = renderDashboardHtml({ runPath: "/run/abc123" });
  assert.match(html, /id="run-title"/);
  assert.match(html, /id="run-meta"/);
  assert.match(html, /id="reviewers"/);
  assert.match(html, /id="results"/);
});
