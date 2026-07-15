/**
 * Interactive /rv and /rv-loop wizard using Pi dialog APIs (select/input/confirm).
 * Pure orchestration over injected UI so it is unit-testable without a TUI.
 */

import type { ModelInfo } from "./rv-completions.js";
import type { RvLocale } from "./rv-locale.js";
import { rvUi } from "./rv-locale.js";
import {
  RV_CLEAN_GOAL,
  RV_CONSENSUS_POLICIES,
  RV_LOOP_DEFAULT_MAX_ROUNDS,
  RV_LOOP_UNTIL_CLEAN_DEFAULT_MAX_ROUNDS,
  type RvConsensusPolicy,
  type RvParsed,
  type RvStrategy,
} from "./rv-prompts.js";
import {
  DEFAULT_REVIEW_MODEL_PRIORITIES,
  loadReviewModelPriorities,
  rankModelsWithPresets,
  resolveReviewProfile,
  type ReviewProfile,
} from "./rv-model-priorities.js";

export type InteractiveUi = {
  select: (title: string, options: string[]) => Promise<string | undefined>;
  input: (title: string, placeholder?: string) => Promise<string | undefined>;
  confirm: (title: string, message: string) => Promise<boolean>;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
};

export type InteractiveWizardInput = {
  strategy: Exclude<RvStrategy, "models">;
  /** Already-parsed partial from the command line (flags + optional target). */
  seed: RvParsed;
  models: ModelInfo[];
  locale: RvLocale;
  primaryProvider?: string;
};

const CANCEL = Symbol("cancel");

function profileFor(mode: string): ReviewProfile {
  return resolveReviewProfile(mode);
}

function rankedModelLabels(models: ModelInfo[], mode: string): string[] {
  if (models.length === 0) return [];
  const profile = profileFor(mode);
  const priorities = loadReviewModelPriorities();
  return rankModelsWithPresets(models, profile, priorities).map((m) => m.label);
}

function modelByLabel(models: ModelInfo[], label: string): ModelInfo | undefined {
  return models.find((m) => m.label === label);
}

function thinkingOptions(model: ModelInfo | undefined, locale: RvLocale): string[] {
  const levels = model?.thinkingLevels?.length ? model.thinkingLevels : ["high", "xhigh", "medium", "low", "off"];
  const skip = locale === "zh" ? "跳过（默认）" : "Skip (default)";
  return [skip, ...levels];
}

function stripSkip(choice: string | undefined, locale: RvLocale): string | undefined {
  if (!choice) return undefined;
  if (choice.startsWith("Skip") || choice.startsWith("跳过")) return undefined;
  return choice;
}

async function mustSelect(ui: InteractiveUi, title: string, options: string[]): Promise<string | typeof CANCEL> {
  if (options.length === 0) return CANCEL;
  const choice = await ui.select(title, options);
  return choice ?? CANCEL;
}

/**
 * Build a fully populated RvParsed via dialogs.
 * Returns undefined if the user cancels any required step.
 */
