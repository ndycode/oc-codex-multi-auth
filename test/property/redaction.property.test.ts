/**
 * DEEP STRESS: privacy/redaction invariants.
 *
 * Property-based hammering of the masking + redaction surfaces hardened across
 * the audit (#163 email masking, codex-diff key-aware redaction, logger
 * sanitizeValue). The invariant: for ANY generated email/secret, the raw value
 * must never survive into the rendered/sanitized output.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import {
  maskEmailForDisplay,
  resolveDisplayEmail,
} from "../../lib/account-display.js";
import { sanitizeValue, maskString } from "../../lib/logger.js";

const arbEmail = fc.emailAddress();
// Opaque, non-token-shaped secrets (what real refresh tokens often look like):
// random-ish strings that maskString's shape heuristics would NOT catch.
const arbOpaqueSecret = fc
  .string({ minLength: 8, maxLength: 64 })
  .filter((s) => s.trim().length >= 8);

describe("DEEP STRESS: email masking invariant (#163)", () => {
  it("masked email reveals at most the first 2 local chars", () => {
    fc.assert(
      fc.property(arbEmail, (email) => {
        const masked = maskEmailForDisplay(email);
        if (!masked) return true;
        const atIndex = email.indexOf("@");
        const local = email.slice(0, atIndex);
        const domain = email.slice(atIndex);
        // The masker contract is: masked local = first min(2, len) chars + "***".
        // We assert that EXACT shape rather than a substring check, because a
        // substring check is fragile when the local part itself contains the
        // mask characters (e.g. "a.*@a.aa" -> "a.***@a.aa", where the local
        // "a.*" reappears as the kept "a." plus a "*" from the mask). The real
        // security property is that no more than the first 2 local chars survive.
        const maskedAtIndex = masked.indexOf("@");
        const maskedLocal =
          maskedAtIndex >= 0 ? masked.slice(0, maskedAtIndex) : masked;
        const expectedRevealed = local.slice(0, Math.min(2, local.length));
        expect(maskedLocal).toBe(`${expectedRevealed}***`);
        // Domain is preserved verbatim for distinguishability.
        expect(masked.endsWith(domain)).toBe(true);
        return true;
      }),
      { numRuns: 500 },
    );
  });

  // Deterministic regression for the two classes that previously made the
  // property test seed-flaky: (1) the local part also occurs in the domain
  // (abc@abc.com), and (2) the local part contains the mask character itself
  // (a.*@a.aa -> a.***). Both broke a naive substring check; the real contract
  // is that the masked local reveals at most the first 2 chars. (#163)
  it("reveals at most the first 2 local chars in tricky cases", () => {
    const cases: Array<[string, string]> = [
      ["abc@abc.com", "ab***@abc.com"],
      ["tom@tom.io", "to***@tom.io"],
      ["xyz@sub.xyz.org", "xy***@sub.xyz.org"],
      ["a.*@a.aa", "a.***@a.aa"],
      ["a@a.com", "a***@a.com"],
    ];
    for (const [email, expected] of cases) {
      expect(maskEmailForDisplay(email)).toBe(expected);
    }
  });

  it("resolveDisplayEmail with masking enabled never returns the raw email (len>3 local)", () => {
    fc.assert(
      fc.property(arbEmail, (email) => {
        const out = resolveDisplayEmail(email, true);
        if (!out) return true;
        const local = email.slice(0, email.indexOf("@"));
        if (local.length > 2) {
          expect(out).not.toBe(email);
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it("masking disabled is an identity (backward compatible)", () => {
    fc.assert(
      fc.property(arbEmail, (email) => {
        expect(resolveDisplayEmail(email, false)).toBe(email.trim());
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

describe("DEEP STRESS: logger sanitizeValue redaction invariant", () => {
  const SENSITIVE_KEYS = [
    "access",
    "accessToken",
    "refresh",
    "refreshToken",
    "token",
    "authorization",
    "apiKey",
    "secret",
    "password",
    "id_token",
    "cookie",
    "set-cookie",
  ];

  it("a sensitive-keyed opaque secret never appears verbatim in sanitized output", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SENSITIVE_KEYS),
        arbOpaqueSecret,
        (key, secret) => {
          const sanitized = sanitizeValue({ [key]: secret });
          const serialized = JSON.stringify(sanitized);
          // The raw secret (when long enough to be masked) must not survive.
          if (secret.length > 12) {
            expect(serialized.includes(secret)).toBe(false);
          }
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("nested sensitive values are recursively masked", () => {
    fc.assert(
      fc.property(arbOpaqueSecret, (secret) => {
        if (secret.length <= 12) return true;
        const sanitized = sanitizeValue({
          outer: { inner: { refreshToken: secret } },
          list: [{ accessToken: secret }],
        });
        const serialized = JSON.stringify(sanitized);
        expect(serialized.includes(secret)).toBe(false);
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("an email value under the email key is domain-masked, not raw", () => {
    fc.assert(
      fc.property(arbEmail, (email) => {
        const local = email.slice(0, email.indexOf("@"));
        if (local.length <= 6) return true; // short locals are within mask hint
        const sanitized = sanitizeValue({ email }) as { email: string };
        // maskToken would leak the first 6 chars; maskEmail must not leak the
        // full local part.
        expect(sanitized.email.includes(local)).toBe(false);
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("maskString scrubs JWT-shaped substrings embedded in free text", () => {
    fc.assert(
      fc.property(
        fc.base64String({ minLength: 20, maxLength: 40 }),
        fc.base64String({ minLength: 20, maxLength: 40 }),
        fc.base64String({ minLength: 20, maxLength: 40 }),
        (a, b, c) => {
          // A real JWT's first two segments are base64url of a JSON object, so
          // they begin with `eyJ`. Construct that shape (which the redactor
          // targets) and strip padding to keep it base64url-clean.
          const clean = (s: string) => s.replace(/[=+/]/g, "A");
          const jwt = `eyJ${clean(a)}.eyJ${clean(b)}.${clean(c)}`;
          const text = `prefix ${jwt} suffix`;
          const masked = maskString(text);
          // The full JWT triple must not survive verbatim.
          expect(masked.includes(jwt)).toBe(false);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
