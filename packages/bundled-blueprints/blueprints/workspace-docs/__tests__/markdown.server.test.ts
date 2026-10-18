// @vitest-environment node
import { HtmlRenderer, Parser } from "commonmark";
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../files/lib/markdown.ts";

describe("htmlToMarkdown", () => {
  // The markup Chrome's execCommand writes under styleWithCSS for the toolbar's Bold, Italic,
  // Strikethrough, Underline and font size.
  it("exports the emphasis the toolbar applies as inline styles", () => {
    expect(htmlToMarkdown(
      '<p data-block-id="b1"><span style="font-weight: bold;">Hello</span> ' +
      '<span style="font-style: italic;">world</span>, ' +
      '<span style="text-decoration-line: line-through;">select</span> ' +
      '<span style="text-decoration-line: underline;">me</span> ' +
      '<font style="font-size: 18pt;">big</font> ' +
      '<span style="font-weight: 700; font-style: italic;">both</span>.</p>',
    )).toBe("**Hello** *world*, ~~select~~ me big ***both***.\n");
  });

  // Plain-text paste writes each newline as a `<br>`, so a blank line between pasted paragraphs
  // is two in a row.
  it("keeps each line break, but not those holding the end of a paragraph open", () => {
    expect(htmlToMarkdown(
      "<p>line one<br>line <b>two</b><br></p><p>pasted<br><br>after a blank line<br><br></p>" +
      "<p><br></p><h2>a<br>b</h2><pre>x<br>y</pre>",
    )).toBe(
      "line one\\\nline **two**\n\npasted\\\n\\\nafter a blank line\n\n## a b\n\n```\nx\ny\n```\n",
    );
  });

  // Typing "Hello " in bold leaves the space inside the run, and `**Hello **world` keeps its
  // asterisks; Enter after a bold line leaves an empty bold run, and `****` is a horizontal rule.
  it("writes emphasis only around text, tight against it", () => {
    expect(htmlToMarkdown(
      '<p><span style="font-weight: bold;">Hello </span>world,<i> see</i> ' +
      '<b><a href="https://example.com">this</a></b></p>' +
      '<p><span style="font-weight: bold;"><br></span></p>' +
      '<p><span style="text-decoration-line: line-through;"><br></span></p>',
    )).toBe("**Hello** world, *see* [**this**](https://example.com)\n");
  });

  // Bolding again what is already bold, or next to it, gives two elements for one stretch of
  // bold; a pair of markers each would read `**A****B**`, with the asterisks showing.
  it("writes one pair of markers for each stretch of formatting", () => {
    expect(htmlToMarkdown(
      '<p><b>A<span style="font-weight: bold;">B</span>C</b> and <b>pasted</b>' +
      '<span style="font-weight: bold;">rebold</span>, <i><b>both</b> italic</i></p>',
    )).toBe("**ABC** and **pastedrebold**, ***both** italic*\n");
  });

  // An agent's HTML can unbold inside bold, and Google Docs wraps what it copies in
  // `<b style="font-weight: normal">`; the page shows the innermost element's say.
  it("lets an element's style turn off the emphasis its tag or an ancestor applies", () => {
    expect(htmlToMarkdown(
      '<p><b>one <span style="font-weight: normal">two</span> three</b> ' +
      '<i>four <span style="font-style: normal;">five</span></i> ' +
      '<b style="font-weight: normal">six</b></p>',
    )).toBe("**one** two **three** *four* five six\n");
  });

  // Emphasis cannot pair across a link label's brackets (`**[one** two](…)` shows its asterisks),
  // and the toolbar's Bold or Italic on a whole link styles the link itself.
  it("renders a link label's emphasis on the letters that have it", () => {
    const markdown = htmlToMarkdown(
      '<p><b>see <a href="https://example.com">one <span style="font-weight: normal">two</span></a></b> ' +
      '<a href="https://example.com" style="font-style: italic;">three</a></p>',
    );
    expect(renderedFormats(markdown), markdown).toEqual([..."bbbbbb", "", "", "", ..."iiiii"]);
  });

  // The editor gives each stretch of formatting one span, so bolding one range of a line and
  // italicising another, inside a word or across words, gives these runs. Delimiters that change
  // inside a word can pair differently than written (`**A***B**C***` leaves C unbolded).
  it("exports bold and italic that CommonMark renders on the same letters", () => {
    const text = "ab cd ef";
    const offsets = [...Array(text.length + 1).keys()];
    const ranges = offsets.flatMap((start) => offsets.filter((end) => end > start).map((end) => [start, end]));
    for (const [boldStart, boldEnd] of ranges) {
      for (const [italicStart, italicEnd] of ranges) {
        const formats = [...text].map((_, i) =>
          (i >= boldStart && i < boldEnd ? "b" : "") + (i >= italicStart && i < italicEnd ? "i" : ""));
        const markdown = htmlToMarkdown(editorHtml(text, formats));
        expect(renderedFormats(markdown), markdown)
          .toEqual(formats.filter((_, i) => text[i] !== " "));
      }
    }
  });

  it("keeps code verbatim, without emphasis or escapes", () => {
    expect(htmlToMarkdown(
      '<pre><span style="font-weight: bold;">npm</span> install</pre>' +
      "<p>Run <code>a*b_c</code> or <b><code>x</code></b>, <code>one<br>line</code></p>",
    )).toBe("```\nnpm install\n```\n\nRun `a*b_c` or **`x`**, `one line`\n");
  });

  // Text that happens to start like block syntax must come back as the paragraph it was.
  it("escapes block markers that open a paragraph or a line in one", () => {
    const html = "<p># not a heading</p><p>- not a list</p><p>&gt; not a quote</p><p>12. not a list</p>" +
      "<p>a<br>## nor this</p><p> ``` not a fence</p><p>nor<br>===</p><p>this<br>---</p>";
    expect(render(htmlToMarkdown(html))).toBe(
      "<p># not a heading</p>\n<p>- not a list</p>\n<p>&gt; not a quote</p>\n<p>12. not a list</p>\n" +
      "<p>a<br />\n## nor this</p>\n<p>``` not a fence</p>\n<p>nor<br />\n===</p>\n<p>this<br />\n---</p>\n");
  });

  it("keeps typed HTML, entities and backticks as the text they were", () => {
    expect(render(htmlToMarkdown("<p>&lt;b&gt;plain&lt;/b&gt; &amp;copy; `tick`</p>")))
      .toBe("<p>&lt;b&gt;plain&lt;/b&gt; &amp;copy; `tick`</p>\n");
  });

  it("nests a list inside an ordered item at that item's content column", () => {
    expect(render(htmlToMarkdown("<ol><li>a<ul><li>b</li></ul></li></ol>")))
      .toBe("<ol>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n</ol>\n");
    const nine = "<li>x</li>".repeat(9);
    expect(render(htmlToMarkdown(`<ol>${nine}<li>ten<ul><li>deep</li></ul></li></ol>`)))
      .toContain("<li>ten\n<ul>\n<li>deep</li>\n</ul>\n</li>");
  });

  it("keeps an item's later paragraphs inside it", () => {
    expect(render(htmlToMarkdown("<ul><li><p>first</p><p>second</p></li><li>next</li></ul>")))
      .toBe("<ul>\n<li>\n<p>first</p>\n<p>second</p>\n</li>\n<li>\n<p>next</p>\n</li>\n</ul>\n");
  });

  it("keeps a quoted >, an ordered list's start, and literal tildes", () => {
    expect(render(htmlToMarkdown('<p><a href="https://example.com/a>b">x</a> ~~kept~~</p><ol start="5"><li>five</li></ol>')))
      .toBe('<p><a href="https://example.com/a%3Eb">x</a> ~~kept~~</p>\n<ol start="5">\n<li>five</li>\n</ol>\n');
  });

  it("keeps a heading's trailing hashes as text", () => {
    expect(render(htmlToMarkdown("<h2>Issue #</h2><h3>C ##</h3>"))).toBe("<h2>Issue #</h2>\n<h3>C ##</h3>\n");
  });

  it("reads whole attribute names, and replaces numeric references outside Unicode", () => {
    expect(render(htmlToMarkdown(
      '<p><a data-href="old" href="new">x</a> <img srcset="wrong.png 1x" src="right.png" alt="y"> &#x110000;&#0;&#xD800;</p>')))
      .toBe('<p><a href="new">x</a> <img src="right.png" alt="y" /> \uFFFD\uFFFD\uFFFD</p>\n');
  });

  it("keeps no-break spaces, alt text, and a ! before a link as they were", () => {
    expect(render(htmlToMarkdown(
      '<p>a&nbsp;&nbsp;b Wow!<a href="https://e.com/?a=1&amp;copy;=2">x</a> <img src="i.png" alt="*lit* &amp;copy;"></p>')))
      .toBe('<p>a\u00a0\u00a0b Wow!<a href="https://e.com/?a=1&amp;copy;=2">x</a> <img src="i.png" alt="*lit* &amp;copy;" /></p>\n');
  });

  it("keeps code blocks verbatim inside list items and quotes", () => {
    const code = "a  \n\n\n\tb&nbsp;";
    expect(render(htmlToMarkdown(`<ul><li>item<pre>${code}</pre></li></ul><blockquote><pre>${code}</pre></blockquote>`)))
      .toBe("<ul>\n<li>\n<p>item</p>\n<pre><code>a  \n\n\n\tb\u00a0\n</code></pre>\n</li>\n</ul>\n" +
        "<blockquote>\n<pre><code>a  \n\n\n\tb\u00a0\n</code></pre>\n</blockquote>\n");
  });

  it("numbers an ordered list from 1 when its start is past CommonMark's nine digits", () => {
    expect(render(htmlToMarkdown('<ol start="1000000000000"><li>x</li></ol>'))).toBe("<ol>\n<li>x</li>\n</ol>\n");
  });

  it("keeps a ] inside a link label or alt text", () => {
    expect(render(htmlToMarkdown('<p><a href="x">a]b</a> <img src="i" alt="c]d"></p>')))
      .toBe('<p><a href="x">a]b</a> <img src="i" alt="c]d" /></p>\n');
  });

  it("shows named references, pre's first line, and href-less anchors as the page does", () => {
    expect(render(htmlToMarkdown(
      '<p>&copy; &amp;copy; <a id="s">Heading</a> <a href="">empty</a></p><pre>\ncode</pre>')))
      .toBe('<p>\u00a9 &amp;copy; Heading <a href="">empty</a></p>\n<pre><code>code\n</code></pre>\n');
  });

  it("decodes a named reference in a destination as the page does", () => {
    expect(render(htmlToMarkdown('<p><a href="https://e.com/?q=&copy;&amp;r=1">x</a></p>')))
      .toBe('<p><a href="https://e.com/?q=%C2%A9&amp;r=1">x</a></p>\n');
  });

  it("keeps a bare < as text and closes list items whose end tags HTML lets go unwritten", () => {
    expect(render(htmlToMarkdown("<p>1 < 2</p><ul><li>one<li>two<ul><li>deep</ul><li>three</ul>")))
      .toBe("<p>1 &lt; 2</p>\n<ul>\n<li>one</li>\n<li>two\n<ul>\n<li>deep</li>\n</ul>\n</li>\n<li>three</li>\n</ul>\n");
  });

  it("reads attributes outside other values, and escapes markers spelled across elements", () => {
    expect(render(htmlToMarkdown(`<p><a title="href='wrong'" href="right">x</a></p><p><span>1</span>. plain</p>`)))
      .toBe('<p><a href="right">x</a></p>\n<p>1. plain</p>\n');
  });

  it("keeps a link's destination whole when it holds parentheses or spaces", () => {
    expect(render(htmlToMarkdown('<p><a href="https://example.com/a)">x</a> <img src="b (1).png" alt="y"></p>')))
      .toBe('<p><a href="https://example.com/a)">x</a> <img src="b%20(1).png" alt="y" /></p>\n');
  });

  it("delimits code by runs longer than the backticks inside it", () => {
    const markdown = htmlToMarkdown("<p><code>a`b</code> <code>`x</code> <code> a </code></p><pre>one\n```\ntwo</pre>");
    expect(render(markdown)).toBe(
      "<p><code>a`b</code> <code>`x</code> <code> a </code></p>\n<pre><code>one\n```\ntwo\n</code></pre>\n");
  });
});

