import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/** What the /founders form (and later any import) hands to `registerFounderLead`. */
export const PreRegistrationSchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(254).email(),
  name: optionalText(80),
  cityId: optionalText(40),
  /** "Contact me when SIAPP opens" — the GDPR consent basis. Required. */
  consent: z.boolean(),
  utm: z
    .object({
      source: optionalText(120),
      medium: optionalText(120),
      campaign: optionalText(160),
      content: optionalText(160),
      term: optionalText(160),
    })
    .optional(),
  referrer: optionalText(500),
  landingPath: optionalText(300),
  /** Language of the page they signed up on (en|pt); emails to the lead go out in it. */
  locale: z.enum(["en", "pt"]).optional(),
});

export type PreRegistrationInput = z.input<typeof PreRegistrationSchema>;
export type PreRegistration = z.output<typeof PreRegistrationSchema>;

/** `?utm_source=…` query → the schema's `utm` block. Unknown keys are ignored. */
export function utmFromQuery(q: Record<string, string | string[] | undefined>): PreRegistration["utm"] {
  const pick = (k: string) => {
    const v = q[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s?.trim() ? s.trim() : undefined;
  };
  const utm = { source: pick("utm_source"), medium: pick("utm_medium"), campaign: pick("utm_campaign"), content: pick("utm_content"), term: pick("utm_term") };
  return Object.values(utm).some(Boolean) ? utm : undefined;
}
