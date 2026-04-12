---
date: 2026-04-09
topic: Marked email-safe HTML rendering
tags: [marked, email, html, css-inlining, juice]
status: complete
sources_count: 15
---

# Marked Email-Safe HTML Rendering

## Research Question

How to use the `marked` Markdown library to produce HTML that renders correctly across all major email clients (Gmail, Outlook, Apple Mail, Yahoo), including CSS inlining strategies and email-specific constraints.

## Executive Summary

Converting Markdown to email-safe HTML requires a two-stage pipeline: (1) render Markdown to HTML using `marked` with a **custom renderer** that outputs email-compatible tags with inline styles, then (2) run the output through **juice** to inline any remaining CSS. The key constraints are: use `<table>` for layout (Outlook uses Word's rendering engine), inline all styles (Gmail strips `<style>` blocks), stay under 102KB total HTML (Gmail clips), use web-safe fonts only, and avoid all modern CSS (flexbox, grid, variables). A custom `marked` renderer is the cleanest integration point -- override ~12 methods to emit email-safe markup with inline styles directly.

## Detailed Findings

### 1. Marked Custom Renderer API

Marked provides a `renderer` option via `marked.use()` that lets you override how each token type is converted to HTML. This is the primary integration point for email-safe output.

**All overridable renderer methods** ([marked docs](https://marked.js.org/using_pro)):

| Method | Token Properties | Purpose |
|--------|-----------------|---------|
| `space()` | -- | Whitespace |
| `code({ text, lang })` | text, lang, escaped | Fenced code blocks |
| `blockquote({ tokens })` | tokens (child tokens) | Blockquotes |
| `html({ text })` | text | Raw HTML passthrough |
| `heading({ tokens, depth })` | tokens, depth (1-6) | Headings |
| `hr()` | -- | Horizontal rules |
| `list({ items, ordered, start })` | items, ordered, start | Lists |
| `listitem({ tokens, task, checked })` | tokens, task, checked | List items |
| `checkbox({ checked })` | checked | Checkboxes |
| `paragraph({ tokens })` | tokens (inline children) | Paragraphs |
| `table({ header, rows })` | header, rows, align | Data tables |
| `tablerow({ text })` | text | Table rows |
| `tablecell({ tokens, header, align })` | tokens, header, align | Table cells |
| `strong({ tokens })` | tokens | Bold |
| `em({ tokens })` | tokens | Italic |
| `codespan({ text })` | text | Inline code |
| `br()` | -- | Line breaks |
| `del({ tokens })` | tokens | Strikethrough |
| `link({ href, title, tokens })` | href, title, tokens | Links |
| `image({ href, title, text })` | href, title, text | Images |

**Usage pattern:**

```javascript
import { marked } from 'marked';

marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const sizes = { 1: '24px', 2: '20px', 3: '18px', 4: '16px', 5: '14px', 6: '12px' };
      return `<h${depth} style="margin: 0 0 12px 0; font-size: ${sizes[depth]}; font-family: Arial, sans-serif; color: #333333;">${text}</h${depth}>\n`;
    },
    paragraph({ tokens }) {
      const text = this.parser.parseInline(tokens);
      return `<p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.5; font-family: Arial, sans-serif; color: #333333;">${text}</p>\n`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${title}"` : '';
      return `<a href="${href}"${titleAttr} style="color: #1a73e8; text-decoration: underline;">${text}</a>`;
    },
    // ... more overrides
  }
});
```

Child tokens must be parsed with `this.parser.parseInline(tokens)` for inline content or `this.parser.parse(tokens)` for block content.

### 2. Email HTML/CSS Compatibility Constraints

**Universally safe HTML tags** ([caniemail.com](https://www.caniemail.com/), [GetResponse](https://www.getresponse.com/blog/supported-html-tags-in-email-clients)):

- **Text:** `<p>`, `<h1>`-`<h6>`, `<span>`, `<strong>`, `<b>`, `<em>`, `<i>`, `<u>`, `<s>`, `<del>`, `<br>`, `<hr>`, `<pre>`, `<code>`, `<blockquote>`
- **Lists:** `<ul>`, `<ol>`, `<li>`, `<dl>`, `<dt>`, `<dd>`
- **Tables:** `<table>`, `<tr>`, `<td>`, `<th>`, `<thead>`, `<tbody>`, `<caption>`
- **Media:** `<img>` (with `alt`, `width`, `height` attributes)
- **Links:** `<a>` (with `href`; `target="_blank"` stripped by some clients)
- **Structure:** `<div>` (partial Outlook support), `<table>` (preferred for layout)

**Universally safe CSS properties** (inline only):

- `color`, `background-color`, `font-family`, `font-size`, `font-weight`, `font-style`
- `line-height`, `text-align`, `text-decoration`, `text-transform`
- `margin`, `padding` (longhand preferred: `margin-top`, `padding-left`, etc.)
- `border`, `border-collapse`, `border-spacing`, `border-radius` (91% support, not Outlook desktop)
- `width`, `height` (on `<table>`, `<td>`, `<img>`)
- `vertical-align`

**Avoid these CSS properties:**

- `display: flex`, `display: grid` -- no Outlook support
- `float`, `position`, `clear` -- unreliable
- CSS variables (`var()`) -- no support
- `max-width` on its own -- Outlook ignores; must pair with `width` attribute
- CSS shorthand -- prefer longhand (`margin-top: 10px` not `margin: 10px 0`)
- `background-image` -- inconsistent
- `@font-face` -- only Apple Mail, iOS Mail, Samsung Mail

**Critical client-specific constraints:**

| Client | Engine | Key Limitations |
|--------|--------|----------------|
| Gmail (web) | Blink | Strips `<style>` blocks, no media queries, clips at 102KB |
| Gmail (mobile) | Blink | Supports `<style>` blocks and media queries |
| Outlook 2016-2021 | **Word** | No flexbox/grid, limited CSS, uses VML for rounded corners |
| Outlook.com | Chromium | Strips class selectors from `<style>` |
| Outlook (new) | Chromium | Better CSS support, phasing in through 2027 |
| Apple Mail | WebKit | Best CSS support, handles `@font-face`, media queries |
| Yahoo Mail | -- | Rewrites class names, supports `<style>` |

### 3. CSS Inlining with Juice

**Juice** ([npm](https://www.npmjs.com/package/juice), [GitHub](https://github.com/Automattic/juice)) is the standard Node.js tool for converting `<style>` blocks to inline `style` attributes.

**Core API:**

```javascript
import juice from 'juice';

