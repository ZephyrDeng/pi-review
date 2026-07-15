/**
 * Inline, searchable model picker built on Pi's TUI component primitives.
 *
 * Pi's `ui.select` dialog is a flat list (arrows + enter + escape) with no
 * in-place search or grouping, which is painful for a long model catalog. This
 * component composes `Input` + a filtered list (using `fuzzyFilter`) and is
 * shown via `ctx.ui.custom(...)`, which grants keyboard focus so `handleInput`
 * drives the whole flow:
 *
 *   - type → live fuzzy filter (e.g. "zenmux glm" matches `zenmux/glm-5.2`)
 *   - ↑↓ / PgUp·PgDn → move selection
 *   - Enter → confirm the highlighted model
 *   - Tab → cycle the provider scope (all → provider1 → … → all)
 *   - Esc → cancel
 *
 * It is a pure Pi-tui `Component`; the host `custom` factory owns focus and
 * input routing. The wizard falls back to the `select`-based picker when
 * `custom` is unavailable (print / RPC modes without a TUI).
 */

import {
  Container,
  Input,
  Spacer,
  Text,
  fuzzyFilter,
  getKeybindings,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "./rv-completions.js";
import type { RvLocale } from "./rv-locale.js";

/** Theme shape we use; the host passes a real `Theme` to the custom factory. */
type PickerTheme = {
  fg: (color: "accent" | "muted" | "warning" | "success" | "error" | "text", text: string) => string;
  bold: (text: string) => string;
};

/** Result of the picker: a chosen label, the skip sentinel, or cancel (undefined). */
export type ModelPickerResult = string | "__skip__" | undefined;

export const MODEL_PICKER_SKIP = "__skip__";

const MAX_VISIBLE = 12;

/** A flattened, selectable row: either a real model or the synthetic skip row. */
type Row = { kind: "model"; label: string; provider: string; id: string } | { kind: "skip" };

/**
 * Build the selectable rows from an already-ranked model list. The caller
 * (wizard) owns preset ranking via `rankModelsWithPresets`; this only flattens
 * and optionally prepends the skip row so it stays a pure UI component.
 */
export function pickerRows(ranked: ModelInfo[], allowSkip: boolean): Row[] {
  const rows: Row[] = ranked.map((m) => ({ kind: "model", label: m.label, provider: m.provider, id: m.id }));
  return allowSkip ? [{ kind: "skip" }, ...rows] : rows;
}

/** Distinct providers in rank order (first occurrence wins), for Tab scope cycling. */
export function pickerProviders(ranked: ModelInfo[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of ranked) {
    if (!seen.has(m.provider)) {
      seen.add(m.provider);
      out.push(m.provider);
    }
  }
  return out;
}

function rowSearchText(r: Row): string {
  if (r.kind === "skip") return "skip pi default 跳过";
  return `${r.provider} ${r.id} ${r.label}`;
}

/**
 * Inline searchable model picker component.
 *
 * Construct via `RvModelPickerComponent.create(...)` inside the `custom`
 * factory and return it; the host grants focus and forwards keystrokes to
 * `handleInput`. Call `done` with the chosen label, `MODEL_PICKER_SKIP`, or
 * `undefined` (cancel).
 */
export class RvModelPickerComponent implements Component {
  private readonly tui: TUI;
  private readonly theme: PickerTheme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: (result: ModelPickerResult) => void;
  private readonly locale: RvLocale;
  private readonly zh: boolean;
  private readonly allRows: Row[];
  private readonly providers: string[];

  private readonly root = new Container();
  private readonly searchInput: Input;
  private readonly listContainer = new Container();
  private readonly hint: Text;
  private readonly scopeText: Text;

  private scope: string = "all"; // "all" or a provider name
  private filteredRows: Row[];
  private selectedIndex = 0;

  private constructor(opts: {
    tui: TUI;
    theme: PickerTheme;
    keybindings: KeybindingsManager;
    done: (result: ModelPickerResult) => void;
    locale: RvLocale;
    ranked: ModelInfo[];
    allowSkip: boolean;
    title: string;
  }) {
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.keybindings = opts.keybindings;
    this.done = opts.done;
    this.locale = opts.locale;
    this.zh = opts.locale === "zh";
    this.allRows = pickerRows(opts.ranked, opts.allowSkip);
    this.providers = pickerProviders(opts.ranked);

    this.root.addChild(new Spacer(1));
    this.hint = new Text("", 0, 0);
    this.root.addChild(this.hint);
    this.root.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.root.addChild(this.searchInput);
    this.root.addChild(new Spacer(1));

    this.scopeText = new Text("", 0, 0);
    this.root.addChild(this.scopeText);
    this.root.addChild(new Spacer(1));

    this.root.addChild(this.listContainer);
    this.root.addChild(new Spacer(1));

    this.filteredRows = this.allRows;
    this.updateHint(opts.title);
    this.updateScopeText();
    this.updateList();
  }

  /** Factory used by the wizard inside `ctx.ui.custom(factory)`. */
  static create(
    tui: TUI,
    theme: PickerTheme,
    keybindings: KeybindingsManager,
    done: (result: ModelPickerResult) => void,
    input: { locale: RvLocale; ranked: ModelInfo[]; allowSkip: boolean; title: string },
  ): RvModelPickerComponent {
    return new RvModelPickerComponent({ tui, theme, keybindings, done, ...input });
  }

  // --- Component interface -------------------------------------------------

  render(width: number): string[] {
    return this.root.render(width);
  }

  invalidate(): void {
    this.root.invalidate();
  }

  handleInput(keyData: string): void {
    const kb = this.keybindings;
    if (kb.matches(keyData, "tui.input.tab")) {
      this.cycleScope();
      return;
    }
    if (kb.matches(keyData, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (kb.matches(keyData, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (kb.matches(keyData, "tui.select.pageUp")) {
      this.moveSelection(-MAX_VISIBLE);
      return;
    }
    if (kb.matches(keyData, "tui.select.pageDown")) {
      this.moveSelection(MAX_VISIBLE);
      return;
    }
    if (kb.matches(keyData, "tui.select.confirm")) {
      this.confirmSelection();
      return;
    }
    if (kb.matches(keyData, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    // Everything else (printable chars, backspace, etc.) feeds the search box.
    this.searchInput.handleInput(keyData);
    this.applyFilter(this.searchInput.getValue());
  }

  // --- behavior ------------------------------------------------------------

  private cycleScope(): void {
    if (this.providers.length === 0) return;
    if (this.scope === "all") {
      this.scope = this.providers[0];
    } else {
      const idx = this.providers.indexOf(this.scope);
      this.scope = idx >= 0 && idx < this.providers.length - 1 ? this.providers[idx + 1] : "all";
    }
    this.applyFilter(this.searchInput.getValue());
    this.updateScopeText();
  }

  private activeRows(): Row[] {
    if (this.scope === "all") return this.allRows;
    return this.allRows.filter((r) => r.kind === "model" && r.provider === this.scope);
  }

  private applyFilter(query: string): void {
    const active = this.activeRows();
    this.filteredRows = query.trim()
      ? fuzzyFilter(active, query, rowSearchText)
      : active;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredRows.length - 1));
    if (this.filteredRows.length === 0) this.selectedIndex = 0;
    this.updateList();
    this.tui.requestRender();
  }

  private moveSelection(delta: number): void {
    if (this.filteredRows.length === 0) return;
    const n = this.filteredRows.length;
    // wrap for single-step, clamp for page jumps
    if (Math.abs(delta) === 1) {
      this.selectedIndex = (this.selectedIndex + delta + n) % n;
    } else {
      this.selectedIndex = Math.max(0, Math.min(n - 1, this.selectedIndex + delta));
    }
    this.updateList();
    this.tui.requestRender();
  }

  private confirmSelection(): void {
    const row = this.filteredRows[this.selectedIndex];
    if (!row) return;
    if (row.kind === "skip") {
      this.done(MODEL_PICKER_SKIP);
    } else {
      this.done(row.label);
    }
  }

  private updateHint(title: string): void {
    const hints = [
      this.theme.fg("muted", this.zh ? "输入关键词过滤（如 glm-5.2 或 zenmux glm）" : "type to filter (e.g. glm-5.2 or zenmux glm)"),
      "  " + this.theme.fg("muted", this.zh ? "Tab 切换 provider" : "Tab switch provider"),
      "  " + this.theme.fg("muted", this.zh ? "↑↓ 选择" : "↑↓ select"),
      "  " + this.theme.fg("muted", this.zh ? "回车确认 · Esc 取消" : "Enter confirm · Esc cancel"),
    ];
    this.hint.setText(`${this.theme.bold(title)}  ${hints.join("  ")}`);
  }

  private updateScopeText(): void {
    const allLabel = this.zh ? "全部" : "all";
    const parts = [this.scope === "all" ? this.theme.fg("accent", allLabel) : this.theme.fg("muted", allLabel)];
    for (const p of this.providers) {
      parts.push(p === this.scope ? this.theme.fg("accent", p) : this.theme.fg("muted", p));
    }
    const sep = this.theme.fg("muted", " | ");
    this.scopeText.setText(this.theme.fg("muted", this.zh ? "Scope: " : "Scope: ") + parts.join(sep));
  }

  private updateList(): void {
    this.listContainer.clear();
    const rows = this.filteredRows;
    const max = MAX_VISIBLE;
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(max / 2), rows.length - max));
    const end = Math.min(start + max, rows.length);

    if (rows.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", this.zh ? "  没有匹配的模型" : "  No matching models"), 0, 0));
      return;
    }

    for (let i = start; i < end; i++) {
      const row = rows[i];
      const isSelected = i === this.selectedIndex;
      const line = this.renderRow(row, isSelected);
      this.listContainer.addChild(new Text(line, 0, 0));
    }

    if (start > 0 || end < rows.length) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${rows.length})`), 0, 0));
    }
  }

  private renderRow(row: Row, isSelected: boolean): string {
    if (row.kind === "skip") {
      const text = this.zh ? "跳过（用 Pi 默认）" : "Skip (Pi default)";
      return isSelected
        ? this.theme.fg("accent", "→ ") + this.theme.fg("accent", text)
        : `  ${this.theme.fg("muted", text)}`;
    }
    const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
    const modelText = isSelected ? this.theme.fg("accent", row.id) : this.theme.fg("text", row.id);
    const badge = this.theme.fg("muted", `[${row.provider}]`);
    return `${prefix}${modelText} ${badge}`;
  }
}
