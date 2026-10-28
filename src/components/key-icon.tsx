/** The key glyph (docs/BRAND.md): chunky, red by default. Use with a number: <KeyIcon /> 50. */
export function KeyIcon({ className = "h-4 w-4 text-red" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="8" cy="12" r="4.5" />
      <path d="M12.5 12H21M18 12v3.5M15 12v2.5" />
    </svg>
  );
}
