import type { ParsedArgs } from "./types.js";

function usage(exitCode = 0): never {
  const out = `Usage:
  pi-review models [search]
  pi-review [options] -- <@files|text...>
  pi-review update                      Update to the latest version
  pi-review install-skill [options]     Install skill to AI agents
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
  -h, --help                                  Show help

Session (requires Pi session support):
  --keep-session                              Persist the review session for follow-up
  --continue <sessionHandle>                  Continue an existing review session
  --name <name>                               Session name (with --keep-session)

Examples:
  pi-review models
  pi-review -- @src/foo.ts
  pi-review --model openai/gpt-5.5 -- @src/foo.ts
  pi-review --mode challenge --keep-session -- @design.md
  pi-review install-skill
`;
  (exitCode === 0 ? process.stdout : process.stderr).write(out);
  process.exit(exitCode);
}

function requireValue(flag: string, argv: string[]): string {
  if (argv.length === 0 || argv[0] === "--") {
    process.stderr.write(`pi-review: ${flag} requires a value\n`);
    process.exit(2);
  }
  return argv.shift()!;
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") usage(0);
  if (argv[0] === "models") {
    return { command: "models", search: argv.slice(1), mode: "code", skills: [], payload: [], keepSession: false, stream: true };
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

  let mode = "code";
  if (argv[0] && !argv[0].startsWith("-")) {
    mode = argv.shift()!;
  }

  const options: ParsedArgs = {
    command: "review",
    mode,
    skills: [],
    payload: [],
    keepSession: false,
    stream: true,
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
        usage(0);
        break;
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
      default:
        if (arg.startsWith("--")) {
          process.stderr.write(`pi-review: unknown option: ${arg}\n`);
          process.exit(2);
        }
        options.payload.push(arg, ...argv);
        argv.length = 0;
        break;
    }
  }

  if (options.keepSession && options.continueHandle) {
    process.stderr.write("pi-review: --keep-session and --continue cannot be used together\n");
    process.exit(2);
  }

  if (options.progressLog && !options.stream) {
    process.stderr.write("pi-review: --progress-log cannot be used with --no-stream\n");
    process.exit(2);
  }

  return options;
}
