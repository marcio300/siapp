import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import sharp from "sharp";
import Stripe from "stripe";
import { OUTBOX } from "../playwright.config";

type State = { dbUrl: string; friday: Ev; nextWeek: Ev; tonight: Ev };
type Ev = { id: string; title: string; scannerCode: string; pin: string };
const state: State = JSON.parse(readFileSync(path.join(process.cwd(), "e2e/.state.json"), "utf8"));
const email = `e2e-${Date.now().toString(36)}@example.com`;

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: state.dbUrl });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Latest console-adapter email to `to` whose subject matches. */
async function waitForEmail(to: string, subject: RegExp, after: number): Promise<{ text: string; html: string }> {
  const dir = path.join(process.cwd(), OUTBOX);
  for (let i = 0; i < 60; i++) {
    const files = readdirSync(dir).filter((f) => Number(f.split("-")[0]) >= after).sort();
    for (const f of files.reverse()) {
      const m = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { to: string; subject: string; text: string; html: string };
      if (m.to === to && subject.test(m.subject)) return m;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no email to ${to} matching ${subject}`);
}

async function signIn(page: Page, to: string) {
  const since = Date.now() - 1;
  await page.goto("/sign-in");
  await page.getByPlaceholder("you@example.com").fill(to);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByText("check your inbox.")).toBeVisible();
  const mail = await waitForEmail(to, /your key to SIAPP/, since);
  const link = mail.text.match(/https?:\/\/[^\s]+\/api\/auth\/callback\/email[^\s]+/)?.[0];
  if (!link) throw new Error("magic link not found in email");
  await page.goto(link.replace(/&amp;/g, "&"));
}

test.describe.serial("signup → subscribe → redeem → scan → cancel", () => {
  let memberId = "";

  test("signup with magic link, onboarding, selfie; welcome email arrives", async ({ page }) => {
    const t0 = Date.now() - 1;
    await signIn(page, email);
    await expect(page).toHaveURL(/\/app\/onboarding/);
    await page.locator('input[name="name"]').fill("E2E Member");
    await page.locator('select[name="dobDay"]').selectOption("15");
    await page.locator('select[name="dobMonth"]').selectOption("6");
    await page.locator('select[name="dobYear"]').selectOption("1990");
    await page.locator('input[name="ageAttested"]').check();
    await page.getByRole("button", { name: /let me in|continue|done|almost|in/i }).first().click();
    await expect(page).toHaveURL(/\/app\/profile\?welcome=1/);
    await expect(page.getByText(/you're in/)).toBeVisible();
    const welcome = await waitForEmail(email, /you're in\. sort of\./, t0);
    expect(welcome.text).toContain("welcome.");

    const jpeg = await sharp({ create: { width: 320, height: 320, channels: 3, background: "#884433" } }).jpeg().toBuffer();
    await page.locator('input[name="selfie"]').setInputFiles({ name: "selfie.jpg", mimeType: "image/jpeg", buffer: jpeg });
    await page.getByRole("button", { name: /take a selfie/i }).click();
    await expect(page).toHaveURL(/selfie=1/);
    const [m] = await sql<{ id: string; "selfieUrl": string | null }>('SELECT id, "selfieUrl" FROM "Member" WHERE email = $1', [email]);
    memberId = m!.id;
    expect(m!.selfieUrl).toBeTruthy();
  });

  test("subscribe (Stripe test): synthetic checkout + invoice webhooks activate SOCIAL and grant 30 keys", async ({ page, request }) => {
    const [plan] = await sql<{ id: string; "stripePriceId": string }>(
      'SELECT p.id, pp."stripePriceId" FROM "Plan" p JOIN "Tier" t ON t.id = p."tierId" JOIN "PlanPrice" pp ON pp."planId" = p.id WHERE t.code = $1 AND p.period = $2 LIMIT 1',
      ["SOCIAL", "MONTHLY"],
    );
    const priceId = plan!.stripePriceId ?? "price_e2e_social";
    if (!plan!.stripePriceId) await sql('UPDATE "PlanPrice" SET "stripePriceId" = $1 WHERE "planId" = $2', [priceId, plan!.id]);
    const stripe = new Stripe("sk_test_unused");
    const post = async (event: object) => {
      const payload = JSON.stringify(event);
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_e2e" });
      const res = await request.post("/api/webhooks/stripe", { data: payload, headers: { "content-type": "application/json", "stripe-signature": signature } });
      expect(res.status(), await res.text()).toBe(200);
    };
    const start = new Date();
    const end = new Date(start.getTime() + 30 * 86_400_000);
    const sec = (d: Date) => Math.floor(d.getTime() / 1000);
    await post({ id: `evt_cs_${memberId}`, type: "checkout.session.completed", data: { object: { id: `cs_${memberId}`, mode: "subscription", subscription: `sub_${memberId}`, payment_status: "paid", metadata: { kind: "subscription", memberId, planId: plan!.id } } } });
    await post({
      id: `evt_in_${memberId}`,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${memberId}`,
          billing_reason: "subscription_create",
          parent: { subscription_details: { subscription: `sub_${memberId}`, metadata: { memberId, planId: plan!.id } } },
          lines: { data: [{ period: { start: sec(start), end: sec(end) }, pricing: { price_details: { price: priceId } }, parent: { subscription_item_details: { subscription: `sub_${memberId}` } } }] },
        },
      },
    });
    await signIn(page, email);
    await page.goto("/app/membership");
    await expect(page.locator("h1")).toContainText("social");
    await page.goto("/app/wallet");
    await expect(page.getByText("30 plan keys")).toBeVisible();
  });

  test("redeem the free offer, then the door scans it OK", async ({ page, browser }) => {
    await signIn(page, email);
    await page.goto(`/app/events/${state.friday.id}`);
    await page.locator('a[href*="/redeem/"]').first().click();
    await expect(page).toHaveURL(/\/redeem\//);
    await page.getByRole("button", { name: /redeem — i'm in/i }).click();
    await expect(page).toHaveURL(/\/app\/tickets\/[^/?]+\?new=1/);
    await expect(page.locator('img[alt="Your ticket QR"]')).toBeVisible();
    const redemptionId = page.url().match(/\/app\/tickets\/([^/?]+)/)![1]!;
    const [t] = await sql<{ qrPayload: string }>('SELECT "qrPayload" FROM "Ticket" WHERE "redemptionId" = $1', [redemptionId]);

    const door = await (await browser.newContext()).newPage();
    await door.goto("/scan");
    await door.locator('input[name="code"]').fill(state.friday.scannerCode);
    await door.locator('input[name="pin"]').fill(state.friday.pin);
    await door.locator('input[name="device"]').fill("E2E door");
    await door.getByRole("button", { name: "Open scanner" }).click();
    await expect(door.getByText("E2E door")).toBeVisible();
    await door.getByLabel("Ticket code").fill(t!.qrPayload);
    await door.getByRole("button", { name: "Check" }).click();
    await expect(door.getByRole("status")).toContainText("OK — welcome in");
    await expect(door.getByRole("status")).toContainText("E2E Member");
    await door.waitForTimeout(3200); // identical reads inside 3 s are debounced by the scanner
    await door.getByLabel("Ticket code").fill(t!.qrPayload);
    await door.getByRole("button", { name: "Check" }).click();
    await expect(door.getByRole("status")).toContainText("Already scanned");
    const [r] = await sql<{ status: string }>('SELECT status FROM "Redemption" WHERE id = $1', [redemptionId]);
    expect(r!.status).toBe("CHECKED_IN");
    await door.context().close();
  });

  test("cancel outside the window refunds the keys; inside the window the ticket is final", async ({ page }) => {
    await signIn(page, email);
    // outside: event in 100 h
    await page.goto(`/app/events/${state.nextWeek.id}`);
    await page.locator('a[href*="/redeem/"]').first().click();
    await page.getByRole("button", { name: /redeem — i'm in/i }).click();
    await expect(page).toHaveURL(/\?new=1/);
    await page.locator("summary", { hasText: /cancel — free until/ }).click();
    await page.getByRole("button", { name: "Yes, cancel" }).click();
    await expect(page).toHaveURL(/cancelled=1/);
    await expect(page.getByText(/keys are back in your wallet/)).toBeVisible();

    // inside: event in 10 h — the sheet already says it's final and the ticket page offers no cancel
    await page.goto(`/app/events/${state.tonight.id}`);
    await page.locator('a[href*="/redeem/"]').first().click();
    await page.getByRole("button", { name: /redeem — i'm in/i }).click();
    await expect(page).toHaveURL(/\?new=1/);
    await expect(page.locator("summary", { hasText: /cancel — free until/ })).toHaveCount(0);
    await expect(page.getByText(/final/i).first()).toBeVisible();
    const tonightId = page.url().match(/\/app\/tickets\/([^/?]+)/)![1]!;
    // belt and braces: the server refuses too
    const [r] = await sql<{ status: string }>('SELECT status FROM "Redemption" WHERE id = $1', [tonightId]);
    expect(r!.status).toBe("ACTIVE");
    // 30 granted − 5 (Friday, scanned) − 5 (next week, refunded) − 5 (tonight) = 20
    await page.goto("/app/wallet");
    await expect(page.getByText(/^20 plan keys/)).toBeVisible();
  });
});
