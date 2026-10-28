/** The logo as text: heavy grotesque "sorry" + red comma, italic serif tail. */
export function Wordmark({ tone = "dark", tail = true }: { tone?: "dark" | "light"; tail?: boolean }) {
  const ink = tone === "dark" ? "text-ink" : "text-ink-dark";
  const muted = tone === "dark" ? "text-ink-muted" : "text-ink-dark-muted";
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className={`font-display text-xl leading-none tracking-tight ${ink}`}>
        sorry<span className="text-red">,</span>
      </span>
      {tail && <span className={`font-serif text-lg italic leading-none ${muted}`}>it&apos;s a private party</span>}
    </span>
  );
}
