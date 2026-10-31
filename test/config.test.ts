import { describe, it, expect } from 'vitest';
import {
	applyFastSessionDefaults,
	clampReasoningForModel,
	getModelConfig,
	getReasoningConfig,
} from '../lib/request/request-transformer.js';
import type { UserConfig } from '../lib/types.js';
import { getParallelProbingMaxConcurrency } from '../lib/config.js';

describe('Configuration Parsing', () => {
	const providerConfig = {
		options: {
			reasoningEffort: 'medium' as const,
			reasoningSummary: 'auto' as const,
			textVerbosity: 'medium' as const,
		},
		models: {
			'gpt-5-codex': {
				options: {
					reasoningSummary: 'concise' as const,
				},
			},
			'gpt-5': {
				options: {
					reasoningEffort: 'high' as const,
				},
			},
		},
	};

	const userConfig: UserConfig = {
		global: providerConfig.options || {},
		models: providerConfig.models || {},
	};

	describe('getModelConfig', () => {
		it('should merge global and model-specific config for gpt-5-codex', () => {
			const codexConfig = getModelConfig('gpt-5-codex', userConfig);

			expect(codexConfig.reasoningEffort).toBe('medium'); // from global
			expect(codexConfig.reasoningSummary).toBe('concise'); // from model override
			expect(codexConfig.textVerbosity).toBe('medium'); // from global
		});

		it('should merge global and model-specific config for gpt-5', () => {
			const gpt5Config = getModelConfig('gpt-5', userConfig);

			expect(gpt5Config.reasoningEffort).toBe('high'); // from model override
			expect(gpt5Config.reasoningSummary).toBe('auto'); // from global
			expect(gpt5Config.textVerbosity).toBe('medium'); // from global
		});

		it('should return empty config when no config provided', () => {
			const emptyConfig = getModelConfig('gpt-5-codex', { global: {}, models: {} });

			expect(emptyConfig).toEqual({});
		});
	});

	describe('applyFastSessionDefaults', () => {
		it('should set low reasoning effort and verbosity when unset', () => {
			const fast = applyFastSessionDefaults({ global: {}, models: {} });
			expect(fast.global.reasoningEffort).toBe('low');
			expect(fast.global.textVerbosity).toBe('low');
		});

		it('should not override explicit global settings', () => {
			const fast = applyFastSessionDefaults({
				global: { reasoningEffort: 'high', textVerbosity: 'high' },
				models: {},
			});
			expect(fast.global.reasoningEffort).toBe('high');
			expect(fast.global.textVerbosity).toBe('high');
		});
	});

		describe('getReasoningConfig', () => {
			it('should use user settings from merged config for gpt-5-codex', () => {
				const codexConfig = getModelConfig('gpt-5-codex', userConfig);
				const reasoningConfig = getReasoningConfig('gpt-5-codex', codexConfig);

			expect(reasoningConfig.effort).toBe('medium');
			expect(reasoningConfig.summary).toBe('concise');
		});

		it('should return defaults when no config provided', () => {
			const emptyConfig = getModelConfig('gpt-5-codex', { global: {}, models: {} });
			const defaultReasoning = getReasoningConfig('gpt-5-codex', emptyConfig);

			expect(defaultReasoning.effort).toBe('high');
			expect(defaultReasoning.summary).toBe('auto');
		});

		it('should use high effort for first-class nano/mini models (resolved via alias)', () => {
			const nanoReasoning = getReasoningConfig('gpt-5-nano', {});

			expect(nanoReasoning.effort).toBe('high');
			expect(nanoReasoning.summary).toBe('auto');
		});

		it('should normalize "minimal" to "low" for gpt-5-codex', () => {
			const codexMinimalConfig = { reasoningEffort: 'minimal' as const };
			const codexMinimalReasoning = getReasoningConfig('gpt-5-codex', codexMinimalConfig);

			expect(codexMinimalReasoning.effort).toBe('low');
			expect(codexMinimalReasoning.summary).toBe('auto');
		});

		it('should preserve "minimal" effort for non-codex models', () => {
			const gpt5MinimalConfig = { reasoningEffort: 'minimal' as const };
			const gpt5MinimalReasoning = getReasoningConfig('gpt-5.5', gpt5MinimalConfig);

			expect(gpt5MinimalReasoning.effort).toBe('minimal');
		});

		it('should handle high effort setting', () => {
			const highConfig = { reasoningEffort: 'high' as const };
			const highReasoning = getReasoningConfig('gpt-5', highConfig);

			expect(highReasoning.effort).toBe('high');
			expect(highReasoning.summary).toBe('auto');
		});

			it('should respect custom summary setting', () => {
				const detailedConfig = { reasoningSummary: 'detailed' as const };
				const detailedReasoning = getReasoningConfig('gpt-5-codex', detailedConfig);

				expect(detailedReasoning.summary).toBe('detailed');
			});

			it('should default codex-mini to medium effort', () => {
				const codexMiniReasoning = getReasoningConfig('gpt-5-codex-mini', {});
				expect(codexMiniReasoning.effort).toBe('medium');
			});

			it('should clamp codex-mini minimal/low to medium', () => {
				const minimal = getReasoningConfig('gpt-5-codex-mini', {
					reasoningEffort: 'minimal',
				});
				const low = getReasoningConfig('gpt-5-codex-mini-high', {
					reasoningEffort: 'low',
				});

				expect(minimal.effort).toBe('medium');
				expect(low.effort).toBe('medium');
			});

		it('should keep codex-mini high effort when requested', () => {
			const high = getReasoningConfig('codex-mini-latest', {
				reasoningEffort: 'high',
			});
			expect(high.effort).toBe('high');
		});

		it('should clamp codex-mini xhigh to high', () => {
			const xhigh = getReasoningConfig('gpt-5-codex-mini', {
				reasoningEffort: 'xhigh',
			});
			expect(xhigh.effort).toBe('high');
		});

		it('should clamp codex-mini unknown effort to medium (line 263 coverage)', () => {
			const unknown = getReasoningConfig('gpt-5-codex-mini', {
				reasoningEffort: 'invalid-effort' as never,
			});
			expect(unknown.effort).toBe('medium');
		});

		// `reasoningEffort` is read straight off opencode.json, so its TypeScript
		// union does not constrain it at runtime. Every clamp compares against
		// lowercase literals, so a capitalized value matched none of them and
		// went to the wire unclamped.
		describe('effort case-folding', () => {
			it('case-folds before clamping, so no capitalized effort escapes', () => {
				// ultra is a client-side tier and must never reach the backend;
				// Astra resolves it to its catalog multi_agent_reasoning_effort.
				expect(
					getReasoningConfig('gpt-6-astra', { reasoningEffort: 'ULTRA' as never }).effort,
				).toBe('xhigh');
				// astra rejects "none".
				expect(
					getReasoningConfig('gpt-6-astra', { reasoningEffort: 'NONE' as never }).effort,
				).toBe('low');
				// Codex families reject "minimal".
				expect(
					getReasoningConfig('gpt-5-codex', { reasoningEffort: 'MINIMAL' as never }).effort,
				).toBe('low');
				// gpt-5.1 tops out at high.
				expect(
					getReasoningConfig('gpt-5.1', { reasoningEffort: 'MAX' as never }).effort,
				).toBe('high');
			});

			it('trims surrounding whitespace', () => {
				expect(
					getReasoningConfig('gpt-6-astra', { reasoningEffort: '  MAX  ' as never }).effort,
				).toBe('max');
				expect(
					getReasoningConfig('gpt-6-astra', { reasoningEffort: '   ' as never }).effort,
				).toBeTruthy();
			});

			it('leaves already-lowercase efforts exactly as they were', () => {
				expect(
					getReasoningConfig('gpt-6-astra', { reasoningEffort: 'xhigh' }).effort,
				).toBe('xhigh');
				expect(
					getReasoningConfig('gpt-5.6-sol', { reasoningEffort: 'max' }).effort,
				).toBe('max');
				expect(
					getReasoningConfig('gpt-5.5', { reasoningEffort: 'none' }).effort,
				).toBe('none');
			});
		});

		// Only codex-mini used to coerce these; every other family emitted the
		// unknown token verbatim, which the backend answers with a 400.
		it('coerces an unknown effort to the family default, not just for codex-mini', () => {
			for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5-codex', 'gpt-5.1']) {
				const resolved = getReasoningConfig(model, {
					reasoningEffort: 'invalid-effort' as never,
				}).effort;
				expect(
					['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
					`${model} emitted ${resolved}`,
				).toContain(resolved);
			}
		});
	});

	describe('Model-specific behavior', () => {
		it('should detect first-class mini model correctly (resolved via alias)', () => {
			const miniReasoning = getReasoningConfig('gpt-5-mini', {});
			expect(miniReasoning.effort).toBe('high');
		});

		it('should detect codex models correctly', () => {
			const codexConfig = { reasoningEffort: 'minimal' as const };
			const codexReasoning = getReasoningConfig('gpt-5-codex', codexConfig);
			expect(codexReasoning.effort).toBe('low'); // normalized
		});

		it('should handle standard gpt-5 model', () => {
			const gpt5Reasoning = getReasoningConfig('gpt-5', {});
			expect(gpt5Reasoning.effort).toBe('high');
		});
	});
});

