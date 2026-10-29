# SIAPP browser smoke test — 2026-10-29

Headless Chromium (Playwright 1.63) against `next dev` on an embedded Postgres, plus a read-only probe of production.

## 1. Committed e2e suite (`pnpm e2e`) — 4/4 pass
signup → onboarding → selfie → synthetic Stripe webhooks (SOCIAL, 30 keys) → redeem → door scan OK + duplicate → cancel outside window (keys back) / inside window (final).
First run failed on a test-locator strict-mode violation (Next route announcer repeats the h1) — fixed in `e2e/flow.spec.ts`, pushed.

## 2. Exploratory pass — 60 page loads, 0 console errors, 0 page errors, 0 unexpected 4xx/5xx
Public: `/` → sign-in, sign-in, legal ×3, offline, scan login, 404, unauthenticated /app and /admin bounce to sign-in with `next=`.
Member (Pixel 7): magic link → onboarding → welcome → selfie → home + day/type filters → wallet → membership → invite → tickets → event (FREE tier correctly refused: needs 5 keys, has 2) → missing event/ticket 404 → billing return → delete account page.
Staff (1366×900 + mobile shell): dashboard, members + search, member detail, ADMIN adjust keys (+10 purchased) → member sees "2 plan + 3 purchased · 7 left after" on the redeem sheet → ticket with QR + selfie → wallet ledger; events list/detail/new, producers + detail, plans, settings, fraud, referrals, partners, settlements, missing-id 404s.
Scanner: wrong PIN → "Wrong scanner code or PIN" with code/device kept; correct PIN → online counters + cached manifest; garbage code → INVALID "Not a SIAPP ticket".
Assets/API: manifest, sw.js, icons 200; `/api/scan/state`, `/api/cron/*` 401 without auth; `/r/CODE` → 307 + `siapp_ref` cookie (30 d).

## 3. Production (https://siapp-two.vercel.app) — read-only
All public pages 200, no console errors; /app and /admin bounce to sign-in; cron/scan APIs 401; GET on the Stripe webhook 405; referral cookie set; HSTS/X-Frame-Options DENY/nosniff/Referrer-Policy/Permissions-Policy present. No CSP header (by design in next.config.ts). Sign-in form NOT submitted on prod (would send a real email).

## Minor polish spotted (no fix applied)
- Missing-entity 404s and unknown URLs render Next's default white "404 | This page could not be found." — no branded `not-found.tsx`.
- Member and admin pages all carry the bare `<title>SIAPP</title>`; only legal/offline/scanner set per-page titles.
- Membership page lists only plans with a Stripe price id — with STRIPE keys unset in prod, the "pick a plan" grid will be empty until `pnpm stripe:sync-prices` runs.

Screenshots were kept out of the repo (70 PNGs); re-run `pnpm e2e` to reproduce the flow.