/** `text` as the editor marks it up, with one span for each stretch of the same `formats`. */
function editorHtml(text: string, formats: string[]): string {
  let html = "";
  for (let start = 0; start < text.length;) {
    let end = start + 1;
    while (formats[end] === formats[start]) end++;
    const style = [
      formats[start].includes("b") && "font-weight: bold;",
      formats[start].includes("i") && "font-style: italic;",
    ].filter(Boolean).join(" ");
    const run = text.slice(start, end);
    html += style ? `<span style="${style}">${run}</span>` : run;
    start = end;
  }
  return `<p>${html}</p>`;
}

/** The formats CommonMark renders `markdown`'s visible characters with; a stray `*` is one. */
function renderedFormats(markdown: string): string[] {
  const html = new HtmlRenderer().render(new Parser().parse(markdown));
  const formats: string[] = [];
  let bold = 0;
  let italic = 0;
  for (const token of html.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (/^<\/?strong>$/.test(token)) bold += token[1] === "/" ? -1 : 1;
    else if (/^<\/?em>$/.test(token)) italic += token[1] === "/" ? -1 : 1;
    else if (!token.startsWith("<")) {
      const format = (bold ? "b" : "") + (italic ? "i" : "");
      formats.push(...Array.from(token.replace(/\s/g, ""), () => format));
    }
  }
  return formats;
}

function render(markdown: string): string {
  return new HtmlRenderer().render(new Parser().parse(markdown));
}
