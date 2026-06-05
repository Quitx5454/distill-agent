// Core Distill pipeline, extracted from the entrypoint handler so it can be
// invoked directly (handler + envelope tests) without standing up the HTTP app.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeInput } from "../utils/flatten";
import { defineSchema } from "../layers/schema";
import { detectBots } from "../layers/botDetection";
import { extractFeatures } from "../layers/features";
import { MLScorer } from "./ml-scorer";
import type {
  CascadeOutput,
  CascadeRowResult,
  DistillOutput,
  RawRow,
  ScoringMethod,
} from "../utils/types";

export interface DistillInput {
  data: unknown;
}

export type DistillResult =
  | { ok: true; output: DistillOutput }
  | { ok: false; error: string };

// ── Hybrid Cascade (v3 LightGBM) — singleton, loaded once at module load ─────
// The ML model is loaded a single time (not per request). predict() returns null
// until the load resolves / if it fails, so scoring degrades gracefully to
// rule-only. `mlReady` lets processDistill await the initial load before scoring.
const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = join(HERE, "..", "..", "models", "refine_bot_detector_cascade.json");
const CONFIG_PATH = join(HERE, "..", "..", "models", "feature_config_cascade.json");

const mlScorer = new MLScorer();
const mlReady: Promise<void> = mlScorer.init(MODEL_PATH, CONFIG_PATH);

// Gray-zone gate bounds (on the rule score scaled to 0–100). Outside the band
// the rule decides immediately and the ML model is not consulted; inside it the
// ML model is the SOLE decision maker (no score blending).
const GATE_LOW = 15;
const GATE_HIGH = 85;

// Run the hybrid cascade over every normalized row. Purely additive: it does NOT
// change the existing clean/suspicious/bot partitioning — it annotates each input
// row (in input order) with a per-tx ML opinion.
function runCascade(rows: RawRow[]): CascadeOutput {
  const ready = mlScorer.isReady();
  const rowResults: CascadeRowResult[] = [];
  let ruleOnly = 0;
  let cascadeCount = 0;
  let botCount = 0;
  let humanCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const tx = rows[i];
    const ruleScore = mlScorer.ruleScore(tx); // existing_algo_score, 0–1
    const gate = ruleScore * 100;

    let isBot: boolean;
    let scoringMethod: ScoringMethod;
    let mlScore: number | null = null;

    if (gate > GATE_HIGH) {
      isBot = true;
      scoringMethod = "rule_only";
    } else if (gate < GATE_LOW) {
      isBot = false;
      scoringMethod = "rule_only";
    } else {
      // Gray zone: the ML model alone decides (no blending with the rule score).
      mlScore = mlScorer.predict(tx);
      if (mlScore !== null) {
        isBot = mlScore >= mlScorer.threshold;
        scoringMethod = "cascade";
      } else {
        // Model unavailable: fall back to the rule at the band midpoint.
        isBot = gate > 50;
        scoringMethod = "rule_only";
      }
    }

    if (scoringMethod === "cascade") cascadeCount++;
    else ruleOnly++;
    if (isBot) botCount++;
    else humanCount++;

    rowResults.push({
      index: i,
      rule_score: ruleScore,
      ml_score: mlScore,
      scoring_method: scoringMethod,
      is_bot: isBot,
    });
  }

  return {
    enabled: ready,
    ml_threshold: mlScorer.threshold,
    scoring_method_counts: { rule_only: ruleOnly, cascade: cascadeCount },
    ml_bot_count: botCount,
    ml_human_count: humanCount,
    rows: rowResults,
  };
}

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

  // Hybrid cascade ML scoring (additive). Ensure the model load has settled so
  // the result is deterministic across requests.
  await mlReady;
  output.cascade = runCascade(rows);

  return { ok: true, output };
}
