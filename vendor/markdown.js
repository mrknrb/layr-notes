// markdown.js: a small, safe Markdown renderer (CommonMark-ish subset), no dependencies. MIT, written for layr.
// Supports: # headings, paragraphs, **bold**, *italic*, ~~strike~~, `code`, ``` fenced code ```, > quotes,
// - / * / 1. lists (nested by indent), - [ ] task lists, [links](url), <autolinks>, bare URLs, ![images](url),
// --- rules, | tables |, hard breaks (two trailing spaces or a backslash). All raw HTML is escaped.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Only http(s), mailto, relative links and inline images; anything else (javascript:, file:) becomes "#". */
function safeUrl(url) {
  const u = url.trim().replace(/&amp;/g, "&");
  if (/^(https?:|mailto:|#|\/|\.\.?\/)/i.test(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u)) return escapeHtml(u);
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(u)) return escapeHtml(u);
  return "#";
}

function inline(text) {
  const keep = [];
  const stash = (html) => {
    keep.push(html);
    return `\u0000${keep.length - 1}\u0000`;
  };
  // Code spans first, so nothing inside them is formatted.
  let s = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code) => stash(`<code>${escapeHtml(code.trim())}</code>`));
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\)/g, (_m, alt, url, title) =>
    stash(`<img src="${safeUrl(url)}" alt="${alt}"${title ? ` title="${title}"` : ""}>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\)/g, (_m, label, url, title) =>
    `<a href="${stash(safeUrl(url))}"${title ? ` title="${title}"` : ""}>${label}</a>`);
  s = s.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, (_m, url) => stash(`<a href="${safeUrl(url)}">${url}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (_m, pre, url) =>
    `${pre}${stash(`<a href="${safeUrl(url)}">${url}</a>`)}`);
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
  s = s.replace(/(^|[^*\w])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?=\S)([\s\S]*?\S)_(?![_\w])/g, "$1<em>$2</em>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  s = s.replace(/(?: {2,}|\\)\n/g, "<br>\n");
  for (let n = 0; n < 3 && s.includes("\u0000"); n++) s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[Number(i)]);
  return s;
}

const RE = {
  fence: /^ {0,3}(```+|~~~+)\s*([\w+-]*)\s*$/,
  heading: /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^ {0,3}([-*_])(\s*\1){2,}\s*$/,
  quote: /^ {0,3}>\s?(.*)$/,
  item: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
  blank: /^\s*$/,
};

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const indentOf = (l) => l.match(/^\s*/)[0].length;

function renderList(lines, start) {
  const first = RE.item.exec(lines[start]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = RE.item.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const body = [m[3]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (RE.blank.test(l)) {
        const next = lines[i + 1];
        if (next !== undefined && !RE.blank.test(next) && indentOf(next) > indent) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      const sub = RE.item.exec(l);
      if (sub && sub[1].length <= indent) break;
      if (!sub && indentOf(l) <= indent) {
        if (RE.heading.test(l) || RE.fence.test(l) || RE.quote.test(l) || RE.hr.test(l)) break;
        body.push(l.trim()); // lazy continuation of the item's paragraph
        i++;
        continue;
      }
      body.push(l.slice(Math.min(indentOf(l), indent + 2)));
      i++;
    }
    items.push(body);
  }
  const html = items
    .map((body) => {
      let text = body[0];
      let task = "";
      const t = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (t) {
        task = `<input type="checkbox" disabled${t[1] !== " " ? " checked" : ""}> `;
        text = t[2];
      }
      const rest = body.slice(1);
      const nestedAt = rest.findIndex((l) => RE.blank.test(l) || RE.item.test(l) || RE.fence.test(l) || RE.quote.test(l));
      const para = [text, ...(nestedAt < 0 ? rest : rest.slice(0, nestedAt))].join("\n").trim();
      const nested = nestedAt < 0 ? "" : blocks(rest.slice(nestedAt));
      return `<li${task ? ' class="task"' : ""}>${task}${inline(para)}${nested}</li>`;
    })
    .join("\n");
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : "";
  return { html: `<${tag}${startAttr}>\n${html}\n</${tag}>`, next: i };
}

function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (RE.blank.test(line)) {
      i++;
      continue;
    }
    let m;
    if ((m = RE.fence.exec(line))) {
      const fence = m[1];
      const lang = m[2];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      i++;
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if ((m = RE.heading.exec(line))) {
      const n = m[1].length;
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
      i++;
      continue;
    }
    if (RE.hr.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (RE.quote.test(line)) {
      const q = [];
      while (i < lines.length && !RE.blank.test(lines[i])) {
        const qm = RE.quote.exec(lines[i]);
        q.push(qm ? qm[1] : lines[i]);
        i++;
      }
      out.push(`<blockquote>${blocks(q)}</blockquote>`);
      continue;
    }
    if (RE.item.test(line)) {
      const r = renderList(lines, i);
      out.push(r.html);
      i = r.next;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "");
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && !RE.blank.test(lines[i])) rows.push(splitRow(lines[i++]));
      const cell = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c)}</${tag}>`;
      out.push(
        `<table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${head.map((_h, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`).join("") +
          "</tbody></table>"
      );
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      !RE.blank.test(lines[i]) &&
      !RE.fence.test(lines[i]) &&
      !RE.heading.test(lines[i]) &&
      !RE.quote.test(lines[i]) &&
      !RE.hr.test(lines[i]) &&
      !(RE.item.test(lines[i]) && para.length === 0)
    ) {
      para.push(lines[i++]);
    }
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${inline(para.join("\n"))}</p>`);
  }
  return out.join("\n");
}

/** Markdown text → safe HTML. */
export function renderMarkdown(text) {
  return blocks(String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"));
}
