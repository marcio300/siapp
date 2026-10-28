/**
 * Base transactional email template. Every email in docs/PRODUCT_SPEC.md §16
 * renders through `renderEmail` so the brand (docs/BRAND.md) and the footer
 * stay in one place. Inline styles only — email clients ignore <style>.
 *
 * Voice: dry, confident, a little cheeky. The grotesque says "sorry," the
 * serif italic says the rest.
 */
const COLORS = {
  bg: "#141414",
  elevated: "#1E1E1E",
  ink: "#F3EBDD",
  inkMuted: "#B7B0A3",
  red: "#FF1E00",
  line: "#2A2A2A",
};

export interface EmailTemplateInput {
  /** Main heading, lowercase like the logo. */
  title: string;
  /** Optional italic one-liner under the title ("the but"). */
  tagline?: string;
  /** Paragraphs of body copy (plain text; escaped). */
  paragraphs: string[];
  /** Primary call to action. */
  cta?: { label: string; url: string };
  /** Short preheader shown in inbox previews. */
  preheader?: string;
  /** Small print under the CTA (plain text; escaped). */
  footnote?: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderEmail(input: EmailTemplateInput): { html: string; text: string } {
  const paragraphs = input.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:${COLORS.ink};">${escapeHtml(p)}</p>`,
    )
    .join("");
  const cta = input.cta
    ? `<p style="margin:24px 0 8px;"><a href="${escapeHtml(input.cta.url)}" style="display:inline-block;background:${COLORS.red};color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 22px;border-radius:12px;">${escapeHtml(input.cta.label)}</a></p>`
    : "";
  const tagline = input.tagline
    ? `<p style="margin:0 0 20px;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:18px;color:${COLORS.inkMuted};">${escapeHtml(input.tagline)}</p>`
    : "";
  const footnote = input.footnote
    ? `<p style="margin:16px 0 0;font-size:13px;line-height:20px;color:${COLORS.inkMuted};">${escapeHtml(input.footnote)}</p>`
    : "";
  const preheader = input.preheader
    ? `<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(input.preheader)}</span>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(input.title)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.bg};font-family:Inter,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
${preheader}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${COLORS.bg};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;">
<tr><td style="padding:0 0 20px;">
<span style="font-size:22px;font-weight:900;letter-spacing:-0.02em;color:${COLORS.ink};">sorry<span style="color:${COLORS.red};">,</span></span>
<span style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:16px;color:${COLORS.inkMuted};"> it's a private party</span>
</td></tr>
<tr><td style="background:${COLORS.elevated};border:1px solid ${COLORS.line};border-radius:16px;padding:28px;">
<h1 style="margin:0 0 8px;font-size:26px;line-height:32px;font-weight:900;letter-spacing:-0.02em;color:${COLORS.ink};">${escapeHtml(input.title)}</h1>
${tagline}
${paragraphs}
${cta}
${footnote}
</td></tr>
<tr><td style="padding:20px 4px 0;font-size:12px;line-height:18px;color:${COLORS.inkMuted};">
You're receiving this because you have a SIAPP account. Lisbon, Portugal.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    input.title,
    input.tagline ?? "",
    "",
    ...input.paragraphs,
    input.cta ? `\n${input.cta.label}: ${input.cta.url}` : "",
    input.footnote ? `\n${input.footnote}` : "",
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n")
    .trim();

  return { html, text };
}
