import { z } from "zod";
import { emptyRotationAccount } from "./observations.js";
import type { RotationAccount } from "./contract.js";

function observation<T extends z.ZodType>(value: T) {
	return z.object({
		value: value.nullable(), status: z.enum(["unknown", "fresh", "stale", "not-applicable"]),
		observedAt: z.number().finite().nullable(), expiresAt: z.number().finite().nullable(),
		source: z.enum(["usage", "headers", "reset-list"]).nullable(),
		scope: z.enum(["seat", "workspace", "unknown"]),
	}).strict();
}
const WindowSchema = z.object({ usedPercent: observation(z.number().finite()), resetAtMs: observation(z.number().finite()), windowMinutes: observation(z.number().finite()) }).strict();
const AccountSchema = z.object({
	id: z.string().min(1).max(256), lastUsed: z.number().finite().optional(),
	plan: observation(z.string()).optional(), primary: WindowSchema.optional(), secondary: WindowSchema.optional(),
	credits: observation(z.object({ balance: z.string().nullable(), unlimited: z.boolean() }).strict()).optional(),
	resetCredits: observation(z.number().int().nonnegative()).optional(),
}).strict().transform((account): RotationAccount => ({ ...emptyRotationAccount(account.id), ...account }));
export const RotationInputSchema = z.object({
	version: z.literal(1), now: z.number().finite(), model: z.string().nullable(), currentAccountId: z.string().nullable(),
	accounts: z.array(AccountSchema).max(1000).refine((accounts) => new Set(accounts.map((account) => account.id)).size === accounts.length, "Duplicate account ids"),
}).strict();
export const RotationFixturesSchema = z.object({
	scenarios: z.array(z.object({ name: z.string().min(1), input: RotationInputSchema, expectedAccountId: z.string().nullable().optional() }).strict()).min(1).max(100),
}).strict();
