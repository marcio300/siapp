export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <>
      <h1>privacy<span className="text-red">.</span></h1>
      <p className="lead">Last updated: 29 October 2026. SIAPP, Lda. (controller) processes your data to run a members-only events club. This notice follows the GDPR.</p>

      <h2>What we collect and why</h2>
      <table>
        <thead><tr><th>Data</th><th>Why</th><th>Legal basis</th><th>Kept</th></tr></thead>
        <tbody>
          <tr><td>Email, name, date of birth, home city</td><td>Your account; the 24+ rule</td><td>Contract</td><td>Account lifetime</td></tr>
          <tr><td>Selfie</td><td>Shown to door staff when your ticket is scanned, so a ticket can&apos;t be passed on</td><td>Contract</td><td>Until replaced or the account is deleted</td></tr>
          <tr><td>ID photo (tourist pass only)</td><td>Checking a visitor&apos;s identity and age</td><td>Legitimate interest (fraud prevention)</td><td>Encrypted, deleted after 30 days</td></tr>
          <tr><td>Payments</td><td>Handled by Stripe; we store a card fingerprint, never the number</td><td>Contract; legitimate interest (fraud)</td><td>Accounting retention (10 years, PT)</td></tr>
          <tr><td>Device fingerprint</td><td>Detecting accounts that share one device</td><td>Legitimate interest (fraud prevention)</td><td>Account lifetime</td></tr>
          <tr><td>Redemptions, scans, attendance</td><td>Running the door and the key ledger; settling with producers</td><td>Contract</td><td>Accounting retention</td></tr>
          <tr><td>Referral and partner-community data</td><td>Referral bonuses; partner promotions (e.g. ELL)</td><td>Contract</td><td>Account lifetime</td></tr>
        </tbody>
      </table>

      <h2>Who sees it</h2>
      <p><strong>Door staff</strong> see your name, your selfie and your +1&apos;s name when your ticket is scanned — nothing else. <strong>Producers</strong> get a settlement statement listing scanned discounted tickets by member name; they never get your contact details. <strong>Processors</strong>: Stripe (payments), Resend (email), Vercel and Neon (hosting, EU region). Partner communities only learn that a token they issued was used.</p>

      <h2>Your rights</h2>
      <p>Access, rectification, erasure, restriction, portability and objection, plus the right to complain to the CNPD (Comissão Nacional de Proteção de Dados). Delete your account yourself in <em>Profile → Delete account</em>; for anything else write to privacy@siapp.club. We answer within a month.</p>

      <h2>Automated decisions</h2>
      <p>A redemption may be held for human review when our fraud rules fire (shared device or card, unusual speed). A human decides; nothing is refused automatically except overlapping tickets for events starting within 3 hours of each other, which you can simply cancel.</p>

      <h2>Transfers and security</h2>
      <p>Data lives in the EU (Frankfurt). ID photos are encrypted at rest; everything travels over TLS. Email sign-in links expire in 15 minutes and work once.</p>
    </>
  );
}
