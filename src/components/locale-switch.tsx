import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/locales";

/** EN / PT toggle — plain links to /api/locale so it works without JS and before hydration. */
export function LocaleSwitch({ current, next, className = "" }: { current: string; next: string; className?: string }) {
  return (
    <nav aria-label="Language" className={`inline-flex items-center gap-1 text-xs ${className}`}>
      {LOCALES.map((l: Locale, i) => (
        <span key={l} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-ink-muted/50">/</span>}
          {l === current ? (
            <span aria-current="true" className="font-semibold text-ink">{LOCALE_LABELS[l]}</span>
          ) : (
            <a href={`/api/locale?set=${l}&next=${encodeURIComponent(next)}`} hrefLang={l} className="text-ink-muted hover:text-ink">
              {LOCALE_LABELS[l]}
            </a>
          )}
        </span>
      ))}
    </nav>
  );
}
