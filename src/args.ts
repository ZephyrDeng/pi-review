import type { ParsedArgs } from "./types.js";
import { CONSENSUS_POLICIES, MAX_REVIEWERS } from "./types.js";
import { parseInstallCommand } from "./install-args.js";

export function usage(exitCode = 0): never {
  const out = `Usage:
  pi-review models [search]
  pi-review [review] [options] -- <@files|text...>
  pi-review loop [options] -- <@files|text...>
  pi-review update                      Update to the latest version
  pi-review install [options]           Pi package + agent skills (one-shot)
  pi-review install-skill [options]     Install skill to AI agents only
  pi-review uninstall-skill [options]  Remove skill from AI agents

Requires Pi CLI (https://pi.dev) to be installed and configured.

Options:
  --mode <name>                                Review mode: code, plan, challenge (default: code)
  --model <provider/model[:thinking]|pattern>  Model for child pi session
  --provider <name>                           Model provider
  --thinking <level>                          off|minimal|low|medium|high|xhigh
  --skill <path>                              Load an extra pi skill (repeatable)
  --tools <csv>                               Override allowed tools
  --no-stream                                 Buffer child output until exit (default: stream live)
  --progress-log <path>                       Stream child --mode json events to this file (cannot combine with --no-stream)
  --max-rounds <n>                            Loop review budget (default: 3; loop only)
  --reviewers <n>                             Panel: number of independent reviewers (2-8; activates panel mode)
  --panel <name>                              Panel: named expert-panel preset (cannot combine with --reviewers)
  --consensus <policy>                        Panel: any | quorum | majority | unanimous (default: quorum)
  --min-agree <n>                             Panel: minimum reviewers for quorum (default: 2; quorum only)
  --consensus-model <model>                   Panel: model for semantic consensus adjudication
  --concurrency <n>                           Panel: bounded reviewer concurrency (default: reviewer count)
  --output-format <events-jsonl>              Panel: emit normalized ReviewEvent v1 JSONL to stdout
  -h, --help                                  Show help

Session (single review only; rejected by loop and panel):
  --keep-session                              Persist the review session for follow-up
  --continue <sessionHandle>                  Continue an existing review session
  --name <name>                               Session name (with --keep-session)

Exit codes:
  0 clean | 1 findings remain | 2 usage | 3 needs human | 4 blocked/runtime failure

Panel cost: reviewer runs = --reviewers <n> times --max-rounds (loop), plus one
consensus-adjudication call per round when --consensus-model is set. Single-review
commands (default, no --reviewers/--panel) keep the existing low-cost workflow.

Examples:
  pi-review models
  pi-review -- @src/foo.ts
  pi-review --model openai/gpt-5.5 -- @src/foo.ts
  pi-review --mode challenge --keep-session -- @design.md
  pi-review --reviewers 3 --consensus quorum --min-agree 2 -- @src
  pi-review --panel code-experts --consensus majority -- @src
  pi-review loop --reviewers 3 --consensus quorum --max-rounds 3 -- @src
  pi-review loop --max-rounds 3 -- @src
  pi-review install
  pi-review install --agent claude-code codex -y
  pi-review install-skill
`;
  (exitCode === 0 ? process.stdout : process.stderr).write(out);
  process.exit(exitCode);
}

export const DEFAULT_MAX_ROUNDS = 3;

export class ArgsParseError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message);
    this.name = "ArgsParseError";
  }
}

function requireValue(flag: string, argv: string[]): string {
  if (argv.length === 0 || argv[0] === "--") {
    throw new ArgsParseError(`${flag} requires a value`);
  }
  return argv.shift()!;
}

