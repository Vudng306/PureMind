import type { AuthError } from "@supabase/supabase-js";

import { MSG } from "./messages";

/** Maps Supabase Auth errors to Appendix B messages. */
export function authErrorMessage(error: AuthError | Error | null | undefined): string {
  if (!error) return MSG["MSG-99"];
  const code = "code" in error ? (error.code as string | undefined) : undefined;
  const status = "status" in error ? (error.status as number | undefined) : undefined;

  if (status === 429 || code?.startsWith("over_")) return MSG["MSG-05"];
  switch (code) {
    case "invalid_credentials":
      return MSG["MSG-04"];
    case "user_already_exists":
    case "email_exists":
      return MSG["MSG-03"];
    case "weak_password":
      return MSG["MSG-02"];
    case "validation_failed":
    case "email_address_invalid":
      return MSG["MSG-01"];
    case "email_not_confirmed":
      return "Email chưa được xác nhận. Hãy kiểm tra hộp thư của bạn.";
  }
  if (status === 0 || error.message?.toLowerCase().includes("fetch")) {
    return "Không kết nối được dịch vụ đăng nhập. Kiểm tra kết nối và thử lại.";
  }
  return MSG["MSG-99"];
}
