/** Lightweight locale for /rv UI strings (no LLM). */

export type RvLocale = "en" | "zh";

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

function systemPrefersZh(env: NodeJS.ProcessEnv = process.env): boolean {
  const keys = ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"];
  for (const key of keys) {
    const value = env[key];
    if (!value) continue;
    if (/(^|[_\.\-])zh/i.test(value)) return true;
  }
  return false;
}

/**
 * Prefer Chinese when:
 * - recent session text has meaningful CJK, or
 * - system locale is zh and samples are empty/ambiguous.
 * Re-run this on each completion; session_start-only capture freezes English too early.
 */
export function detectRvLocale(textSamples: string[], env: NodeJS.ProcessEnv = process.env): RvLocale {
  let cjk = 0;
  let latin = 0;
  for (const sample of textSamples) {
    const t = sample.slice(0, 2000);
    for (const ch of t) {
      if (CJK_RE.test(ch)) cjk++;
      else if (/[a-zA-Z]/.test(ch)) latin++;
    }
  }
  if (cjk > 0 && cjk >= Math.max(1, latin * 0.05)) return "zh";
  if (cjk === 0 && latin === 0) return systemPrefersZh(env) ? "zh" : "en";
  if (systemPrefersZh(env) && cjk > 0) return "zh";
  return "en";
}

export type RvUiStrings = {
  modelsKeyword: string;
  modelsDesc: string;
  modeCode: string;
  modePlan: string;
  modeChallenge: string;
  keepSession: string;
  keepSessionDesc: string;
  listModels: string;
  listModelsDesc: string;
  codePreset: string;
  frontendPreset: string;
  planPreset: string;
  challengePreset: string;
  loopCodePreset: string;
  loopCodeDesc: string;
  loopTwoRounds: string;
  loopPlanPreset: string;
  presetHint: string;
  suggested: string;
  presetTier: (n: number) => string;
  thinkingSuggested: string;
};

const UI: Record<RvLocale, RvUiStrings> = {
  en: {
    modelsKeyword: "models",
    modelsDesc: "List pi-review models only",
    modeCode: "code review",
    modePlan: "plan review",
    modeChallenge: "challenge review",
    keepSession: "keep session for follow-up",
    keepSessionDesc: "Persist review session for /rv --continue",
    listModels: "list models",
    listModelsDesc: "Show provider/model catalog",
    codePreset: "Code review preset",
    frontendPreset: "Frontend preset",
    planPreset: "Plan review preset",
    challengePreset: "Challenge preset",
    loopCodePreset: "Loop closeout (code)",
    loopCodeDesc: "Host fixes, re-review until clean",
    loopTwoRounds: "Loop closeout (2 rounds)",
    loopPlanPreset: "Loop closeout (plan)",
    presetHint: "Type preset / code / plan for templates",
    suggested: "Suggested",
    presetTier: (n) => (n === 0 ? "Suggested" : `Preset #${n + 1}`),
    thinkingSuggested: "Suggested ",
  },
  zh: {
    modelsKeyword: "models",
    modelsDesc: "仅列出 pi-review 可用模型",
    modeCode: "代码审核",
    modePlan: "方案审核",
    modeChallenge: "对抗性审核",
    keepSession: "保留会话可追问",
    keepSessionDesc: "保留 review 会话，便于 /rv --continue",
    listModels: "查看模型列表",
    listModelsDesc: "列出当前可用 provider/model",
    codePreset: "代码审核预设",
    frontendPreset: "前端审核预设",
    planPreset: "方案审核预设",
    challengePreset: "对抗审核预设",
    loopCodePreset: "Loop 关单（代码）",
    loopCodeDesc: "宿主修 → 再审，直到 clean",
    loopTwoRounds: "Loop 两轮关单",
    loopPlanPreset: "Loop 关单（方案）",
    presetHint: "输入 预设 / 代码 / 方案 查看模板",
    suggested: "推荐",
    presetTier: (n) => (n === 0 ? "推荐" : `预设 #${n + 1}`),
    thinkingSuggested: "推荐 ",
  },
};

export function rvUi(locale: RvLocale): RvUiStrings {
  return UI[locale];
}