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
type Emphasis = Partial<Record<Marker, boolean>> & { weight?: number | "bolder" | "lighter" };
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
const HIDDEN_TAGS = new Set(["script", "style", "template", "noscript", "title", "iframe", "video", "audio", "canvas"]);

/** Elements a same-kind start tag implicitly closes, so they never nest inside a hidden subtree. */
const IMPLICITLY_CLOSED = new Set(["p", "li", "dd", "dt", "td", "th", "tr", "option"]);

/** Start tags that implicitly close a `p` element (its end tag may be omitted before any of them). */
const P_CLOSERS = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main",
  "menu", "nav", "ol", "p", "pre", "section", "table", "ul",
]);

/** Whether a start tag named `name` implicitly closes an open element named `open`. */
function implicitlyCloses(open: string, name: string): boolean {
  if (name === open) return IMPLICITLY_CLOSED.has(open);
  if (open === "p") return P_CLOSERS.has(name);
  if (open === "dd" || open === "dt") return name === "dd" || name === "dt";
  if (open === "td" || open === "th") return name === "td" || name === "th" || name === "tr";
  if (open === "option") return name === "optgroup";
  return false;
}

/** Elements with no end tag or subtree, so a `hidden` attribute suppresses only the element. */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

/** Other block elements, which Markdown has no syntax for: each stands apart as a paragraph does. */
const PARAGRAPH_LIKE = [
  "address", "article", "aside", "caption", "center", "dd", "details", "dl", "dt", "fieldset",
  "dialog", "figcaption", "figure", "footer", "form", "header", "hgroup", "legend", "main", "nav", "section", "summary",
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
    /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>|<\/?[a-z][^>]*>|[^<]+|</gi) || [];
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
    frameTags.pop();
    if (destination === null) return;
    closeTo(0);
    inline += "](" + (destination ?? "") + ")";
  };
  // HTML lets `</li>` go unwritten before the next item or the list's end, which close it then.
  const finishOpenItem = () => { if (items.at(-1)?.depth === lists.length) finishItem(); };
  const closeBlockquote = () => {
    const start = blockquotes.pop();
    if (start === undefined) return;
    const content = trimAscii(markdown.slice(start)).replace(/\n{3,}/g, "\n\n");
    const quoted = content
      ? content.split("\n").map((line) => line ? "> " + line : ">").join("\n")
      : ">";
    markdown = markdown.slice(0, start) + quoted + "\n\n";
  };
  // Each open anchor's destination, or null for one with no href, which the page shows as text.
  const links: (string | null)[] = [];
  const blockquotes: number[] = [];
  // An anchor wrapping block content, which CommonMark cannot nest a link around: each block's
  // segment becomes a complete link of its own, opened with its content and closed at its end.
  let wrapAnchor: { destination: string; open: boolean } | undefined;
  const closeWrapSegment = () => {
    if (!wrapAnchor?.open) return;
    inline += "](" + wrapAnchor.destination + ")";
    wrapAnchor.open = false;
  };
  // How deep nested quotation marks are: the page alternates double and single marks.
  let qDepth = 0;
  // Elements that declared a visibility, outermost first: the nearest declaration decides, so
  // a descendant declaring itself visible shows again inside a hidden ancestor.
  const visStack: { tag: string; hidden: boolean }[] = [];
  const invisible = () => visStack.at(-1)?.hidden === true;
  // Each open disclosure: a collapsed one shows only its first summary, so the rest is suppressed.
  const details: { collapsed: boolean; inSummary: boolean; summarySeen: boolean }[] = [];
  const detailsSuppressed = () => details.some((frame) => frame.collapsed && !frame.inSummary);
  // An open select's options and the one being read: a single select shows only its selected
  // value; a multiple select shows every option, so it is kept as HTML instead.
  type SelectOption = { text: string; selected: boolean; labeled: boolean };
  // A listbox's structure in order: options and the option groups around them.
  type SelectItem = SelectOption | { group: string } | { endGroup: true };
  let select: { listbox?: string; items: SelectItem[]; current?: SelectOption } | undefined;
  const flushSelect = () => {
    const current = select;
    select = undefined;
    if (!current) return;
    const options = current.items.filter((item): item is SelectOption => "text" in item);
    if (current.listbox) {
      endBlock();
      const lines = current.items.map((item) => "text" in item
        ? `<option${item.selected ? " selected" : ""}>${item.text.replace(/</g, "&lt;")}</option>`
        : "group" in item
          ? `<optgroup label="${item.group.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}">`
          : "</optgroup>");
      markdown += `\n\n${current.listbox}\n${lines.join("\n")}\n</select>\n\n`;
      return;
    }
    // A single select keeps the last option marked selected, as the browser's reset does.
    const chosen = options.findLast((option) => option.selected) ?? options[0];
    if (chosen) emitText(withLegacySemicolons(chosen.text));
  };
  // Fenced code blocks, each held out of the Markdown as a placeholder line until the end, so no
  // trimming, blank-line collapsing or indenting of the text around it reaches its content.
  const fences: string[] = [];
  // What each open formatting element says about emphasis, and the markers open in the output,
  // outermost first. Markers follow the formatting rather than the elements: they open at the
  // first content that has it and close at the next content or block that does not, before the
  // space between, the only placement Markdown reads (`**Hello **world` keeps its asterisks; an
  // empty `****` is a horizontal rule).
  const frames: Emphasis[] = [];
  const frameTags: string[] = [];
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
  // Whether the open preformatted block holds an element, in which case it stays raw HTML.
  let preHasTags = false;
  let inHeading = false;
  // The open heading's tag name: a mismatched heading end tag is ignored, as in HTML.
  let headingName: string | undefined;
  // Space and `<br>`s since the last content, written only once more content follows: the editor
  // leaves a `<br>` as the sole content of an empty paragraph.
  let space = false;
  let breaks = 0;

  // Whether the anchor opened at `tokens[from]` reaches block content before its end tag, in
  // which case no single link can wrap what it holds.
  const anchorWrapsBlock = (from: number): boolean => {
    let depth = 0;
    for (let i = from + 1; i < tokens.length; i++) {
      const ahead = /^<\s*(\/?)\s*([a-z0-9]+)(?=[\s/>])/i.exec(tokens[i]);
      if (!ahead) continue;
      const name = ahead[2].toLowerCase();
      if (name === "a") {
        if (ahead[1]) { if (depth === 0) return false; depth--; }
        else depth++;
      } else if (BLOCK_TAGS[name]) return true;
    }
    return false;
  };

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
    // A block-wrapping anchor's next segment opens with its content.
    if (wrapAnchor && !wrapAnchor.open) { inline += "["; wrapAnchor.open = true; }
  };
  // Writes the code accumulated so far as one span, without ending the code element: an anchor
  // inside code wraps the segment written before it, so the link's label holds that segment.
  const writeCode = () => {
    // An empty element shows nothing, and an empty span would show its backticks.
    if (codeText) {
      inline += hasForeignReference(codeHtml)
        ? "<code>" + textMarkdown(codeHtml) + "</code>" : codeSpan(codeText);
    }
    codeText = "";
    codeHtml = "";
  };
  // Writes the open code element, at its `</code>` or, when that was left out, at the block's end.
  const flushCode = () => {
    if (!inCode) return;
    writeCode();
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

  // Writes the open preformatted block, at its `</pre>` or, left open, at the end of the input.
  const writePre = () => {
    const fence = "`".repeat(Math.max(3, longestRun(preText, "`") + 1));
    // An HTML block keeps its content verbatim, references and all, up to its `</pre>`; one
    // holding elements keeps those elements too.
    fences.push(preHasTags
      ? "<pre>" + preHtml.replace(/\n$/, "") + "</pre>"
      : hasForeignReference(preHtml)
        ? "<pre><code>" + preHtml.replace(/\n$/, "") + "</code></pre>"
        : fence + "\n" + preText.replace(/\n$/, "") + "\n" + fence);
    markdown += "\n\n" + fencePlaceholder(fences.length - 1) + "\n\n";
    preText = "";
    preHtml = "";
    preHasTags = false;
    inPre = false;
  };

  let cellOpen = false;
  // Whether a table row is open, apart from its cell: a row ends at the next row even when its
  // last cell was closed explicitly.
  let rowOpen = false;
  // The open element whose content the page never shows (script, style, template, or anything
  // carrying a `hidden` attribute), and how deep. `nest` is set for parsed elements, whose same
  // tag can nest; raw-text elements end at their first proper end tag however often they reopen.
  let hidden: { tag: string; depth: number; nest: boolean } | undefined;
  // A textarea's raw content while it is open: its tags are literal text, not markup.
  let rawTextarea: string | undefined;
  // Writes raw HTML text as inline content, as the ordinary text path does.
  const emitText = (html: string) => {
    const words = textMarkdown(html);
    space ||= words.startsWith(" ");
    if (trimAscii(words)) {
      beginInline();
      inline += trimAscii(words);
      space = words.endsWith(" ");
    }
  };
  const flushTextarea = () => {
    // Textarea content is RCDATA: references decode but tags stay literal, and the parser drops
    // a newline right after the start tag.
    const html = withLegacySemicolons((rawTextarea ?? "").replace(/^\r?\n/, ""));
    rawTextarea = undefined;
    emitText(html);
  };

  for (const [index, token] of tokens.entries()) {
    if (hidden) {
      // An end-tag name must be followed by whitespace, `/` or `>`: `</script.foo>` is not one.
      const tag = /^<\s*(\/?)\s*([a-z0-9]+)(?=[\s/>])/i.exec(token);
      if (tag && !tag[1] && hidden.nest && implicitlyCloses(hidden.tag, tag[2].toLowerCase())) {
        // A start tag that implicitly closes the hidden element (a <div> or a second <p> ends
        // a hidden paragraph) is itself visible: stop hiding and process it normally.
        hidden = undefined;
      } else {
        if (tag?.[2].toLowerCase() === hidden.tag) {
          hidden.depth += tag[1] ? -1 : hidden.nest ? 1 : 0;
          if (hidden.depth === 0) hidden = undefined;
        }
        continue;
      }
    }
    // Inside a collapsed disclosure only its summary shows; details/summary tags still run so
    // the state above tracks where the summary starts and ends.
    if (detailsSuppressed() && !/^<\s*\/?\s*(?:details|summary)(?=[\s/>])/i.test(token)) continue;
    // `visibility` is inherited: a hidden subtree stays hidden until a descendant declares
    // itself visible, whose own end tag then hides it again.
    const visTag = /^<\s*(\/?)\s*([a-z0-9]+)(?=[\s/>])([\s\S]*)>$/i.exec(token);
    if (!visTag) {
      if (invisible()) continue;
    } else {
      const name = visTag[2].toLowerCase();
      if (visTag[1]) {
        if (visStack.at(-1)?.tag === name) {
          // A hidden element's opening made no other state, so its end is skipped too; a
          // revealed element's end tag runs normally.
          if (visStack.pop()!.hidden) continue;
        } else if (invisible()) continue;
      } else {
        const declared = declaredStyles(visTag[3]).get("visibility")?.value;
        if (declared === "hidden" || declared === "collapse") {
          if (!VOID_TAGS.has(name)) visStack.push({ tag: name, hidden: true });
          continue;
        }
        if (invisible()) {
          if (declared === "visible" && !VOID_TAGS.has(name)) {
            visStack.push({ tag: name, hidden: false });
          } else continue;
        } else if (declared === "visible" && visStack.length && !VOID_TAGS.has(name)) {
          visStack.push({ tag: name, hidden: false });
        }
      }
    }
    if (rawTextarea !== undefined) {
      if (/^<\s*\/\s*textarea(?=[\s/>])/i.test(token)) flushTextarea();
      else rawTextarea += token;
      continue;
    }
    if (select) {
      const tag = /^<\s*(\/?)\s*([a-z0-9]+)(?=[\s/>])([\s\S]*)>$/i.exec(token);
      const name = tag?.[2].toLowerCase();
      if (tag && !tag[1] && name === "optgroup") {
        select.items.push({ group: readHtmlAttribute(tag[3], "label") ?? "" });
        select.current = undefined;
      } else if (tag && tag[1] && name === "optgroup") {
        select.items.push({ endGroup: true });
        select.current = undefined;
      } else if (tag && !tag[1] && name === "option") {
        // An option's `label` is what the page shows; its text is only the fallback.
        const label = readHtmlAttribute(tag[3], "label");
        const option = {
          text: label ?? "", labeled: label !== undefined,
          selected: readRawHtmlAttribute(tag[3], "selected") !== undefined,
        };
        select.items.push(option);
        select.current = option;
      } else if (tag && tag[1] && name === "select") flushSelect();
      else if (tag && tag[1] && name === "option") select.current = undefined;
      else if ((!token.startsWith("<") || token === "<") && select.current && !select.current.labeled) {
        select.current.text += token;
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
    if (token.startsWith("<!--") || token.startsWith("<!") || token.startsWith("<?")) continue;

    const match = /^<\s*(\/?)\s*([a-z0-9]+)(?=[\s/>])([\s\S]*)>$/i.exec(token);
    if (!match) continue;
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const attributes = match[3];
    // A `hidden` attribute suppresses any element's subtree, as the tag-name set above does;
    // it is honored before disclosure state, so a hidden details never shows its summary.
    const attributeHidden = !closing && readRawHtmlAttribute(attributes, "hidden") !== undefined;
    // A dialog without `open` is not rendered either; an open one keeps block boundaries below.
    const closedDialog = !closing && tag === "dialog" &&
      readRawHtmlAttribute(attributes, "open") === undefined;
    // An effective inline `display: none` hides any element and its subtree.
    const styleHidden = !closing && declaredStyles(attributes).get("display")?.value === "none";
    if (!closing && (HIDDEN_TAGS.has(tag) || attributeHidden || closedDialog || styleHidden)) {
      if (!VOID_TAGS.has(tag)) {
        hidden = {
          tag, depth: 1,
          nest: tag === "template" || attributeHidden || closedDialog || styleHidden,
        };
      }
      continue;
    }
    if (tag === "details") {
      if (closing) details.pop();
      else details.push({
        collapsed: readRawHtmlAttribute(attributes, "open") === undefined,
        inSummary: false, summarySeen: false,
      });
    } else if (tag === "summary" && details.at(-1)?.collapsed) {
      // Only the first summary is a collapsed disclosure's label; later ones are body content.
      const top = details.at(-1)!;
      if (closing) top.inSummary = false;
      else if (!top.summarySeen) { top.inSummary = true; top.summarySeen = true; }
    }
    if (detailsSuppressed()) continue;
    // An anchor or image inside a preformatted block is kept as written, so the block stays
    // raw HTML; other elements there are formatting the verbatim text ignores, as before.
    if (inPre && (tag === "a" || tag === "img")) { preHtml += token; preHasTags = true; continue; }
    const emphasis = emphasisOf(tag, attributes);
    if (emphasis) {
      if (closing) {
        // An unmatched end tag is ignored; a misnested one closes through its opener and
        // reopens the formatting nested inside it, as HTML's adoption agency does.
        const at = frameTags.lastIndexOf(tag);
        if (at >= 0) {
          const inner = frames.splice(at + 1);
          const innerTags = frameTags.splice(at + 1);
          frames.pop();
          frameTags.pop();
          frames.push(...inner);
          frameTags.push(...innerTags);
        }
      } else { frames.push(emphasis); frameTags.push(tag); }
      continue;
    }
    if (BLOCK_TAGS[tag]) {
      const wrapped = !closing && links.length > 0 ? links.at(-1) : undefined;
      if (wrapped !== undefined) closeLink();
      // A block boundary also ends a block-wrapping anchor's current segment, complete.
      closeWrapSegment();
      endBlock();
      if (wrapped !== undefined) {
        links.push(wrapped);
        frames.push({});
        frameTags.push("a");
        // An href-less anchor shows as plain text: reopen it without link delimiters.
        if (wrapped !== null) inline += "[";
      }
    }
    if (PARAGRAPH_LIKE.includes(tag)) {
      markdown += "\n\n";
      continue;
    }

    if (closing) {
      switch (tag) {
        // HTML recovers a stray </br> as a <br>.
        case "br":
          if (inPre) { preText += "\n"; preHtml += "\n"; }
          else if (inCode) { codeText += " "; codeHtml += " "; }
          else if (inHeading) space = true;
          else breaks++;
          break;
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
          // A heading end tag naming another heading is ignored; that heading stays open.
          if (tag !== headingName) break;
          inHeading = false;
          headingName = undefined;
          // A trailing run of `#` after a space would be read as the heading's closing sequence.
          markdown = markdown.replace(/(\s)(#+)$/, "$1\\$2") + "\n\n";
          break;
        case "p": case "div":
          markdown += "\n\n";
          break;
        case "blockquote": closeBlockquote(); break;
        case "code": if (!inPre) flushCode(); break;
        case "pre": writePre(); break;
        // An `</a>` with no anchor open (one a later `<a>` already closed) is ignored, as in HTML.
        // Code before it inside a code element is written first, as the link's label segment.
        case "a": {
          if (inCode) writeCode();
          if (wrapAnchor) {
            closeWrapSegment();
            frames.pop();
            frameTags.pop();
            wrapAnchor = undefined;
            break;
          }
          closeLink();
          break;
        }
        // The page supplies a quotation's marks: closing the one its depth opened. A stray
        // end tag with none open is ignored, as in HTML.
        case "q": {
          if (qDepth === 0) break;
          qDepth--;
          beginInline();
          inline += qDepth % 2 ? "’" : "”";
          break;
        }
        case "li": if (lists.at(-1)?.html) markdown += "\n\n</li>\n\n"; else finishOpenItem(); break;
        case "ul": case "ol": {
          // A list end tag with no open list of its type is ignored, as in a browser; one that
          // matches an outer list closes through the lists nested inside it.
          let at = lists.findLastIndex((list) => list.type === tag);
          if (at < 0) break;
          while (lists.length > at) {
            const list = lists.at(-1)!;
            if (list.html) markdown += `\n\n</${list.type}>\n\n`;
            else finishOpenItem();
            lists.pop();
          }
          listEnd = markdown.length;
          break;
        }
        case "td": case "th": if (cellOpen) markdown += "\t"; cellOpen = false; break;
        case "tr": markdown += "\n"; cellOpen = false; rowOpen = false; break;
        case "table": markdown += "\n\n"; break;
      }
      continue;
    }

    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        inHeading = true;
        headingName = tag;
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
      case "pre": preText = ""; preHtml = ""; preHasTags = false; inPre = true; break;
      // Textarea content is raw text until its end tag; it is collected at the top of the loop.
      case "textarea": rawTextarea = ""; break;
      // A select shows only its selected option, which the top of the loop collects.
      case "select": {
        // A multiple select, or a sized one, shows several options at once: a listbox.
        const size = integer(readHtmlAttribute(attributes, "size"));
        const listbox = readRawHtmlAttribute(attributes, "multiple") !== undefined
          ? "<select multiple>" : size !== undefined && size > 1 ? `<select size="${size}">` : undefined;
        select = { listbox, items: [] };
        break;
      }
      // An input's value and state are its visible content: keep the control as raw HTML,
      // except a hidden one, which the page does not show at all.
      case "input": {
        if ((readHtmlAttribute(attributes, "type") ?? "").toLowerCase() === "hidden") break;
        beginInline();
        inline += token;
        break;
      }
      case "blockquote": markdown += "\n\n"; blockquotes.push(markdown.length); break;
      case "hr": markdown += "\n\n---\n\n"; break;
      // HTML lets `</td>` go unwritten before the next cell, which closes it then.
      case "td": case "th": if (cellOpen) markdown += "\t"; cellOpen = true; break;
      // A table is its own block, apart from any inline content before it.
      case "table": markdown += "\n\n"; break;
      case "tr":
        if (rowOpen) { markdown += "\n"; cellOpen = false; }
        rowOpen = true;
        break;
      case "ul": openList({ type: "ul", next: 1, step: 1 }); break;
      case "ol": {
        const markerType = readHtmlAttribute(attributes, "type");
        if (markerType !== undefined && markerType !== "1" && ["a", "A", "i", "I"].includes(markerType)) {
          // CommonMark has no lettered or roman markers; keep the list as HTML.
          const reversedAttr = readHtmlAttribute(attributes, "reversed") !== undefined;
          const startAttr = integer(readHtmlAttribute(attributes, "start"));
          openList({ type: "ol", step: reversedAttr ? -1 : 1,
            next: startAttr ?? (reversedAttr ? itemValues(tokens, index).length : 1), html: true });
          markdown += `\n\n<ol type="${markerType}"${startAttr !== undefined ? ` start="${startAttr}"` : ""}${reversedAttr ? " reversed" : ""}>\n\n`;
          break;
        }
        const reversed = readHtmlAttribute(attributes, "reversed") !== undefined;
        const values = itemValues(tokens, index);
        const step = reversed ? -1 : 1;
        // A reversed list counts down from its item count unless it says where to start.
        const next = integer(readHtmlAttribute(attributes, "start")) ?? (reversed ? values.length : 1);
        // Only a list starting at 1 may interrupt a paragraph in CommonMark.
        if (inline.trim() && next !== 1) endBlock();
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
        // Code written before an anchor inside a code element stands outside the link, so its
        // segment is written first; the anchor's own segment becomes the label at its `</a>`.
        if (inCode) writeCode();
        // Anchors cannot nest: a browser closes an open one before the next begins, including
        // a block-wrapping one.
        if (wrapAnchor) {
          closeWrapSegment();
          frames.pop();
          frameTags.pop();
          wrapAnchor = undefined;
        }
        closeLink();
        const href = readRawHtmlAttribute(attributes, "href", true);
        // An anchor reaching block content cannot be one link: each block becomes its own.
        if (href !== undefined && anchorWrapsBlock(index)) {
          frames.push(styleEmphasis(attributes));
          frameTags.push("a");
          wrapAnchor = { destination: linkDestination(href), open: false };
          break;
        }
        frames.push(styleEmphasis(attributes));
        frameTags.push("a");
        links.push(href === undefined ? null : linkDestination(href));
        if (href === undefined) break;
        beginInline([]);
        // `!` right before the label would make the link an image.
        if (inline.endsWith("!")) inline = inline.slice(0, -1) + "\\!";
        inline += "[";
        break;
      }
      // The page supplies a quotation's marks, alternating double and single by depth.
      case "q": beginInline(); inline += qDepth++ % 2 ? "‘" : "“"; break;
      case "img": {
        // Code before an image inside a code element is its own segment, written first.
        if (inCode) writeCode();
        beginInline();
        if (inline.endsWith("!")) inline = inline.slice(0, -1) + "\\!";
        const alt = textMarkdown(readRawHtmlAttribute(attributes, "alt", true) ?? "");
        inline += "![" + alt + "](" + linkDestination(readRawHtmlAttribute(attributes, "src", true) ?? "") + ")";
        break;
      }
    }
  }
  if (select) flushSelect();
  if (rawTextarea !== undefined) flushTextarea();
  if (inPre) writePre();
  if (wrapAnchor) { closeWrapSegment(); wrapAnchor = undefined; }
  closeLink();
  endBlock();
  while (items.length > 0) finishItem();
  while (blockquotes.length > 0) closeBlockquote();

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
  return implied && { ...implied, ...styleEmphasis(attributes, implied["~~"] === true) };
}

/**
 * What an element's inline style says about emphasis, which overrides what its tag implies.
 * `ownStrike` is set when the element's own tag implies a line-through: its style then replaces
 * that default, so a decoration without one cancels it. On any other element a descendant's
 * style cannot lift an ancestor's line-through, so strikethrough only turns on there.
 */
/** An element's inline style declarations as the cascade picks each: last `!important`, else last. */
function declaredStyles(attributes: string): Map<string, { value: string; important: boolean }> {
  const style = (readHtmlAttribute(attributes, "style") ?? "").toLowerCase();
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
  return declared;
}

function styleEmphasis(attributes: string, ownStrike = false): Emphasis {
  const declared = declaredStyles(attributes);
  const value = (property: string) => declared.get(property)?.value;
  const emphasis: Emphasis = {};
  // Relative weights resolve against the inherited weight in emphasisIn.
  const weightValue = value("font-weight") ?? "";
  if (weightValue === "bolder" || weightValue === "lighter") emphasis.weight = weightValue;
  else if (weightValue === "bold") emphasis.weight = 700;
  else if (weightValue === "normal") emphasis.weight = 400;
  else if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/.test(weightValue)) {
    // CSS allows any number in 1..1000, fractions included, not just the hundred steps.
    const weight = Number(weightValue);
    if (weight >= 1 && weight <= 1000) emphasis.weight = weight;
  }
  const slant = /^(?:(italic|oblique)\b.*|normal)$/.exec(value("font-style") ?? "");
  if (slant) emphasis["*"] = slant[1] !== undefined;
  const decoration = value("text-decoration-line");
  if (decoration?.includes("line-through")) emphasis["~~"] = true;
  else if (decoration !== undefined && ownStrike) emphasis["~~"] = false;
  return emphasis;
}

/** The emphasis in force inside `frames`, in the order it was turned on. */
function emphasisIn(frames: Emphasis[]): Marker[] {
  const on = new Set<Marker>();
  let weight: number | undefined;
  for (const frame of frames) {
    for (const marker of MARKERS) {
      if (frame[marker]) on.add(marker);
      else if (frame[marker] === false) on.delete(marker);
    }
    // The CSS relative-weight table at its 350/550/750 boundaries: bolder steps below 350 to
    // 400, below 550 to 700, the rest to 900; lighter below 550 to 100, below 750 to 400, else 700.
    if (frame.weight === "bolder") weight = (weight ?? 400) < 350 ? 400 : (weight ?? 400) < 550 ? 700 : 900;
    else if (frame.weight === "lighter") weight = (weight ?? 400) < 550 ? 100 : (weight ?? 400) < 750 ? 400 : 700;
    else if (frame.weight !== undefined) weight = frame.weight;
    else if (frame["**"] !== undefined) weight = frame["**"] ? 700 : 400;
  }
  if (weight !== undefined) {
    if (weight >= 600) on.add("**");
    else on.delete("**");
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
    const tag = /^<\s*(\/?)\s*(ol|ul|li)(?=[\s/>])([\s\S]*)>$/i.exec(token);
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