export async function runRvInteractiveWizard(
  ui: InteractiveUi,
  input: InteractiveWizardInput,
): Promise<RvParsed | undefined> {
  const { strategy, seed, models, locale } = input;
  const zh = locale === "zh";
  const uiText = rvUi(locale);

  // 1) Target
  let target = seed.target.trim();
  if (!target) {
    const entered = await ui.input(
      zh ? "审查目标（自然语言或 @路径）" : "Review target (natural language or @path)",
      zh ? "例如：@src 或 review the auth changes" : "e.g. @src or review the auth changes",
    );
    if (!entered?.trim()) {
      ui.notify(zh ? "已取消：需要审查目标" : "Cancelled: target required", "warning");
      return undefined;
    }
    target = entered.trim();
  }

  // 2) Mode
  let mode = seed.mode || "code";
  if (!seed.mode || seed.mode === "code") {
    const modeChoice = await mustSelect(
      ui,
      zh ? "审查模式" : "Review mode",
      [
        `${uiText.modeCode} (code)`,
        `${uiText.modePlan} (plan)`,
        `${uiText.modeChallenge} (challenge)`,
      ],
    );
    if (modeChoice === CANCEL) return undefined;
    if (modeChoice.includes("(plan)")) mode = "plan";
    else if (modeChoice.includes("(challenge)")) mode = "challenge";
    else mode = "code";
  }

  // 3) Loop goal + hard budget — always ask for /rv-loop so the stop condition is explicit.
  let until = seed.until;
  let maxRounds = seed.maxRounds;
  if (strategy === "loop") {
    const goal = await mustSelect(
      ui,
      zh ? "Loop 目标" : "Loop goal",
      [
        zh
          ? "单轮门禁（修完再手动 /rv-loop）· 推荐"
          : "Single gate (fix then re-run /rv-loop) · recommended",
        zh
          ? "until clean · 审→修→再审直到 clean（有硬预算）"
          : "until clean · review→fix→re-review until clean (hard budget)",
      ],
    );
    if (goal === CANCEL) return undefined;
    if (goal.includes("until clean")) {
      until = "clean";
      const current = maxRounds ?? RV_LOOP_UNTIL_CLEAN_DEFAULT_MAX_ROUNDS;
      const budget = await mustSelect(
        ui,
        zh
          ? `until-clean 硬预算 max-rounds（当前 ${current}）· 不是无限`
          : `until-clean hard budget max-rounds (current ${current}) · not unlimited`,
        [
          zh ? `5 · 最多 5 个 host 周期` : `5 · up to 5 host cycles`,
          zh ? `10 · 默认` : `10 · default`,
          zh ? `15 · 更长` : `15 · longer`,
          zh ? `20 · 上限偏松` : `20 · looser cap`,
        ].sort((a, b) => (Number(a.split(" · ")[0]) === current ? -1 : Number(b.split(" · ")[0]) === current ? 1 : 0)),
      );
      if (budget === CANCEL) return undefined;
      maxRounds = Number(budget.split(" · ")[0]) || RV_LOOP_UNTIL_CLEAN_DEFAULT_MAX_ROUNDS;
    } else {
      until = undefined;
      const current = maxRounds ?? RV_LOOP_DEFAULT_MAX_ROUNDS;
      const options = [
        zh ? `1 · 修一次再审（推荐）` : `1 · host fix point (recommended)`,
        zh ? `2 · 两轮` : `2 · two gates`,
        zh ? `3 · 三轮` : `3 · three gates`,
      ];
      const ordered = [...options].sort((a, b) => {
        const av = Number(a[0]) === current ? 0 : 1;
        const bv = Number(b[0]) === current ? 0 : 1;
        return av - bv;
      });
      const rounds = await mustSelect(
        ui,
        zh
          ? `审查轮数 max-rounds（当前 ${current}）· 与 reviewers 人数无关`
          : `Review rounds max-rounds (current ${current}) · not reviewer count`,
        ordered,
      );
      if (rounds === CANCEL) return undefined;
      maxRounds = Number(rounds[0]) || RV_LOOP_DEFAULT_MAX_ROUNDS;
    }
  }

  // 4) Panel shape: preset vs N reviewers
  let panel = seed.panel;
  let reviewers = seed.reviewers;
  const reviewerModels = [...(seed.reviewerModels ?? [])];

  if (!panel && reviewers === undefined) {
    const shape = await mustSelect(
      ui,
      zh ? "Panel 形态" : "Panel shape",
      [
        zh ? "预设 code-experts（正确性/安全/测试）" : "Preset code-experts (correctness/security/testing)",
        zh ? "自定义人数 2–8（r1..rN，可逐个选模型）" : "Custom reviewer count 2–8 (r1..rN, pick models)",
        // Single-reviewer is a different product path (no panel). Keep it explicit and rare.
        zh ? "单 reviewer 非 panel（无共识，仅 shell 单审查）" : "Single reviewer non-panel (no consensus; shell single review)",
      ],
    );
    if (shape === CANCEL) return undefined;
    if (shape.includes("code-experts") || shape.includes("Preset")) {
      panel = "code-experts";
    } else if (shape.includes("non-panel") || shape.includes("非 panel") || shape.includes("Single reviewer non-panel")) {
      // Explicit non-panel single review. Parent must use shell CLI, not pi_review panel tool.
      reviewers = 1;
      panel = undefined;
    } else {
      const countChoice = await mustSelect(
        ui,
        zh ? "独立 reviewer 人数（宽度，≥2 才是 panel）" : "Independent reviewers (width, panel requires ≥2)",
        ["2", "3", "4", "5"],
      );
      if (countChoice === CANCEL) return undefined;
      reviewers = Number(countChoice);
    }
  }

  // Keep reviewers=1 explicit: orchestration uses it to select the non-panel shell path.
  // Collapsing it to undefined would be indistinguishable from the default code-experts panel.

  // 5) Per-reviewer models via select dialogs (no tab completion)
  const ids =
    panel === "code-experts"
      ? ["correctness", "security", "testing"]
      : reviewers && reviewers > 1
        ? Array.from({ length: reviewers }, (_, i) => `r${i + 1}`)
        : [];

  const labels = rankedModelLabels(models, mode);
  const sharedDefault =
    seed.model ??
    (labels[0]
      ? undefined
      : undefined);

  if (ids.length > 0) {
    const assignEach = await ui.confirm(
      zh ? "为每位 reviewer 选择模型？" : "Pick a model for each reviewer?",
      zh
        ? `将依次为 ${ids.join(", ")} 弹出模型列表（方向键选择，回车确认）。选「同一模型」可共用。`
        : `You will pick models for ${ids.join(", ")} from a list (arrows + enter). Choose "Same model for all" to share.`,
    );

    if (assignEach) {
      const sameFirst = await mustSelect(
        ui,
        zh ? "模型分配方式" : "Model assignment",
        [
          zh ? "每位 reviewer 分别选择" : "Pick separately for each reviewer",
          zh ? "所有 reviewer 使用同一模型" : "Same model for all reviewers",
        ],
      );
      if (sameFirst === CANCEL) return undefined;

      if (sameFirst.includes("Same") || sameFirst.includes("同一")) {
        if (labels.length === 0) {
          ui.notify(zh ? "当前没有可用模型目录，请先 /rv-models" : "No model catalog available; run /rv-models first", "warning");
        } else {
          const pick = await mustSelect(ui, zh ? "共用模型" : "Shared model", labels.slice(0, 40));
          if (pick === CANCEL) return undefined;
          const m = modelByLabel(models, pick);
          const thinkingPick = await mustSelect(
            ui,
            zh ? `思考强度（${pick}）` : `Thinking (${pick})`,
            thinkingOptions(m, locale),
          );
          if (thinkingPick === CANCEL) return undefined;
          const thinking = stripSkip(thinkingPick, locale);
          const token = thinking ? `${pick}:${thinking}` : pick;
          for (const id of ids) reviewerModels.push(`${id}=${token}`);
        }
      } else {
        for (const id of ids) {
          if (labels.length === 0) break;
          const pick = await mustSelect(
            ui,
            zh ? `模型 · ${id}` : `Model · ${id}`,
            labels.slice(0, 40),
          );
          if (pick === CANCEL) return undefined;
          const m = modelByLabel(models, pick);
          const thinkingPick = await mustSelect(
            ui,
            zh ? `思考强度 · ${id}` : `Thinking · ${id}`,
            thinkingOptions(m, locale),
          );
          if (thinkingPick === CANCEL) return undefined;
          const thinking = stripSkip(thinkingPick, locale);
          reviewerModels.push(`${id}=${thinking ? `${pick}:${thinking}` : pick}`);
        }
      }
    } else if (!seed.model && labels.length > 0) {
      // Shared default model when not assigning per-reviewer
      const pick = await mustSelect(ui, zh ? "默认模型（全体 reviewer）" : "Default model (all reviewers)", [
        ...(zh ? ["跳过（用 Pi 默认）"] : ["Skip (Pi default)"]),
        ...labels.slice(0, 40),
      ]);
      if (pick === CANCEL) return undefined;
      const model = stripSkip(pick, locale);
      if (model) {
        const m = modelByLabel(models, model);
        const thinkingPick = await mustSelect(
          ui,
          zh ? "默认思考强度" : "Default thinking",
          thinkingOptions(m, locale),
        );
        if (thinkingPick === CANCEL) return undefined;
        const thinking = stripSkip(thinkingPick, locale);
        seed.model = model;
        if (thinking) seed.thinking = thinking;
      }
    }
  } else if (!seed.model && labels.length > 0) {
    // Single-reviewer path
    const pick = await mustSelect(ui, zh ? "模型" : "Model", [
      ...(zh ? ["跳过（用 Pi 默认）"] : ["Skip (Pi default)"]),
      ...labels.slice(0, 40),
    ]);
    if (pick === CANCEL) return undefined;
    const model = stripSkip(pick, locale);
    if (model) {
      seed.model = model;
      const m = modelByLabel(models, model);
      const thinkingPick = await mustSelect(ui, zh ? "思考强度" : "Thinking", thinkingOptions(m, locale));
      if (thinkingPick === CANCEL) return undefined;
      const thinking = stripSkip(thinkingPick, locale);
      if (thinking) seed.thinking = thinking;
    }
  }

  // 6) Consensus when multi-reviewer
  let consensus = seed.consensus;
  let minAgree = seed.minAgree;
  if ((panel || (reviewers ?? 0) > 1) && !consensus) {
    const c = await mustSelect(
      ui,
      zh ? "共识策略" : "Consensus policy",
      RV_CONSENSUS_POLICIES.map((p) => {
        if (p === "quorum") return zh ? "quorum · 至少 min-agree 人同意（默认）" : "quorum · at least min-agree agree (default)";
        if (p === "majority") return zh ? "majority · 过半数" : "majority · floor(n/2)+1";
        if (p === "unanimous") return zh ? "unanimous · 全员同意" : "unanimous · all must agree";
        return zh ? "any · 任一即可" : "any · single actionable reviewer";
      }),
    );
    if (c === CANCEL) return undefined;
    consensus = c.split(" · ")[0] as RvConsensusPolicy;
    if (consensus === "quorum" && minAgree === undefined) {
      const m = await mustSelect(
        ui,
        zh ? "quorum 最少同意人数" : "Quorum min-agree",
        ["2", "3", "4"],
      );
      if (m === CANCEL) return undefined;
      minAgree = Number(m);
    }
  }

  // 7) Confirm summary
  const summaryLines = [
    `${zh ? "策略" : "Strategy"}: ${strategy}`,
    `${zh ? "目标" : "Target"}: ${target}`,
    `${zh ? "模式" : "Mode"}: ${mode}`,
    strategy === "loop"
      ? until === "clean"
        ? `${zh ? "目标" : "Goal"}: until clean · budget ${maxRounds ?? RV_LOOP_UNTIL_CLEAN_DEFAULT_MAX_ROUNDS}\n${zh ? "Clean 定义" : "Clean means"}: ${RV_CLEAN_GOAL.summary}`
        : `${zh ? "审查轮数 max-rounds" : "Review rounds max-rounds"}: ${maxRounds ?? RV_LOOP_DEFAULT_MAX_ROUNDS}`
      : `${zh ? "审查轮数" : "Review rounds"}: 1 (${zh ? "/rv 单次 panel，无 loop" : "/rv is a single panel gate"})`,
    panel
      ? `panel: ${panel}`
      : reviewers
        ? `${zh ? "每轮 reviewers" : "reviewers per round"}: ${reviewers}`
        : zh
          ? "单 reviewer"
          : "single reviewer",
    seed.model ? `model: ${seed.model}${seed.thinking ? `:${seed.thinking}` : ""}` : "",
    reviewerModels.length ? `reviewer-models: ${reviewerModels.join(", ")}` : "",
    consensus ? `consensus: ${consensus}${minAgree ? ` min-agree=${minAgree}` : ""}` : "",
  ].filter(Boolean);

  const ok = await ui.confirm(
    zh ? "确认开始审查？" : "Start review?",
    summaryLines.join("\n"),
  );
  if (!ok) {
    ui.notify(zh ? "已取消" : "Cancelled", "info");
    return undefined;
  }

  return {
    ...seed,
    strategy,
    mode,
    target,
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    ...(until ? { until } : {}),
    ...(panel ? { panel } : {}),
    ...(reviewers !== undefined ? { reviewers } : {}),
    ...(reviewerModels.length ? { reviewerModels } : {}),
    ...(seed.model ? { model: seed.model } : {}),
    ...(seed.thinking ? { thinking: seed.thinking } : {}),
    ...(consensus ? { consensus } : {}),
    ...(minAgree !== undefined ? { minAgree } : {}),
    keepSession: seed.keepSession,
    noStream: seed.noStream,
    modelsOnly: false,
  };
}

const INTERACTIVE_TOKEN_RE = /(?:^|\s)(?:interactive|--interactive|-i)(?=\s|$)/i;

/** True when the invocation should open the interactive wizard. */
export function shouldRunInteractiveWizard(rawArgs: string, parsed: RvParsed): boolean {
  const trimmed = rawArgs.trim();
  if (!trimmed) return true;
  if (INTERACTIVE_TOKEN_RE.test(` ${trimmed} `) || /^(interactive|--interactive|-i)\b/i.test(trimmed)) {
    return true;
  }
  // Power users with full flags are never interrupted unless they ask for interactive.
  void parsed;
  return false;
}

/** Remove interactive trigger tokens anywhere in the arg string. */
export function stripInteractiveToken(rawArgs: string): string {
  return rawArgs
    .replace(/(?:^|\s)(?:interactive|--interactive|-i)(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
