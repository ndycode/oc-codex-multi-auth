/** Unix epoch milliseconds. Unknown values are never represented as zero quota. */
export type RotationObservation<T> = {
	readonly value: T | null;
	readonly status: "unknown" | "fresh" | "stale" | "not-applicable";
	readonly observedAt: number | null;
	readonly expiresAt: number | null;
	readonly source: "usage" | "headers" | "reset-list" | null;
	readonly scope: "seat" | "workspace" | "unknown";
};

/** Each independently observed quota field carries its own freshness. */
export type RotationWindow = {
	readonly usedPercent: RotationObservation<number>;
	readonly resetAtMs: RotationObservation<number>;
	readonly windowMinutes: RotationObservation<number>;
};

/** No email, workspace identifiers, credentials, prompts or credit IDs. */
export type RotationAccount = {
	/** Opaque host identity, distinct for Business seats and storage scopes. */
	readonly id: string;
	readonly lastUsed: number;
	readonly plan: RotationObservation<string>;
	readonly primary: RotationWindow;
	readonly secondary: RotationWindow;
	readonly credits: RotationObservation<{
		readonly balance: string | null;
		readonly unlimited: boolean;
	}>;
	/** Informational only; policies cannot redeem credits. */
	readonly resetCredits: RotationObservation<number>;
};

/** Versioned input to the named `select` export of a trusted .mjs policy. */
export type RotationInput = {
	readonly version: 1;
	readonly now: number;
	readonly model: string | null;
	readonly currentAccountId: string | null;
	/** Only accounts eligible for this request; host rechecks after selection. */
	readonly accounts: readonly RotationAccount[];
};

/** Return an input account's id or null to request eligible host fallback. */
export type RotationSelect = (input: RotationInput) => string | null | Promise<string | null>;
