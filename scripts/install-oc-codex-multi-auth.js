#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import {
	isDirectRunPath as isDirectRunPathCore,
	runInstaller,
} from "./install-oc-codex-multi-auth-core.js";

export * from "./install-oc-codex-multi-auth-core.js";

const __filename = fileURLToPath(import.meta.url);

export function isDirectRunPath(
	argvPath = process.argv[1],
	modulePath = __filename,
	resolveRealPath,
) {
	return isDirectRunPathCore(argvPath, modulePath, resolveRealPath);
}

if (isDirectRunPath()) {
	runInstaller()
		.then((result) => {
			// Propagate a non-zero exit from standalone commands (e.g. `warm`
			// reporting per-account failures) without throwing. Read-only
			// commands return exitCode 0; only set a failure code so a clean run
			// still exits 0.
			if (result && typeof result.exitCode === "number" && result.exitCode !== 0) {
				process.exitCode = result.exitCode;
			}
		})
		.catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`Installer failed: ${message}`);
			process.exit(1);
		});
}
