/**
 * Shared account-display helpers.
 *
 * Account identity is rendered across several UI surfaces (interactive auth
 * menu, command output, runtime/log messages, standalone CLI login menu, TUI
 * quota status). Historically each surface formatted the email independently
 * and only the TUI quota path honored the `maskEmail` config, so full emails
 * could still leak into screenshots, screen shares, and terminal recordings.
 *
 * These helpers centralize the privacy behavior so every human-facing surface
 * masks the email consistently when `maskEmail` is enabled, while preferring a
 * user-defined account label when one exists.
 */

/**
 * Mask an email for display while preserving the domain so collisions between
 * accounts on the same provider remain distinguishable.
 *
 * `user@example.com` -> `us***@example.com`
 * `a@example.org`    -> `a***@example.org`
 * `not-an-email`     -> `*****`
 *
 * Returns `undefined` for empty/whitespace input so callers can fall back to
 * other identity fields.
 */
export function maskEmailForDisplay(email: string | undefined): string | undefined {
	const trimmed = email?.trim();
	if (!trimmed) return undefined;
	const atIndex = trimmed.indexOf("@");
	if (atIndex <= 0) return "*****";
	const prefix = trimmed.slice(0, Math.min(2, atIndex));
	const domain = trimmed.slice(atIndex);
	return `${prefix}***${domain}`;
}

/**
 * Resolve the email value to display for an account, applying masking when
 * requested. Returns `undefined` when there is no email to show.
 */
export function resolveDisplayEmail(
	email: string | undefined,
	maskEmail: boolean,
): string | undefined {
	const trimmed = email?.trim();
	if (!trimmed) return undefined;
	return maskEmail ? maskEmailForDisplay(trimmed) : trimmed;
}
