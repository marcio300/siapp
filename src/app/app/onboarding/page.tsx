import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireMemberPage } from "@/lib/authz";
import { MIN_AGE } from "@/domain/identity";
import { Wordmark } from "@/components/wordmark";
import { Notice } from "@/components/member-nav";
import { completeOnboardingAction } from "./actions";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireMemberPage("/app/onboarding");
  const { error } = await searchParams;
  const member = await prisma.member.findUniqueOrThrow({ where: { id: user.id } });
  if (member.onboardedAt) redirect("/app");
  const cities = await prisma.city.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
  const jar = await cookies();
  const referral = jar.get("siapp_ref")?.value ?? "";
  const thisYear = new Date().getUTCFullYear();
  const years = Array.from({ length: 100 - MIN_AGE + 1 }, (_, i) => thisYear - MIN_AGE - i);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 py-8">
      <Wordmark />
      <h1 className="mt-10 font-display text-3xl leading-tight">
        almost in<span className="text-red">.</span>
      </h1>
      <p className="mt-2 font-serif text-lg italic text-ink-muted">
        a few things before the door opens. it&apos;s a {MIN_AGE}+ party.
      </p>
      {error && <div className="mt-4"><Notice tone="error">{error}</Notice></div>}

      <form action={completeOnboardingAction} className="mt-6 flex flex-col gap-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Your name</span>
          <input name="name" required minLength={2} maxLength={80} defaultValue={member.name ?? ""} className="input-dark" placeholder="as it is on your ID" />
        </label>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Date of birth</legend>
          <div className="grid grid-cols-3 gap-2">
            <select name="dobDay" required className="input-dark" defaultValue="">
              <option value="" disabled>Day</option>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <select name="dobMonth" required className="input-dark" defaultValue="">
              <option value="" disabled>Month</option>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
            <select name="dobYear" required className="input-dark" defaultValue="">
              <option value="" disabled>Year</option>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        </fieldset>

        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" name="ageAttested" required className="mt-1 h-4 w-4 accent-red" />
          <span>
            I confirm I am {MIN_AGE} or older. <span className="text-ink-muted">Door staff may ask for ID.</span>
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Your city</span>
          <select name="cityId" required className="input-dark" defaultValue={member.cityId ?? (cities.length === 1 ? cities[0]!.id : "")}>
            {cities.length !== 1 && <option value="" disabled>Pick a city</option>}
            {cities.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Referral code <span className="normal-case tracking-normal">(optional)</span></span>
          <input name="referralCode" maxLength={16} defaultValue={referral} className="input-dark font-mono uppercase" placeholder="from a friend" />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Partner code <span className="normal-case tracking-normal">(optional)</span></span>
          <input name="partnerClaimToken" maxLength={4096} className="input-dark font-mono text-xs" placeholder="e.g. your Erasmus Life Lisboa token" />
          <span className="text-xs text-ink-muted">we&apos;ll apply your partner perk once claims open.</span>
        </label>

        <button className="btn btn-primary mt-2 w-full">Let me in</button>
      </form>
    </main>
  );
}
