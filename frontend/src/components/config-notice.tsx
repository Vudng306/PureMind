import { Alert } from "./ui";

export function SupabaseConfigNotice() {
  return (
    <Alert>
      Supabase chưa được cấu hình. Điền <code>NEXT_PUBLIC_SUPABASE_URL</code> và{" "}
      <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> vào <code>frontend/.env.local</code> rồi khởi động lại.
    </Alert>
  );
}
