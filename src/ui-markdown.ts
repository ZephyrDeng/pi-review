// Dependency-free markdown renderer for the loopback dashboard. The parser
// is pure (unit-testable in Node); the DOM writer builds nodes exclusively
// through document.createElement/textContent, so untrusted review text can
// never inject markup. Links are restricted to http(s) and open in a new tab.

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "link"; href: string; children: MdInline[] };

export type MdBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { kind: "paragraph"; children: MdInline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: MdInline[][] }
  | { kind: "blockquote"; children: MdInline[] }
  | { kind: "hr" };

const SAFE_LINK = /^https?:\/\//i;

/** True when the href is plain http(s); everything else renders as text. */
export function isSafeLinkHref(href: string): boolean {
  return SAFE_LINK.test(href.trim());
}

// --------------------------------------------------------------------------
// Inline parsing
// --------------------------------------------------------------------------

/** Parse inline markdown: `code`, **strong**, *em* / _em_, [text](https://…). */
export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let text = "";
  const push = (node: MdInline): void => {
    const last = out[out.length - 1];
    if (node.kind === "text" && last?.kind === "text") {
      last.text += node.text;
      return;
    }
    out.push(node);
  };
  const flush = (): void => {
    if (text) push({ kind: "text", text });
    text = "";
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    if (ch === "`") {
      const close = src.indexOf("`", i + 1);
      if (close > i) {
        flush();
        out.push({ kind: "code", text: src.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    if (src.startsWith("**", i)) {
      const close = src.indexOf("**", i + 2);
      if (close > i + 1) {
        flush();
        out.push({ kind: "strong", children: parseInline(src.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if ((ch === "*" || ch === "_") && src[i + 1] !== ch) {
      const close = src.indexOf(ch, i + 1);
      if (close > i + 1) {
        flush();
        out.push({ kind: "em", children: parseInline(src.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }

    if (ch === "[") {
      const closeBracket = src.indexOf("]", i + 1);
      if (closeBracket > i && src[closeBracket + 1] === "(") {
        const closeParen = src.indexOf(")", closeBracket + 2);
        if (closeParen > closeBracket + 1) {
          const label = src.slice(i + 1, closeBracket);
          const href = src.slice(closeBracket + 2, closeParen);
          flush();
          if (isSafeLinkHref(href)) {
            push({ kind: "link", href: href.trim(), children: parseInline(label) });
          } else {
            // Unsafe scheme: keep the label readable, drop the destination.
            for (const node of parseInline(label)) push(node);
          }
          i = closeParen + 1;
          continue;
        }
      }
    }

    text += ch;
    i += 1;
  }
  flush();
  return out;
}

// --------------------------------------------------------------------------
// Block parsing
// --------------------------------------------------------------------------

const HEADING = /^(#{1,6})\s+(.*)$/;
const UL_ITEM = /^\s{0,3}[-*+]\s+(.*)$/;
const OL_ITEM = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const HR = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s{0,3}```\s*(\S*)\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/** Parse a markdown document into a flat block list. */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = line.match(FENCE);
    if (fence) {
      flushParagraph();
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // skip the closing fence (or run off the end for an unterminated block)
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      flushParagraph();
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] ?? ""),
      });
      i += 1;
      continue;
    }

    const quote = line.match(QUOTE);
    if (quote) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length) {
        const inner = lines[i]!.match(QUOTE);
        if (!inner) break;
        quoted.push(inner[1] ?? "");
        i += 1;
      }
      blocks.push({ kind: "blockquote", children: parseInline(quoted.join(" ")) });
      continue;
    }

    const listMatch = line.match(UL_ITEM) ?? line.match(OL_ITEM);
    if (listMatch) {
      flushParagraph();
      const ordered = OL_ITEM.test(line) && !UL_ITEM.test(line);
      const itemPattern = ordered ? OL_ITEM : UL_ITEM;
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const item = lines[i]!.match(itemPattern);
        if (!item) break;
        items.push(parseInline(item[1] ?? ""));
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return blocks;
}

// --------------------------------------------------------------------------
// DOM writer — only executed inside a real browser.
// --------------------------------------------------------------------------

function appendInlines(doc: Document, parent: HTMLElement, inlines: MdInline[]): void {
  for (const inline of inlines) {
    switch (inline.kind) {
      case "text":
        parent.append(doc.createTextNode(inline.text));
        break;
      case "code": {
        const code = doc.createElement("code");
        code.textContent = inline.text;
        parent.append(code);
        break;
      }
      case "strong": {
        const strong = doc.createElement("strong");
        appendInlines(doc, strong, inline.children);
        parent.append(strong);
        break;
      }
      case "em": {
        const em = doc.createElement("em");
        appendInlines(doc, em, inline.children);
        parent.append(em);
        break;
      }
      case "link": {
        const a = doc.createElement("a");
        a.href = inline.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        appendInlines(doc, a, inline.children);
        parent.append(a);
        break;
      }
    }
  }
}

/** Render markdown into `container` (cleared first) using safe DOM writes only. */
export function renderMarkdownInto(container: HTMLElement, src: string): void {
  const doc = container.ownerDocument;
  container.replaceChildren();
  for (const block of parseMarkdown(src)) {
    switch (block.kind) {
      case "heading": {
        const h = doc.createElement(`h${block.level}`);
        appendInlines(doc, h, block.children);
        container.append(h);
        break;
      }
      case "paragraph": {
        const p = doc.createElement("p");
        appendInlines(doc, p, block.children);
        container.append(p);
        break;
      }
      case "code": {
        const pre = doc.createElement("pre");
        const code = doc.createElement("code");
        if (block.lang) code.dataset.lang = block.lang;
        code.textContent = block.text;
        pre.append(code);
        container.append(pre);
        break;
      }
      case "list": {
        const list = doc.createElement(block.ordered ? "ol" : "ul");
        for (const item of block.items) {
          const li = doc.createElement("li");
          appendInlines(doc, li, item);
          list.append(li);
        }
        container.append(list);
        break;
      }
      case "blockquote": {
        const quote = doc.createElement("blockquote");
        const p = doc.createElement("p");
        appendInlines(doc, p, block.children);
        quote.append(p);
        container.append(quote);
        break;
      }
      case "hr":
        container.append(doc.createElement("hr"));
        break;
    }
  }
}

/** Render inline markdown (no block structure) into `container`; used for finding summaries. */
export function renderInlineMarkdownInto(container: HTMLElement, src: string): void {
  container.replaceChildren();
  appendInlines(container.ownerDocument, container, parseInline(src));
}
