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

  it("keeps an ordered list whose start is past CommonMark's nine digits as HTML list tags", () => {
    expect(render(htmlToMarkdown('<ol start="1000000000000"><li>x</li></ol>')))
      .toBe('<ol start="1000000000000">\n<li value="1000000000000">\n<p>x</p>\n</li>\n</ol>\n');
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

  it("honors item values, decodes references in code, and leaves out what the page never shows", () => {
    expect(render(htmlToMarkdown(
      "<ol><li value=\"5\">five</li><li>six</li></ol><p>before</p><script>alert(1)</script>" +
      "<style>p{}</style><template><p>t</p></template><p>after <code>&copy;</code></p><pre>&copy;</pre>")))
      .toBe('<ol start="5">\n<li>five</li>\n<li>six</li>\n</ol>\n<p>before</p>\n<p>after <code>\u00a9</code></p>\n' +
        // An HTML block, passed through as written, which a browser shows as ©.
        "<pre><code>&copy;</code></pre>\n");
  });

  it("ends raw-text elements at their first close, renumbers mid-list, and takes the last style", () => {
    expect(render(htmlToMarkdown(
      '<script>let s = "<script>";</script><p>shown</p><ol><li>one</li><li value="5">five</li><li>six</li></ol>' +
      '<p><span style="font-weight:bold;font-weight:normal">plain</span> ' +
      '<span style="font-weight:normal;font-weight:bold">bold</span></p>')))
      .toBe('<p>shown</p>\n<ol>\n<li>one</li>\n</ol>\n<!-- -->\n<ol start="5">\n<li>five</li>\n<li>six</li>\n</ol>\n' +
        "<p>plain <strong>bold</strong></p>\n");
  });

  it("numbers reversed lists down, and reads semicolonless references as a browser does", () => {
    expect(render(htmlToMarkdown(
      '<ol reversed start="5"><li>five</li><li>four</li></ol><ol reversed><li>b</li><li>a</li></ol>' +
      '<p>&copy test &notit &amp; <a href="?a=1&copy=2&amp">x</a></p>')))
      .toBe('<ol start="5">\n<li>five</li>\n</ol>\n<!-- -->\n<ol start="4">\n<li>four</li>\n</ol>\n<!-- -->\n' +
        '<ol start="2">\n<li>b</li>\n</ol>\n<!-- -->\n<ol>\n<li>a</li>\n</ol>\n' +
        '<p>\u00a9 test \u00acit &amp; <a href="?a=1&amp;copy=2&amp;">x</a></p>\n');
  });

  it("separates cells whose end tags were left out, maps C1 references, and drops empty code", () => {
    expect(htmlToMarkdown("<table><tr><td>a<td>b</tr></table>")).toBe("a\tb\n");
    expect(render(htmlToMarkdown("<p>&#128;&#x9F;&#129; a<code></code>b</p>")))
      .toBe("<p>\u20ac\u0178\u0081 ab</p>\n");
  });

  it("keeps numbers below zero as HTML list tags, and decodes semicolonless numeric references", () => {
    expect(render(htmlToMarkdown('<ol start="-2"><li>a</li><li onclick="x()">b</li></ol><p>&#169 test &#xa9x</p>')))
      .toBe('<ol start="-2">\n<li value="-2">\n<p>a</p>\n</li>\n<li value="-1">\n<p>b</p>\n</li>\n</ol>\n' +
        "<p>\u00a9 test \u00a9x</p>\n");
  });

  it("keeps other block elements apart, and closes an anchor when another opens", () => {
    expect(htmlToMarkdown("<section>one</section><section>two</section><dl><dt>Term</dt><dd>Definition</dd></dl>"))
      .toBe("one\n\ntwo\n\nTerm\n\nDefinition\n");
    expect(render(htmlToMarkdown('<p><a href="a">one<a href="b">two</a>three</a></p>')))
      .toBe('<p><a href="a">one</a><a href="b">two</a>three</p>\n');
  });

  it("writes code whose end tag was left out, and lets !important win the cascade", () => {
    expect(htmlToMarkdown("<p>a<code>b</p>")).toBe("a`b`\n");
    expect(htmlToMarkdown('<p><span style="font-weight:bold!important;font-weight:normal">x</span></p>'))
      .toBe("**x**\n");
  });

  it("keeps a link's destination whole when it holds parentheses or spaces", () => {
    expect(render(htmlToMarkdown('<p><a href="https://example.com/a)">x</a> <img src="b (1).png" alt="y"></p>')))
      .toBe('<p><a href="https://example.com/a)">x</a> <img src="b%20(1).png" alt="y" /></p>\n');
  });

  it("ignores a list end tag that matches no open list of its type", () => {
    expect(render(htmlToMarkdown("<ol><li>one</ul><li>two</ol>")))
      .toBe("<ol>\n<li>one</li>\n<li>two</li>\n</ol>\n");
    expect(render(htmlToMarkdown("<ul><li>one</ol><li>two</ul>")))
      .toBe("<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n");
    // One matching an outer list closes through the lists nested inside it.
    expect(render(htmlToMarkdown("<ul><li>one<ol><li>two</ul><li>three</li></ul>")))
      .toBe("<ul>\n<li>one\n<ol>\n<li>two</li>\n</ol>\n</li>\n<li>three</li>\n</ul>\n");
  });

  it("lets an element's own style cancel its strike, and keeps code inside link labels", () => {
    expect(htmlToMarkdown(
      '<p><s style="text-decoration:none">plain</s> <s>struck</s> ' +
      '<s><span style="text-decoration:none">still</span></s></p>'))
      .toBe("plain ~~struck still~~\n");
    expect(render(htmlToMarkdown('<p><code><a href="x">foo</a></code></p>')))
      .toBe('<p><a href="x"><code>foo</code></a></p>\n');
    expect(render(htmlToMarkdown('<p><code>pre <a href="x">foo</a> post</code></p>')))
      .toBe('<p><code>pre </code><a href="x"><code>foo</code></a><code> post</code></p>\n');
  });

  it("shows a textarea's contents as the literal text the page shows", () => {
    expect(render(htmlToMarkdown("<textarea><b>literal</b> &copy;</textarea>")))
      .toBe("<p>&lt;b&gt;literal&lt;/b&gt; \u00a9</p>\n");
    expect(render(htmlToMarkdown("<textarea>before</textarea.foo><b>after</b></textarea>")))
      .toBe("<p>before&lt;/textarea.foo&gt;&lt;b&gt;after&lt;/b&gt;</p>\n");
    expect(htmlToMarkdown('<p><span style="font-weight:650">heavy</span> ' +
      '<span style="font-weight:550">medium</span></p>'))
      .toBe("**heavy** medium\n");
    expect(htmlToMarkdown("<p>a</p><textarea>left open"))
      .toBe("a\n\nleft open\n");
  });

  it("reopens an href-less anchor without brackets, and keeps hidden content hidden", () => {
    expect(htmlToMarkdown("<a><div>x</div></a>")).toBe("x\n");
    expect(htmlToMarkdown("<p hidden>private draft</p><p>shown</p>")).toBe("shown\n");
    expect(htmlToMarkdown("<div hidden><div>x</div>y</div><p>shown</p>")).toBe("shown\n");
    expect(htmlToMarkdown('<p>a<img hidden src="x">b</p>')).toBe("ab\n");
    expect(htmlToMarkdown("<script>secret</script.foo>visible</script><p>shown</p>"))
      .toBe("shown\n");
  });

  it("reads malformed tag names as unknown elements, and keeps tables and rows apart", () => {
    expect(htmlToMarkdown("<b.foo>x</b.foo>")).toBe("x\n");
    expect(htmlToMarkdown("<div>intro<table><tr><td>a</td></tr></table></div>"))
      .toBe("intro\n\na\n");
    expect(htmlToMarkdown("<table><tr><td>a</td><tr><td>b</td></tr></table>"))
      .toBe("a\nb\n");
  });

  it("leaves iframe fallback, collapsed details and unselected options unshown", () => {
    expect(htmlToMarkdown("<iframe>private fallback</iframe><p>shown</p>")).toBe("shown\n");
    expect(htmlToMarkdown(
      "<details><summary>Public title</summary>hidden until expanded</details><p>shown</p>"))
      .toBe("Public title\n\nshown\n");
    expect(htmlToMarkdown("<details open><summary>Title</summary>body</details>"))
      .toBe("Title\n\nbody\n");
    expect(htmlToMarkdown("<select><option>one</option><option selected>two</option></select>"))
      .toBe("two\n");
    expect(htmlToMarkdown("<select><option>one</option><option>two</option></select>"))
      .toBe("one\n");
    expect(htmlToMarkdown(
      "<details><summary>shown</summary><summary>hidden</summary>body</details>"))
      .toBe("shown\n");
    expect(htmlToMarkdown(
      "<select multiple><option selected>one</option><option selected>two</option></select>"))
      .toBe("<select multiple>\n<option selected>one</option>\n<option selected>two</option>\n</select>\n");
    expect(htmlToMarkdown('<p>Name: <input value="Ada"></p>')).toBe('Name: <input value="Ada">\n');
    expect(htmlToMarkdown('<p>a<input type="hidden" value="x">b</p>')).toBe("ab\n");
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
