// The Markdown export: the document's block HTML, as the editor and agents write it, rendered as
// Markdown. A Worker has no DOM parser, so the HTML is read as a flat run of tags and text.
//
// The editor formats with `execCommand` under `styleWithCSS`, so the bold, italic and
// strikethrough it applies arrive as `<span style>` rather than `<b>`, `<i>` and `<s>`; both
// spellings export alike, and as in the page the innermost element's say holds, so
// `font-weight: normal` inside bold is plain. Formatting Markdown has no syntax for (underline,
// colour, size, font, alignment) is dropped and its text kept, as is emphasis inside code, which
// shows text verbatim.

type Marker = "**" | "*" | "~~";
/** What one element says about each emphasis: on, off, or (absent) nothing. */
type Emphasis = Partial<Record<Marker, boolean>>;
/** Emphasis turning on or off at an offset into a block's inline Markdown. */
type EmphasisChange = { at: number; marker: Marker; open: boolean };

const MARKERS: Marker[] = ["**", "*", "~~"];
const HTML_TAGS: Record<Marker, string> = { "**": "strong", "*": "em", "~~": "del" };

/** The formatting elements, with the emphasis each implies before its inline style has a say. */
const ELEMENT_EMPHASIS = new Map<string, Emphasis>([
  ["strong", { "**": true }], ["b", { "**": true }],
  ["em", { "*": true }], ["i", { "*": true }],
  ["s", { "~~": true }], ["strike", { "~~": true }], ["del", { "~~": true }],
  ["span", {}], ["font", {}],
]);

/** Elements whose content the page never renders, so the export leaves it out too. */
const HIDDEN_TAGS = new Set(["script", "style", "template", "noscript", "title"]);

/** Other block elements, which Markdown has no syntax for: each stands apart as a paragraph does. */
const PARAGRAPH_LIKE = [
  "address", "article", "aside", "caption", "center", "dd", "details", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "header", "hgroup", "legend", "main", "nav", "section", "summary",
];

/** Tags that end a run of inline content, closing its emphasis and dropping any space or break. */
const BLOCK_TAGS: Record<string, true> = Object.fromEntries([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "blockquote", "pre", "ul", "ol", "li", "hr",
  "table", "tr", "td", "th", ...PARAGRAPH_LIKE,
].map((tag) => [tag, true]));

