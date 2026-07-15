import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelInfo } from "./rv-completions.js";

export type PresetModelEntry = {
  idContains: string;
  thinking?: string;
  versionPrefer?: string;
};

export type ReviewModelPriorities = {
  code: PresetModelEntry[];
  frontend: PresetModelEntry[];
  plan: PresetModelEntry[];
};

/**
 * Default priorities when resources/rv-model-priorities.json is missing.
 * - code: fast review
 * - plan: complex / architecture / 方案评审 (max thinking)
 * - frontend: vision / UI / multimodal
 */
export const DEFAULT_REVIEW_MODEL_PRIORITIES: ReviewModelPriorities = {
  code: [
    { idContains: "claude-sonnet", versionPrefer: "5", thinking: "xhigh" },
    { idContains: "deepseek-v4-flash", thinking: "xhigh" },
    { idContains: "glm-5.2", thinking: "xhigh" },
    { idContains: "minimax-m3", thinking: "xhigh" },
    { idContains: "grok-4.5", thinking: "xhigh" },
    { idContains: "gpt-5.6-terra" },
    { idContains: "gpt-5.6-luna", thinking: "xhigh" },
  ],
  frontend: [
    { idContains: "claude" },
    { idContains: "gpt" },
    { idContains: "kimi", versionPrefer: "2.7" },
    { idContains: "minimax-m3", thinking: "xhigh" },
  ],
  plan: [
    { idContains: "gpt-5.6-sol", thinking: "xhigh" },
    { idContains: "claude-opus-4-8", thinking: "xhigh" },
    { idContains: "claude-opus-4", versionPrefer: "8", thinking: "xhigh" },
    { idContains: "claude-fable-5", thinking: "xhigh" },
    { idContains: "glm-5.2", thinking: "xhigh" },
    { idContains: "deepseek-v4-pro", thinking: "xhigh" },
    { idContains: "grok-4.5", thinking: "xhigh" },
  ],
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PRIORITIES_PATH = path.resolve(__dirname, "../resources/rv-model-priorities.json");

export function loadReviewModelPriorities(
  filePath: string = process.env.PI_REVIEW_RV_PRIORITIES || DEFAULT_PRIORITIES_PATH,
): ReviewModelPriorities {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ReviewModelPriorities>;
    return {
      code: parsed.code?.length ? parsed.code : DEFAULT_REVIEW_MODEL_PRIORITIES.code,
      frontend: parsed.frontend?.length ? parsed.frontend : DEFAULT_REVIEW_MODEL_PRIORITIES.frontend,
      plan: parsed.plan?.length ? parsed.plan : DEFAULT_REVIEW_MODEL_PRIORITIES.plan,
    };
  } catch {
    return DEFAULT_REVIEW_MODEL_PRIORITIES;
  }
}

export type ReviewProfile = "code" | "frontend" | "plan";

const FRONTEND_EXTS = new Set([
  "vue", "svelte", "css", "scss", "sass", "less", "styl", "html", "htm",
]);

export function resolveReviewProfile(mode: string, targetExt?: string): ReviewProfile {
  if (mode === "plan" || mode === "challenge") return "plan";
  if (targetExt && FRONTEND_EXTS.has(targetExt)) return "frontend";
  return "code";
}

function idVersionSortKey(id: string): string {
  return id.toLowerCase();
}

export function matchPresetEntry(
  models: ModelInfo[],
  entry: PresetModelEntry,
): ModelInfo | undefined {
  const needle = entry.idContains.toLowerCase();
  let candidates = models.filter((m) => m.id.toLowerCase().includes(needle));
  if (entry.versionPrefer) {
    const vp = entry.versionPrefer.toLowerCase();
    const withVersion = candidates.filter((m) => m.id.toLowerCase().includes(vp));
    if (withVersion.length) candidates = withVersion;
  }
  if (!candidates.length) return undefined;
  candidates.sort((a, b) =>
    idVersionSortKey(b.id).localeCompare(idVersionSortKey(a.id), undefined, { numeric: true }),
  );
  return candidates[0];
}

export type ResolvedPresetModel = {
  model: ModelInfo;
  thinking?: string;
  presetRank: number;
  presetLabel: string;
};

export function resolvePresetOrderedModels(
  models: ModelInfo[],
  profile: ReviewProfile,
  priorities: ReviewModelPriorities,
): ResolvedPresetModel[] {
  const rows = priorities[profile];
  const seen = new Set<string>();
  const out: ResolvedPresetModel[] = [];
  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i];
    const matched = matchPresetEntry(models, entry);
    if (!matched || seen.has(matched.label)) continue;
    seen.add(matched.label);
    out.push({
      model: matched,
      thinking: entry.thinking,
      presetRank: i,
      presetLabel: entry.idContains,
    });
  }
  return out;
}

export function rankModelsWithPresets(
  models: ModelInfo[],
  profile: ReviewProfile,
  priorities: ReviewModelPriorities,
): ModelInfo[] {
  const preset = resolvePresetOrderedModels(models, profile, priorities);
  const presetLabels = new Set(preset.map((p) => p.model.label));
  const rest = models
    .filter((m) => !presetLabels.has(m.label))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...preset.map((p) => p.model), ...rest];
}

export function primaryPresetForProfile(
  models: ModelInfo[],
  profile: ReviewProfile,
  priorities: ReviewModelPriorities,
): ResolvedPresetModel | undefined {
  return resolvePresetOrderedModels(models, profile, priorities)[0];
}