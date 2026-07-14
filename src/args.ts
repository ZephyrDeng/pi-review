import type { ParsedArgs } from "./types.js";
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
  -h, --help                                  Show help

Session (single review only; rejected by loop):
  --keep-session                              Persist the review session for follow-up
  --continue <sessionHandle>                  Continue an existing review session
  --name <name>                               Session name (with --keep-session)

Exit codes:
  0 clean | 1 findings remain | 2 usage | 3 needs human | 4 blocked/runtime failure

Examples:
  pi-review models
  pi-review -- @src/foo.ts
  pi-review --model openai/gpt-5.5 -- @src/foo.ts
  pi-review --mode challenge --keep-session -- @design.md
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

  return options;
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
