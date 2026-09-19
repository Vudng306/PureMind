import { redirect } from "next/navigation";

/** Profile now lives on the combined settings page. */
export default function AccountPage() {
  redirect("/settings");
}
