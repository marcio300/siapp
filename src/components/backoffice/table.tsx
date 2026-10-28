import type { ReactNode } from "react";

/**
 * Backoffice table primitives (ported from EventOS's `.tbl` convention):
 * tables sit inside a `card overflow-hidden` wrapper, header cells are
 * uppercase, rows hover. Keep them dumb — data loading happens in pages.
 */
export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`card overflow-x-auto ${className}`}>
      <table className="tbl">{children}</table>
    </div>
  );
}

export function Th({ children, className = "", align = "left" }: { children?: ReactNode; className?: string; align?: "left" | "right" }) {
  return <th className={`${align === "right" ? "!text-right" : ""} ${className}`}>{children}</th>;
}

export function Td({ children, className = "", align = "left", colSpan }: { children?: ReactNode; className?: string; align?: "left" | "right"; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={`${align === "right" ? "text-right tabular-nums" : ""} ${className}`}>
      {children}
    </td>
  );
}

/** Single full-width row for "nothing here yet" states. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="!py-10 text-center text-sm text-ink-dark-muted">
        {children}
      </td>
    </tr>
  );
}
