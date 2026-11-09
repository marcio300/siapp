"use server";

import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/authz";
import { checkbox, text } from "@/lib/forms";
import { ProducerError, clearPayoutDetails, createProducer, updateProducer } from "@/domain/producers";
import { createProducerApiKey, disconnectProducer } from "@/domain/partners-api";

function input(fd: FormData) {
  return {
    name: text(fd, "name") ?? "",
    cityId: text(fd, "cityId") ?? "",
    contactName: text(fd, "contactName"),
    contactEmail: text(fd, "contactEmail"),
    contactPhone: text(fd, "contactPhone"),
    payoutDetails: text(fd, "payoutDetails"),
    defaultDiscountPercent: text(fd, "defaultDiscountPercent"),
    usesEventOS: checkbox(fd, "usesEventOS"),
    notes: text(fd, "notes"),
  };
}

export async function createProducerAction(fd: FormData): Promise<void> {
  await requireStaff("OPS");
  let id = "";
  try {
    id = (await createProducer(input(fd))).id;
  } catch (e) {
    if (e instanceof ProducerError) redirect(`/admin/producers?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  redirect(`/admin/producers/${id}?saved=1`);
}

export async function updateProducerAction(fd: FormData): Promise<void> {
  await requireStaff("OPS");
  const id = text(fd, "id") ?? "";
  try {
    await updateProducer(id, input(fd));
  } catch (e) {
    if (e instanceof ProducerError) redirect(`/admin/producers/${id}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  redirect(`/admin/producers/${id}?saved=1`);
}

/** ADMIN: mint the EventOS API key (shown once on the redirect). Revokes any active key. */
export async function generateApiKeyAction(fd: FormData): Promise<void> {
  const staff = await requireStaff("ADMIN");
  const id = text(fd, "id") ?? "";
  const { plain } = await createProducerApiKey(id, staff.staffId);
  redirect(`/admin/producers/${id}?apiKey=${encodeURIComponent(plain)}`);
}

/** ADMIN: revoke the key. EventOS is told (`producer.disconnected`, reason key_revoked) first. */
export async function revokeApiKeyAction(fd: FormData): Promise<void> {
  await requireStaff("ADMIN");
  const id = text(fd, "id") ?? "";
  await disconnectProducer(id, "key_revoked");
  redirect(`/admin/producers/${id}?saved=1`);
}

/** ADMIN: forget the EventOS binding (org, webhook, secrets) and revoke keys. Events stay. EventOS is told first. */
export async function unbindEventOSAction(fd: FormData): Promise<void> {
  await requireStaff("ADMIN");
  const id = text(fd, "id") ?? "";
  await disconnectProducer(id, "staff");
  redirect(`/admin/producers/${id}?saved=1`);
}

export async function clearPayoutAction(fd: FormData): Promise<void> {
  await requireStaff("ADMIN");
  const id = text(fd, "id") ?? "";
  await clearPayoutDetails(id);
  redirect(`/admin/producers/${id}?saved=1`);
}
