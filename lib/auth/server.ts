import http from "node:http";
import { randomBytes } from "node:crypto";
import type { OAuthServerInfo } from "../types.js";
import { logError, logWarn } from "../logger.js";
import { renderOAuthSuccessHtml } from "../oauth-success.js";
import {
	OAUTH_CALLBACK_BIND_HOSTS,
	OAUTH_CALLBACK_BIND_URL,
	OAUTH_CALLBACK_PATH,
	OAUTH_CALLBACK_PORT,
} from "../oauth-constants.js";

type ServerWithLastCode = http.Server & { _lastCode?: string };

function closeServer(server: http.Server): void {
	try {
		server.close();
	} catch (err) {
		logError(`Failed to close OAuth server: ${(err as Error)?.message ?? String(err)}`);
	}
}

/**
 * Start a small local HTTP server that waits for /auth/callback and returns the code.
 *
 * The public redirect URI uses localhost because that is what the Codex OAuth
 * client registration expects. Bind both concrete loopback interfaces so
 * Windows dual-stack localhost resolution can reach either 127.0.0.1 or ::1.
 *
 * @param options - OAuth state for validation
 * @returns Promise that resolves to server info
 */
export async function startLocalOAuthServer({ state }: { state: string }): Promise<OAuthServerInfo> {
	let pollAborted = false;
	let lastCode: string | undefined;
	const allServers: ServerWithLastCode[] = [];

	const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
		try {
			const url = new URL(req.url || "", "http://localhost");
			if (url.pathname !== OAUTH_CALLBACK_PATH) {
				res.statusCode = 404;
				res.end("Not found");
				return;
			}
			if (url.searchParams.get("state") !== state) {
				res.statusCode = 400;
				res.end("State mismatch");
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				res.statusCode = 400;
				res.end("Missing authorization code");
				return;
			}
			const styleNonce = randomBytes(18).toString("base64");
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("Referrer-Policy", "no-referrer");
			res.setHeader("X-Frame-Options", "DENY");
			res.setHeader("X-Content-Type-Options", "nosniff");
			res.setHeader(
				"Content-Security-Policy",
				`default-src 'none'; style-src 'nonce-${styleNonce}'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
			);
			res.end(renderOAuthSuccessHtml(styleNonce));
			lastCode = code;
			for (const server of allServers) {
				server._lastCode = code;
			}
		} catch (err) {
			logError(`Request handler error: ${(err as Error)?.message ?? String(err)}`);
			res.statusCode = 500;
			res.end("Internal error");
		}
	};

	const bindServer = (host: string): Promise<http.Server | null> => {
		const server = http.createServer(handler) as ServerWithLastCode;
		allServers.push(server);
		server.unref();

		return new Promise((resolve) => {
			let settled = false;
			const settle = (value: http.Server | null): void => {
				if (settled) return;
				settled = true;
				resolve(value);
			};

			server
				.on("error", (err: NodeJS.ErrnoException) => {
					const message =
						host === OAUTH_CALLBACK_BIND_HOSTS[0]
							? `Failed to bind ${OAUTH_CALLBACK_BIND_URL} (${err?.code}). Suggest device code or manual URL paste.`
							: `Failed to bind http://[::1]:${OAUTH_CALLBACK_PORT} (${err?.code}); continuing if IPv4 loopback is available.`;
					if (host === OAUTH_CALLBACK_BIND_HOSTS[0]) {
						logError(message);
					} else {
						logWarn(message);
					}
					settle(null);
				})
				.listen(OAUTH_CALLBACK_PORT, host, () => {
					settle(server);
				});
		});
	};

	const boundServers = (await Promise.all(
		OAUTH_CALLBACK_BIND_HOSTS.map((host) => bindServer(host)),
	)).filter((server): server is http.Server => server !== null);

	if (boundServers.length === 0) {
		return {
			port: OAUTH_CALLBACK_PORT,
			ready: false,
			close: () => {
				pollAborted = true;
				for (const server of allServers) {
					closeServer(server);
				}
			},
			waitForCode: () => Promise.resolve(null),
		};
	}

	return {
		port: OAUTH_CALLBACK_PORT,
		ready: true,
		close: () => {
			pollAborted = true;
			for (const server of boundServers) {
				closeServer(server);
			}
		},
		waitForCode: async () => {
			const POLL_INTERVAL_MS = 100;
			const TIMEOUT_MS = 5 * 60 * 1000;
			const maxIterations = Math.floor(TIMEOUT_MS / POLL_INTERVAL_MS);
			const poll = () => new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
			for (let i = 0; i < maxIterations; i++) {
				if (pollAborted) return null;
				const serverCode = allServers
					.map((server) => server._lastCode)
					.find((code): code is string => typeof code === "string" && code.length > 0);
				const code = lastCode ?? serverCode;
				if (code) return { code };
				await poll();
			}
			logWarn("OAuth poll timeout after 5 minutes");
			return null;
		},
	};
}
