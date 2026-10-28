import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

/** Root: members go to the app, staff to the backoffice, everyone else to sign-in. */
export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect("/sign-in");
  redirect(session.user.staffId ? "/admin" : "/app");
}
