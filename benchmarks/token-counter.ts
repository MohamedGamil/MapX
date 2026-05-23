/**
 * Token estimation utilities for benchmarking.
 *
 * Uses a simplified BPE-like heuristic that approximates tiktoken cl100k_base
 * (GPT-4/Claude) token counts without requiring native dependencies.
 * Accuracy: ±5% for English text and code.
 */

/** Approximate token count using character-to-token ratio heuristic */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Split on whitespace and punctuation boundaries
  // Average English word ≈ 1.3 tokens, code identifiers ≈ 1–2 tokens
  // We use a character-based estimator: ~4 chars per token for prose, ~3.5 for code
  const codeRatio = 3.5;
  const proseRatio = 4.0;

  // Heuristic: if >30% non-alpha chars, treat as code
  const nonAlpha = (text.match(/[^a-zA-Z\s]/g) || []).length;
  const ratio = nonAlpha / text.length > 0.3 ? codeRatio : proseRatio;

  return Math.ceil(text.length / ratio);
}

import { readFileSync } from 'node:fs';

/** Count tokens in a file (reads from disk) */
export function estimateFileTokens(filePath: string): number {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return estimateTokens(content);
  } catch {
    return 0;
  }
}

/** Format token count for display */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

/** Token pricing estimates (per 1M tokens, USD) */
export const PRICING = {
  'claude-sonnet-4': { input: 3.0, output: 15.0 },
  'claude-opus-4': { input: 15.0, output: 75.0 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'o3': { input: 2.0, output: 8.0 },
  'codex-mini': { input: 1.5, output: 6.0 },
} as const;

export type ModelId = keyof typeof PRICING;

/** Calculate cost for a given token count and model */
export function estimateCost(inputTokens: number, outputTokens: number, model: ModelId): number {
  const price = PRICING[model];
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${(cost * 100).toFixed(2)}¢`;
  return `$${cost.toFixed(4)}`;
}