// Simple: inline styles from <style> tags in the HTML
const inlined = juice(htmlWithStyleBlock);

// From separate CSS string
const inlined2 = juice.inlineContent(html, cssString);

// With options
const inlined3 = juice(html, {
  applyStyleTags: true,        // Process <style> tags (default: true)
  removeStyleTags: true,        // Remove <style> after inlining (default: true)
  preserveMediaQueries: true,   // Keep @media in <style> (default: true)
  preserveFontFaces: true,      // Keep @font-face rules (default: true)
  preserveKeyFrames: true,      // Keep @keyframes (default: true)
  applyWidthAttributes: true,   // CSS width -> width="" attribute (default: true)
  applyHeightAttributes: true,  // CSS height -> height="" attribute (default: true)
  xmlMode: false,               // XHTML self-closing tags (default: false)
});
```

**Key options for email:**

- `applyWidthAttributes: true` -- converts CSS `width` to HTML `width` attribute, critical for Outlook
- `applyHeightAttributes: true` -- same for height
- `preserveMediaQueries: true` -- keeps responsive `@media` rules in a `<style>` block for clients that support them (Gmail mobile, Apple Mail)
- `removeStyleTags: true` -- cleans up after inlining

**Juice ignore directives** (in CSS):

```css
/* juice ignore */              /* Skip entire stylesheet */
/* juice start ignore */        /* Begin ignore block */
/* juice end ignore */          /* End ignore block */
```

**Preserve a `<style>` block** (e.g., for media queries):

```html
<style data-embed>
  /* This style block is preserved by Juice */
  @media (max-width: 600px) { ... }
</style>
```

### 4. Recommended Integration Pattern

**Two-stage pipeline: marked renderer + juice post-processing**

```javascript
import { marked } from 'marked';
import juice from 'juice';

