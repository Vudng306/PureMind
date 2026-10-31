import { describe, expect, it } from "vitest";

import { isAlreadyRegistered } from "./auth-errors";

const identity = { id: "1", user_id: "1", identity_id: "1", provider: "email" } as never;

describe("isAlreadyRegistered", () => {
  it("spots the stand-in user Supabase returns for an email already registered", () => {
    expect(isAlreadyRegistered({ identities: [] })).toBe(true);
  });

  it("lets a new or still unconfirmed account through", () => {
    expect(isAlreadyRegistered({ identities: [identity] })).toBe(false);
    expect(isAlreadyRegistered({ identities: undefined })).toBe(false);
    expect(isAlreadyRegistered(null)).toBe(false);
  });
});
