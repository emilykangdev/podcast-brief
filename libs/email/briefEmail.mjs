import { Marked } from "marked";
import juice from "juice";
import config from "../../config.js";
import supabase from "../supabase/admin.mjs";
import { sendEmail } from "../resend.js";

const DASHBOARD_URL = getDashboardUrl(config.domainName);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function sanitizeUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(value, DASHBOARD_URL);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizeFilename(value) {
  const cleaned = String(value)
    .replace(/[^a-zA-Z0-9\-_ ]/g, "")
    .trim()
    .replace(/\s+/g, " ");

  return cleaned || "brief";
}

function getDashboardUrl(domainName) {
  const trimmed = String(domainName || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "http://localhost:3000/dashboard";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return new URL("/dashboard", trimmed).toString();
  }
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(trimmed)) {
    return `http://${trimmed}/dashboard`;
  }
  return `https://${trimmed}/dashboard`;
}

// ---------------------------------------------------------------------------
// Scoped Marked instance — does NOT mutate the global marked singleton
// ---------------------------------------------------------------------------
const emailMarked = new Marked();
emailMarked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const sizes = {
        1: "24px",
        2: "20px",
        3: "18px",
        4: "16px",
        5: "14px",
        6: "12px",
      };
      return `<h${depth} style="margin-top: 0; margin-bottom: 12px; font-size: ${sizes[depth]}; font-weight: bold; font-family: Arial, Helvetica, sans-serif; color: #1a1a1a;">${text}</h${depth}>\n`;
    },

    paragraph({ tokens }) {
      const text = this.parser.parseInline(tokens);
      return `<p style="margin-top: 0; margin-bottom: 16px; font-size: 16px; line-height: 1.5; font-family: Arial, Helvetica, sans-serif; color: #333333;">${text}</p>\n`;
    },

    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safeHref = sanitizeUrl(href);
      if (!safeHref) return text;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${safeHref}"${titleAttr} style="color: #1a73e8; text-decoration: underline;">${text}</a>`;
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
      return `<code style="background-color: #f4f4f4; padding-top: 2px; padding-bottom: 2px; padding-left: 6px; padding-right: 6px; border-radius: 3px; font-family: 'Courier New', Courier, monospace; font-size: 14px; color: #d63384;">${escapeHtml(text)}</code>`;
    },

    code({ text, lang }) {
      void lang;
      return `<pre style="background-color: #f6f8fa; padding-top: 16px; padding-bottom: 16px; padding-left: 16px; padding-right: 16px; border-radius: 6px; overflow-x: auto; margin-top: 0; margin-bottom: 16px;"><code style="font-family: 'Courier New', Courier, monospace; font-size: 14px; line-height: 1.45; color: #24292e;">${escapeHtml(text)}</code></pre>\n`;
    },

    blockquote({ tokens }) {
      const body = this.parser.parse(tokens);
      return `<blockquote style="margin-top: 0; margin-bottom: 16px; margin-left: 0; margin-right: 0; padding-top: 12px; padding-bottom: 12px; padding-left: 16px; padding-right: 16px; border-left: 4px solid #dddddd; color: #666666; font-style: italic;">${body}</blockquote>\n`;
    },

    list({ items, ordered, start }) {
      const tag = ordered ? "ol" : "ul";
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : "";
      const body = items.map((item) => this.listitem(item)).join("");
      return `<${tag}${startAttr} style="margin-top: 0; margin-bottom: 16px; padding-left: 24px;">${body}</${tag}>\n`;
    },

    listitem({ tokens, task, checked }) {
      let text = this.parser.parse(tokens);
      if (task) {
        const checkbox = checked ? "&#9745; " : "&#9744; ";
        text = checkbox + text;
      }
      return `<li style="margin-top: 0; margin-bottom: 4px; font-size: 16px; line-height: 1.5; font-family: Arial, Helvetica, sans-serif; color: #333333;">${text}</li>\n`;
    },

    table({ header, rows }) {
      const headerHtml =
        "<tr>" +
        header
          .map((cell) => {
            const align = cell.align ? ` text-align: ${cell.align};` : "";
            const content = this.parser.parseInline(cell.tokens);
            return `<th style="padding-top: 8px; padding-bottom: 8px; padding-left: 12px; padding-right: 12px; border: 1px solid #dddddd; background-color: #f6f8fa; font-weight: bold;${align}">${content}</th>`;
          })
          .join("") +
        "</tr>";

      const rowsHtml = rows
        .map(
          (row) =>
            "<tr>" +
            row
              .map((cell) => {
                const align = cell.align ? ` text-align: ${cell.align};` : "";
                const content = this.parser.parseInline(cell.tokens);
                return `<td style="padding-top: 8px; padding-bottom: 8px; padding-left: 12px; padding-right: 12px; border: 1px solid #dddddd;${align}">${content}</td>`;
              })
              .join("") +
            "</tr>"
        )
        .join("");

      return `<table style="border-collapse: collapse; width: 100%; margin-top: 0; margin-bottom: 16px;" cellpadding="0" cellspacing="0">${headerHtml}${rowsHtml}</table>\n`;
    },

    hr() {
      return `<hr style="border: 0; border-top: 1px solid #dddddd; margin-top: 24px; margin-bottom: 24px;">\n`;
    },

    image({ href, title, text }) {
      const safeHref = sanitizeUrl(href);
      if (!safeHref) return escapeHtml(text || "");
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${safeHref}" alt="${escapeHtml(text || "")}"${titleAttr} style="max-width: 100%; height: auto; display: block; margin-top: 0; margin-bottom: 16px;" />`;
    },

    br() {
      return "<br />";
    },

    del({ tokens }) {
      const text = this.parser.parseInline(tokens);
      return `<s style="text-decoration: line-through;">${text}</s>`;
    },
  },
});

