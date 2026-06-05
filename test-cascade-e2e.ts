// End-to-end cascade test through processDistill: confirms the output carries the
// additive `cascade` block with per-row ml_score + scoring_method, that both the
// rule_only and cascade paths are exercised, and that existing fields are intact.
// Also checks MLScorer's graceful fallback when the model file is missing.
// Run: bun run test-cascade-e2e.ts
import { processDistill } from "./src/lib/process";
import { MLScorer } from "./src/lib/ml-scorer";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

// A batch of raw EVM tx objects spanning gray-zone (-> cascade) and extreme
// (-> rule_only) rule scores.
const data = [
  // gate ~6.8 (<15) -> rule_only human
  {
    type: "0x2", gas: "0x5208", maxFeePerGas: "0x6fc23ac00",
    maxPriorityFeePerGas: "0x9502f900", value: "0x0",
    to: "0x1111111254eeb25477b68fb85ed929f73a960582",
    from: "0xdeadbeef00000000000000000000000000000001",
    input: "0x38ed1739000000000000000000000000000000000000000000000000016345785d8a0000",
  },
  // gate ~49.9 (gray) -> cascade
  {
    type: "0x0", gas: "0x5208", gasPrice: "0x4a817c800",
    value: "0xde0b6b3a7640000",
    to: "0xabc0000000000000000000000000000000000def",
    from: "0xcafe000000000000000000000000000000000001", input: "0x",
  },
  // gate ~35 (gray) -> cascade
  {
    type: "0x2", gas: "0x186a0", maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x77359400", value: "5000000",
    to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", input: "0x095ea7b3",
  },
];

const res = await processDistill({ data });
assert(res.ok, "processDistill returns ok");
if (!res.ok) process.exit(1);
const out = res.output;

// Existing fields untouched.
assert(out.summary && typeof out.summary.total_transactions === "number", "existing summary present");
assert(Array.isArray(out.clean_data), "existing clean_data present");
assert(Array.isArray(out.suspicious_data), "existing suspicious_data present");
assert(out.features !== undefined, "existing features present");

// New cascade block.
assert(out.cascade !== undefined, "cascade block added to output");
const c = out.cascade!;
assert(c.enabled === true, "cascade.enabled true (model loaded)");
assert(c.ml_threshold === 0.7, "cascade.ml_threshold is 0.7");
assert(c.rows.length === data.length, "cascade.rows aligned to input length");

for (const r of c.rows) {
  assert(typeof r.rule_score === "number", `row ${r.index}: rule_score present`);
  assert(
    r.scoring_method === "rule_only" || r.scoring_method === "cascade",
    `row ${r.index}: scoring_method is ${r.scoring_method}`,
  );
  if (r.scoring_method === "cascade") {
    assert(typeof r.ml_score === "number", `row ${r.index}: cascade -> ml_score is a number`);
  } else {
    assert(r.ml_score === null, `row ${r.index}: rule_only -> ml_score is null`);
  }
}

const methods = new Set(c.rows.map((r) => r.scoring_method));
assert(methods.has("rule_only"), "rule_only path exercised");
assert(methods.has("cascade"), "cascade path exercised");
console.log("  scoring_method_counts:", JSON.stringify(c.scoring_method_counts));
console.log("  cascade rows:", JSON.stringify(c.rows, null, 2));

// Graceful fallback: a scorer pointed at a missing model must not throw, must
// report not-ready, and predict() must return null (rule still works).
const broken = new MLScorer();
await broken.init("/nonexistent/model.json", "/nonexistent/config.json");
assert(broken.isReady() === false, "fallback: isReady() false when model missing");
assert(broken.predict(data[0]) === null, "fallback: predict() returns null when model missing");
assert(typeof broken.ruleScore(data[0]) === "number", "fallback: ruleScore() still works without model");

console.log("\n✓ ALL end-to-end cascade assertions passed");
