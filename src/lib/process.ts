// Core Distill pipeline, extracted from the entrypoint handler so it can be
// invoked directly (handler + envelope tests) without standing up the HTTP app.
import { normalizeInput } from "../utils/flatten";
import { defineSchema } from "../layers/schema";
import { detectBots } from "../layers/botDetection";
import { extractFeatures } from "../layers/features";
import type { DistillOutput } from "../utils/types";

export interface DistillInput {
  data: unknown;
}

export type DistillResult =
  | { ok: true; output: DistillOutput }
  | { ok: false; error: string };

// Clean raw blockchain transaction data, filter bots, and return structured
// features. Returns a discriminated result so the caller decides how to surface
// errors (e.g. wrap them in the standard envelope with status "error").
export async function processDistill(input: DistillInput): Promise<DistillResult> {
  let rawArray: unknown[];
  if (Array.isArray(input.data)) {
    rawArray = input.data;
  } else if (
    typeof input.data === "object" &&
    input.data !== null &&
    Array.isArray((input.data as Record<string, unknown>)["data"])
  ) {
    rawArray = (input.data as Record<string, unknown>)["data"] as unknown[];
  } else {
    return { ok: false, error: "Invalid input: expected array or { data: [...] } format" };
  }

  const rows = normalizeInput(rawArray);

  if (rows.length === 0) {
    return { ok: false, error: "No rows found in input data" };
  }

  if (rows.length > 10000) {
    return { ok: false, error: "Too many rows. Maximum 10,000 rows per request." };
  }

  const schemaResult = await defineSchema(rows);
  if (!schemaResult.success) {
    return { ok: false, error: schemaResult.error ?? "Schema detection failed" };
  }
  const columns = schemaResult.columns;

  const botResult = detectBots(rows, columns);
  const output = extractFeatures(botResult, columns);

  return { ok: true, output };
}
