import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { MODEL_MAP, getNormalizedModel, isKnownModel } from "../lib/request/helpers/model-map.js";
import { resolveUnsupportedCodexFallbackModel } from "../lib/request/fetch-helpers.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));

type ConfigModel = {
  variants?: Record<string, unknown>;
};

type OpenCodeConfig = {
  model?: string;
  provider?: {
    openai?: {
      models?: Record<string, ConfigModel>;
    };
  };
};

function readConfig(relativePath: string): OpenCodeConfig {
  return JSON.parse(
    readFileSync(path.resolve(testDir, "..", relativePath), "utf8"),
  ) as OpenCodeConfig;
}

function collectConfigModelIds(relativePath: string): string[] {
  const config = readConfig(relativePath);
  const modelIds = new Set<string>();
  const providerModels = config.provider?.openai?.models ?? {};

  if (config.model?.startsWith("openai/")) {
    modelIds.add(config.model.slice("openai/".length));
  }

  for (const [modelId, modelConfig] of Object.entries(providerModels)) {
    modelIds.add(modelId);
    for (const variant of Object.keys(modelConfig.variants ?? {})) {
      modelIds.add(`${modelId}-${variant}`);
    }
  }

  return Array.from(modelIds).sort();
}

describe("Model Map Module", () => {
  describe("MODEL_MAP", () => {
    it("contains canonical GPT-5 codex mappings", () => {
      expect(MODEL_MAP["gpt-5-codex"]).toBe("gpt-5-codex");
      expect(MODEL_MAP["gpt-5-codex-low"]).toBe("gpt-5-codex");
      expect(MODEL_MAP["gpt-5-codex-medium"]).toBe("gpt-5-codex");
      expect(MODEL_MAP["gpt-5-codex-high"]).toBe("gpt-5-codex");
    });

    it("contains GPT-5.1 codex-max models", () => {
      expect(MODEL_MAP["gpt-5.1-codex-max"]).toBe("gpt-5.1-codex-max");
      expect(MODEL_MAP["gpt-5.1-codex-max-low"]).toBe("gpt-5.1-codex-max");
      expect(MODEL_MAP["gpt-5.1-codex-max-medium"]).toBe("gpt-5.1-codex-max");
      expect(MODEL_MAP["gpt-5.1-codex-max-high"]).toBe("gpt-5.1-codex-max");
      expect(MODEL_MAP["gpt-5.1-codex-max-xhigh"]).toBe("gpt-5.1-codex-max");
    });

    it("contains GPT-5.2 models", () => {
      expect(MODEL_MAP["gpt-5.2"]).toBe("gpt-5.2");
      expect(MODEL_MAP["gpt-5.2-none"]).toBe("gpt-5.2");
      expect(MODEL_MAP["gpt-5.2-low"]).toBe("gpt-5.2");
      expect(MODEL_MAP["gpt-5.2-medium"]).toBe("gpt-5.2");
      expect(MODEL_MAP["gpt-5.2-high"]).toBe("gpt-5.2");
      expect(MODEL_MAP["gpt-5.2-xhigh"]).toBe("gpt-5.2");
    });

	    it("contains GPT-5.4 models", () => {
	      expect(MODEL_MAP["gpt-5.4"]).toBe("gpt-5.4");
	      expect(MODEL_MAP["gpt-5.4-none"]).toBe("gpt-5.4");
	      expect(MODEL_MAP["gpt-5.4-low"]).toBe("gpt-5.4");
	      expect(MODEL_MAP["gpt-5.4-medium"]).toBe("gpt-5.4");
	      expect(MODEL_MAP["gpt-5.4-high"]).toBe("gpt-5.4");
	      expect(MODEL_MAP["gpt-5.4-xhigh"]).toBe("gpt-5.4");
	      expect(MODEL_MAP["gpt-5.4-2026-03-05"]).toBe("gpt-5.4");
	      expect(MODEL_MAP["gpt-5.4-2026-03-05-high"]).toBe("gpt-5.4");
	    });

	    it("contains GPT-5.5 models including the fast variant", () => {
	      expect(MODEL_MAP["gpt-5.5"]).toBe("gpt-5.5");
	      expect(MODEL_MAP["gpt-5.5-high"]).toBe("gpt-5.5");
	      expect(MODEL_MAP["gpt-5.5-xhigh"]).toBe("gpt-5.5");
	      expect(MODEL_MAP["gpt-5.5-fast"]).toBe("gpt-5.5");
	      expect(MODEL_MAP["gpt-5.5-fast-none"]).toBe("gpt-5.5");
	      expect(MODEL_MAP["gpt-5.5-fast-low"]).toBe("gpt-5.5");
	      expect(MODEL_MAP["gpt-5.5-fast-medium"]).toBe("gpt-5.5");
	      expect(MODEL_MAP["gpt-5.5-fast-high"]).toBe("gpt-5.5");
	      expect(MODEL_MAP["gpt-5.5-fast-xhigh"]).toBe("gpt-5.5");
	    });

	    it("does not map GPT-5.5 Pro (ChatGPT-only per 2026-04-23 launch)", () => {
	      expect(MODEL_MAP["gpt-5.5-pro"]).toBeUndefined();
	      expect(MODEL_MAP["gpt-5.5-pro-high"]).toBeUndefined();
	      expect(MODEL_MAP["gpt-5.5-pro-xhigh"]).toBeUndefined();
	    });

    it("contains GPT-5.4 Pro models (medium/high/xhigh only)", () => {
      expect(MODEL_MAP["gpt-5.4-pro"]).toBe("gpt-5.4-pro");
      expect(MODEL_MAP["gpt-5.4-pro-medium"]).toBe("gpt-5.4-pro");
      expect(MODEL_MAP["gpt-5.4-pro-high"]).toBe("gpt-5.4-pro");
      expect(MODEL_MAP["gpt-5.4-pro-xhigh"]).toBe("gpt-5.4-pro");
      expect(MODEL_MAP["gpt-5.4-pro-2026-03-05"]).toBe("gpt-5.4-pro");
      expect(MODEL_MAP["gpt-5.4-pro-2026-03-05-xhigh"]).toBe("gpt-5.4-pro");
      // none and low are not supported for Pro
      expect(MODEL_MAP["gpt-5.4-pro-none"]).toBeUndefined();
      expect(MODEL_MAP["gpt-5.4-pro-low"]).toBeUndefined();
    });

    it("contains GPT-5.4 Mini models", () => {
      expect(MODEL_MAP["gpt-5.4-mini"]).toBe("gpt-5.4-mini");
      expect(MODEL_MAP["gpt-5.4-mini-none"]).toBe("gpt-5.4-mini");
      expect(MODEL_MAP["gpt-5.4-mini-low"]).toBe("gpt-5.4-mini");
      expect(MODEL_MAP["gpt-5.4-mini-medium"]).toBe("gpt-5.4-mini");
      expect(MODEL_MAP["gpt-5.4-mini-high"]).toBe("gpt-5.4-mini");
      expect(MODEL_MAP["gpt-5.4-mini-xhigh"]).toBe("gpt-5.4-mini");
      expect(MODEL_MAP["gpt-5.4-mini-2026-03-05"]).toBe("gpt-5.4-mini");
      expect(MODEL_MAP["gpt-5.4-mini-2026-03-05-high"]).toBe("gpt-5.4-mini");
    });

	    it("contains GPT-5.2 codex models (distinct backend model, not collapsed to gpt-5-codex)", () => {
	      expect(MODEL_MAP["gpt-5.2-codex"]).toBe("gpt-5.2-codex");
	      expect(MODEL_MAP["gpt-5.2-codex-low"]).toBe("gpt-5.2-codex");
	      expect(MODEL_MAP["gpt-5.2-codex-medium"]).toBe("gpt-5.2-codex");
	      expect(MODEL_MAP["gpt-5.2-codex-high"]).toBe("gpt-5.2-codex");
	      expect(MODEL_MAP["gpt-5.2-codex-xhigh"]).toBe("gpt-5.2-codex");
	      // "-none" is intentionally absent: this model rejects effort "none"
	      expect(MODEL_MAP["gpt-5.2-codex-none"]).toBeUndefined();
	    });

	    it("contains GPT-5.3 codex models (distinct backend model, not collapsed to gpt-5-codex)", () => {
	      expect(MODEL_MAP["gpt-5.3-codex"]).toBe("gpt-5.3-codex");
	      expect(MODEL_MAP["gpt-5.3-codex-low"]).toBe("gpt-5.3-codex");
	      expect(MODEL_MAP["gpt-5.3-codex-medium"]).toBe("gpt-5.3-codex");
	      expect(MODEL_MAP["gpt-5.3-codex-high"]).toBe("gpt-5.3-codex");
	      expect(MODEL_MAP["gpt-5.3-codex-xhigh"]).toBe("gpt-5.3-codex");
	      // "-none" is intentionally absent: this model rejects effort "none"
	      expect(MODEL_MAP["gpt-5.3-codex-none"]).toBeUndefined();
	    });

    it("contains GPT-5.3 codex spark models (distinct backend model, not collapsed to gpt-5-codex)", () => {
      expect(MODEL_MAP["gpt-5.3-codex-spark"]).toBe("gpt-5.3-codex-spark");
	      expect(MODEL_MAP["gpt-5.3-codex-spark-low"]).toBe("gpt-5.3-codex-spark");
	      expect(MODEL_MAP["gpt-5.3-codex-spark-medium"]).toBe("gpt-5.3-codex-spark");
	      expect(MODEL_MAP["gpt-5.3-codex-spark-high"]).toBe("gpt-5.3-codex-spark");
      expect(MODEL_MAP["gpt-5.3-codex-spark-xhigh"]).toBe("gpt-5.3-codex-spark");
      // "-none" is intentionally absent: this model rejects effort "none"
      expect(MODEL_MAP["gpt-5.3-codex-spark-none"]).toBeUndefined();
    });

    it("keeps Codex normalization aligned with canonical fallback chain", () => {
      // Each versioned codex family now resolves to its own canonical ID
      expect(getNormalizedModel("gpt-5.2-codex")).toBe("gpt-5.2-codex");
      expect(getNormalizedModel("gpt-5.3-codex")).toBe("gpt-5.3-codex");
      expect(getNormalizedModel("gpt-5.3-codex-spark")).toBe("gpt-5.3-codex-spark");

      // ── gpt-5.2-codex → gpt-5-codex → gpt-5.4 ──────────────────────────────
      const normalized52 = getNormalizedModel("gpt-5.2-codex")!;
      const fallback52 = resolveUnsupportedCodexFallbackModel({
        requestedModel: normalized52,
        errorBody: {
          error: {
            code: "model_not_supported_with_chatgpt_account",
            message: "The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.",
          },
        },
        attemptedModels: [normalized52],
        fallbackOnUnsupportedCodexModel: true,
        fallbackToGpt52OnUnsupportedGpt53: true,
      });
      expect(fallback52).toBe("gpt-5-codex");

      const fallback52step2 = resolveUnsupportedCodexFallbackModel({
        requestedModel: fallback52,
        errorBody: {
          error: {
            code: "model_not_supported_with_chatgpt_account",
            message: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
          },
        },
        attemptedModels: [normalized52, fallback52!],
        fallbackOnUnsupportedCodexModel: true,
        fallbackToGpt52OnUnsupportedGpt53: true,
      });
      expect(fallback52step2).toBe("gpt-5.4");

      // ── gpt-5.3-codex → gpt-5-codex ─────────────────────────────────────────
      const normalized53 = getNormalizedModel("gpt-5.3-codex")!;
      const fallback53 = resolveUnsupportedCodexFallbackModel({
        requestedModel: normalized53,
        errorBody: {
          error: {
            code: "model_not_supported_with_chatgpt_account",
            message: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
          },
        },
        attemptedModels: [normalized53],
        fallbackOnUnsupportedCodexModel: true,
        fallbackToGpt52OnUnsupportedGpt53: true,
      });
      expect(fallback53).toBe("gpt-5-codex");

      // ── gpt-5.3-codex-spark → gpt-5-codex → gpt-5.3-codex → gpt-5.2-codex ──
      const normalizedSpark = getNormalizedModel("gpt-5.3-codex-spark")!;
      const fallbackSpark1 = resolveUnsupportedCodexFallbackModel({
        requestedModel: normalizedSpark,
        errorBody: {
          error: {
            code: "model_not_supported_with_chatgpt_account",
            message: "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
          },
        },
        attemptedModels: [normalizedSpark],
        fallbackOnUnsupportedCodexModel: true,
        fallbackToGpt52OnUnsupportedGpt53: true,
      });
      expect(fallbackSpark1).toBe("gpt-5-codex");

      const fallbackSpark2 = resolveUnsupportedCodexFallbackModel({
        requestedModel: normalizedSpark,
        errorBody: {
          error: {
            code: "model_not_supported_with_chatgpt_account",
            message: "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
          },
        },
        attemptedModels: [normalizedSpark, fallbackSpark1!],
        fallbackOnUnsupportedCodexModel: true,
        fallbackToGpt52OnUnsupportedGpt53: true,
      });
      expect(fallbackSpark2).toBe("gpt-5.3-codex");

      const fallbackSpark3 = resolveUnsupportedCodexFallbackModel({
        requestedModel: normalizedSpark,
        errorBody: {
          error: {
            code: "model_not_supported_with_chatgpt_account",
            message: "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
          },
        },
        attemptedModels: [normalizedSpark, fallbackSpark1!, fallbackSpark2!],
        fallbackOnUnsupportedCodexModel: true,
        fallbackToGpt52OnUnsupportedGpt53: true,
      });
      expect(fallbackSpark3).toBe("gpt-5.2-codex");
    });

    it("contains GPT-5.1 codex-mini models", () => {
      expect(MODEL_MAP["gpt-5.1-codex-mini"]).toBe("gpt-5.1-codex-mini");
      expect(MODEL_MAP["gpt-5.1-codex-mini-medium"]).toBe("gpt-5.1-codex-mini");
      expect(MODEL_MAP["gpt-5.1-codex-mini-high"]).toBe("gpt-5.1-codex-mini");
    });

    it("contains GPT-5.1 general purpose models", () => {
      expect(MODEL_MAP["gpt-5.1"]).toBe("gpt-5.1");
      expect(MODEL_MAP["gpt-5.1-none"]).toBe("gpt-5.1");
      expect(MODEL_MAP["gpt-5.1-low"]).toBe("gpt-5.1");
      expect(MODEL_MAP["gpt-5.1-medium"]).toBe("gpt-5.1");
      expect(MODEL_MAP["gpt-5.1-high"]).toBe("gpt-5.1");
      expect(MODEL_MAP["gpt-5.1-chat-latest"]).toBe("gpt-5.1");
    });

    it("keeps canonical GPT-5 codex mapping stable", () => {
      expect(MODEL_MAP["gpt-5-codex"]).toBe("gpt-5-codex");
    });

    it("maps legacy codex-mini models to GPT-5.1 codex-mini", () => {
      expect(MODEL_MAP["codex-mini-latest"]).toBe("gpt-5.1-codex-mini");
      expect(MODEL_MAP["gpt-5-codex-mini"]).toBe("gpt-5.1-codex-mini");
      expect(MODEL_MAP["gpt-5-codex-mini-medium"]).toBe("gpt-5.1-codex-mini");
      expect(MODEL_MAP["gpt-5-codex-mini-high"]).toBe("gpt-5.1-codex-mini");
    });

    it("maps legacy GPT-5 aliases to proper canonical models", () => {
      expect(MODEL_MAP["gpt-5"]).toBe("gpt-5.5");
      expect(MODEL_MAP["gpt-5-high"]).toBe("gpt-5.5");
      expect(MODEL_MAP["gpt-5-mini"]).toBe("gpt-5.4-mini");
      expect(MODEL_MAP["gpt-5-nano"]).toBe("gpt-5.4-nano");
    });

    it("should map GPT-5.4 Nano model entries", () => {
      expect(MODEL_MAP["gpt-5.4-nano"]).toBe("gpt-5.4-nano");
      expect(MODEL_MAP["gpt-5.4-nano-none"]).toBe("gpt-5.4-nano");
      expect(MODEL_MAP["gpt-5.4-nano-low"]).toBe("gpt-5.4-nano");
      expect(MODEL_MAP["gpt-5.4-nano-medium"]).toBe("gpt-5.4-nano");
      expect(MODEL_MAP["gpt-5.4-nano-high"]).toBe("gpt-5.4-nano");
      expect(MODEL_MAP["gpt-5.4-nano-xhigh"]).toBe("gpt-5.4-nano");
    });
  });

  describe("getNormalizedModel", () => {
    it("returns normalized model for exact match", () => {
      expect(getNormalizedModel("gpt-5.1-codex")).toBe("gpt-5-codex");
      expect(getNormalizedModel("gpt-5.1-codex-low")).toBe("gpt-5-codex");
      expect(getNormalizedModel("gpt-5.2-codex-high")).toBe("gpt-5.2-codex");
      expect(getNormalizedModel("gpt-5.3-codex-high")).toBe("gpt-5.3-codex");
      expect(getNormalizedModel("gpt-5.3-codex-spark-high")).toBe("gpt-5.3-codex-spark");
      expect(getNormalizedModel("gpt-5.4-high")).toBe("gpt-5.4");
      expect(getNormalizedModel("gpt-5.4-fast")).toBe("gpt-5.4");
      expect(getNormalizedModel("gpt-5.4-mini-fast")).toBe("gpt-5.4-mini");
      expect(getNormalizedModel("gpt-5.4-pro-none")).toBeUndefined();
      expect(getNormalizedModel("gpt-5.4-pro-high")).toBe("gpt-5.4-pro");
      expect(getNormalizedModel("gpt-5.4-2026-03-05-medium")).toBe("gpt-5.4");
      expect(getNormalizedModel("gpt-5.4-pro-2026-03-05-medium")).toBe("gpt-5.4-pro");
      expect(getNormalizedModel("gpt-5.4-mini")).toBe("gpt-5.4-mini");
      expect(getNormalizedModel("gpt-5.4-mini-high")).toBe("gpt-5.4-mini");
      expect(getNormalizedModel("gpt-5.4-mini-2026-03-05-medium")).toBe("gpt-5.4-mini");
    });

    it("handles case-insensitive lookup", () => {
      expect(getNormalizedModel("GPT-5.1-CODEX")).toBe("gpt-5-codex");
      expect(getNormalizedModel("Gpt-5.2-Codex-High")).toBe("gpt-5.2-codex");
      expect(getNormalizedModel("Gpt-5.3-Codex-High")).toBe("gpt-5.3-codex");
      expect(getNormalizedModel("Gpt-5.3-Codex-Spark-High")).toBe("gpt-5.3-codex-spark");
      expect(getNormalizedModel("Gpt-5.4-High")).toBe("gpt-5.4");
      expect(getNormalizedModel("Gpt-5.4-Pro-High")).toBe("gpt-5.4-pro");
      expect(getNormalizedModel("Gpt-5.4-Mini-High")).toBe("gpt-5.4-mini");
      expect(getNormalizedModel("GPT-5.4-MINI")).toBe("gpt-5.4-mini");
    });

    it("returns undefined for unknown models", () => {
      expect(getNormalizedModel("unknown-model")).toBeUndefined();
      expect(getNormalizedModel("gpt-6")).toBeUndefined();
      expect(getNormalizedModel("")).toBeUndefined();
    });

    it("handles legacy model mapping", () => {
      expect(getNormalizedModel("gpt-5-codex")).toBe("gpt-5-codex");
      expect(getNormalizedModel("gpt-5")).toBe("gpt-5.5");
      expect(getNormalizedModel("codex-mini-latest")).toBe("gpt-5.1-codex-mini");
    });

    it("strips reasoning effort suffix and normalizes", () => {
      expect(getNormalizedModel("gpt-5.1-codex-max-xhigh")).toBe("gpt-5.1-codex-max");
      expect(getNormalizedModel("gpt-5.2-medium")).toBe("gpt-5.2");
    });
  });

  describe("isKnownModel", () => {
    it("returns true for known models", () => {
      expect(isKnownModel("gpt-5.1-codex")).toBe(true);
      expect(isKnownModel("gpt-5.2")).toBe(true);
      expect(isKnownModel("gpt-5.3-codex")).toBe(true);
      expect(isKnownModel("gpt-5.3-codex-spark")).toBe(true);
      expect(isKnownModel("gpt-5.4")).toBe(true);
      expect(isKnownModel("gpt-5.4-pro-none")).toBe(false);
      expect(isKnownModel("gpt-5.4-pro")).toBe(true);
      expect(isKnownModel("gpt-5.4-mini")).toBe(true);
      expect(isKnownModel("gpt-5.4-mini-high")).toBe(true);
      expect(isKnownModel("gpt-5.1-codex-max")).toBe(true);
      expect(isKnownModel("gpt-5-codex")).toBe(true);
    });

    it("returns true for case-insensitive matches", () => {
      expect(isKnownModel("GPT-5.1-CODEX")).toBe(true);
      expect(isKnownModel("GPT-5.2-CODEX-HIGH")).toBe(true);
      expect(isKnownModel("GPT-5.3-CODEX-HIGH")).toBe(true);
      expect(isKnownModel("GPT-5.3-CODEX-SPARK-HIGH")).toBe(true);
      expect(isKnownModel("GPT-5.4-HIGH")).toBe(true);
      expect(isKnownModel("GPT-5.4-PRO-HIGH")).toBe(true);
      expect(isKnownModel("GPT-5.4-MINI-HIGH")).toBe(true);
      expect(isKnownModel("gpt-5.4-mini")).toBe(true);
    });
    it("returns false for unknown models", () => {
      expect(isKnownModel("gpt-6")).toBe(false);
      expect(isKnownModel("claude-3")).toBe(false);
      expect(isKnownModel("unknown")).toBe(false);
      expect(isKnownModel("")).toBe(false);
    });
  });

  describe("Model count and completeness", () => {
    it("covers every model id shipped in the OpenCode config examples", () => {
      const configModelIds = [
        ...collectConfigModelIds("config/minimal-opencode.json"),
        ...collectConfigModelIds("config/opencode-modern.json"),
        ...collectConfigModelIds("config/opencode-legacy.json"),
      ];

      expect(configModelIds.length).toBeGreaterThan(0);
      for (const modelId of configModelIds) {
        expect(isKnownModel(modelId), modelId).toBe(true);
        expect(getNormalizedModel(modelId), modelId).toBeDefined();
      }
    });

    it("has expected number of model mappings", () => {
      const modelCount = Object.keys(MODEL_MAP).length;
      expect(modelCount).toBeGreaterThanOrEqual(30);
    });

    it("all values are valid normalized model names", () => {
      const validNormalizedModels = new Set([
        "gpt-5-codex",
        "gpt-5.1-codex-max",
        "gpt-5.1-codex-mini",
        "gpt-5.1",
        "gpt-5.2",
        "gpt-5.2-codex",
        "gpt-5.3-codex",
        "gpt-5.3-codex-spark",
        "gpt-5.5",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.4",
        "gpt-5.4-pro",
        "gpt-5.4-mini",
        "gpt-5.4-nano",
      ]);

      for (const [key, value] of Object.entries(MODEL_MAP)) {
        expect(validNormalizedModels.has(value)).toBe(true);
      }
    });

    it("no duplicate keys exist", () => {
      const keys = Object.keys(MODEL_MAP);
      const uniqueKeys = new Set(keys);
      expect(keys.length).toBe(uniqueKeys.size);
    });
  });
});
