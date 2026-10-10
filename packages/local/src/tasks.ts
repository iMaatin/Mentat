/**
 * Layer 1's semantic work.
 *
 * These are the *only* places the local model is invoked, and each one was
 * chosen because a model genuinely beats a regex:
 *
 *  - `rewritePrompt` needs to understand what you actually asked for and restate
 *    it without domain vocabulary. No rule engine can paraphrase.
 *  - `extractTerms` needs to decide which nouns in a codebase are *proprietary*
 *    rather than generic. That is a judgement about your business.
 *  - `redactProse` needs to rewrite comments and messages that describe internal
 *    behaviour, keeping the technical meaning and dropping the identifying detail.
 *
 * Everything statistical, structural, or reversible stays in deterministic code.
 */

import { LocalModel, type LocalMessage } from "./client.js";

export interface RewriteResult {
  /** The de-identified request. */
  readonly prompt: string;
  /** Domain terms that were generalized, for the audit log. */
  readonly generalized: readonly string[];
  readonly notes: string;
}

const REWRITE_SYSTEM = `You de-identify engineering requests before they are sent to an external AI service.

You will be given a request written by an engineer about their own system. Produce a rewritten request that:
- preserves the technical intent completely: the goal, the constraints, the acceptance criteria, the specific behaviours requested
- replaces every product name, company name, customer name, internal project codename, team name, internal system name, and domain-specific business term with a neutral generic equivalent (e.g. "the billing service", "the customer record table", "the internal analytics pipeline")
- replaces specific metric names, KPI names, and business process names with generic descriptions of the same concept
- keeps all technical vocabulary intact: language names, library names, file paths, function signatures, data types, SQL keywords, and standard engineering terms are NOT proprietary and must be preserved verbatim
- keeps any code snippets, identifiers written in backticks, or file paths exactly as given
- stays in the same language as the original request

You must not: invent requirements, simplify the ask, drop edge cases, or add advice. Length should be close to the original.

Return JSON: {"prompt": string, "generalized": string[], "notes": string}. The "generalized" array lists the domain terms you replaced.`;

export async function rewritePrompt(model: LocalModel, prompt: string, context?: string): Promise<RewriteResult> {
  const user =
    context && context.trim().length > 0
      ? `Context the engineer gave (may itself contain domain terms):\n---\n${context}\n---\n\nRequest:\n${prompt}`
      : `Request:\n${prompt}`;

  const messages: LocalMessage[] = [
    { role: "system", content: REWRITE_SYSTEM },
    { role: "user", content: user },
  ];

  const parsed = await model.chatJson<{ prompt: string; generalized?: string[]; notes?: string }>(messages, {
    temperature: 0.2,
    maxTokens: 2048,
  });

  const text = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
  if (text.length === 0) {
    throw new Error("Local model returned an empty rewrite; refusing to send the original prompt.");
  }
  return {
    prompt: text,
    generalized: parsed.generalized ?? [],
    notes: parsed.notes ?? "",
  };
}

const TERMS_SYSTEM = `You identify which identifiers in a codebase carry proprietary meaning.

You will be given a file from a real codebase. Return the domain-specific identifiers it contains.

An identifier IS proprietary if it names or implies:
- a company, product, client, customer, partner, or internal team
- an internal system, service, database, table, queue, or infrastructure component that has a real-world name
- a business process, product concept, or domain entity specific to this organization
- a metric, KPI, or report name used by the business
- a person, place, or vendor name

An identifier is NOT proprietary if it is:
- standard programming vocabulary (user, config, handler, parse, validate)
- a library, framework, protocol, or standard name (HTTP, JSON, Postgres, React)
- generic data or file-format vocabulary (id, name, timestamp, amount)
- a language keyword or type name

Return JSON: {"terms": string[], "kinds": {term: string}} where "kinds" maps each term to a short kind such as "product", "customer", "table", "service", "team", "metric", "process", "person", "vendor", "other". Include only proprietary terms. Empty list is a valid and common answer.`;

export async function extractTerms(
  model: LocalModel,
  source: string,
  filePath: string,
): Promise<{ terms: readonly string[]; kinds: Readonly<Record<string, string>> }> {
  const truncated = source.length > 6000 ? `${source.slice(0, 6000)}\n... (truncated)` : source;
  const messages: LocalMessage[] = [
    { role: "system", content: TERMS_SYSTEM },
    { role: "user", content: `File: ${filePath}\n\n\`\`\`\n${truncated}\n\`\`\`` },
  ];
  const parsed = await model.chatJson<{ terms?: string[]; kinds?: Record<string, string> }>(messages, {
    temperature: 0,
    maxTokens: 1024,
  });
  const terms = (parsed.terms ?? []).filter((t) => typeof t === "string" && t.trim().length >= 3);
  return { terms, kinds: parsed.kinds ?? {} };
}

const PROSE_SYSTEM = `You rewrite code comments and documentation strings to remove identifying detail while keeping technical meaning.

Rules:
- Keep the technical content: what the code does, why a non-obvious decision was made, what a parameter means, what an invariant is.
- Remove: company, product, client, and team names; internal system and table names; business process names; people's names; anything that would identify the organization.
- Replace removed specifics with neutral equivalents that keep the sentence grammatical and useful ("the primary customer table", "the reporting job").
- Do not add commentary, do not editorialize about the removal, and do not change the code, only the prose.
- Preserve the original indentation of each comment line.

Return JSON: {"text": string}.`;

export async function redactProse(model: LocalModel, text: string): Promise<string> {
  const messages: LocalMessage[] = [
    { role: "system", content: PROSE_SYSTEM },
    { role: "user", content: text },
  ];
  const parsed = await model.chatJson<{ text?: string }>(messages, { temperature: 0.1, maxTokens: 2048 });
  return typeof parsed.text === "string" ? parsed.text.trim() : text;
}

/**
 * Names a dataset generically from its schema, so the cloud model understands
 * what the data represents without learning anything about the real business.
 */
const SCHEMA_SYSTEM = `You name a synthetic dataset based only on its column names and types.

Return JSON: {"name": string, "description": string, "grain": string}.
- "name" is a short generic snake_case identifier describing what one row represents.
- "description" is one sentence describing the table's purpose.
- "grain" describes what one row represents.
Base everything strictly on the column names and dtypes provided. Do not speculate about
a specific organization, and do not invent columns you were not shown.`;

export async function describeDataset(
  model: LocalModel,
  datasetName: string,
  schema: readonly { name: string; dtype: string; nullRate: number }[],
): Promise<{ name: string; description: string; grain: string }> {
  const lines = schema.map((c) => `  ${c.name}: ${c.dtype} (nulls ${(c.nullRate * 100).toFixed(0)}%)`).join("\n");
  const messages: LocalMessage[] = [
    { role: "system", content: SCHEMA_SYSTEM },
    { role: "user", content: `Current table name: ${datasetName}\n\nColumns:\n${lines}` },
  ];
  return await model.chatJson<{ name: string; description: string; grain: string }>(messages, {
    temperature: 0.1,
    maxTokens: 512,
  });
}

export type { LocalMessage } from "./client.js";
export { LocalModel } from "./client.js";