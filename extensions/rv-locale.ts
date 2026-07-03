/** Lightweight locale for /rv UI strings (no LLM). */

export type RvLocale = "en" | "zh";

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

export function detectRvLocale(textSamples: string[]): RvLocale {
  let cjk = 0;
  let latin = 0;
  for (const sample of textSamples) {
    const t = sample.slice(0, 2000);
    for (const ch of t) {
      if (CJK_RE.test(ch)) cjk++;
      else if (/[a-zA-Z]/.test(ch)) latin++;
    }
  }
  if (cjk === 0 && latin === 0) return "en";
  return cjk >= latin * 0.15 ? "zh" : "en";
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
    codePreset: "Code review (preset)",
    frontendPreset: "Frontend / multimodal review (preset)",
    planPreset: "Plan review (preset)",
    challengePreset: "Challenge review (preset)",
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
    codePreset: "代码审核（推荐配置）",
    frontendPreset: "前端 / 多模态审核（推荐）",
    planPreset: "方案 / 架构审核（推荐）",
    challengePreset: "对抗性方案审核（可追问）",
    suggested: "推荐",
    presetTier: (n) => (n === 0 ? "推荐" : `预设 #${n + 1}`),
    thinkingSuggested: "推荐 ",
  },
};

export function rvUi(locale: RvLocale): RvUiStrings {
  return UI[locale];
}