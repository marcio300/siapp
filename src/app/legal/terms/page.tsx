export const metadata = { title: "Terms" };

const COMPANY = "SIAPP, Lda. (company details to be completed)";

export default function TermsPage() {
  return (
    <>
      <h1>terms of membership<span className="text-red">.</span></h1>
      <p className="lead">Last updated: 29 October 2026. These terms govern your membership of SIAPP (&quot;Sorry, it&apos;s a private party&quot;), operated by {COMPANY}, Lisbon, Portugal.</p>

      <h2>1. Who can join</h2>
      <p>Membership is for people aged 24 or over. You confirm your age when you sign up and we may ask for proof. One account per person and per email address; accounts are personal and cannot be shared, sold or transferred. We can refuse or close accounts that break these terms.</p>

      <h2>2. Keys</h2>
      <p>Keys are the club&apos;s credit unit. They are not money, have no cash value, cannot be withdrawn, exchanged or transferred between members, and can only be spent inside SIAPP on the offers we list.</p>
      <ul>
        <li><strong>Plan keys</strong> come with your subscription each period and <strong>expire at the end of that period</strong>. Unused plan keys are lost.</li>
        <li><strong>Purchased keys</strong> (key packs, referral bonuses, partner promotions) do not expire while your account is open.</li>
        <li>Plan keys are spent before purchased keys.</li>
      </ul>

      <h2>3. Subscriptions, automatic renewal and cancellation</h2>
      <p><strong>Paid plans renew automatically</strong> at the end of each billing period (monthly, quarterly or yearly) at the price shown when you subscribed, until you cancel. You are told this, and must confirm it, before you subscribe. You can cancel renewal at any time in <em>Membership → Cancel renewal</em>; your plan then runs to the end of the period you have already paid for and no further charge is made. Cancelling does not refund the current period. The weekly tourist pass is a one-off purchase and does not renew.</p>
      <p>Price changes apply from the next renewal and we tell you at least 30 days in advance. If you don&apos;t agree, cancel renewal before it applies.</p>

      <h2>4. Right of withdrawal</h2>
      <p>Under EU consumer law you have 14 days to withdraw from a subscription without giving a reason. Because keys become available immediately, you ask us to start the service during the withdrawal period; if you withdraw after spending keys we may deduct the value of what was used. Write to the address below to withdraw.</p>

      <h2>5. Redemptions, tickets and the door</h2>
      <p>Spending keys on an offer gives you a ticket: a QR code tied to your account and your selfie. The door scans the QR and checks your face. A ticket admits you (and one named guest where the offer allows a +1), once, on that date.</p>
      <ul>
        <li>You can cancel a redemption <strong>until 24 hours before the event starts</strong> (some offers set a different cutoff, shown before you confirm). Keys and any card payment are refunded in full.</li>
        <li>Inside the cutoff the redemption is final. If you don&apos;t show up, the keys are forfeited and any card payment is not refunded.</li>
        <li>Entry is at the venue&apos;s discretion (dress code, capacity, behaviour, legal requirements). If a venue refuses you entry for reasons outside your control, contact us and we&apos;ll return the keys.</li>
        <li>If an event is cancelled, every redemption is refunded automatically.</li>
      </ul>

      <h2>6. Discounted tickets — who you are buying from</h2>
      <p>For discounted tickets you pay a cash amount by card in addition to keys. <strong>SIAPP is the seller of record</strong>: we take your payment, issue the ticket and handle refunds and support. We pass the agreed share on to the producer. Your contract for the entry itself is with the producer; your payment contract is with us. VAT is included in the price shown.</p>

      <h2>7. Fair use and fraud</h2>
      <p>We may hold a redemption for review, limit accounts that share a device or payment card, and close accounts used for resale, impersonation or abuse. Forfeited keys are not refunded in those cases. Referral bonuses vest only after the invited member has paid and attended, and are withdrawn for self-referrals.</p>

      <h2>8. Closing your account</h2>
      <p>You can delete your account in <em>Profile → Delete account</em>. Renewal stops, upcoming tickets are cancelled where the cutoff allows, and remaining keys of both kinds are forfeited. We keep the financial records the law requires, anonymised.</p>

      <h2>9. Liability</h2>
      <p>We provide access, not the events. Nothing in these terms limits liability that cannot be limited by law. Otherwise our liability is limited to the amount you paid us in the 12 months before the claim.</p>

      <h2>10. Changes, law, contact</h2>
      <p>We may update these terms; material changes are emailed 30 days ahead. Portuguese law applies; consumers keep the protections of their country of residence. Disputes: the Lisbon courts, or the EU online dispute resolution platform. Contact: hello@siapp.club.</p>
    </>
  );
}
