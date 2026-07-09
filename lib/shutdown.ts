type CleanupFn = () => void | Promise<void>;

const cleanupFunctions: CleanupFn[] = [];
let shutdownRegistered = false;

/**
 * Whether this process is ours to terminate.
 *
 * Defaults to false: the package normally runs as a plugin *inside* the
 * opencode host process, where calling `process.exit` from a signal handler
 * preempts opencode's own shutdown (#187). Only an entrypoint that IS the
 * process — the standalone `warm` CLI — opts in. Read lazily at signal time,
 * so the opt-in may happen after handlers are installed.
 */
let ownsProcess = false;

/**
 * The in-flight drain, if one is running. Concurrent callers (a signal handler
 * and `beforeExit` firing in the same shutdown) share it rather than racing on
 * an already-emptied queue. Cleared once settled, so *sequential* calls each
 * drain freshly — `AccountManager` re-registers its flush handler after an
 * external `runCleanup()`, and the test suites depend on that.
 */
let inFlight: Promise<void> | null = null;

export function setShutdownOwnsProcess(owns: boolean): void {
	ownsProcess = owns;
}

export function registerCleanup(fn: CleanupFn): void {
	cleanupFunctions.push(fn);
	ensureShutdownHandler();
}

export function unregisterCleanup(fn: CleanupFn): void {
	const index = cleanupFunctions.indexOf(fn);
	if (index !== -1) {
		cleanupFunctions.splice(index, 1);
	}
}

export function runCleanup(): Promise<void> {
	if (inFlight) return inFlight;

	const fns = [...cleanupFunctions];
	cleanupFunctions.length = 0;

	inFlight = (async () => {
		for (const fn of fns) {
			try {
				await fn();
			} catch {
				// Ignore cleanup errors during shutdown
			}
		}
	})().finally(() => {
		inFlight = null;
	});

	return inFlight;
}

function ensureShutdownHandler(): void {
	if (shutdownRegistered) return;
	shutdownRegistered = true;

	const handleSignal = (signal: "SIGINT" | "SIGTERM") => {
		const drained = runCleanup();
		// A guest in someone else's process: run cleanup, then let the host
		// finish its own shutdown. Exiting here is what broke #187.
		if (!ownsProcess) return;
		void drained.finally(() => {
			process.exit(signal === "SIGTERM" ? 143 : 130);
		});
	};

	process.once("SIGINT", () => handleSignal("SIGINT"));
	process.once("SIGTERM", () => handleSignal("SIGTERM"));
	process.once("beforeExit", () => {
		void runCleanup();
	});
}

export function getCleanupCount(): number {
	return cleanupFunctions.length;
}
