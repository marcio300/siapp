"use server";

import { redirect } from "next/navigation";
import { requireMember } from "@/lib/authz";
import { PhotoError, deleteIdPhoto, storeIdPhoto, storeSelfie } from "@/domain/identity";

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
