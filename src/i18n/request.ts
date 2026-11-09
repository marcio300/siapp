import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, pickLocale, type Locale } from "./locales";

export { LOCALES, DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "./locales";

/**
 * next-intl without locale routing (same URL for every language). The locale
 * is resolved per request: the `siapp_locale` cookie (set by the EN/PT toggle
 * → /api/locale) wins, else the browser's Accept-Language, else English.
 * Copy lives in messages/{en,pt}.json; a key missing from pt.json falls back
 * to the English string (so untranslated pages stay readable while the rest
 * of the app is translated screen by screen).
 */
export default getRequestConfig(async () => {
  const locale = await resolveRequestLocale();
  const en = (await import("../../messages/en.json")).default;
  const messages = locale === DEFAULT_LOCALE ? en : { ...en, ...(await import(`../../messages/${locale}.json`)).default };
  return { locale, messages, getMessageFallback: ({ key, namespace }) => (namespace ? `${namespace}.${key}` : key) };
});

async function resolveRequestLocale(): Promise<Locale> {
  try {
    const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
    if (fromCookie && isLocale(fromCookie)) return fromCookie;
    return pickLocale((await headers()).get("accept-language"));
  } catch {
    return DEFAULT_LOCALE; // outside a request (build-time rendering, scripts)
  }
}