function parsePositiveInteger(flag: string, value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ArgsParseError(`${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ArgsParseError(`${flag} must be a safe positive integer`);
  }
  return parsed;
}

/** Pure parser for the review and loop command seam. */
export function parseReviewCommand(input: string[]): ParsedArgs {
  const argv = [...input];
  let command: ParsedArgs["command"] = "review";
  if (argv[0] === "review" || argv[0] === "loop") {
    command = argv.shift() as "review" | "loop";
  }

  let mode = "code";
  if (argv[0] && !argv[0].startsWith("-")) {
    mode = argv.shift()!;
  }

  const options: ParsedArgs = {
    command,
    mode,
    skills: [],
    payload: [],
    keepSession: false,
    stream: true,
    ...(command === "loop" ? { maxRounds: DEFAULT_MAX_ROUNDS } : {}),
  };

  while (argv.length > 0) {
    const arg = argv.shift()!;
    if (arg === "--") {
      options.payload = argv.slice();
      break;
    }
    switch (arg) {
      case "-h":
      case "--help":
        throw new ArgsParseError("", 0);
      case "--mode":
        options.mode = requireValue(arg, argv);
        break;
      case "--keep-session":
        options.keepSession = true;
        break;
      case "--continue":
        options.continueHandle = requireValue(arg, argv);
        break;
      case "--model":
        options.model = requireValue(arg, argv);
        break;
      case "--provider":
        options.provider = requireValue(arg, argv);
        break;
      case "--thinking":
        options.thinking = requireValue(arg, argv);
        break;
      case "--skill":
        options.skills.push(requireValue(arg, argv));
        break;
      case "--tools":
        options.tools = requireValue(arg, argv);
        break;
      case "--name":
        options.name = requireValue(arg, argv);
        break;
      case "--no-stream":
        options.stream = false;
        break;
      case "--progress-log":
        options.progressLog = requireValue(arg, argv);
        break;
      case "--max-rounds":
        options.maxRounds = parsePositiveInteger(arg, requireValue(arg, argv));
        break;
      case "--reviewers":
        options.reviewers = parsePositiveInteger(arg, requireValue(arg, argv));
        break;
      case "--panel":
        options.panel = requireValue(arg, argv);
        break;
      case "--consensus":
        options.consensus = requireValue(arg, argv);
        break;
      case "--min-agree":
        options.minAgree = parsePositiveInteger(arg, requireValue(arg, argv));
        break;
      case "--consensus-model":
        options.consensusModel = requireValue(arg, argv);
        break;
      case "--concurrency":
        options.concurrency = parsePositiveInteger(arg, requireValue(arg, argv));
        break;
      case "--output-format": {
        const format = requireValue(arg, argv);
        if (format !== "events-jsonl") throw new ArgsParseError("--output-format must be events-jsonl");
        options.outputFormat = format;
        break;
      }
      default:
        if (arg.startsWith("--")) {
          throw new ArgsParseError(`unknown option: ${arg}`);
        }
        options.payload.push(arg, ...argv);
        argv.length = 0;
        break;
    }
  }

  if (options.keepSession && options.continueHandle) {
    throw new ArgsParseError("--keep-session and --continue cannot be used together");
  }
  if (options.progressLog && !options.stream) {
    throw new ArgsParseError("--progress-log cannot be used with --no-stream");
  }
  if (command !== "loop" && options.maxRounds !== undefined) {
    throw new ArgsParseError("--max-rounds can only be used with loop");
  }
  if (command === "loop" && (options.keepSession || options.continueHandle || options.name)) {
    throw new ArgsParseError("loop cannot be used with --keep-session, --continue, or --name");
  }

  validatePanelOptions(options);

  return options;
}

function validatePanelOptions(options: ParsedArgs): void {
  const hasReviewers = options.reviewers !== undefined;
  const reviewerCount = options.reviewers ?? 1;
  const panelActive = reviewerCount > 1 || options.panel !== undefined;
  const anyPanelOption =
    options.consensus !== undefined ||
    options.minAgree !== undefined ||
    options.consensusModel !== undefined ||
    options.concurrency !== undefined;

  if (hasReviewers && options.reviewers! > MAX_REVIEWERS) {
    throw new ArgsParseError(`--reviewers must be between 1 and ${MAX_REVIEWERS}`);
  }
  if (hasReviewers && options.panel) {
    throw new ArgsParseError("--reviewers cannot be used with --panel");
  }
  if (!panelActive && anyPanelOption) {
    throw new ArgsParseError("panel options require --reviewers > 1 or --panel");
  }
  if (!panelActive && options.outputFormat) {
    throw new ArgsParseError("--output-format events-jsonl requires an active panel");
  }
  if (panelActive && (options.keepSession || options.continueHandle || options.name)) {
    throw new ArgsParseError("panel cannot be used with --keep-session, --continue, or --name");
  }
  if (options.consensus !== undefined && !(CONSENSUS_POLICIES as readonly string[]).includes(options.consensus)) {
    throw new ArgsParseError(
      `unknown consensus policy: ${options.consensus}. Available: ${CONSENSUS_POLICIES.join(", ")}`,
    );
  }
  if (options.minAgree !== undefined) {
    if (options.consensus !== undefined && options.consensus !== "quorum") {
      throw new ArgsParseError("--min-agree is only meaningful with --consensus quorum");
    }
    if (hasReviewers && !options.panel && options.minAgree > options.reviewers!) {
      throw new ArgsParseError(`--min-agree ${options.minAgree} cannot exceed reviewer count ${options.reviewers}`);
    }
  }
  if (options.concurrency !== undefined && hasReviewers && !options.panel && options.concurrency > options.reviewers!) {
    throw new ArgsParseError(`--concurrency ${options.concurrency} cannot exceed reviewer count ${options.reviewers}`);
  }
}

export function isPanelActive(options: Pick<ParsedArgs, "reviewers" | "panel">): boolean {
  return (options.reviewers !== undefined && options.reviewers > 1) || options.panel !== undefined;
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") usage(0);
  if (argv[0] === "models") {
    return { command: "models", search: argv.slice(1), mode: "code", skills: [], payload: [], keepSession: false, stream: true };
  }
  if (argv[0] === "install") {
    return parseInstallCommand(argv.slice(1));
  }
  if (argv[0] === "install-skill") {
    return { command: "install-skill", extraArgs: argv.slice(1), mode: "code", skills: [], payload: [], keepSession: false, stream: true };
  }
  if (argv[0] === "uninstall-skill") {
    return { command: "uninstall-skill", extraArgs: argv.slice(1), mode: "code", skills: [], payload: [], keepSession: false, stream: true };
  }
  if (argv[0] === "update") {
    return { command: "update", mode: "code", skills: [], payload: [], keepSession: false, stream: true };
  }

  try {
    return parseReviewCommand(argv);
  } catch (error) {
    if (!(error instanceof ArgsParseError)) throw error;
    if (error.message) process.stderr.write(`pi-review: ${error.message}\n`);
    usage(error.exitCode);
  }
}
