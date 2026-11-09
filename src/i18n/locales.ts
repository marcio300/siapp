/** Locale primitives shared by the request config, the toggle route and non-request code (emails). */
export const LOCALES = ["en", "pt"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "siapp_locale";
export const LOCALE_COOKIE_MAX_AGE = 365 * 86_400;

export const LOCALE_LABELS: Record<Locale, string> = { en: "EN", pt: "PT" };

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/** Best supported locale for an Accept-Language header ("pt-PT,pt;q=0.9,en;q=0.8" → pt). */
export function pickLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { lang: (tag ?? "").trim().toLowerCase().split("-")[0] ?? "", q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter((r) => r.lang && r.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const r of ranked) if (isLocale(r.lang)) return r.lang;
  return DEFAULT_LOCALE;
}
