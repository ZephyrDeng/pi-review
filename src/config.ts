import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const DEFAULT_RESOURCE_DIR = path.join(PACKAGE_ROOT, "resources");
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".pi", "pi-review");

export interface Config {
  piBin: string;
  presetsFile: string;
  panelPresetsFile: string;
  systemPromptFile: string;
  sessionsRoot: string;
  reviewHome: string;
}

export function resolveConfig(): Config {
  const reviewHome = process.env.PI_REVIEW_HOME || DEFAULT_RESOURCE_DIR;
  return {
    piBin: process.env.PI_BIN || "pi",
    reviewHome,
    presetsFile: process.env.PI_REVIEW_PRESETS || path.join(reviewHome, "review-presets.json"),
    panelPresetsFile: process.env.PI_REVIEW_PANEL_PRESETS || path.join(reviewHome, "panel-presets.json"),
    systemPromptFile: process.env.PI_REVIEW_SYSTEM_PROMPT || path.join(reviewHome, "system-prompt.md"),
    sessionsRoot: process.env.PI_REVIEW_SESSION_DIR || path.join(DEFAULT_DATA_DIR, "sessions"),
  };
}
