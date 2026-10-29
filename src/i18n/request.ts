import { getRequestConfig } from "next-intl/server";

/**
 * next-intl without locale routing: one locale (en) for launch, `pt` arrives
 * later by adding messages/pt.json and a locale resolver here (cookie or the
 * member's city). Copy that already moved into messages/ is read with
 * `getTranslations()`; the rest is plain strings until it's translated.
 */
export const LOCALES = ["en"] as const;
export const DEFAULT_LOCALE = "en";

export default getRequestConfig(async () => {
  const locale = DEFAULT_LOCALE;
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});
