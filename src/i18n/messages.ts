import { createTranslator } from "next-intl";
import en from "../../messages/en.json";
import pt from "../../messages/pt.json";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales";

type Messages = typeof en;
const ALL: Record<Locale, Messages> = { en, pt: { ...en, ...(pt as Partial<Messages>) } as Messages };

/** Messages for a locale with English as the fallback for anything not yet translated. */
export function messagesFor(locale: string | null | undefined): Messages {
  return ALL[isLocale(locale) ? locale : DEFAULT_LOCALE];
}

/**
 * A translator usable OUTSIDE a request (emails sent from jobs, webhooks and
 * tests), keyed by the stored locale of the person we're writing to. Pages
 * and actions use `getTranslations()` from next-intl/server instead.
 */
export function translatorFor<N extends keyof Messages>(locale: string | null | undefined, namespace: N) {
  const l = isLocale(locale) ? locale : DEFAULT_LOCALE;
  return createTranslator({ locale: l, messages: ALL[l], namespace });
}
