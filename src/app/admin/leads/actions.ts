"use server";

import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/authz";
import { multi, text } from "@/lib/forms";
import { markLeadsContacted, reopenLead } from "@/domain/leads";

function back(formData: FormData, extra: string): never {
  const base = text(formData, "back") ?? "/admin/leads";
  const path = base.startsWith("/admin/leads") ? base : "/admin/leads";
  redirect(`${path}${path.includes("?") ? "&" : "?"}${extra}`);
}

/** Mark one lead, or every id in the (filtered) list, as contacted. */
export async function markContactedAction(formData: FormData): Promise<void> {
  const staff = await requireStaff("OPS");
  const ids = multi(formData, "ids");
  const n = await markLeadsContacted(ids, staff.staffId);
  back(formData, `contacted=${n}`);
}

export async function reopenLeadAction(formData: FormData): Promise<void> {
  await requireStaff("OPS");
  const id = text(formData, "id") ?? "";
  const ok = await reopenLead(id);
  back(formData, ok ? "reopened=1" : "error=not_contacted");
}
