import { redirect } from "next/navigation";

/** The profile is a tab of the settings page now; the old address still leads to it. */
export default function AccountPage() {
  redirect("/settings?tab=account");
}
