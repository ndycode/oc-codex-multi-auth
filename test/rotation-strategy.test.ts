import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { resetTrackers } from "../lib/rotation.js";
import { getRotationStrategy } from "../lib/config.js";
import type { PluginConfig } from "../lib/types.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import type { ModelFamily } from "../lib/prompts/codex.js";

vi.mock("../lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage.js")>();
  return {
    ...actual,
    saveAccounts: vi.fn().mockResolvedValue(undefined),
  };
});

const FAMILY: ModelFamily = "codex";

function makeStorage(count: number): AccountStorageV3 {
  const now = Date.now();
  return {
    version: 3,
    accounts: Array.from({ length: count }, (_v, idx) => ({
      email: `account${idx + 1}@example.com`,
      refreshToken: `fake_refresh_token_${idx + 1}_for_testing_only`,
      addedAt: now - (count - idx) * 1000,
      // Stagger lastUsed so account 0 is the LEAST recently used (oldest).
      lastUsed: now - (count - idx) * 500,
    })),
    activeIndex: 0,
    activeIndexByFamily: { codex: 0 },
  };
}

describe("getRotationStrategy (#183 config)", () => {
  const baseConfig = (overrides: Partial<PluginConfig> = {}): PluginConfig =>
    ({ ...overrides }) as PluginConfig;

  afterEach(() => {
    delete process.env.CODEX_AUTH_ROTATION_STRATEGY;
  });

  it("defaults to hybrid when unset", () => {
    expect(getRotationStrategy(baseConfig())).toBe("hybrid");
  });

  it("reads sticky / round-robin from config", () => {
    expect(getRotationStrategy(baseConfig({ rotationStrategy: "sticky" }))).toBe("sticky");
    expect(getRotationStrategy(baseConfig({ rotationStrategy: "round-robin" }))).toBe(
      "round-robin",
    );
    expect(getRotationStrategy(baseConfig({ rotationStrategy: "hybrid" }))).toBe("hybrid");
  });

  it("env var overrides config", () => {
    process.env.CODEX_AUTH_ROTATION_STRATEGY = "sticky";
    expect(getRotationStrategy(baseConfig({ rotationStrategy: "round-robin" }))).toBe(
      "sticky",
    );
  });

  it("bogus env value falls back to config / default", () => {
    process.env.CODEX_AUTH_ROTATION_STRATEGY = "turbo";
    expect(getRotationStrategy(baseConfig({ rotationStrategy: "round-robin" }))).toBe(
      "round-robin",
    );
    expect(getRotationStrategy(baseConfig())).toBe("hybrid");
  });

  it("env var is case-insensitive / trimmed", () => {
    process.env.CODEX_AUTH_ROTATION_STRATEGY = "  Round-Robin  ";
    expect(getRotationStrategy(baseConfig())).toBe("round-robin");
  });
});

describe("sticky selection (#183, drain-first)", () => {
  let manager: AccountManager;

  beforeEach(() => {
    resetTrackers();
    manager = new AccountManager(undefined, makeStorage(3));
  });

  it("stays on the current account across repeated calls while healthy", () => {
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      const account = manager.getCurrentOrNextForFamilySticky(FAMILY);
      expect(account).not.toBeNull();
      if (account) seen.push(account.index);
    }
    // Drain-first: never leaves account 0 while it is healthy.
    expect(seen).toEqual([0, 0, 0, 0, 0]);
  });

  it("moves to the lowest-indexed available account when current is rate-limited", () => {
    // Pin + exhaust account 0.
    const first = manager.getCurrentOrNextForFamilySticky(FAMILY);
    expect(first?.index).toBe(0);
    manager.markRateLimited(first!, 60_000, FAMILY);

    const next = manager.getCurrentOrNextForFamilySticky(FAMILY);
    // Concentrate: pick account 1 (lowest available), not the freshest.
    expect(next?.index).toBe(1);

    // And it sticks to 1 now.
    expect(manager.getCurrentOrNextForFamilySticky(FAMILY)?.index).toBe(1);
  });

  it("skips disabled accounts", () => {
    manager.setAccountEnabled(0, false);
    const account = manager.getCurrentOrNextForFamilySticky(FAMILY);
    expect(account?.index).toBe(1);
  });

  it("returns null when every account is unavailable", () => {
    // Mark each LIVE account rate-limited. getAccountsSnapshot() returns deep
    // copies, so we drive the rate limit through the account the selector
    // actually returns (which is the live object) to mutate real state.
    for (let i = 0; i < 3; i++) {
      const account = manager.getCurrentOrNextForFamilySticky(FAMILY);
      expect(account).not.toBeNull();
      manager.markRateLimited(account!, 60_000, FAMILY);
    }
    expect(manager.getCurrentOrNextForFamilySticky(FAMILY)).toBeNull();
  });

  it("recovers the current account once its rate limit expires", () => {
    const first = manager.getCurrentOrNextForFamilySticky(FAMILY);
    manager.markRateLimited(first!, 1, FAMILY); // expires ~immediately
    // Move off 0.
    const moved = manager.getCurrentOrNextForFamilySticky(FAMILY);
    expect(moved?.index).toBe(1);
  });
});

describe("strategy dispatcher (#183)", () => {
  let manager: AccountManager;

  beforeEach(() => {
    resetTrackers();
    manager = new AccountManager(undefined, makeStorage(3));
  });

  it("round-robin advances through accounts in order", () => {
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const account = manager.getAccountForStrategy("round-robin", FAMILY);
      if (account) seen.push(account.index);
    }
    expect(seen).toEqual([0, 1, 2, 0]);
  });

  it("sticky concentrates on one account", () => {
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const account = manager.getAccountForStrategy("sticky", FAMILY);
      if (account) seen.push(account.index);
    }
    expect(seen).toEqual([0, 0, 0, 0]);
  });

  it("hybrid dispatches identically to getCurrentOrNextForFamilyHybrid", () => {
    const viaDispatcher = manager.getAccountForStrategy("hybrid", FAMILY);
    expect(viaDispatcher).not.toBeNull();
    // With one healthy current account, hybrid stays put too.
    expect(manager.getAccountForStrategy("hybrid", FAMILY)?.index).toBe(
      viaDispatcher?.index,
    );
  });
});
