import {
	maskEmailForDisplay,
	resolveDisplayEmail,
} from "../lib/account-display.js";

describe("account-display", () => {
	describe("maskEmailForDisplay", () => {
		it("preserves the domain and first two local characters", () => {
			expect(maskEmailForDisplay("user@example.com")).toBe("us***@example.com");
		});

		it("keeps a single-character local part", () => {
			expect(maskEmailForDisplay("a@example.org")).toBe("a***@example.org");
		});

		it("preserves multi-part domains", () => {
			expect(maskEmailForDisplay("user@mail.company.co.uk")).toBe(
				"us***@mail.company.co.uk",
			);
		});

		it("falls back to a fully masked token for non-emails", () => {
			expect(maskEmailForDisplay("not-an-email")).toBe("*****");
		});

		it("returns undefined for empty or whitespace input", () => {
			expect(maskEmailForDisplay(undefined)).toBeUndefined();
			expect(maskEmailForDisplay("")).toBeUndefined();
			expect(maskEmailForDisplay("   ")).toBeUndefined();
		});

		it("trims surrounding whitespace before masking", () => {
			expect(maskEmailForDisplay("  user@example.com  ")).toBe(
				"us***@example.com",
			);
		});
	});

	describe("resolveDisplayEmail", () => {
		it("returns the raw email when masking is disabled", () => {
			expect(resolveDisplayEmail("user@example.com", false)).toBe(
				"user@example.com",
			);
		});

		it("returns a masked email when masking is enabled", () => {
			expect(resolveDisplayEmail("user@example.com", true)).toBe(
				"us***@example.com",
			);
		});

		it("returns undefined when there is no email", () => {
			expect(resolveDisplayEmail(undefined, true)).toBeUndefined();
			expect(resolveDisplayEmail("", false)).toBeUndefined();
		});
	});
});
