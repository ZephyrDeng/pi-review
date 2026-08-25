import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Persistent pi-review settings. The config file is the durable home for
 * behavior defaults (currently one key: childExtensions); environment
 * variables only override it for a single process. The file is machine-level:
 * any pi-review invocation on this machine reads the same settings.
 *
 * The config never blocks core functionality: any problem in it (unknown key,
 * wrong-typed value, invalid JSON) degrades to a stderr warning plus fallback,
 * never a crash — a config file written by a newer version must not brick an
 * older pi-review.
 */
export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".pi", "pi-review", "config.json");

export interface PiReviewConfig {
  /**
   * Let review children load host Pi extensions so providers registered only
   * through those extensions (e.g. px:anthropic, zenmux) are usable. false
   * keeps children isolated with --no-extensions (issue #8).
   */
  childExtensions?: boolean;
}

/** Where the effective value came from. */
export type ConfigSource = "default" | "config" | "env";

export interface ChildExtensionsDecision {
  enabled: boolean;
  source: ConfigSource;
}

/** Parsed config plus human-readable warnings for anything leniently ignored. */
export interface ReviewConfigLoad {
  config: PiReviewConfig;
  warnings: string[];
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_REVIEW_CONFIG || DEFAULT_CONFIG_PATH;
}

/**
 * Parse and validate config file text — lenient by design.
 *
 * - Unknown keys are ignored (forward compat with newer config files).
 * - null and any non-boolean value for a known key warn and count as unset
 *   (forward compat: a future schema change must degrade, not crash).
 * - Invalid JSON / non-object root warns and yields the empty config.
 * Nothing throws: the config is advisory, never a core-functionality gate.
 */
export function parseReviewConfig(text: string): ReviewConfigLoad {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      config: {},
      warnings: [`config file is not valid JSON (${(error as Error).message}); treating it as empty`],
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: {}, warnings: ["config file must contain a JSON object; treating it as empty"] };
  }
  const record = raw as Record<string, unknown>;
  const config: PiReviewConfig = {};
  if (record.childExtensions !== undefined && record.childExtensions !== null) {
    if (typeof record.childExtensions === "boolean") {
      config.childExtensions = record.childExtensions;
    } else {
      warnings.push(
        `"childExtensions" must be true or false, got ${JSON.stringify(record.childExtensions)}; ignoring it`,
      );
    }
  }
  return { config, warnings };
}

/** Load the config file; a missing file is the empty config with no warnings. */
export function loadReviewConfigFile(file: string): ReviewConfigLoad {
  if (!fs.existsSync(file)) return { config: {}, warnings: [] };
  return parseReviewConfig(fs.readFileSync(file, "utf8"));
}

let cached: { file: string; load: ReviewConfigLoad } | undefined;

/** Memoized per-process config load (the file is stable during one run). */
export function currentConfig(env: NodeJS.ProcessEnv = process.env): ReviewConfigLoad {
  const file = configFilePath(env);
  if (cached?.file === file) return cached.load;
  const load = loadReviewConfigFile(file);
  cached = { file, load };
  return load;
}

/**
 * Effective childExtensions for this process: env (1/true/keep enable,
 * any other set value disables) overrides the config file, which overrides the
 * built-in default of false (children isolated with --no-extensions, issue #8).
 * An empty or whitespace-only env value counts as unset and falls through.
 */
export function resolveChildExtensions(env: NodeJS.ProcessEnv, cfg: PiReviewConfig): ChildExtensionsDecision {
  const raw = env.PI_REVIEW_CHILD_EXTENSIONS?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "keep") return { enabled: true, source: "env" };
  if (raw !== undefined && raw !== "") return { enabled: false, source: "env" };
  if (cfg.childExtensions !== undefined) return { enabled: cfg.childExtensions, source: "config" };
  return { enabled: false, source: "default" };
}
