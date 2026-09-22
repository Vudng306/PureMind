import type { AuthError } from "@supabase/supabase-js";

import { translate } from "./i18n";
import { MSG } from "./messages";
import { currentLang } from "./preferences";

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
      return translate(currentLang(), "auth.emailNotConfirmed");
  }
  if (status === 0 || error.message?.toLowerCase().includes("fetch")) {
    return translate(currentLang(), "auth.serviceUnreachable");
  }
  return MSG["MSG-99"];
}
