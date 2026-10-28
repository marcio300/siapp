"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Backoffice navigation (ported from EventOS's AdminNav). Modules follow
 * docs/PRODUCT_SPEC.md §13; entries land as their phases ship — a link to a
 * page that doesn't exist yet is worse than no link, so only built pages are
 * listed. Add to NAV when the page exists.
 */
type IconName = "dashboard" | "plans" | "settings";

function Icon({ name, className }: { name: IconName; className?: string }) {
  const common = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "dashboard":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
          <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
          <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
          <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
        </svg>
      );
    case "plans":
      return (
        <svg {...common}>
          <circle cx="8" cy="12" r="4.5" />
          <path d="M12.5 12H21M18 12v3.5M15 12v2.5" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01A1.7 1.7 0 0 0 10.05 3V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z" />
        </svg>
      );
  }
}

type NavItem = { href: string; label: string; icon: IconName };

const NAV: NavItem[] = [
  { href: "/admin", label: "Dashboard", icon: "dashboard" },
  { href: "/admin/plans", label: "Plans & key packs", icon: "plans" },
  { href: "/admin/settings", label: "Settings", icon: "settings" },
];

export function AdminNav({ variant }: { variant: "sidebar" | "topbar" }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/admin" ? pathname === "/admin" : pathname.startsWith(href));

  if (variant === "topbar") {
    return (
      <nav className="flex items-center gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition ${
              isActive(item.href)
                ? "bg-red/10 font-semibold text-red"
                : "text-ink-dark-muted hover:bg-black/5 hover:text-ink-dark"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    );
  }

  return (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3">
      {NAV.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
              active ? "bg-red/10 font-semibold text-red" : "text-ink-dark-muted hover:bg-black/5 hover:text-ink-dark"
            }`}
          >
            <Icon
              name={item.icon}
              className={`h-[18px] w-[18px] shrink-0 ${active ? "text-red" : "text-ink-dark-muted/70 group-hover:text-ink-dark"}`}
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
