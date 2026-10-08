import { constants } from "node:fs";
import { open } from "node:fs/promises";

export async function runRotationValidate(argv) {
	const json = argv.includes("--json");
	const fail = (error) => {
		const payload = { exitCode: 2, error, results: [] };
		console.log(json ? JSON.stringify(payload) : error);
		return { exitCode: 2, action: "rotation" };
	};
	if (argv[0] !== "validate") return fail("Usage: rotation validate [absolute-module.mjs] [--fixtures file] [--json]");
	let module;
	let fixturePath;
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") continue;
		if (arg === "--fixtures" && argv[index + 1] && !fixturePath) { fixturePath = argv[++index]; continue; }
		if (!arg.startsWith("-") && !module) { module = arg; continue; }
		return fail("Invalid rotation validation arguments");
	}
	try {
		if (!module) {
			const { loadPluginConfig } = await import("../dist/lib/config.js");
			module = loadPluginConfig().customRotation?.module;
		}
		if (!module) return fail("No customRotation.module configured");
		let fixtures;
		if (fixturePath) {
			// Reach descriptor validation even for a POSIX FIFO with no writer.
			const file = await open(fixturePath, constants.O_RDONLY | constants.O_NONBLOCK);
			try {
				const info = await file.stat();
				if (!info.isFile() || info.size > 1_048_576) return fail("Rotation fixtures must be a regular file of at most 1 MiB");
				const buffer = Buffer.alloc(1_048_577);
				let total = 0;
				while (total < buffer.length) {
					const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
					if (bytesRead === 0) break;
					total += bytesRead;
				}
				if (total > 1_048_576) return fail("Rotation fixtures exceed 1 MiB");
				fixtures = JSON.parse(buffer.toString("utf8", 0, total));
			} finally { await file.close(); }
		}
		const { validateRotation } = await import("../dist/lib/custom-rotation/validate.js");
		const { setShutdownOwnsProcess } = await import("../dist/lib/shutdown.js");
		setShutdownOwnsProcess(true);
		const payload = await validateRotation(module, fixtures);
		console.log(json ? JSON.stringify(payload) : payload.error ?? payload.results.map((result) => `${result.passed ? "PASS" : "FAIL"} ${result.name}${result.error ? ` (${result.error})` : ""}`).join("\n"));
		return { exitCode: payload.exitCode, action: "rotation" };
	} catch {
		return fail("Could not read rotation configuration or fixtures (build the package first)");
	}
}
