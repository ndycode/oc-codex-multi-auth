import { describe, it, expect, vi } from "vitest";
import { warmAccounts, type WarmOutcome } from "../lib/accounts/warm.js";

interface FakeAccount {
  email: string;
  enabled?: boolean;
}

const acct = (email: string, enabled?: boolean): FakeAccount => ({ email, enabled });

describe("warmAccounts (#182 orchestrator)", () => {
  it("warms every enabled account and summarizes", async () => {
    const accounts = [acct("a@x.com"), acct("b@x.com"), acct("c@x.com")];
    const warmOne = vi.fn(async (): Promise<WarmOutcome> => ({ status: "warmed" }));

    const summary = await warmAccounts(accounts, warmOne);

    expect(warmOne).toHaveBeenCalledTimes(3);
    expect(summary.warmedCount).toBe(3);
    expect(summary.failedCount).toBe(0);
    expect(summary.skippedCount).toBe(0);
    expect(summary.total).toBe(3);
    expect(summary.results.map((r) => r.status)).toEqual(["warmed", "warmed", "warmed"]);
  });

  it("skips disabled accounts WITHOUT calling warmOne for them", async () => {
    const accounts = [acct("a@x.com"), acct("b@x.com", false), acct("c@x.com")];
    const seen: string[] = [];
    const warmOne = vi.fn(async (a: FakeAccount): Promise<WarmOutcome> => {
      seen.push(a.email);
      return { status: "warmed" };
    });

    const summary = await warmAccounts(accounts, warmOne);

    expect(seen).toEqual(["a@x.com", "c@x.com"]); // b skipped
    expect(summary.warmedCount).toBe(2);
    expect(summary.skippedCount).toBe(1);
    const skipped = summary.results.find((r) => r.account.email === "b@x.com");
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.detail).toBe("disabled");
  });

  it("records a returned failure outcome", async () => {
    const accounts = [acct("a@x.com"), acct("b@x.com")];
    const warmOne = async (a: FakeAccount): Promise<WarmOutcome> =>
      a.email === "b@x.com"
        ? { status: "failed", detail: "401 unauthorized" }
        : { status: "warmed" };

    const summary = await warmAccounts(accounts, warmOne);

    expect(summary.warmedCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    const failed = summary.results.find((r) => r.account.email === "b@x.com");
    expect(failed?.detail).toBe("401 unauthorized");
  });

  it("captures a THROWN error as a failed outcome (one bad account never aborts the batch)", async () => {
    const accounts = [acct("a@x.com"), acct("b@x.com"), acct("c@x.com")];
    const warmOne = async (a: FakeAccount): Promise<WarmOutcome> => {
      if (a.email === "b@x.com") throw new Error("network exploded");
      return { status: "warmed" };
    };

    const summary = await warmAccounts(accounts, warmOne);

    expect(summary.warmedCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    const failed = summary.results.find((r) => r.account.email === "b@x.com");
    expect(failed?.status).toBe("failed");
    expect(failed?.detail).toBe("network exploded");
  });

  it("preserves input order in results regardless of concurrent resolution", async () => {
    const accounts = [acct("a@x.com"), acct("b@x.com"), acct("c@x.com"), acct("d@x.com")];
    // Resolve in reverse-ish order via varied delays.
    const delays: Record<string, number> = {
      "a@x.com": 30,
      "b@x.com": 5,
      "c@x.com": 20,
      "d@x.com": 1,
    };
    const warmOne = async (a: FakeAccount): Promise<WarmOutcome> => {
      await new Promise((resolve) => setTimeout(resolve, delays[a.email]));
      return { status: "warmed" };
    };

    const summary = await warmAccounts(accounts, warmOne);
    expect(summary.results.map((r) => r.account.email)).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
    ]);
    expect(summary.results.map((r) => r.index)).toEqual([0, 1, 2, 3]);
  });

  it("runs sequentially when concurrent=false (strict ordering of invocation)", async () => {
    const accounts = [acct("a@x.com"), acct("b@x.com"), acct("c@x.com")];
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const warmOne = async (a: FakeAccount): Promise<WarmOutcome> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(a.email);
      inFlight--;
      return { status: "warmed" };
    };

    await warmAccounts(accounts, warmOne, { concurrent: false });
    expect(order).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    expect(maxInFlight).toBe(1); // never overlapped
  });

  it("allows concurrency when concurrent=true (default)", async () => {
    const accounts = [acct("a@x.com"), acct("b@x.com"), acct("c@x.com")];
    let inFlight = 0;
    let maxInFlight = 0;
    const warmOne = async (): Promise<WarmOutcome> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { status: "warmed" };
    };

    await warmAccounts(accounts, warmOne);
    expect(maxInFlight).toBeGreaterThan(1); // overlapped
  });

  it("handles an empty account list", async () => {
    const summary = await warmAccounts([], async () => ({ status: "warmed" }));
    expect(summary.total).toBe(0);
    expect(summary.warmedCount).toBe(0);
    expect(summary.results).toEqual([]);
  });

  it("handles an all-disabled list with zero warmOne calls", async () => {
    const accounts = [acct("a@x.com", false), acct("b@x.com", false)];
    const warmOne = vi.fn(async (): Promise<WarmOutcome> => ({ status: "warmed" }));
    const summary = await warmAccounts(accounts, warmOne);
    expect(warmOne).not.toHaveBeenCalled();
    expect(summary.skippedCount).toBe(2);
    expect(summary.warmedCount).toBe(0);
  });
});