describe('clampReasoningForModel (unsupported-model fallback)', () => {
	it('degrades a 5.6-only max effort when the fallback target is pre-5.6', () => {
		// gpt-5.6-sol-max falling back to gpt-5.5 must not put `max` on the
		// wire — gpt-5.5 tops out at xhigh and would reject the request.
		expect(
			clampReasoningForModel({ effort: 'max', summary: 'auto' }, 'gpt-5.5'),
		).toEqual({ effort: 'xhigh', summary: 'auto' });
	});

	it('keeps max on a 5.6-to-5.6 fallback hop', () => {
		const reasoning = { effort: 'max' as const, summary: 'auto' as const };
		expect(clampReasoningForModel(reasoning, 'gpt-5.6-terra')).toBe(reasoning);
	});

	it('returns the input unchanged when no effort is carried', () => {
		expect(clampReasoningForModel(undefined, 'gpt-5.5')).toBeUndefined();
		const summaryOnly = { summary: 'auto' as const };
		expect(clampReasoningForModel(summaryOnly, 'gpt-5.5')).toBe(summaryOnly);
	});

	it('preserves other reasoning fields while re-deriving effort', () => {
		const clamped = clampReasoningForModel(
			{ effort: 'max', summary: 'detailed' },
			'gpt-5.4',
		);
		expect(clamped?.effort).toBe('xhigh');
		expect(clamped?.summary).toBe('detailed');
	});
});

describe("config bounds probes", () => {
	afterEach(() => {
		delete process.env.CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY;
	});

	it("parallelProbingMaxConcurrency env values clamp into [1, 5]", () => {
		for (const [raw, expected] of [
			["0", 1],
			["-1", 1],
			["1e309", 2],
			["NaN", 2],
			["Infinity", 2],
			["3", 3],
			["99", 5],
		] as const) {
			process.env.CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY = raw;
			expect(getParallelProbingMaxConcurrency({} as never)).toBe(expected);
		}
	});
});
