"use server";

import { redirect } from "next/navigation";
import { ScannerError, loginScanner } from "@/domain/scanner";
import { clearScannerCookie, setScannerCookie } from "@/lib/scanner-auth";

export async function scannerLoginAction(fd: FormData): Promise<void> {
  const code = String(fd.get("code") ?? "");
  const pin = String(fd.get("pin") ?? "");
  const device = String(fd.get("device") ?? "");
  try {
    const { token, expiresAt } = await loginScanner({ code, pin, device });
    await setScannerCookie(token, expiresAt);
  } catch (e) {
    if (e instanceof ScannerError) redirect(`/scan?error=${encodeURIComponent(e.message)}&code=${encodeURIComponent(code)}&device=${encodeURIComponent(device)}`);
    throw e;
  }
  redirect("/scan");
}

export async function scannerLogoutAction(): Promise<void> {
  await clearScannerCookie();
  redirect("/scan");
}
