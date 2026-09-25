import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";

export const CodexStatusRpc = Rpc.define({
	id: "oc-codex-multi-auth",
	methods: {
		status: {
			input: z.object({ width: z.number().int().min(1).max(1000) }),
			output: z.object({
				text: z.string(), details: z.string(), showFor: z.enum(["always", "codex-models"]),
				accountStorage: z.enum(["project", "global"]),
				accounts: z.array(z.object({ index: z.number().int(), label: z.string(), active: z.boolean(), enabled: z.boolean() })),
			}),
		},
	},
	events: {},
});
