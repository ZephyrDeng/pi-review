import fs from "node:fs";
import type { ReviewPreset } from "./types.js";
import { fail } from "./utils.js";

export function loadPresets(presetsFile: string): Record<string, ReviewPreset> {
  if (!fs.existsSync(presetsFile)) {
    fail(`preset file not found: ${presetsFile}`);
  }
  try {
    return JSON.parse(fs.readFileSync(presetsFile, "utf8"));
  } catch (error) {
    fail(`failed to read preset file ${presetsFile}: ${(error as Error).message}`);
  }
}

export function loadSystemPrompt(systemPromptFile: string): string {
  if (!fs.existsSync(systemPromptFile)) return "";
  try {
    return fs.readFileSync(systemPromptFile, "utf8").trim();
  } catch (error) {
    fail(`failed to read system prompt ${systemPromptFile}: ${(error as Error).message}`);
  }
}
