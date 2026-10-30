import { describe, expect, it } from "vitest";

import { measureStatusSlot, showsQuotaForSession, withStatusPrefix } from "../tui.js";
import { formatPromptStatusText, type CompactQuotaStatus } from "../lib/tui-status.js";

/**
 * A stand-in for the host's laid-out prompt row.
 *
 * `measureStatusSlot` duck-types the renderer's tree rather than importing it,
 * so the fake only has to carry the three things it reads. Building it here is
 * also the only way to pin the assumption: if the host ever stops putting this
 * slot in a two-child row, this is the test that says so.
 */
type FakeNode = {
	width?: number;
	height?: number;
	primaryAxis?: string;
	parent?: FakeNode | null;
	getChildren?: () => FakeNode[];
};

function promptRow(options: {
	labelWidth: number;
	labelHeight: number;
	rowWidth: number;
	/** The extra box the slot machinery inserts between node and row. */
	wrapped?: boolean;
}): FakeNode {
	const label: FakeNode = {
		width: options.labelWidth,
		height: options.labelHeight,
		primaryAxis: "row",
		getChildren: () => [],
	};
	const status: FakeNode = { width: 10, height: 1, getChildren: () => [] };
	const wrapper: FakeNode = {
		width: 10,
		height: 1,
		primaryAxis: "row",
		getChildren: () => [status],
	};
	const row: FakeNode = {
		width: options.rowWidth,
		height: Math.max(options.labelHeight, 1),
		primaryAxis: "row",
		getChildren: () => [label, wrapper],
	};
	label.parent = row;
	wrapper.parent = row;
	status.parent = wrapper;
	if (options.wrapped === false) {
		// Straight into the row, with no wrapper of its own.
		status.parent = row;
		row.getChildren = () => [label, status];
	}
	return status;
}

describe("measureStatusSlot", () => {
	it("budgets against the prompt row rather than the terminal", () => {
		// A 114-wide row inside a 165-column terminal, less the 40 the model
		// label beside this line owns.
		expect(
			measureStatusSlot(
				promptRow({ labelWidth: 40, labelHeight: 2, rowWidth: 114 }),
			),
		).toEqual({ availableChars: 74 });
	});

	it("finds the row through the box the slot machinery inserts", () => {
		expect(
			measureStatusSlot(
				promptRow({
					labelWidth: 40,
					labelHeight: 1,
					rowWidth: 114,
					wrapped: false,
				}),
			),
		).toEqual({ availableChars: 74 });
	});

	it("does not let the label's own width into the budget", () => {
		// The same row with a label squeezed to nothing must still report the
		// same budget. A label with no room left is shrunk to whatever this line
		// did not take, so reading its width would make the budget a function of
		// this line's own length and ratchet it down on every render.
		expect(
			measureStatusSlot(
				promptRow({ labelWidth: 4, labelHeight: 1, rowWidth: 114 }),
			),
		).toEqual({ availableChars: 74 });
	});

	it("reports nothing before the first layout pass", () => {
		expect(
			measureStatusSlot(promptRow({ labelWidth: 0, labelHeight: 0, rowWidth: 0 })),
		).toEqual({});
	});

	it("reports nothing when the row is too narrow to share", () => {
		expect(
			measureStatusSlot(
				promptRow({ labelWidth: 20, labelHeight: 1, rowWidth: 30 }),
			),
		).toEqual({});
	});

	it("reports nothing rather than guessing at an unfamiliar tree", () => {
		expect(measureStatusSlot(undefined)).toEqual({});
		expect(measureStatusSlot({})).toEqual({});
		expect(measureStatusSlot({ parent: { width: 80, primaryAxis: "row" } })).toEqual(
			{},
		);
	});

	it("stops walking rather than following a cycle forever", () => {
		const looped: FakeNode = { width: 4, getChildren: () => [] };
		looped.parent = looped;
		expect(measureStatusSlot(looped)).toEqual({});
	});
});

describe("showsQuotaForSession", () => {
	it("always shows the line by default", () => {
		expect(
			showsQuotaForSession({ audience: "always", providerID: "anthropic" }),
		).toBe(true);
	});

	it("hides the line for a model this plugin does not route", () => {
		expect(
			showsQuotaForSession({ audience: "codex-models", providerID: "anthropic" }),
		).toBe(false);
		expect(
			showsQuotaForSession({ audience: "codex-models", providerID: "openai" }),
		).toBe(true);
	});

	it("shows the line when the session has not said what it runs yet", () => {
		expect(
			showsQuotaForSession({ audience: "codex-models", providerID: undefined }),
		).toBe(true);
	});
});

describe("withStatusPrefix", () => {
	it("names the provider on the first row and lines up the rest under it", () => {
		expect(withStatusPrefix(["[a@b] 7d 24%", "5h 90%"], "OpenAI ")).toEqual([
			"OpenAI [a@b] 7d 24%",
			"       5h 90%",
		]);
	});

	it("leaves the line unchanged without a prefix", () => {
		expect(withStatusPrefix(["[a@b] 7d 24%"], "")).toEqual(["[a@b] 7d 24%"]);
	});
});
