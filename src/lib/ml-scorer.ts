// ml-scorer.ts — v3 LightGBM cascade bot detector for the Refine agent.
//
// Loads the exported LightGBM JSON model at startup and scores a single raw
// transaction with zero new dependencies (manual tree traversal). Feature
// extraction is a faithful TypeScript port of the Python training pipeline
// (refine-ml/src/features.py + meta_feature.py) so the live feature vector
// matches the distribution the model was trained on — this is what preserves the
// reported 2.03% false-positive rate at threshold 0.7.
//
// Critical parity notes with the Python training code:
//   * The 14 active features and their ORDER come from the model's own
//     `feature_names` (identical to feature_config_cascade.json). The model's
//     `split_feature` indices address into this exact order.
//   * `existing_algo_score` is the meta-feature from meta_feature.py — a weighted
//     logistic squash of value/gas/contract-creation sub-scores, NOT the existing
//     detector's score / 100. The same 0–1 value is reused by process.ts as the
//     cascade gate (×100 → the <15 / >85 cutoffs).
//   * `calldata_length` is the FULL byte length, but `calldata_entropy`,
//     `calldata_shannon_entropy` and `zero_byte_ratio` are computed over the FIRST
//     256 bytes of calldata — exactly as the training rows were built (Dune stored
//     a 256-byte calldata prefix while carrying the true length in its own column).
//   * `calldata_shannon_entropy` is a deliberate duplicate of `calldata_entropy`.
//   * `priority_base_ratio` and absolute fee features are EXCLUDED from this model
//     (time-confounded) and are intentionally not part of the vector.
//   * Missing fields default to 0 / derived defaults exactly as Python's _to_int
//     did (the model never saw NaN in training); tree traversal still implements
//     LightGBM's full missing-value semantics for robustness.
import { readFile } from "node:fs/promises";

// --------------------------------------------------------------------------- //
// LightGBM JSON model shapes (only the fields we read).
// --------------------------------------------------------------------------- //
interface LGBMNode {
  // Internal nodes:
  split_feature?: number;
  threshold?: number;
  decision_type?: string;
  default_left?: boolean;
  missing_type?: string; // "None" | "Zero" | "NaN"
  left_child?: LGBMNode;
  right_child?: LGBMNode;
  // Leaf nodes:
  leaf_value?: number;
}

interface LGBMTree {
  tree_structure: LGBMNode;
}

interface LGBMModel {
  feature_names: string[];
  tree_info: LGBMTree[];
  objective?: string;
  average_output?: boolean;
  max_feature_idx?: number;
}

interface FeatureConfig {
  features: string[];
  recommended_threshold?: number;
}

// LightGBM's IsZero uses |x| <= 1e-35 (kZeroThreshold).
const ZERO_THRESHOLD = 1e-35;
const WEI_PER_ETH = 10n ** 18n;
const WEI_PER_USDC = 10n ** 6n;

// Meta-feature weights (must mirror meta_feature.py exactly).
const W_SIZE = 0.25;
const W_CLUSTER = 0.2;
const W_FREQ = 0.3;
const W_COUNTERPARTY = 0.15;
const W_AGE = 0.1;
const AGE_PROXY = 0.5;
const GAS_AUTOMATION_REF = 500_000.0;

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

// --------------------------------------------------------------------------- //
// Low-level parsing helpers (ports of features.py _to_int / _calldata_bytes).
// --------------------------------------------------------------------------- //

// Coerce a tx field to a bigint. Accepts hex strings ("0x1a"), decimal strings,
// numbers, bigints, booleans, or null/undefined. Unparseable → default. Mirrors
// Python's _to_int but returns bigint so huge wei values stay exact.
function toBigInt(value: unknown, dflt = 0n): bigint {
  if (value === null || value === undefined) return dflt;
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return dflt;
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return dflt;
    try {
      if (s.toLowerCase().startsWith("0x")) {
        if (s.length === 2) return dflt; // bare "0x"
        return BigInt(s);
      }
      if (/^[+-]?\d+$/.test(s)) return BigInt(s.replace(/^\+/, ""));
      const f = Number(s);
      return Number.isFinite(f) ? BigInt(Math.trunc(f)) : dflt;
    } catch {
      const f = Number(s);
      return Number.isFinite(f) ? BigInt(Math.trunc(f)) : dflt;
    }
  }
  return dflt;
}

// Normalise a calldata/input field into raw bytes (empty on missing/garbage).
// Mirrors features.py _calldata_bytes, including odd-length defensive padding.
function calldataBytes(value: unknown): Uint8Array {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    let s = value.trim();
    if (s.toLowerCase().startsWith("0x")) s = s.slice(2);
    if (s === "") return new Uint8Array(0);
    if (s.length % 2 === 1) s = "0" + s;
    if (!/^[0-9a-fA-F]*$/.test(s)) return new Uint8Array(0);
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(s.substr(i * 2, 2), 16);
    }
    return out;
  }
  return new Uint8Array(0);
}

