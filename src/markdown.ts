import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { normalizeAlias } from "./domain.ts";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export type WikiLinkTarget = "active" | "missing" | { state: "deleted"; id: number };

export function renderMarkdown(markdown: string, resolveTarget: (alias: string) => boolean | WikiLinkTarget): string {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    extensions: [
      {
        name: "wikilink",
        level: "inline",
        start(source: string) {
          return source.indexOf("[[");
        },
        tokenizer(source: string) {
          const match = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(source);
          if (!match) return undefined;
          return { type: "wikilink", raw: match[0], alias: normalizeAlias(match[1]!), label: match[2]?.trim() || match[1]!.trim() };
        },
        renderer(token) {
          const { alias, label } = token as unknown as { alias: string; label: string };
          const resolved = resolveTarget(alias);
          const target: WikiLinkTarget = resolved === true ? "active" : resolved === false ? "missing" : resolved;
          if (target === "active") {
            return `<a class="wikilink" href="/wiki/${encodeURIComponent(alias)}">${escapeHtml(label)}</a>`;
          }
          if (typeof target === "object" && target.state === "deleted") {
            return `<a class="wikilink deleted" href="/trash/${target.id}" aria-label="Deleted page ${escapeHtml(label)}">${escapeHtml(label)}</a>`;
          }
          const query = new URLSearchParams({ alias, title: label }).toString();
          return `<a class="wikilink missing" href="/new?${query}" aria-label="Create missing page ${escapeHtml(label)}">${escapeHtml(label)}</a>`;
        },
      },
    ],
  });

  const html = marked.parse(markdown, { async: false }) as string;
  return sanitizeHtml(html, {
    allowedTags: [
      "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
      "hr", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
      "input",
    ],
    allowedAttributes: {
      a: ["href", "class", "aria-label"],
      input: ["type", "checked", "disabled"],
      code: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
  });
}