// Stage 1: Configure marked with email-safe renderer
marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const sizes = { 1: '24px', 2: '20px', 3: '18px', 4: '16px', 5: '14px', 6: '12px' };
      return `<h${depth} style="margin: 0 0 12px 0; font-size: ${sizes[depth]}; font-weight: bold; font-family: Arial, Helvetica, sans-serif; color: #1a1a1a;">${text}</h${depth}>\n`;
    },

    paragraph({ tokens }) {
      const text = this.parser.parseInline(tokens);
      return `<p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.5; font-family: Arial, Helvetica, sans-serif; color: #333333;">${text}</p>\n`;
    },

    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${title}"` : '';
      return `<a href="${href}"${titleAttr} style="color: #1a73e8; text-decoration: underline;">${text}</a>`;
    },

    strong({ tokens }) {
      const text = this.parser.parseInline(tokens);
      return `<strong style="font-weight: bold;">${text}</strong>`;
    },

    em({ tokens }) {
      const text = this.parser.parseInline(tokens);
      return `<em style="font-style: italic;">${text}</em>`;
    },

    codespan({ text }) {
      return `<code style="background-color: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-family: 'Courier New', Courier, monospace; font-size: 14px; color: #d63384;">${text}</code>`;
    },

    code({ text, lang }) {
      return `<pre style="background-color: #f6f8fa; padding: 16px; border-radius: 6px; overflow-x: auto; margin: 0 0 16px 0;"><code style="font-family: 'Courier New', Courier, monospace; font-size: 14px; line-height: 1.45; color: #24292e;">${text}</code></pre>\n`;
    },

    blockquote({ tokens }) {
      const body = this.parser.parse(tokens);
      return `<blockquote style="margin: 0 0 16px 0; padding: 12px 16px; border-left: 4px solid #ddd; color: #666666; font-style: italic;">${body}</blockquote>\n`;
    },

    list({ items, ordered, start }) {
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
      const body = items.map(item => this.listitem(item)).join('');
      return `<${tag}${startAttr} style="margin: 0 0 16px 0; padding-left: 24px;">${body}</${tag}>\n`;
    },

    listitem({ tokens, task, checked }) {
      let text = this.parser.parse(tokens);
      if (task) {
        const checkbox = checked ? '&#9745; ' : '&#9744; ';
        text = checkbox + text;
      }
      return `<li style="margin: 0 0 4px 0; font-size: 16px; line-height: 1.5; font-family: Arial, Helvetica, sans-serif; color: #333333;">${text}</li>\n`;
    },

    table({ header, rows }) {
      let headerHtml = '<tr>' + header.map(cell => {
        const align = cell.align ? ` text-align: ${cell.align};` : '';
        const content = this.parser.parseInline(cell.tokens);
        return `<th style="padding: 8px 12px; border: 1px solid #ddd; background-color: #f6f8fa; font-weight: bold;${align}">${content}</th>`;
      }).join('') + '</tr>';

      let rowsHtml = rows.map(row =>
        '<tr>' + row.map(cell => {
          const align = cell.align ? ` text-align: ${cell.align};` : '';
          const content = this.parser.parseInline(cell.tokens);
          return `<td style="padding: 8px 12px; border: 1px solid #ddd;${align}">${content}</td>`;
        }).join('') + '</tr>'
      ).join('');

      return `<table style="border-collapse: collapse; width: 100%; margin: 0 0 16px 0;" cellpadding="0" cellspacing="0">${headerHtml}${rowsHtml}</table>\n`;
    },

    hr() {
      return `<hr style="border: 0; border-top: 1px solid #ddd; margin: 24px 0;">\n`;
    },

    image({ href, title, text }) {
      const titleAttr = title ? ` title="${title}"` : '';
      return `<img src="${href}" alt="${text}"${titleAttr} style="max-width: 100%; height: auto; display: block; margin: 0 0 16px 0;" />`;
    },

    br() {
      return '<br />';
    },

    del({ tokens }) {
      const text = this.parser.parseInline(tokens);
      return `<s style="text-decoration: line-through;">${text}</s>`;
    },
  }
});

