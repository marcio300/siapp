"use server";

import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/authz";
import { setSetting } from "@/lib/settings";

/** The launch switch: open or close public sign-in / account creation (ADMIN). */
export async function setPublicSignInAction(formData: FormData): Promise<void> {
  await requireStaff("ADMIN");
  const open = formData.get("open") === "1";
  await setSetting("public_signin_open", open ? 1 : 0);
  redirect(`/admin/settings?launch=${open ? "opened" : "closed"}`);
}
