import { useT } from "@/lib/i18n";

import { Alert } from "./ui";

export function SupabaseConfigNotice() {
  const t = useT();
  return (
    <Alert>
      {t("config.supabase", {
        url: "NEXT_PUBLIC_SUPABASE_URL",
        key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        file: "frontend/.env.local",
      })}
    </Alert>
  );
}
