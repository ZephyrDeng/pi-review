// Test hermeticity: never let the developer machine's real
// ~/.pi/pi-review/config.json (e.g. { childExtensions: true }) leak into
// isolation assertions. Set before any test module runs so the memoized
// currentConfig() and spawned CLI children (which inherit process.env) both
// see the pinned path.
process.env.PI_REVIEW_CONFIG ||= "/tmp/pi-review-test-no-such-dir/config.json";

// The Claude Code plugin exports PI_REVIEW_UI=pane into its session's shells;
// a test run from such a shell must still exercise the default --ui paths.
delete process.env.PI_REVIEW_UI;