// Stage 2: Render and wrap in email template
function markdownToEmail(markdown) {
  const bodyHtml = marked.parse(markdown);

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #ffffff;">
    <tr>
      <td align="center" style="padding: 20px 0;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <tr>
            <td style="padding: 20px; font-family: Arial, Helvetica, sans-serif;">
              ${bodyHtml}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // Stage 3: Juice pass for any remaining CSS
  return juice(fullHtml, {
    preserveMediaQueries: true,
    applyWidthAttributes: true,
    applyHeightAttributes: true,
    removeStyleTags: true,
  });
}
```

### 5. Alternative: emailmd

[emailmd](https://github.com/unmta/emailmd) is a purpose-built library that uses MJML under the hood to convert Markdown to responsive, email-safe HTML. It handles responsive layout, CSS inlining, and client compatibility automatically.

```javascript
import { render } from "emailmd";
const { html, text } = render("# Hello\nWelcome to the newsletter.");
```

**Trade-offs vs. marked + juice:**

| Aspect | marked + juice | emailmd |
|--------|---------------|---------|
| Control over output | Full -- every tag customizable | Limited -- MJML abstractions |
| Bundle size | marked (~40KB) + juice (~30KB) | Heavier (includes MJML) |
| Responsive design | Manual | Automatic |
| Maturity | Both battle-tested | Pre-1.0, API may change |
| Learning curve | Moderate | Low |

For a project that already uses `marked` or needs fine-grained control over HTML output (e.g., matching a design system), the custom renderer approach is better. For a quick solution with built-in responsive design, `emailmd` is worth evaluating.

## Comparison Table: CSS Inlining Tools

| Feature | juice | inline-css | emailmd (built-in) |
|---------|-------|------------|-------------------|
| npm weekly downloads | ~2M | ~300K | <10K |
| Maintained by | Automattic | Community | unmta |
| Preserve media queries | Yes | Yes | Yes (via MJML) |
| Width/height attr conversion | Yes | No | Yes |
| Remote resource fetching | Optional (`juiceResources`) | Yes | N/A |
| `<style data-embed>` | Yes | No | N/A |
| Ignore directives in CSS | Yes | No | N/A |
| cheerio integration | Yes (`juiceDocument`) | No | No |

**Recommendation:** Use `juice`. It is the most mature, best-maintained, and has the richest option set for email use cases.

## Best Practices

1. **Inline all styles directly in the renderer** -- Don't rely on `<style>` blocks. Gmail web strips them entirely. Put critical styles on every element. ([caniemail.com](https://www.caniemail.com/features/html-style/))

2. **Use `<table>` for layout, not `<div>`** -- Outlook desktop uses Word's rendering engine which only reliably renders tables. Use `role="presentation"` on layout tables for accessibility. ([Litmus](https://www.litmus.com/blog/a-bulletproof-guide-to-using-html5-and-css3-in-email))

3. **Keep total HTML under 102KB** -- Gmail clips emails exceeding this threshold, showing "Message clipped" with a link to view the full email. ([designmodo](https://designmodo.com/html-css-emails/))

4. **Use web-safe fonts only** -- Arial, Verdana, Georgia, Times New Roman. `@font-face` is not supported in Gmail or Outlook. ([Litmus](https://www.litmus.com/blog/a-bulletproof-guide-to-using-html5-and-css3-in-email))

5. **Set explicit `width` and `height` on images** -- Prevents layout shift and is required for Outlook. Use HTML attributes, not just CSS. ([emailonacid](https://www.emailonacid.com/blog/article/email-development/how-to-code-emails-for-outlook/))

6. **Use longhand CSS properties** -- Write `margin-top: 10px; margin-bottom: 10px;` not `margin: 10px 0`. Shorthand is inconsistently parsed. ([caniemail.com](https://www.caniemail.com/))

7. **Wrap content in a 600px layout table** -- The safe rendering width across all clients. ([designmodo](https://designmodo.com/html-css-emails/))

8. **Use Unicode checkboxes for task lists** -- `&#9745;` (checked) and `&#9744;` (unchecked) instead of `<input type="checkbox">` which is stripped by all email clients.

9. **Prefer `<s>` over `<del>` for strikethrough** -- Both work, but `<s>` with inline `text-decoration: line-through` has wider support.

