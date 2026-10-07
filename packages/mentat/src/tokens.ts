// Rough token estimator for bundle budgets. chars/4 is the standard cheap
// heuristic; it only drives truncation, never the privacy gate.

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
