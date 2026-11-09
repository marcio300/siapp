export const metadata = { title: "Cookies" };

export default function CookiesPage() {
  return (
    <>
      <h1>cookies<span className="text-red">.</span></h1>
      <p className="lead">The app itself uses only cookies it needs to work — no analytics, no advertising. The one exception is our pre-launch founders page, where a Meta pixel measures whether our ads brought you there; it loads only if you say yes to the banner.</p>
      <table>
        <thead><tr><th>Cookie</th><th>Purpose</th><th>Lifetime</th></tr></thead>
        <tbody>
          <tr><td><code>authjs.session-token</code> (and CSRF/callback cookies)</td><td>Keeps you signed in after the email link</td><td>30 days</td></tr>
          <tr><td><code>siapp_ref</code></td><td>Remembers a friend&apos;s invite link until you finish signing up</td><td>30 days</td></tr>
          <tr><td><code>siapp_scan</code></td><td>The door&apos;s scanner session for one event</td><td>Until 12 h after the event</td></tr>
          <tr><td><code>siapp_consent</code></td><td>Remembers your answer to the cookie banner on the founders page (yes or no)</td><td>1 year</td></tr>
          <tr><td><code>_fbp</code>, <code>_fbc</code> (Meta)</td><td>Meta pixel on <code>/founders</code> only, after consent: tells Meta a visit or pre-registration came from one of our ads. Meta is a joint controller for this measurement; see Meta&apos;s data policy.</td><td>90 days</td></tr>
        </tbody>
      </table>
      <h2>Local storage</h2>
      <p>The scanner keeps a copy of the event&apos;s ticket list and any scans made offline in the browser&apos;s local storage so it keeps working without signal; it syncs and clears when the connection returns. The member app caches pages you have opened (your tickets) for offline use. A per-tab flag stops the device check from running twice.</p>
      <h2>Device fingerprint</h2>
      <p>When you use the member app we compute a device fingerprint (browser and hardware characteristics, no cookie). It exists only to spot accounts that share one device and is covered in the privacy notice under fraud prevention.</p>
    </>
  );
}
