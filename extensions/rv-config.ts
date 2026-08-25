/**
 * /rv-config: show the effective pi-review configuration — the persistent
 * config file (~/.pi/pi-review/config.json), per-process env overrides, and
 * the resolved paths the CLI will use. Read-only, plain text (no markdown),
 * locale-aware like the other /rv* commands.
 */

import {
  configFilePath,
  loadReviewConfigFile,
  parseReviewConfig,
  resolveChildExtensions,
  resolveConfig,
} from "@zephyrdeng/pi-review";
import type { PiReviewConfig } from "@zephyrdeng/pi-review";
import type { RvLocale } from "./rv-locale.js";

export interface RvConfigViewInput {
  locale: RvLocale;
  env?: NodeJS.ProcessEnv;
  /** Override the config file path (tests). */
  configPath?: string;
  /** Override config file content (tests); null means the file is missing. */
  readConfig?: (file: string) => string | null;
  /** Override the resolved environment keys (tests). */
  resolved?: ReturnType<typeof resolveConfig>;
}

type Strings = {
  header: string;
  childExtensions: string;
  configFileLabel: string;
  configFileMissing: string;
  envSection: string;
  sourceDefault: string;
  sourceConfig: string;
  sourceEnv: string;
  warnFile: (reason: string) => string;
  piBin: string;
  reviewHome: string;
  presetsFile: string;
  panelPresetsFile: string;
  systemPromptFile: string;
  sessionsRoot: string;
};

const STRINGS: Record<RvLocale, Strings> = {
  en: {
    header: "Pi Review config",
    childExtensions:
      "Load host Pi extensions in review children so providers registered only by extensions (e.g. px:anthropic, zenmux) are usable; false keeps children isolated with --no-extensions (issue #8). Override one run: PI_REVIEW_CHILD_EXTENSIONS=1 or =0.",
    configFileLabel: "config file",
    configFileMissing: "(missing — using defaults)",
    envSection: "Resolved environment",
    sourceDefault: "default",
    sourceConfig: "config file",
    sourceEnv: "env override",
    warnFile: (reason) => `config warning: ${reason} — using defaults for that key`,
    piBin: "Pi executable used to spawn review children.",
    reviewHome: "Directory holding the default presets and system prompt.",
    presetsFile: "Review mode presets (code / plan / challenge).",
    panelPresetsFile: "Named panel presets (e.g. code-experts).",
    systemPromptFile: "Extra system prompt appended to every review child.",
    sessionsRoot: "Persisted --keep-session review sessions.",
  },
  zh: {
    header: "Pi Review 配置",
    childExtensions:
      "是否让评审子进程加载宿主 Pi 扩展，以使用仅由扩展注册的 provider（如 px:anthropic、zenmux）；false 表示隔离运行（--no-extensions，issue #8）。单次覆盖：PI_REVIEW_CHILD_EXTENSIONS=1 或 =0。",
    configFileLabel: "配置文件",
    configFileMissing: "（不存在——使用默认值）",
    envSection: "生效环境",
    sourceDefault: "默认",
    sourceConfig: "配置文件",
    sourceEnv: "env 覆盖",
    warnFile: (reason) => `配置警告：${reason}——该键按未设置处理`,
    piBin: "用于启动评审子进程的 Pi 可执行文件。",
    reviewHome: "存放默认 presets 与系统提示词的目录。",
    presetsFile: "评审模式预设（code / plan / challenge）。",
    panelPresetsFile: "命名评审面板预设（如 code-experts）。",
    systemPromptFile: "附加到每个评审子进程的系统提示词。",
    sessionsRoot: "持久化 --keep-session 评审会话的目录。",
  },
};

function warnNotes(s: Strings, warnings: string[]): string[] {
  return warnings.map((w) => s.warnFile(w));
}

/**
 * Build the /rv-config display lines. Pure apart from reading the config file
 * (inject readConfig for tests; null means the file is missing).
 *
 * The config is advisory and lenient: nothing here can fail the CLI, so the
 * view and the CLI always agree — warnings are displayed, values fall back.
 */
export function buildRvConfigLines(input: RvConfigViewInput): string[] {
  const s = STRINGS[input.locale];
  const env = input.env ?? process.env;
  const file = input.configPath ?? configFilePath(env);

  let cfg: PiReviewConfig = {};
  const configNotes: string[] = [];
  if (input.readConfig) {
    let text: string | null;
    try {
      text = input.readConfig(file);
    } catch (error) {
      configNotes.push(s.warnFile(String((error as Error).message)));
      text = null;
    }
    if (text !== null) {
      const load = parseReviewConfig(text);
      cfg = load.config;
      configNotes.push(...warnNotes(s, load.warnings));
    } else if (configNotes.length === 0) {
      configNotes.push(s.configFileMissing);
    }
  } else {
    const load = loadReviewConfigFile(file);
    cfg = load.config;
    configNotes.push(...warnNotes(s, load.warnings));
  }

  const decision = resolveChildExtensions(env, cfg);
  const sourceLabel =
    decision.source === "env" ? s.sourceEnv : decision.source === "config" ? s.sourceConfig : s.sourceDefault;

  const resolved = input.resolved ?? resolveConfig();
  const line = (key: string, value: string, description: string): string => {
    const head = `${key}: ${value}`;
    return [head, `  ${description}`].join("\n");
  };

  const lines: string[] = [];
  lines.push(s.header);
  lines.push(`childExtensions: ${decision.enabled} (${sourceLabel})`);
  lines.push(`  ${s.childExtensions}`);
  lines.push(`${s.configFileLabel}: ${file}`);
  for (const note of configNotes) lines.push(`  ${note}`);
  lines.push("");
  lines.push(s.envSection);
  lines.push(line("piBin", resolved.piBin, s.piBin));
  lines.push(line("reviewHome", resolved.reviewHome, s.reviewHome));
  lines.push(line("presetsFile", resolved.presetsFile, s.presetsFile));
  lines.push(line("panelPresetsFile", resolved.panelPresetsFile, s.panelPresetsFile));
  lines.push(line("systemPromptFile", resolved.systemPromptFile, s.systemPromptFile));
  lines.push(line("sessionsRoot", resolved.sessionsRoot, s.sessionsRoot));
  return lines;
}
