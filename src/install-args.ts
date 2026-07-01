import type { ParsedArgs } from "./types.js";

export function parseInstallCommand(argv: string[]): ParsedArgs {
  let installPi = true;
  let installAgents = true;
  const agentArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      return {
        command: "install",
        extraArgs: ["--help"],
        mode: "code",
        skills: [],
        payload: [],
        keepSession: false,
        stream: true,
        installPi: true,
        installAgents: true,
      };
    }
    if (arg === "--pi-only") {
      installPi = true;
      installAgents = false;
      continue;
    }
    if (arg === "--agents-only") {
      installPi = false;
      installAgents = true;
      continue;
    }
    agentArgs.push(arg);
  }

  return {
    command: "install",
    extraArgs: agentArgs,
    mode: "code",
    skills: [],
    payload: [],
    keepSession: false,
    stream: true,
    installPi,
    installAgents,
  };
}

export function isInstallHelp(parsed: ParsedArgs): boolean {
  return parsed.command === "install" && (parsed.extraArgs?.includes("--help") || parsed.extraArgs?.includes("-h") || false);
}