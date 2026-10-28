import { signOut } from "@/lib/auth";
import { requireOnboardedMember } from "@/lib/authz";
import { verificationStatus } from "@/domain/identity";
import { formatDateOnly } from "@/lib/format";
import { MemberHeader, Notice } from "@/components/member-nav";
import { deleteIdPhotoAction, uploadIdPhotoAction, uploadSelfieAction } from "./actions";

export default async function ProfilePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const member = await requireOnboardedMember("/app/profile");
  const sp = await searchParams;
  const status = verificationStatus(member);

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/sign-in" });
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-6 py-8">
      <MemberHeader current="/app/profile" signOut={doSignOut} />

      {sp.welcome && (
        <Notice tone="ok">
          you&apos;re in. one more thing: a selfie — it&apos;s what the door sees when they scan you.
          {sp.referral === "unknown" && " (that referral code didn't match anyone, so we skipped it.)"}
          {sp.referral === "self" && " (nice try — you can't refer yourself.)"}
          {sp.partner === "invalid" && " (the partner code didn't look right, so we skipped it.)"}
        </Notice>
      )}
      {sp.error && <Notice tone="error">{sp.error}</Notice>}
      {sp.selfie && <Notice tone="ok">selfie saved. you&apos;re ready to redeem.</Notice>}
      {sp.idphoto === "1" && <Notice tone="ok">ID photo received. it&apos;s encrypted, reviewed by a human, and deleted after 30 days.</Notice>}
      {sp.idphoto === "deleted" && <Notice tone="ok">ID photo deleted.</Notice>}

      <section className="night-card p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Selfie</p>
            <p className="mt-1 font-serif text-base italic text-ink-muted">
              {status.selfie ? "shown large on the scanner, every time." : "required before your first redemption. face, good light, no sunglasses."}
            </p>
          </div>
          {member.selfieUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={member.selfieUrl} alt="Your selfie" className="h-20 w-20 shrink-0 rounded-2xl border border-line object-cover" />
          ) : (
            <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-dashed border-line text-2xl">🙂</div>
          )}
        </div>
        <form action={uploadSelfieAction} className="mt-4 flex flex-col gap-2">
          <input type="file" name="selfie" accept="image/*" capture="user" required className="text-sm text-ink-muted file:mr-3 file:rounded-lg file:border-0 file:bg-bg file:px-3 file:py-2 file:text-ink" />
          <button className="btn btn-primary w-full">{status.selfie ? "Replace selfie" : "Take a selfie"}</button>
        </form>
      </section>

      <section className="night-card p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">ID photo · tourists only</p>
        <p className="mt-1 font-serif text-base italic text-ink-muted">
          the weekly pass needs a photo of your passport or ID card. stored encrypted, deleted after 30 days.
        </p>
        {member.idPhotoUploadedAt ? (
          <div className="mt-4 flex items-center justify-between text-sm">
            <span>uploaded {formatDateOnly(member.idPhotoUploadedAt, member.city?.timezone)}</span>
            <form action={deleteIdPhotoAction}>
              <button className="text-ink-muted hover:text-red">Delete</button>
            </form>
          </div>
        ) : (
          <form action={uploadIdPhotoAction} className="mt-4 flex flex-col gap-2">
            <input type="file" name="idPhoto" accept="image/*" capture="environment" required className="text-sm text-ink-muted file:mr-3 file:rounded-lg file:border-0 file:bg-bg file:px-3 file:py-2 file:text-ink" />
            <button className="btn border border-line text-ink hover:border-red-soft">Upload ID photo</button>
          </form>
        )}
      </section>

      <section>
        <dl className="space-y-2 text-sm text-ink-muted">
          <div className="flex justify-between"><dt>Name</dt><dd className="text-ink">{member.name}</dd></div>
          <div className="flex justify-between"><dt>Email</dt><dd className="text-ink">{member.email}</dd></div>
          <div className="flex justify-between"><dt>City</dt><dd className="text-ink">{member.city?.name}</dd></div>
          <div className="flex justify-between"><dt>Date of birth</dt><dd className="text-ink">{member.dateOfBirth ? formatDateOnly(member.dateOfBirth, "UTC") : "—"}</dd></div>
          <div className="flex justify-between"><dt>Referral code</dt><dd className="font-mono text-ink">{member.referralCode}</dd></div>
        </dl>
        <p className="mt-6 text-xs text-ink-muted">account deletion and the legal pages arrive in Phase 10.</p>
      </section>
    </main>
  );
}