10. **Run juice as a final pass** -- Even with inline styles in the renderer, juice catches edge cases and converts CSS dimensions to HTML attributes for Outlook. ([juice GitHub](https://github.com/Automattic/juice))

## Common Pitfalls

1. **Relying on `<style>` blocks** -- Gmail web completely strips them. Every style must be inline. ([caniemail.com](https://www.caniemail.com/features/html-style/))

2. **Using `max-width` without `width` attribute** -- Outlook ignores `max-width`. Always pair with a `width` HTML attribute or a `width` style. ([emailonacid](https://www.emailonacid.com/blog/article/email-development/how-to-code-emails-for-outlook/))

3. **Using `<div>` for layout** -- Outlook's Word engine doesn't properly handle div-based layouts. Use tables. ([Litmus](https://www.litmus.com/blog/a-guide-to-rendering-differences-in-microsoft-outlook-clients))

4. **Forgetting `cellpadding="0" cellspacing="0"`** -- Without these, tables get default browser spacing in some clients.

5. **Using CSS shorthand** -- `border: 1px solid #ccc` works in most clients, but `margin: 10px 0` is unreliable. Use longhand.

6. **Forgetting `border-collapse: collapse`** -- Tables without this show gaps between cell borders in most clients.

7. **Checkbox/form inputs in task lists** -- All email clients strip `<input>` elements. Use Unicode characters instead.

8. **Background images** -- `background-image` CSS is stripped by Gmail and unreliable elsewhere. Use `<img>` tags or VML for Outlook.

9. **JavaScript and interactive elements** -- All email clients strip `<script>`, `onclick`, and similar. Code blocks with syntax highlighting must use inline color styles, not JS.

10. **Outlook conditional comments (2027 deadline)** -- MSO conditional comments (`<!--[if mso]>...<![endif]-->`) are still needed for Outlook desktop through ~2027 for ghost tables and VML. But the new Chromium-based Outlook is gradually replacing Word rendering. ([dev.to](https://dev.to/aoifecarrigan/the-complete-guide-to-email-client-rendering-differences-in-2026-243f))

## Confidence Assessment

| Finding | Confidence | Notes |
|---------|------------|-------|
| Marked custom renderer API | High | Official docs, Context7 |
| Gmail strips `<style>` blocks | High | Widely documented, caniemail.com |
| Outlook uses Word engine | High | Well-established, phasing out 2027+ |
| 102KB Gmail clipping threshold | High | Widely confirmed |
| Juice as best CSS inliner | High | 2M+ weekly downloads, Automattic-maintained |
| emailmd maturity | Medium | Pre-1.0, limited production usage data |
| New Outlook timeline (2027) | Medium | Microsoft timeline subject to change |
| `border-radius` 91% support | High | caniemail.com data |

## Sources

### Official Documentation
- [marked.js Using Pro](https://marked.js.org/using_pro) -- Custom renderer API, extensions, walkTokens
- [marked npm / jsDocs.io](https://www.jsdocs.io/package/marked) -- TypeScript types for all renderer methods
- [Can I email](https://www.caniemail.com/) -- Email client HTML/CSS support tables
- [Juice npm](https://www.npmjs.com/package/juice) -- CSS inliner package
- [Juice GitHub](https://github.com/Automattic/juice) -- Full API docs, options, ignore directives

### Technical Articles
- [Litmus: Bulletproof HTML5/CSS3 in Email](https://www.litmus.com/blog/a-bulletproof-guide-to-using-html5-and-css3-in-email)
- [Litmus: Outlook Rendering Differences](https://www.litmus.com/blog/a-guide-to-rendering-differences-in-microsoft-outlook-clients)
- [Email on Acid: Coding for Outlook](https://www.emailonacid.com/blog/article/email-development/how-to-code-emails-for-outlook/)
- [Designmodo: HTML and CSS in Emails 2026](https://designmodo.com/html-css-emails/)
- [GetResponse: Supported HTML Tags](https://www.getresponse.com/blog/supported-html-tags-in-email-clients)
- [DEV.to: Email Client Rendering Differences 2026](https://dev.to/aoifecarrigan/the-complete-guide-to-email-client-rendering-differences-in-2026-243f)

### Community Resources
- [emailmd GitHub](https://github.com/unmta/emailmd) -- Markdown-to-email library using MJML
- [Stacks: Outlook Conditional CSS](https://stackoverflow.design/email/base/mso/)
- [HTeuMeuLeu: Outlook Rendering Engine](https://www.hteumeuleu.com/2020/outlook-rendering-engine/)

## Open Questions

1. **Dark mode handling** -- How to ensure email content looks good in dark mode across clients? Some clients invert colors, others apply their own dark theme. This is a separate research topic.
2. **Syntax highlighting in code blocks** -- Can inline color styles survive email clients for syntax-highlighted code? Likely yes (inline `color` is universally supported), but untested at scale.
3. **RTL language support** -- `dir="rtl"` support varies across clients; needs investigation if relevant.
4. **AMP for Email** -- Gmail supports AMP emails with interactive components, but this is a separate rendering path entirely.
