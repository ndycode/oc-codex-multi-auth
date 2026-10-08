import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { RotationInput } from "./contract.js";
import { ROTATION_WORKER_SOURCE } from "./worker.js";
import { terminateRotationTree } from "./process.js";
import { registerCleanup, unregisterCleanup } from "../shutdown.js";

export type RotationRunResult = {
	readonly accountId: string | null;
	readonly error: "module-path" | "input-limit" | "busy" | "cancelled" | "timeout" | "output-limit" | "policy" | "protocol" | "spawn" | null;
};
const ResultSchema = z.union([
	z.object({ accountId: z.string().max(256).nullable() }).strict(),
	z.object({ error: z.literal("policy") }).strict(),
]);
const MAX_BYTES = 65_536;
const MAX_CHILDREN = 4;
let activeChildren = 0;

/** Trusted code, NOT a sandbox. Bounds import, synchronous select and async work. */
export async function runRotationPolicy(
	module: string,
	context: RotationInput,
	options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<RotationRunResult> {
	if (!isAbsolute(module) || !module.endsWith(".mjs")) return { accountId: null, error: "module-path" };
	if (options.signal?.aborted) return { accountId: null, error: "cancelled" };
	if (activeChildren >= MAX_CHILDREN) return { accountId: null, error: "busy" };
	const input = JSON.stringify({ module, context });
	if (Buffer.byteLength(input) > 1_048_576) return { accountId: null, error: "input-limit" };
	activeChildren += 1;
	return new Promise((resolve) => {
		const nodeHost = process.versions["bun"] === undefined && process.release.name === "node";
		const child = spawn(nodeHost ? process.execPath : "node", [
			"--max-old-space-size=64", "--input-type=module", "--eval", ROTATION_WORKER_SOURCE,
		], {
			cwd: tmpdir(),
			// Deliberately no NODE_OPTIONS, loader/preload arguments, HOME or tokens.
			env: nodeHost ? {} : { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			stdio: ["pipe", "pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let error: RotationRunResult["error"] = null;
		let outputBytes = 0;
		let protocol = "";
		const decoder = new StringDecoder("utf8");
		let completed = false;
		let settled = false;
		let teardown: Promise<void> | undefined;
		let settlementTimer: ReturnType<typeof setTimeout> | undefined;
		const terminate = (): void => {
			if (teardown) return;
			teardown = terminateRotationTree(child);
			settlementTimer = setTimeout(() => { void finish(null); }, 250);
		};
		const fail = (reason: RotationRunResult["error"]): void => {
			error ??= reason;
			terminate();
		};
		const abort = (): void => fail("cancelled");
		let releaseCleanup: () => void = () => {};
		const closed = new Promise<void>((reaped) => { releaseCleanup = reaped; });
		const cleanup = (): Promise<void> => { abort(); return closed; };
		registerCleanup(cleanup);
		const timeout = setTimeout(() => fail("timeout"), options.timeoutMs ?? 1_000);
		options.signal?.addEventListener("abort", abort, { once: true });
		const consume = (chunk: Buffer): boolean => {
			outputBytes += chunk.length;
			if (outputBytes > MAX_BYTES) { fail("output-limit"); return false; }
			return true;
		};
		child.stdout?.on("data", consume);
		child.stderr?.on("data", consume);
		const channel = child.stdio[3];
		if (channel && "on" in channel) channel.on("data", (chunk: Buffer) => {
			if (consume(chunk)) {
				protocol += decoder.write(chunk);
				if (protocol.endsWith("\n")) { completed = true; terminate(); }
			}
		});
		child.on("error", () => fail("spawn"));
		child.stdin?.on("error", () => { error ??= "protocol"; });
		// Exit, not close: descendants retaining pipes cannot hold the host open.
		child.on("exit", () => terminate());
		const finish = async (code: number | null): Promise<void> => {
			if (settled) return;
			settled = true;
			await teardown;
			clearTimeout(settlementTimer);
			for (const stream of child.stdio) stream?.destroy();
			child.unref();
			unregisterCleanup(cleanup);
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
			activeChildren -= 1;
			releaseCleanup();
			if (error) { resolve({ accountId: null, error }); return; }
			if (!completed && code !== 0) { resolve({ accountId: null, error: "policy" }); return; }
			try {
				const parsed = ResultSchema.safeParse(JSON.parse(protocol));
				resolve(parsed.success
					? "error" in parsed.data ? { accountId: null, error: parsed.data.error } : { ...parsed.data, error: null }
					: { accountId: null, error: "protocol" });
			} catch (cause) {
				if (!(cause instanceof SyntaxError)) throw cause;
				resolve({ accountId: null, error: "protocol" });
			}
		};
		child.on("close", (code) => { terminate(); void finish(code); });
		child.stdin?.end(input);
		if (options.signal?.aborted) abort();
	});
}
