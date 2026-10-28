import Link from "next/link";
import { signOut } from "@/lib/auth";
import { requireStaffPage } from "@/lib/authz";
import { Wordmark } from "@/components/wordmark";
import { AdminNav } from "./nav";

/**
 * Backoffice shell (ported from EventOS's admin layout): fixed sidebar on
 * lg+, sticky top bar with a pill nav below. Guarded by requireStaffPage —
 * any active StaffUser role gets in; pages tighten with a minimum role.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireStaffPage();

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/sign-in" });
  }

  const logo = (
    <Link href="/admin" className="flex items-center gap-2">
      <Wordmark tone="light" tail={false} />
      <span className="rounded-md bg-ink-dark px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cream">
        backoffice
      </span>
    </Link>
  );

  const userBlock = (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-ink-dark">{staff.email}</p>
        <p className="text-[11px] text-ink-dark-muted">{staff.role}</p>
      </div>
      <form action={doSignOut}>
        <button className="btn btn-ghost shrink-0 whitespace-nowrap !px-2 !py-1 text-xs" title="Sign out">
          Sign out
        </button>
      </form>
    </div>
  );

  return (
    <div className="office">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-line-light bg-white lg:flex">
        <div className="px-5 py-5">{logo}</div>
        <AdminNav variant="sidebar" />
        <div className="border-t border-line-light px-4 py-3">{userBlock}</div>
      </aside>

      <header className="sticky top-0 z-20 border-b border-line-light bg-white/90 backdrop-blur lg:hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          {logo}
          <form action={doSignOut}>
            <button className="btn btn-ghost !px-2 !py-1 text-xs">Sign out</button>
          </form>
        </div>
        <AdminNav variant="topbar" />
      </header>

      <div className="lg:pl-60">
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
