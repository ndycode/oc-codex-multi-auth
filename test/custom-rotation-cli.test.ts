import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "rotation-cli-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function validateFixtures(path: string, module = fileURLToPath(new URL("../assets/rotation/my-policy.mjs", import.meta.url))) {
	return spawnSync(process.execPath, [
		"--input-type=module", "--eval",
		`import { runRotationValidate } from ${JSON.stringify(new URL("../scripts/rotation-validate.js", import.meta.url).href)};
		const result = await runRotationValidate(['validate', ${JSON.stringify(module)}, '--fixtures', process.argv[1], '--json']);
		process.exitCode = result.exitCode;`,
		path,
	], {
		cwd: directory,
		env: { HOME: directory, USERPROFILE: directory, CODEX_KEYCHAIN: "0" },
		encoding: "utf8", timeout: 3_000, killSignal: "SIGKILL",
	});
}

describe("rotation validation fixture files", () => {
	it.skipIf(process.platform === "win32").each([false, true])(
		"rejects a FIFO without a writer when symlinked=%s",
		async (symlinked, context) => {
			// Given a real POSIX FIFO with no writer attached.
			const fifo = join(directory, "fixtures.fifo");
			const created = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 3_000, killSignal: "SIGKILL" });
			if (created.status !== 0 && /not supported|not implemented/i.test(created.stderr)) {
				context.skip();
				return;
			}
			expect(created.error).toBeUndefined();
			expect(created.status).toBe(0);
			const path = symlinked ? join(directory, "fixtures.json") : fifo;
			if (symlinked) await symlink(fifo, path);

			// When the CLI reads the fixture, the parent enforces a hard deadline.
			const result = validateFixtures(path);

			// Then it rejects the descriptor normally instead of needing a kill.
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(2);
			expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: 2, results: [] });
		},
	);

	it("rejects fixtures when the path is a directory", () => {
		// Given the isolated fixture directory; when validation opens it.
		const result = validateFixtures(directory);
		// Then validation rejects it with a normal usage error.
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(2);
		expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: 2, results: [] });
	});

	it("accepts a valid fixture from a regular file", async () => {
		// Given a valid fixture JSON file and an eligible policy.
		const path = join(directory, "fixtures.json");
		await writeFile(path, JSON.stringify({
			scenarios: [{
				name: "empty-pool",
				input: { version: 1, now: 1_800_000_000_000, model: null, currentAccountId: null, accounts: [] },
				expectedAccountId: null,
			}],
		}));

		// When the CLI validates the regular fixture.
		const result = validateFixtures(path);

		// Then fixture validation completes successfully.
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			exitCode: 0,
			error: null,
			results: expect.arrayContaining([
				expect.objectContaining({ name: "empty-pool", passed: true }),
			]),
		});
	});

	it("rejects fixtures when a regular file exceeds 1 MiB", async () => {
		// Given a real regular file beyond the fixture budget.
		const path = join(directory, "fixtures.json");
		await writeFile(path, " ".repeat(1_048_577));
		// When validation opens it.
		const result = validateFixtures(path);
		// Then it rejects the oversized fixture without running a policy.
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(2);
		expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: 2, results: [] });
	});
});