// ---------------------------------------------------------------------------
// Email HTML template wrapper
// ---------------------------------------------------------------------------
function buildEmailHtml(bodyHtml, { episodeTitle, podcastName }) {
  const safeEpisodeTitle = episodeTitle ? escapeHtml(episodeTitle) : "";
  const safePodcastName = podcastName ? escapeHtml(podcastName) : "";
  const titleRow =
    episodeTitle
      ? `<tr>
          <td style="padding-top: 24px; padding-bottom: 0; padding-left: 20px; padding-right: 20px;">
            <h1 style="font-size: 24px; font-weight: bold; margin-top: 0; margin-bottom: 8px; font-family: Arial, Helvetica, sans-serif; color: #1a1a1a;">${safeEpisodeTitle}</h1>
            ${podcastName ? `<p style="font-size: 14px; color: #666666; margin-top: 0; margin-bottom: 0; font-family: Arial, Helvetica, sans-serif;">${safePodcastName}</p>` : ""}
          </td>
        </tr>`
      : "";

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #ffffff;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding-top: 20px; padding-bottom: 20px; padding-left: 20px; padding-right: 20px; text-align: center; font-size: 14px; font-family: Arial, Helvetica, sans-serif;">
              <a href="${DASHBOARD_URL}" style="color: #1a73e8; text-decoration: underline;">View in your dashboard &rarr;</a>
            </td>
          </tr>
          ${titleRow}
          <tr>
            <td style="padding-top: 20px; padding-bottom: 20px; padding-left: 20px; padding-right: 20px; font-family: Arial, Helvetica, sans-serif;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding-top: 20px; padding-bottom: 20px; padding-left: 20px; padding-right: 20px; font-size: 12px; color: #999999; border-top: 1px solid #eeeeee; font-family: Arial, Helvetica, sans-serif;">
              You received this email because you generated a brief on PodcastBrief.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return juice(fullHtml, {
    applyWidthAttributes: true,
    applyHeightAttributes: true,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends the completed brief as an email to the profile owner.
 *
 * Idempotent: a unique index on brief_email_deliveries(brief_id) ensures only
 * one delivery attempt is recorded. Duplicate calls (e.g. retried pipeline
 * steps) return early on a 23505 unique-violation error.
 *
 * @param {Object} params
 * @param {string} params.briefId
 * @param {string} params.profileId
 * @param {string} params.outputMarkdown
 * @param {string} [params.episodeTitle]
 * @param {string} [params.podcastName]
 */
export async function sendBriefEmail({
  briefId,
  profileId,
  outputMarkdown,
  episodeTitle,
  podcastName,
}) {
  // 1. Look up profile email
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("email")
    .eq("id", profileId)
    .single();
  if (profileError) throw new Error(`Profile lookup failed: ${profileError.message}`);
  if (!profile?.email) {
    console.error(`[email] No email on file for profile ${profileId}, skipping brief email`);
    return;
  }

  // 2. Idempotent insert — unique index on brief_id prevents duplicate sends
  const { data: delivery, error: insertError } = await supabase
    .from("brief_email_deliveries")
    .insert({ brief_id: briefId, profile_id: profileId, status: "queued" })
    .select("id")
    .single();
  if (insertError) {
    if (insertError.code === "23505") return; // unique violation — already sent/queued
    throw new Error(`Email delivery insert failed: ${insertError.message}`);
  }
  if (!delivery?.id) return;

  // 3. Render markdown to email HTML
  const briefHtml = emailMarked.parse(outputMarkdown);
  const emailHtml = buildEmailHtml(briefHtml, { episodeTitle, podcastName });
  const plainText = outputMarkdown;

  // 4. Send via shared helper
  const subject = episodeTitle
    ? `Your brief is ready: ${episodeTitle}`
    : "Your brief is ready";

  const filename = episodeTitle
    ? `${sanitizeFilename(episodeTitle)}.md`
    : "brief.md";

  try {
    const data = await sendEmail({
      from: config.resend.fromNoReply,
      to: profile.email,
      subject,
      html: emailHtml,
      text: plainText,
      attachments: [{ filename, content: Buffer.from(outputMarkdown) }],
    });

    await supabase
      .from("brief_email_deliveries")
      .update({
        status: "sent",
        provider_message_id: data.id,
        sent_at: new Date().toISOString(),
      })
      .eq("id", delivery.id)
      .catch(() => {});
  } catch (err) {
    await supabase
      .from("brief_email_deliveries")
      .update({
        status: "failed",
        error: err.message,
        failed_at: new Date().toISOString(),
      })
      .eq("id", delivery.id)
      .catch(() => {});
    throw err;
  }
}
