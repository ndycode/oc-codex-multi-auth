import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { lock } from "proper-lockfile";

const testHome = vi.hoisted(
	() => `/tmp/oc-codex-model-pool-config-${process.pid}`,
);

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, homedir: () => testHome };
});

import { updateModelAccountPool } from "../lib/config.js";

const configDir = join(testHome, ".opencode");
const configPath = join(configDir, "openai-codex-auth-config.json");

async function readConfig(): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<
		string,
		unknown
	>;
}

describe("model account pool config mutation", () => {
	beforeEach(async () => {
		await fs.rm(testHome, { recursive: true, force: true });
		await fs.mkdir(configDir, { recursive: true });
	});

	afterAll(async () => {
		await fs.rm(testHome, { recursive: true, force: true });
	});

	it("sets a canonical model key and preserves unrelated configuration", async () => {
		await fs.writeFile(
			configPath,
			JSON.stringify({
				rotationStrategy: "sticky",
				customFutureField: { keep: true },
				modelAccountPools: {
					" GPT-5.6-SOL ": ["old-one"],
					"gpt-5.6-sol": ["old-two"],
					"gpt-5.6-terra": ["terra-one"],
				},
			}),
		);

		const result = await updateModelAccountPool(
			" GPT-5.6-SOL ",
			"set",
			["new-one", "new-one", "new-two"],
		);
		const saved = await readConfig();

		expect(result).toMatchObject({
			model: "gpt-5.6-sol",
			previousAccountIds: ["old-one", "old-two"],
			accountIds: ["new-one", "new-two"],
			changed: true,
		});
		expect(saved).toMatchObject({
			rotationStrategy: "sticky",
			customFutureField: { keep: true },
			modelAccountPools: {
				"gpt-5.6-sol": ["new-one", "new-two"],
				"gpt-5.6-terra": ["terra-one"],
			},
		});
	});

	it("adds, removes, and clears stable IDs while preserving order", async () => {
		await fs.writeFile(
			configPath,
			JSON.stringify({ modelAccountPools: { model: ["one", "two"] } }),
		);

		await updateModelAccountPool("model", "add", ["two", "three"]);
		expect((await readConfig()).modelAccountPools).toEqual({
			model: ["one", "two", "three"],
		});

		await updateModelAccountPool("model", "remove", ["two"]);
		expect((await readConfig()).modelAccountPools).toEqual({
			model: ["one", "three"],
		});

		await updateModelAccountPool("model", "clear");
		expect(await readConfig()).not.toHaveProperty("modelAccountPools");
	});

	it("serializes concurrent mutations so updates are not lost", async () => {
		await fs.writeFile(
			configPath,
			JSON.stringify({ modelAccountPools: { model: ["one"] } }),
		);

		await Promise.all([
			updateModelAccountPool("model", "add", ["two"]),
			updateModelAccountPool("model", "add", ["three"]),
		]);

		expect((await readConfig()).modelAccountPools).toEqual({
			model: ["one", "two", "three"],
		});
	});

	it("waits for a foreign lock before reading and preserves the latest config", async () => {
		await fs.writeFile(
			configPath,
			JSON.stringify({ modelAccountPools: { model: ["one"] } }),
		);
		const releaseForeignLock = await lock(configPath, { realpath: false });
		const pendingMutation = updateModelAccountPool("model", "add", ["two"]);

		await new Promise((resolve) => setTimeout(resolve, 75));
		await fs.writeFile(
			configPath,
			JSON.stringify({
				rotationStrategy: "sticky",
				modelAccountPools: { model: ["one", "external"] },
			}),
		);
		await releaseForeignLock();
		await pendingMutation;

		expect(await readConfig()).toMatchObject({
			rotationStrategy: "sticky",
			modelAccountPools: { model: ["one", "external", "two"] },
		});
	});

	it("previews a change without creating or modifying the config file", async () => {
		const result = await updateModelAccountPool("model", "set", ["one"], {
			dryRun: true,
		});

		expect(result).toMatchObject({
			accountIds: ["one"],
			changed: true,
			dryRun: true,
		});
		await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not rewrite an unchanged pool", async () => {
		const original = `${JSON.stringify({
			modelAccountPools: { model: ["one"] },
		})}\n\n`;
		await fs.writeFile(configPath, original);

		const result = await updateModelAccountPool("model", "set", ["one"]);

		expect(result.changed).toBe(false);
		expect(await fs.readFile(configPath, "utf-8")).toBe(original);
	});

	it("refuses to overwrite malformed JSON", async () => {
		await fs.writeFile(configPath, "{ malformed");

		await expect(
			updateModelAccountPool("model", "set", ["one"]),
		).rejects.toThrow();
		expect(await fs.readFile(configPath, "utf-8")).toBe("{ malformed");
		const release = await lock(configPath, { realpath: false });
		await release();
	});

	it("refuses to overwrite an invalid existing pool", async () => {
		const original = JSON.stringify({ modelAccountPools: { model: [1] } });
		await fs.writeFile(configPath, original);

		await expect(
			updateModelAccountPool("model", "set", ["one"]),
		).rejects.toThrow("Existing modelAccountPools configuration is invalid");
		expect(await fs.readFile(configPath, "utf-8")).toBe(original);
	});
});
