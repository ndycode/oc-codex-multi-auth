import { createHash } from "node:crypto";
import type { AccountMetadataV3 } from "../storage.js";
import { getUsageAccountDedupeKey, mapUsageWindow, type LimitWindow, type UsagePayload } from "../codex-usage.js";
import { extractAccountUserId } from "../auth/token-utils.js";
import { parseCodexQuotaWindows } from "../quota-windows.js";
import type { RotationAccount, RotationObservation, RotationWindow } from "./contract.js";

type Identity = Pick<AccountMetadataV3, "accountId" | "accountUserId" | "organizationId" | "refreshToken" | "lastUsed" | "accessToken" | "addedAt">;
export function rotationAccountId(account: Identity, scope: string): string {
	return createHash("sha256").update(JSON.stringify([scope, getUsageAccountDedupeKey(account)])).digest("hex");
}

function observationScope(account: Identity): "seat" | "unknown" {
	return account.accountUserId || extractAccountUserId(account.accessToken) ? "seat" : "unknown";
}

export function unknownObservation<T>(): RotationObservation<T> {
	return { value: null, status: "unknown", observedAt: null, expiresAt: null, source: null, scope: "unknown" };
}

function emptyWindow(): RotationWindow {
	return { usedPercent: unknownObservation(), resetAtMs: unknownObservation(), windowMinutes: unknownObservation() };
}

export function emptyRotationAccount(id: string, lastUsed = 0): RotationAccount {
	return { id, lastUsed, plan: unknownObservation(), primary: emptyWindow(), secondary: emptyWindow(), credits: unknownObservation(), resetCredits: unknownObservation() };
}

function fresh<T>(field: RotationObservation<T>, now: number): RotationObservation<T> {
	return field.status === "fresh" && field.expiresAt !== null && now >= field.expiresAt
		? { ...field, status: "stale" } : field;
}

function freshWindow(window: RotationWindow, now: number): RotationWindow {
	return { usedPercent: fresh(window.usedPercent, now), resetAtMs: fresh(window.resetAtMs, now), windowMinutes: fresh(window.windowMinutes, now) };
}

export class RotationObservations {
	private readonly accounts = new Map<string, RotationAccount>();

	snapshot(account: Identity, scope: string, now: number): RotationAccount {
		const id = rotationAccountId(account, scope);
		const data = this.accounts.get(id) ?? emptyRotationAccount(id);
		return { ...data, lastUsed: account.lastUsed ?? 0, plan: fresh(data.plan, now), primary: freshWindow(data.primary, now), secondary: freshWindow(data.secondary, now), credits: fresh(data.credits, now), resetCredits: fresh(data.resetCredits, now) };
	}

	private field<T>(previous: RotationObservation<T>, value: T | undefined, meta: {
		readonly now: number; readonly ttl: number; readonly source: RotationObservation<T>["source"];
		readonly scope: RotationObservation<T>["scope"]; readonly disabled?: boolean;
	}): RotationObservation<T> {
		if (previous.observedAt !== null && previous.observedAt > meta.now) return previous;
		if (value === undefined && !meta.disabled) return previous;
		return { value: meta.disabled ? null : value ?? null, status: meta.disabled ? "not-applicable" : "fresh", observedAt: meta.now, expiresAt: meta.now + meta.ttl, source: meta.source, scope: meta.scope };
	}

	private window(previous: RotationWindow, value: LimitWindow, meta: {
		readonly now: number; readonly source: "usage" | "headers"; readonly scope: "seat" | "workspace" | "unknown";
	}): RotationWindow {
		const fields = { ...meta, ttl: 300_000, disabled: value.windowMinutes === 0 };
		return { usedPercent: this.field(previous.usedPercent, value.usedPercent, fields), resetAtMs: this.field(previous.resetAtMs, value.resetAtMs, fields), windowMinutes: this.field(previous.windowMinutes, value.windowMinutes, fields) };
	}

	usage(account: Identity, scope: string, payload: UsagePayload, now: number): void {
		const data = this.snapshot(account, scope, now);
		const meta = { now, ttl: 300_000, source: "usage" as const, scope: observationScope(account) };
		this.accounts.set(data.id, {
			...data,
			plan: this.field(data.plan, payload.plan_type, meta),
			primary: this.window(data.primary, mapUsageWindow(payload.rate_limit?.primary_window), meta),
			secondary: this.window(data.secondary, mapUsageWindow(payload.rate_limit?.secondary_window), meta),
			credits: this.field(data.credits, payload.credits ? { balance: typeof payload.credits.balance === "string" ? payload.credits.balance : null, unlimited: payload.credits.unlimited === true } : undefined, meta),
		});
	}

	headers(account: Identity, scope: string, headers: Headers, now: number): void {
		let data = this.snapshot(account, scope, now);
		for (const window of parseCodexQuotaWindows(headers, now)) {
			const key = window.kind;
			data = { ...data, [key]: this.window(data[key], window, { now, source: "headers", scope: observationScope(account) }) };
		}
		this.accounts.set(data.id, data);
	}

	resets(account: Identity, scope: string, count: number, now: number): void {
		const data = this.snapshot(account, scope, now);
		this.accounts.set(data.id, { ...data, resetCredits: this.field(data.resetCredits, count, { now, ttl: 1_800_000, source: "reset-list", scope: observationScope(account) }) });
	}

	retain(ids: ReadonlySet<string>): void {
		for (const id of this.accounts.keys()) if (!ids.has(id)) this.accounts.delete(id);
	}
	clear(): void { this.accounts.clear(); }
}
