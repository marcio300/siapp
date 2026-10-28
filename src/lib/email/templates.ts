import { renderEmail } from "./template";

/** Magic-link sign-in email (NextAuth email provider). */
export function signInEmail(url: string, minutes: number) {
  return {
    subject: "your key to SIAPP",
    ...renderEmail({
      title: "sorry, we need to check it's you",
      tagline: "one tap and you're in.",
      preheader: "Your sign-in link — expires soon.",
      paragraphs: [`Use the button below to sign in. The link works once and expires in ${minutes} minutes.`],
      cta: { label: "Sign in", url },
      footnote: "Didn't ask for this? Ignore it — nobody gets in without this email.",
    }),
  };
}
