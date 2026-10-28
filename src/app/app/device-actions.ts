"use server";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { recordDevice } from "@/domain/fraud";

/** Called once per browser session by <DeviceFingerprint/>. Silently ignored when signed out. */
export async function recordDeviceAction(fingerprint: string): Promise<void> {
  const session = await auth();
  if (!session?.user?.id || typeof fingerprint !== "string") return;
  const ua = (await headers()).get("user-agent");
  try {
    await recordDevice(session.user.id, fingerprint, ua);
  } catch (e) {
    console.error("recordDevice failed:", e);
  }
}
