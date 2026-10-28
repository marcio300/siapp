import { describe, expect, it } from "vitest";
import { escapeHtml, renderEmail } from "./template";
import { signInEmail } from "./templates";

describe("email base template", () => {
  it("escapes content and renders CTA + text fallback", () => {
    const { html, text } = renderEmail({
      title: "you're in",
      paragraphs: ["<script>alert(1)</script> & friends"],
      cta: { label: "Open", url: "https://siapp.club/x?a=1&b=2" },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="https://siapp.club/x?a=1&amp;b=2"');
    expect(text).toContain("Open: https://siapp.club/x?a=1&b=2");
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
  });

  it("sign-in email carries the link and expiry", () => {
    const mail = signInEmail("https://siapp.club/api/auth/callback/email?token=abc", 15);
    expect(mail.subject).toBeTruthy();
    expect(mail.html).toContain("token=abc");
    expect(mail.text).toContain("15 minutes");
  });
});
