"use server";

import { redirect } from "next/navigation";
import { requireMember } from "@/lib/authz";
import { signOut } from "@/lib/auth";
import { DeletionError, PhotoError, deleteAccount, deleteIdPhoto, storeIdPhoto, storeSelfie } from "@/domain/identity";

async function fileInput(formData: FormData, field: string) {
  const file = formData.get(field);
  if (!(file instanceof File) || file.size === 0) throw new PhotoError("Pick a photo first");
  return { data: Buffer.from(await file.arrayBuffer()), contentType: file.type };
}

function fail(e: unknown): never {
  if (e instanceof PhotoError) redirect(`/app/profile?error=${encodeURIComponent(e.message)}`);
  console.error("photo upload failed:", e);
  redirect(`/app/profile?error=${encodeURIComponent("Upload failed. Try a smaller photo.")}`);
}

export async function uploadSelfieAction(formData: FormData): Promise<void> {
  const member = await requireMember();
  try {
    await storeSelfie(member.id, await fileInput(formData, "selfie"));
  } catch (e) {
    fail(e);
  }
  redirect("/app/profile?selfie=1");
}

export async function uploadIdPhotoAction(formData: FormData): Promise<void> {
  const member = await requireMember();
  try {
    await storeIdPhoto(member.id, await fileInput(formData, "idPhoto"));
  } catch (e) {
    fail(e);
  }
  redirect("/app/profile?idphoto=1");
}

export async function deleteIdPhotoAction(): Promise<void> {
  const member = await requireMember();
  await deleteIdPhoto(member.id);
  redirect("/app/profile?idphoto=deleted");
}

/** Spec §15 "delete account": irreversible; signs the member out afterwards. */
export async function deleteAccountAction(formData: FormData): Promise<void> {
  const member = await requireMember();
  if (String(formData.get("confirm") ?? "").trim().toUpperCase() !== "DELETE") redirect("/app/profile/delete?error=" + encodeURIComponent("Type DELETE to confirm."));
  try {
    await deleteAccount(member.id);
  } catch (e) {
    if (e instanceof DeletionError) redirect(`/app/profile/delete?error=${encodeURIComponent(e.message)}`);
    console.error("account deletion failed:", e);
    redirect("/app/profile/delete?error=" + encodeURIComponent("Something went wrong. Nothing was deleted — try again or write to privacy@siapp.club."));
  }
  await signOut({ redirectTo: "/sign-in?deleted=1" });
}