// Shannon entropy in bits/byte (0..8) — port of features.py shannon_entropy.
function shannonEntropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const freq = new Map<number, number>();
  for (const b of bytes) freq.set(b, (freq.get(b) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / bytes.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function zeroByteRatio(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let zeros = 0;
  for (const b of bytes) if (b === 0) zeros++;
  return zeros / bytes.length;
}

// Port of features.py is_round_value (exact bigint modulo, never NaN).
function isRoundValue(valueWei: bigint): boolean {
  if (valueWei <= 0n) return false;
  for (const denom of [
    WEI_PER_ETH,
    WEI_PER_ETH / 10n,
    WEI_PER_ETH / 100n,
    WEI_PER_ETH / 1000n,
  ]) {
    if (denom > 0n && valueWei % denom === 0n) return true;
  }
  return valueWei % WEI_PER_USDC === 0n;
}

// Case-insensitive accessor over a raw-tx-shaped row, matching both JSON-RPC
// camelCase and snake_case keys (port of the `get(...)` closure used in Python).
// Returns undefined only when no candidate key is present (a present-but-null
// field returns its null, exactly like the Python `in` check).
type Getter = (...names: string[]) => unknown;
function makeGetter(row: Record<string, unknown>): { get: Getter; has: (name: string) => boolean } {
  const lower: Record<string, unknown> = {};
  for (const k of Object.keys(row)) lower[k.toLowerCase()] = row[k];
  const get: Getter = (...names) => {
    for (const n of names) {
      const key = n.toLowerCase();
      if (key in lower) return lower[key];
    }
    return undefined;
  };
  const has = (name: string): boolean => name.toLowerCase() in lower;
  return { get, has };
}

// --------------------------------------------------------------------------- //
// Meta-feature: existing rule-based score, normalised 0–1 (meta_feature.py).
// --------------------------------------------------------------------------- //
function valueSizeScore(valueWeiNum: number): number {
  if (valueWeiNum <= 0) return 0;
  return Math.min(Math.log10(valueWeiNum + 1) / 19.0, 1.0);
}

// existing_algorithm_score(tx) — the cascade meta-feature. Used BOTH as the
// `existing_algo_score` model feature and (×100) as the cascade gate score.
function existingAlgorithmScore(g: { get: Getter; has: (name: string) => boolean }): number {
  const valueWei = toBigInt(g.get("value", "value_wei"));
  const gasLimit = Number(toBigInt(g.get("gas", "gas_limit", "gaslimit")));

  const sizeScore = valueSizeScore(Number(valueWei));
  const clusterScore = isRoundValue(valueWei) ? 1.0 : 0.0;
  const freqScore = Math.min(gasLimit / GAS_AUTOMATION_REF, 1.0);

  let creation: number;
  if (g.has("is_contract_creation")) {
    creation = toBigInt(g.get("is_contract_creation")) !== 0n ? 1.0 : 0.0;
  } else {
    const to = g.get("to");
    creation = to === null || to === undefined || to === "" || to === "0x" ? 1.0 : 0.0;
  }

  const raw =
    W_SIZE * sizeScore +
    W_CLUSTER * clusterScore +
    W_FREQ * freqScore +
    W_COUNTERPARTY * creation +
    W_AGE * AGE_PROXY;

  // Stable logistic squash centred at 0.5 (matches meta_feature.py).
  return 1.0 / (1.0 + Math.exp(-6.0 * (raw - 0.5)));
}

// --------------------------------------------------------------------------- //
// MLScorer
// --------------------------------------------------------------------------- //
export class MLScorer {
  private model: LGBMModel | null = null;
  private featureNames: string[] = [];
  threshold = 0.7;

  // Load the LightGBM JSON model and feature config. Never throws — on any
  // missing file / parse error it logs a warning and leaves the scorer in a
  // not-ready state so the agent falls back to rule-only scoring.
  async init(modelPath: string, configPath: string): Promise<void> {
    try {
      const [modelRaw, configRaw] = await Promise.all([
        readFile(modelPath, "utf8"),
        readFile(configPath, "utf8"),
      ]);
      const model = JSON.parse(modelRaw) as LGBMModel;
      const config = JSON.parse(configRaw) as FeatureConfig;

      if (!Array.isArray(model.feature_names) || !Array.isArray(model.tree_info)) {
        throw new Error("model JSON missing feature_names / tree_info");
      }

      this.model = model;
      // The model's own feature_names define the canonical vector order; the
      // config is used only to pick up the recommended threshold.
      this.featureNames = model.feature_names;
      if (typeof config.recommended_threshold === "number") {
        this.threshold = config.recommended_threshold;
      }
      console.log(
        `[Distill ML] cascade model loaded: ${model.tree_info.length} trees, ` +
          `${this.featureNames.length} features, threshold ${this.threshold}`,
      );
    } catch (err) {
      this.model = null;
      console.warn(
        `[Distill ML] cascade model unavailable — falling back to rule-only ` +
          `scoring. Reason: ${(err as Error).message}`,
      );
    }
  }

  isReady(): boolean {
    return this.model !== null;
  }

  // The existing rule-based score for a single tx, 0–1 (meta_feature parity).
  // Pure function — works even when the ML model failed to load, so it can drive
  // the cascade gate regardless of model availability.
  ruleScore(tx: Record<string, unknown>): number {
    return existingAlgorithmScore(makeGetter(tx));
  }

  // Build the 14-feature vector in the model's feature_names order. Exposed for
  // tests; mirrors build_ground_truth.py feature computation exactly.
  extractFeatures(tx: Record<string, unknown>): number[] {
    const g = makeGetter(tx);

    const maxFee = Number(toBigInt(g.get("maxFeePerGas", "max_fee_per_gas")));
    const maxPriority = Number(
      toBigInt(g.get("maxPriorityFeePerGas", "max_priority_fee_per_gas")),
    );
    const gasLimit = Number(toBigInt(g.get("gas", "gas_limit", "gaslimit")));
    const gasFeeRatio = maxFee > 0 ? maxPriority / maxFee : 0.0;

    const valueWei = toBigInt(g.get("value", "value_wei"));

    // Calldata: full bytes for the length feature, first 256 bytes for the
    // entropy / zero-byte features (training-data parity).
    const data = calldataBytes(g.get("input", "data", "calldata"));
    const prefix = data.length > 256 ? data.subarray(0, 256) : data;
    const calldataLength = data.length;
    const functionSelector =
      data.length >= 4
        ? data[0] * 0x1000000 + data[1] * 0x10000 + data[2] * 0x100 + data[3]
        : 0;
    const entropy = shannonEntropy(prefix);

    const txType = Number(toBigInt(g.get("type", "tx_type")));

    let isContractCreation: number;
    if (g.has("is_contract_creation")) {
      isContractCreation = toBigInt(g.get("is_contract_creation")) !== 0n ? 1 : 0;
    } else {
      const to = g.get("to");
      isContractCreation =
        to === null || to === undefined || to === "" || to === "0x" ? 1 : 0;
    }

    const featMap: Record<string, number> = {
      gas_limit: gasLimit,
      gas_fee_ratio: gasFeeRatio,
      value_wei: Number(valueWei),
      value_is_zero: valueWei === 0n ? 1 : 0,
      value_round_number: isRoundValue(valueWei) ? 1 : 0,
      calldata_length: calldataLength,
      calldata_is_empty: calldataLength === 0 ? 1 : 0,
      function_selector: functionSelector,
      calldata_entropy: entropy,
      tx_type: txType,
      is_contract_creation: isContractCreation,
      calldata_shannon_entropy: entropy, // deliberate duplicate of calldata_entropy
      zero_byte_ratio: zeroByteRatio(prefix),
      existing_algo_score: existingAlgorithmScore(g),
    };

    return this.featureNames.map((name) => featMap[name] ?? 0);
  }

  // Score a single tx. Returns P(bot) in [0,1], or null if the model is not
  // loaded (caller falls back to rule-only scoring).
  predict(tx: Record<string, unknown>): number | null {
    if (!this.model) return null;
    const features = this.extractFeatures(tx);
    let sum = 0;
    for (const tree of this.model.tree_info) {
      sum += traverseTree(tree.tree_structure, features);
    }
    if (this.model.average_output) sum /= this.model.tree_info.length;
    return sigmoid(sum); // objective "binary sigmoid:1"
  }
}

// Manual LightGBM tree traversal with full missing-value semantics:
//   1. If the value is NaN/missing and missing_type != "NaN", treat it as 0.
//   2. Go the default direction when (missing_type=="Zero" and value≈0) or
//      (missing_type=="NaN" and value is NaN), per LightGBM's default_left.
//   3. Otherwise compare value <= threshold (decision_type "<=").
function traverseTree(root: LGBMNode, features: number[]): number {
  let node = root;
  while (true) {
    if (typeof node.leaf_value === "number") return node.leaf_value;

    const fi = node.split_feature ?? 0;
    let fval = features[fi];
    const missingType = node.missing_type ?? "None";

    let valIsNaN = fval === null || fval === undefined || Number.isNaN(fval);
    if (valIsNaN && missingType !== "NaN") {
      fval = 0;
      valIsNaN = false;
    }

    let goDefault = false;
    if (missingType === "Zero" && Math.abs(fval) <= ZERO_THRESHOLD) {
      goDefault = true;
    } else if (missingType === "NaN" && valIsNaN) {
      goDefault = true;
    }

    if (goDefault) {
      node = (node.default_left ? node.left_child : node.right_child) as LGBMNode;
    } else {
      node = (fval <= (node.threshold as number) ? node.left_child : node.right_child) as LGBMNode;
    }
  }
}
