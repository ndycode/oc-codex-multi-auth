# lib/tools/

Per-tool modules for the 23 `codex-*` tools registered by the plugin.

## Status

All current tools live here. `index.ts` builds a `ToolContext` and passes it
to `createToolRegistry(ctx)` from `./index.ts`, which wires every `codex-*`
tool into the OpenCode plugin surface.

## Layout

```
lib/tools/
  AGENTS.md
  index.ts                # ToolContext type + createToolRegistry(ctx) barrel
  codex-list.ts           # one file per tool
  codex-switch.ts
  codex-status.ts
  codex-limits.ts
  codex-reset.ts
  codex-metrics.ts
  codex-help.ts
  codex-setup.ts
  codex-doctor.ts
  codex-next.ts
  codex-label.ts
  codex-tag.ts
  codex-note.ts
  codex-dashboard.ts
  codex-health.ts
  codex-remove.ts
  codex-refresh.ts
  codex-export.ts
  codex-import.ts
  codex-diag.ts
  codex-diff.ts
  codex-keychain.ts
```

## Factory pattern

Every tool is exported as a factory function that takes a `ToolContext`
and returns a `ToolDefinition`:

```ts
// lib/tools/codex-refresh.ts
import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import type { ToolContext } from "./index.js";

export function createCodexRefreshTool(ctx: ToolContext): ToolDefinition {
  const { resolveUiRuntime, formatCommandAccountLabel } = ctx;
  return tool({
    description: "…",
    args: {},
    async execute() {
      const ui = resolveUiRuntime();
      // …
    },
  });
}
```

`ToolContext` (declared in `lib/tools/index.ts`) exposes:

- **Mutable plugin-closure refs** (`cachedAccountManagerRef`,
  `accountManagerPromiseRef`) wrapping `let` bindings in `index.ts` via
  getter/setter `.current` so factory writes propagate to the outer
  closure.
- **Read-only runtime handles** (`runtimeMetrics`, `beginnerSafeModeRef`).
- **Helper functions** captured from the plugin closure
  (`resolveUiRuntime`, `formatCommandAccountLabel`,
  `promptAccountIndexSelection`, `buildRoutingVisibilitySnapshot`, …).

Tool schema factories (`toolOutputFormatSchema`, `toolSensitiveJsonSchema`)
are **inlined** in each tool that needs them rather than threaded through
`ToolContext`, because their inferred Zod return type cannot be named
across the module boundary without leaking the plugin's bundled `zod`
copy (TS2742).

## Adding a new codex-* tool

1. Create `lib/tools/codex-<name>.ts` exporting `createCodex<Name>Tool(ctx)`.
2. Import the factory in `lib/tools/index.ts` and add a wiring entry to
   `createToolRegistry`.
3. If the tool needs a new plugin-closure helper, add a field to
   `ToolContext` and wire it up in the `ctx` builder inside
   `index.ts` (search for `const ctx: ToolContext = {`).