/** Render block HTML as Markdown, ending with one newline, or as "" when it holds no content. */
export function htmlToMarkdown(html: string): string {
  // A quoted attribute value may hold `>`; a tag with an unbalanced quote falls back to the first.
  // A `<` that starts no tag (`1 < 2`) is text, as the browser recovers it.
  const tokens = String(html).match(
    /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>|<\/?[a-z][^>]*>|[^<]+|</gi) || [];
  // Each open list: the number its next item takes, which way it counts, and the last it wrote.
  // `html` marks a list whose numbers Markdown cannot write (below zero), kept as HTML tags instead.
  const lists: { type: "ul" | "ol"; next: number; step: 1 | -1; last?: number; html?: true }[] = [];
  // Where the last list ended: a list opening with nothing written since would run on from it.
  let listEnd = -1;
  const openList = (list: (typeof lists)[number]) => {
    if (listEnd >= 0 && !trimAscii(markdown.slice(listEnd))) markdown += "\n\n<!-- -->\n\n";
    lists.push(list);
  };
  // Each open list item's marker and where its content starts, written whole when it closes.
  const items: { marker: string; start: number; depth: number }[] = [];
  // Every line after the first is indented to the marker's width, which CommonMark needs to keep
  // an item's later paragraphs, code and nested lists inside it.
  const finishItem = () => {
    const item = items.pop();
    if (!item) return;
    const lines = trimAscii(markdown.slice(item.start)).replace(/\n{3,}/g, "\n\n").split("\n");
    const indent = " ".repeat(item.marker.length);
    markdown = markdown.slice(0, item.start) +
      (item.marker + lines[0]).trimEnd() + "\n" +
      lines.slice(1).map((line) => (line ? indent + line : line) + "\n").join("");
  };
  const closeLink = () => {
    if (links.length === 0) return;
    const destination = links.pop();
    frames.pop();
    if (destination === null) return;
    closeTo(0);
    inline += "](" + (destination ?? "") + ")";
  };
  // HTML lets `</li>` go unwritten before the next item or the list's end, which close it then.
  const finishOpenItem = () => { if (items.at(-1)?.depth === lists.length) finishItem(); };
  // Each open anchor's destination, or null for one with no href, which the page shows as text.
  const links: (string | null)[] = [];
  const blockquotes: number[] = [];
  // Fenced code blocks, each held out of the Markdown as a placeholder line until the end, so no
  // trimming, blank-line collapsing or indenting of the text around it reaches its content.
  const fences: string[] = [];
  // What each open formatting element says about emphasis, and the markers open in the output,
  // outermost first. Markers follow the formatting rather than the elements: they open at the
  // first content that has it and close at the next content or block that does not, before the
  // space between, the only placement Markdown reads (`**Hello **world` keeps its asterisks; an
  // empty `****` is a horizontal rule).
  const frames: Emphasis[] = [];
  const written: Marker[] = [];
  let markdown = "";
  // The current block's inline content and where its emphasis changes, spelled when it ends.
  let inline = "";
  let changes: EmphasisChange[] = [];
  let inPre = false;
  let inCode = false;
  let codeText = "";
  let preText = "";
  // The same code as HTML, references as written: code spans and fences show references
  // literally, so code holding one only a browser decodes is written as HTML instead.
  let codeHtml = "";
  let preHtml = "";
  let inHeading = false;
  // Space and `<br>`s since the last content, written only once more content follows: the editor
  // leaves a `<br>` as the sole content of an empty paragraph.
  let space = false;
  let breaks = 0;

  const closeTo = (depth: number) => {
    for (const marker of written.splice(depth).reverse()) {
      changes.push({ at: inline.length, marker, open: false });
    }
  };
  // Inline content is about to be written: close the emphasis it lacks, write the space or breaks
  // before it, then open the emphasis it gains.
  const beginInline = (wanted = emphasisIn(frames)) => {
    let kept = 0;
    while (kept < written.length && wanted.includes(written[kept])) kept++;
    closeTo(kept);
    inline += breaks ? "\\\n".repeat(breaks) : space ? " " : "";
    space = false;
    breaks = 0;
    for (const marker of wanted) {
      if (written.includes(marker)) continue;
      written.push(marker);
      changes.push({ at: inline.length, marker, open: true });
    }
  };
  // Writes the open code element, at its `</code>` or, when that was left out, at the block's end.
  const flushCode = () => {
    if (!inCode) return;
    // An empty element shows nothing, and an empty span would show its backticks.
    if (codeText) {
      inline += hasForeignReference(codeHtml)
        ? "<code>" + textMarkdown(codeHtml) + "</code>" : codeSpan(codeText);
    }
    codeText = "";
    codeHtml = "";
    inCode = false;
  };
  const endBlock = () => {
    flushCode();
    closeTo(0);
    // Text that opens a line must not be read back as block syntax there: a heading, list, quote
    // or fence, however many elements spelled it (`<span>1</span>. x`); a hard break leaves the
    // next line able to open one too.
    markdown += spellEmphasis(inline, changes).split("\n").map(escapeBlockMarker).join("\n");
    inline = "";
    changes = [];
    space = false;
    breaks = 0;
  };

  let cellOpen = false;
  // The open element whose content the page never shows (script, style, template), and how deep.
  let hidden: { tag: string; depth: number } | undefined;

  for (const [index, token] of tokens.entries()) {
    if (hidden) {
      const tag = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(token);
      if (tag?.[2].toLowerCase() === hidden.tag) {
        // Only a template nests; the others are raw text up to their first closing tag.
        hidden.depth += tag[1] ? -1 : hidden.tag === "template" ? 1 : 0;
        if (hidden.depth === 0) hidden = undefined;
      }
      continue;
    }
    if (!token.startsWith("<") || token === "<") {
      const html = token === "<" ? "&lt;" : withLegacySemicolons(token);
      const text = decodeHtml(html);
      // The HTML parser drops a newline right after `<pre>`; the page never shows it.
      if (inPre) {
        preText += preText ? text : text.replace(/^\r?\n/, "");
        preHtml += preHtml ? html : html.replace(/^\r?\n/, "");
      } else if (inCode) {
        codeText += text.replace(/[ \t\n\r\f]+/g, " ");
        codeHtml += html.replace(/[ \t\n\r\f]+/g, " ");
      }
      else {
        // Only ASCII whitespace collapses: a no-break space is content, as in the page.
        const words = textMarkdown(html);
        space ||= words.startsWith(" ");
        if (trimAscii(words)) {
          beginInline();
          inline += trimAscii(words);
          space = words.endsWith(" ");
        }
      }
      continue;
    }
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;

    const match = /^<\s*(\/?)\s*([a-z0-9]+)([\s\S]*)>$/i.exec(token);
    if (!match) continue;
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    if (!closing && HIDDEN_TAGS.has(tag) && !/\/\s*$/.test(match[3])) {
      hidden = { tag, depth: 1 };
      continue;
    }
    const attributes = match[3];
    const emphasis = emphasisOf(tag, attributes);
    if (emphasis) {
      if (closing) frames.pop();
      else frames.push(emphasis);
      continue;
    }
    if (BLOCK_TAGS[tag]) endBlock();
    if (PARAGRAPH_LIKE.includes(tag)) {
      markdown += "\n\n";
      continue;
    }

    if (closing) {
      switch (tag) {
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
          inHeading = false;
          // A trailing run of `#` after a space would be read as the heading's closing sequence.
          markdown = markdown.replace(/(\s)(#+)$/, "$1\\$2") + "\n\n";
          break;
        case "p": case "div":
          markdown += "\n\n";
          break;
        case "blockquote": {
          const start = blockquotes.pop();
          const content = trimAscii(markdown.slice(start)).replace(/\n{3,}/g, "\n\n");
          const quoted = content
            ? content.split("\n").map((line) => line ? "> " + line : ">").join("\n")
            : ">";
          markdown = markdown.slice(0, start) + quoted + "\n\n";
          break;
        }
        case "code": if (!inPre) flushCode(); break;
        case "pre": {
          const fence = "`".repeat(Math.max(3, longestRun(preText, "`") + 1));
          // An HTML block keeps its content verbatim, references and all, up to its `</pre>`.
          fences.push(hasForeignReference(preHtml)
            ? "<pre><code>" + preHtml.replace(/\n$/, "") + "</code></pre>"
            : fence + "\n" + preText.replace(/\n$/, "") + "\n" + fence);
          markdown += "\n\n" + fencePlaceholder(fences.length - 1) + "\n\n";
          preText = "";
          preHtml = "";
          inPre = false;
          break;
        }
        // An `</a>` with no anchor open (one a later `<a>` already closed) is ignored, as in HTML.
        case "a": closeLink(); break;
        case "li": if (lists.at(-1)?.html) markdown += "\n\n</li>\n\n"; else finishOpenItem(); break;
        case "ul": case "ol":
          if (lists.at(-1)?.html) markdown += "\n\n</ol>\n\n";
          else finishOpenItem();
          lists.pop();
          listEnd = markdown.length;
          break;
        case "td": case "th": if (cellOpen) markdown += "\t"; cellOpen = false; break;
        case "tr": markdown += "\n"; cellOpen = false; break;
      }
      continue;
    }

    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        inHeading = true;
        markdown += "\n\n" + "#".repeat(Number(tag[1])) + " ";
        break;
      case "p": case "div": markdown += "\n\n"; break;
      // A heading is one line in Markdown, and code one span, so a break in either is a space.
      case "br":
        if (inPre) { preText += "\n"; preHtml += "\n"; }
        else if (inCode) { codeText += " "; codeHtml += " "; }
        else if (inHeading) space = true;
        else breaks++;
        break;
      case "code": if (!inPre) { beginInline(); codeText = ""; codeHtml = ""; inCode = true; } break;
      case "pre": preText = ""; preHtml = ""; inPre = true; break;
      case "blockquote": markdown += "\n\n"; blockquotes.push(markdown.length); break;
      case "hr": markdown += "\n\n---\n\n"; break;
      // HTML lets `</td>` go unwritten before the next cell, which closes it then.
      case "td": case "th": if (cellOpen) markdown += "\t"; cellOpen = true; break;
      case "tr": cellOpen = false; break;
      case "ul": openList({ type: "ul", next: 1, step: 1 }); break;
      case "ol": {
        const reversed = readHtmlAttribute(attributes, "reversed") !== undefined;
        const values = itemValues(tokens, index);
        const step = reversed ? -1 : 1;
        // A reversed list counts down from its item count unless it says where to start.
        const next = integer(readHtmlAttribute(attributes, "start")) ?? (reversed ? values.length : 1);
        let number = next - step;
        const numbers = values.map(value => number = integer(value) ?? number + step);
        if (numbers.every(n => listNumber(String(n)) !== undefined)) {
          openList({ type: "ol", step, next });
          break;
        }
        // A number Markdown cannot write: the list stays HTML, its tags (rebuilt from the numbers
        // alone) between blank lines, so CommonMark passes them through and reads the items within.
        openList({ type: "ol", step, next, html: true });
        markdown += `\n\n<ol start="${next}"${reversed ? " reversed" : ""}>\n\n`;
        break;
      }
      case "li": {
        const list = lists.at(-1) || { type: "ul", next: 1, step: 1 };
        if (list.html) {
          const number = integer(readHtmlAttribute(attributes, "value")) ?? list.next;
          markdown += `\n\n<li value="${number}">\n\n`;
          list.next = number + list.step;
          break;
        }
        finishOpenItem();
        // An item's own `value` renumbers it, and the items after it count on from there.
        const number = (list.type === "ol" ? listNumber(readHtmlAttribute(attributes, "value")) : undefined)
          ?? list.next;
        // CommonMark reads only a list's first number and counts up from it, so an item numbered
        // any other way starts a list of its own, which an empty comment keeps apart.
        if (list.type === "ol" && list.last !== undefined && number !== list.last + 1) {
          markdown += "\n<!-- -->\n\n";
        }
        list.last = number;
        list.next = number + list.step;
        if (!markdown.endsWith("\n")) markdown += "\n";
        items.push({
          marker: list.type === "ol" ? number + ". " : "- ", start: markdown.length, depth: lists.length,
        });
        break;
      }
      // Emphasis cannot pair across a link label's brackets, so the label opens and closes its
      // own; the toolbar's Bold or Italic on a whole link styles the link itself.
      case "a": {
        // Anchors cannot nest: a browser closes an open one before the next begins.
        closeLink();
        frames.push(styleEmphasis(attributes));
        const href = readRawHtmlAttribute(attributes, "href", true);
        links.push(href === undefined ? null : linkDestination(href));
        if (href === undefined) break;
        beginInline([]);
        // `!` right before the label would make the link an image.
        if (inline.endsWith("!")) inline = inline.slice(0, -1) + "\\!";
        inline += "[";
        break;
      }
      case "img": {
        beginInline();
        if (inline.endsWith("!")) inline = inline.slice(0, -1) + "\\!";
        const alt = textMarkdown(readRawHtmlAttribute(attributes, "alt", true) ?? "");
        inline += "![" + alt + "](" + linkDestination(readRawHtmlAttribute(attributes, "src", true) ?? "") + ")";
        break;
      }
    }
  }
  endBlock();

  const clean = trimAscii(markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n"));
  // Each fence goes back on its placeholder's line, every line carrying the quote markers and
  // item indent that line has; a list marker in that prefix holds only for the first line.
  const fenced = clean.replace(/^(.*)\0(\d+)\0$/gm, (_, prefix: string, index: string) => {
    const continued = prefix.replace(/[^> ]/g, " ");
    return fences[Number(index)].split("\n").map((line, i) =>
      line ? (i ? continued : prefix) + line : continued.trimEnd()).join("\n");
  });
  return fenced ? fenced + "\n" : "";
}

/** What a formatting element says about emphasis, or undefined for any other element. */
function emphasisOf(tag: string, attributes: string): Emphasis | undefined {
  const implied = ELEMENT_EMPHASIS.get(tag);
  return implied && { ...implied, ...styleEmphasis(attributes) };
}

/** What an element's inline style says about emphasis, which overrides what its tag implies. */
function styleEmphasis(attributes: string): Emphasis {
  const style = (readHtmlAttribute(attributes, "style") ?? "").toLowerCase();
  // Each property's value as the cascade picks it: the last `!important` declaration, else the last.
  const declared = new Map<string, { value: string; important: boolean }>();
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    // The shorthand sets the line longhand, so the two are one property here.
    const property = declaration.slice(0, colon).trim().replace(/^text-decoration$/, "text-decoration-line");
    const raw = declaration.slice(colon + 1);
    const important = /!\s*important\s*$/.test(raw);
    if (declared.get(property)?.important && !important) continue;
    declared.set(property, { value: raw.replace(/!\s*important\s*$/, "").trim(), important });
  }
  const value = (property: string) => declared.get(property)?.value;
  const emphasis: Emphasis = {};
  // `lighter` is relative (900 becomes a still-bold 700), so it says nothing.
  const weight = /^(?:(bold|bolder|[6-9]00)|normal|[1-5]00)$/.exec(value("font-weight") ?? "");
  if (weight) emphasis["**"] = weight[1] !== undefined;
  const slant = /^(?:(italic|oblique)\b.*|normal)$/.exec(value("font-style") ?? "");
  if (slant) emphasis["*"] = slant[1] !== undefined;
  // A descendant cannot lift its ancestor's line-through, so strikethrough only turns on.
  if (value("text-decoration-line")?.includes("line-through")) emphasis["~~"] = true;
  return emphasis;
}

/** The emphasis in force inside `frames`, in the order it was turned on. */
function emphasisIn(frames: Emphasis[]): Marker[] {
  const on = new Set<Marker>();
  for (const frame of frames) {
    for (const marker of MARKERS) {
      if (frame[marker]) on.add(marker);
      else if (frame[marker] === false) on.delete(marker);
    }
  }
  return [...on];
}

/**
 * A block's inline Markdown with its emphasis changes written in: as asterisks and tildes when
 * CommonMark reads each of their runs as written, and otherwise, as where emphasis changes inside
 * a word (`**A***B**C***`), as inline HTML tags, which Markdown passes through.
 */
function spellEmphasis(text: string, changes: EmphasisChange[]): string {
  const spell = (delimiter: (change: EmphasisChange) => string) => {
    let spelled = "";
    let from = 0;
    for (const change of changes) {
      spelled += text.slice(from, change.at) + delimiter(change);
      from = change.at;
    }
    return spelled + text.slice(from);
  };
  const markdown = spell(({ marker }) => marker);
  if (delimitersReadAsWritten(markdown, changes)) return markdown;
  return spell(({ marker, open }) => `<${open ? "" : "/"}${HTML_TAGS[marker]}>`);
}

/**
 * Whether CommonMark reads each delimiter run that `changes` spelled into `markdown` as written. An
 * opening run must be left- and not right-flanking, or it may close an earlier opener. A closing
 * run need only be right-flanking: the opener it closes is the nearest one waiting. A run that
 * both closes and opens cannot be read as written.
 */
function delimitersReadAsWritten(markdown: string, changes: EmphasisChange[]): boolean {
  const runs: { start: number; end: number; opens: boolean; closes: boolean }[] = [];
  let shift = 0;
  for (const { at, marker, open } of changes) {
    const start = at + shift;
    shift += marker.length;
    const run = runs.at(-1);
    if (run?.end === start && markdown[run.start] === marker[0]) {
      run.end += marker.length;
      run.opens ||= open;
      run.closes ||= !open;
    } else {
      runs.push({ start, end: start + marker.length, opens: open, closes: !open });
    }
  }
  return runs.every(({ start, end, opens, closes }) => {
    // Whole code points, since an emoji is a symbol and so punctuation.
    const before = charClass(markdown.slice(Math.max(start - 2, 0), start).match(/.$/su)?.[0]);
    const after = charClass(markdown.slice(end, end + 2).match(/^./su)?.[0]);
    const leftFlanking = after !== "space" && (after !== "punctuation" || before !== "word");
    const rightFlanking = before !== "space" && (before !== "punctuation" || after !== "word");
    return opens ? !closes && leftFlanking && !rightFlanking : rightFlanking;
  });
}

/** A character as CommonMark's flanking rules class it, where a block's edge is space. */
function charClass(char: string | undefined): "space" | "punctuation" | "word" {
  if (char === undefined || /\s/.test(char)) return "space";
  return /[\p{P}\p{S}]/u.test(char) ? "punctuation" : "word";
}

/**
 * An attribute's value as written, entities and all, or undefined when the element has none. The
 * attributes are read in order, a quoted value whole, so a name inside another's value (`title=
 * "href=x"`) is not mistaken for that attribute; the first of a repeated name wins, as in HTML.
 */
function readRawHtmlAttribute(source: string, name: string, legacy = false): string | undefined {
  for (const [, key, double, single, bare] of
      source.matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    if (key.toLowerCase() !== name) continue;
    const value = double ?? single ?? bare ?? "";
    return legacy ? withLegacySemicolons(value, true) : value;
  }
  return undefined;
}

/** An attribute's decoded value, or undefined when the element has none. */
function readHtmlAttribute(source: string, name: string): string | undefined {
  const value = readRawHtmlAttribute(source, name);
  return value === undefined ? undefined : decodeHtml(withLegacySemicolons(value, true));
}

/**
 * HTML text as Markdown text: decoded, ASCII whitespace collapsed, and escaped. A named reference
 * `decodeHtml` does not know is passed through as written, since CommonMark decodes every HTML5
 * one itself (`&copy;` stays a copyright sign), while the same text spelled `&amp;copy;` is
 * escaped and stays literal.
 */
function textMarkdown(html: string): string {
  return withForeignReferences(html, (part) => escapeText(part.replace(/[ \t\n\r\f]+/g, " ")));
}

/** A list number as CommonMark can write it (at most nine digits), or undefined. */
function listNumber(value: string | undefined): number | undefined {
  const number = Number.parseInt(value ?? "", 10);
  return number >= 0 && number <= 999_999_999 ? number : undefined;
}

/** An integer attribute value as HTML reads one, or undefined. */
function integer(value: string | undefined): number | undefined {
  const number = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(number) ? number : undefined;
}

/** The `value` of each item of the list opened at `tokens[open]`, not those of nested lists. */
function itemValues(tokens: string[], open: number): (string | undefined)[] {
  let depth = 0;
  const values: (string | undefined)[] = [];
  for (const token of tokens.slice(open + 1)) {
    const tag = /^<\s*(\/?)\s*(ol|ul|li)\b([\s\S]*)>$/i.exec(token);
    if (!tag) continue;
    const list = tag[2].toLowerCase() !== "li";
    if (list && tag[1]) { if (depth-- === 0) break; }
    else if (list) depth++;
    else if (!tag[1] && depth === 0) values.push(readHtmlAttribute(tag[3], "value"));
  }
  return values;
}

/**
 * The named references HTML still decodes without their `;`, from before HTML required one (the
 * spec's legacy list). CommonMark decodes none without it, so they get theirs back first.
 */
const LEGACY_REFERENCES = new Set([
  "AElig", "AMP", "Aacute", "Acirc", "Agrave", "Aring", "Atilde", "Auml", "COPY", "Ccedil", "ETH",
  "Eacute", "Ecirc", "Egrave", "Euml", "GT", "Iacute", "Icirc", "Igrave", "Iuml", "LT", "Ntilde",
  "Oacute", "Ocirc", "Ograve", "Oslash", "Otilde", "Ouml", "QUOT", "REG", "THORN", "Uacute",
  "Ucirc", "Ugrave", "Uuml", "Yacute", "aacute", "acirc", "acute", "aelig", "agrave", "amp",
  "aring", "atilde", "auml", "brvbar", "ccedil", "cedil", "cent", "copy", "curren", "deg",
  "divide", "eacute", "ecirc", "egrave", "eth", "euml", "frac12", "frac14", "frac34", "gt",
  "iacute", "icirc", "iexcl", "igrave", "iquest", "iuml", "laquo", "lt", "macr", "micro", "middot",
  "nbsp", "not", "ntilde", "oacute", "ocirc", "ograve", "ordf", "ordm", "oslash", "otilde", "ouml",
  "para", "plusmn", "pound", "quot", "raquo", "reg", "sect", "shy", "sup1", "sup2", "sup3",
  "szlig", "thorn", "times", "uacute", "ucirc", "ugrave", "uml", "uuml", "yacute", "yen", "yuml",
]);

/**
 * `html` with each semicolonless legacy reference spelled with its `;`, as a browser reads it: in
 * text the longest legacy name the run starts with (`&notit` is `&not;it`), in an attribute value
 * only a whole name not followed by `=`, which would make it a query parameter.
 */
function withLegacySemicolons(html: string, attribute = false): string {
  return html.replace(/&([a-z][a-z0-9]*)(;?)(=?)/gi, (whole, run: string, semicolon, equals) => {
    if (semicolon) return whole;
    if (attribute) return LEGACY_REFERENCES.has(run) && !equals ? `&${run};` : whole;
    for (let length = run.length; length > 0; length--) {
      if (LEGACY_REFERENCES.has(run.slice(0, length))) {
        return `&${run.slice(0, length)};${run.slice(length)}${equals}`;
      }
    }
    return whole;
  });
}

/** Whether `html` holds a named reference `decodeHtml` leaves for a browser or CommonMark. */
function hasForeignReference(html: string): boolean {
  return [...html.matchAll(/&([a-z][a-z0-9]*);/gi)]
    .some(([, name]) => !Object.hasOwn(NAMED_ENTITIES, name.toLowerCase()));
}

/** `html` decoded and rewritten by `write`, except for named references left for CommonMark. */
function withForeignReferences(html: string, write: (decoded: string) => string): string {
  return html.split(/(&[a-z][a-z0-9]*;)/i).map((part, i) =>
    i % 2 && !Object.hasOwn(NAMED_ENTITIES, part.slice(1, -1).toLowerCase())
      ? part
      : write(decodeHtml(part))).join("");
}

/** The named references the editor writes; any other is left for CommonMark (see textMarkdown). */
const NAMED_ENTITIES: Record<string, string> =
  { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" };

/** The characters HTML reads numeric references 0x80 to 0x9F as; 0 where it keeps the code. */
const WINDOWS_1252 = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0,
  0x017d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161,
  0x203a, 0x0153, 0, 0x017e, 0x0178,
];

function decodeHtml(value: string): string {
  // NUL marks a fence placeholder in the output, so a raw one reads as a browser shows it.
  return String(value).replace(/\0/g, "\ufffd").replace(/&(?:(#x[0-9a-f]+|#\d+);?|(amp|lt|gt|quot|apos|nbsp);)/gi, (_: string, numeric?: string, named?: string) => {
    const entity = (numeric ?? named)!;
    const lower = entity.toLowerCase();
    if (lower.startsWith("#")) {
      const code = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      // As a browser does: NUL, a surrogate or past Unicode reads as the replacement character,
      // and the C1 controls Windows-1252 used for printable characters read as those.
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return String.fromCodePoint(valid ? WINDOWS_1252[code - 0x80] || code : 0xfffd);
    }
    return NAMED_ENTITIES[lower];
  });
}

/**
 * `text` with the block marker it would open a line with, if any, escaped. A run of `=` or `-`
 * is escaped wherever it leads, since alone on a line it underlines the line before as a heading.
 */
function escapeBlockMarker(text: string): string {
  return text.replace(/^(?:#{1,6}|[-+>]|\d{1,9}[.)])(?=\s|$)|^(?:`{3}|~{3}|=+|-+)/,
    marker => marker.replace(/\D/, "\\$&"));
}

/**
 * `text` as an inline code span: delimited by a backtick run longer than any inside it, and padded
 * where it starts or ends with a backtick, which would otherwise merge into the delimiter, or with
 * a space at both ends, which CommonMark would otherwise strip.
 */
function codeSpan(text: string): string {
  const delimiter = "`".repeat(longestRun(text, "`") + 1);
  // CommonMark strips one space from each end when both have one, unless the span is all spaces.
  const pad = /^`|`$/.test(text) || (/^ [^]* $/.test(text) && text.trim() !== "") ? " " : "";
  return delimiter + pad + text + pad + delimiter;
}

/**
 * A raw `href` or `src` value as an inline link destination: parentheses, backslashes and `&`
 * (which could start an entity) escaped, whitespace and angle brackets encoded. CommonMark decodes
 * references in a destination too, so one `decodeHtml` does not know passes through as written.
 */
function linkDestination(raw: string): string {
  return withForeignReferences(raw, (url) =>
    url.replace(/[\\()&]/g, "\\$&").replace(/[\s<>]/g, encodeURIComponent));
}

/** Plain text with every character that could start inline Markdown syntax escaped. */
function escapeText(text: string): string {
  return text.replace(/([\\`*_~[\]<&])/g, "\\$1");
}

/** `text` without leading or trailing ASCII whitespace; a no-break space is kept. */
function trimAscii(text: string): string {
  return text.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, "");
}

/** The line a fenced code block holds until the end; `decodeHtml` keeps NUL out of all text. */
function fencePlaceholder(index: number): string {
  return `\0${index}\0`;
}

/** The longest run of `char` in `text` (0 when it never occurs). */
function longestRun(text: string, char: string): number {
  let longest = 0;
  let current = 0;
  for (const c of text) { current = c === char ? current + 1 : 0; longest = Math.max(longest, current); }
  return longest;
}
