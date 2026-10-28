"use server";

import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/authz";
import { checkbox, text } from "@/lib/forms";
import { PartnerCommunityError, createPartnerCommunity, updatePartnerCommunity } from "@/domain/partners";

function input(fd: FormData) {
  return { code: text(fd, "code") ?? "", name: text(fd, "name") ?? "", publicKey: text(fd, "publicKey") ?? "", promo: text(fd, "promo") ?? "", isActive: checkbox(fd, "isActive") };
}

export async function createPartnerAction(fd: FormData): Promise<void> {
  await requireStaff("ADMIN");
  let id = "";
  try {
    id = (await createPartnerCommunity(input(fd))).id;
  } catch (e) {
    if (e instanceof PartnerCommunityError) redirect(`/admin/partners?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  redirect(`/admin/partners/${id}?saved=1`);
}

export async function updatePartnerAction(fd: FormData): Promise<void> {
  await requireStaff("ADMIN");
  const id = text(fd, "id") ?? "";
  try {
    await updatePartnerCommunity(id, input(fd));
  } catch (e) {
    if (e instanceof PartnerCommunityError) redirect(`/admin/partners/${id}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  redirect(`/admin/partners/${id}?saved=1`);
}
