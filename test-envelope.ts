// Local test for the Distill Standard Envelope (bypasses the x402 paywall).
//   bun run test-envelope.ts
//
// Mirrors the entrypoint handler exactly: parseEnvelope -> processDistill ->
// wrapResponse. Verifies both envelope mode and legacy (backward-compat) mode.
// Scenario 1 & 2 run the real pipeline (Anthropic Haiku), so ANTHROPIC_API_KEY
// must be set (Bun auto-loads it from .env).
import { parseEnvelope, wrapResponse, type DistillResponse } from "./src/lib/envelope";
import { processDistill, type DistillInput } from "./src/lib/process";

const SAMPLE_DATA = {
  data: [
    { tx_hash: "0xabc1", tx_from_address: "0xaaa", amount: "500", timestamp: "2026-05-28T20:13:59Z" },
    { tx_hash: "0xabc2", tx_from_address: "0xbbb", amount: "750", timestamp: "2026-05-28T20:14:30Z" },
  ],
};

// Same code path the handler runs.
async function runHandler(rawInput: unknown): Promise<DistillResponse> {
  const { payload, sessionId, agentId } = parseEnvelope<DistillInput>(rawInput);
  const result = await processDistill(payload);
  if (!result.ok) return wrapResponse({ error: result.error }, sessionId, agentId, "error");
  return wrapResponse(result.output, sessionId, agentId, "ok");
}

function assert(cond: boolean, msg: string) {
  console.log(`${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) process.exitCode = 1;
}

// ── Scenario 1 — Envelope mode ────────────────────────────────────
console.log("\n── SCENARIO 1 — Envelope mode ────────────────────");
const envelopeInput = {
  distill_version: "1.0",
  agent_id: "6482",
  session_id: "test-session-001",
  payload: SAMPLE_DATA,
};
const parsed1 = parseEnvelope<DistillInput>(envelopeInput);
assert(parsed1.isEnvelope === true, "detected as envelope mode");
assert(JSON.stringify(parsed1.payload) === JSON.stringify(SAMPLE_DATA), "payload unwrapped from envelope");
assert(parsed1.sessionId === "test-session-001", "session_id taken from envelope");
assert(parsed1.agentId === "6482", "agent_id taken from envelope");

const res1 = await runHandler(envelopeInput);
console.log(JSON.stringify(res1, null, 2));
assert(res1.distill_version === "1.0", "response.distill_version === '1.0'");
assert(res1.session_id === "test-session-001", "response.session_id preserved");
assert(res1.agent_id === "6482", "response.agent_id preserved");
assert(res1.status === "ok", "response.status === 'ok'");
assert(typeof res1.processed_at === "string" && !isNaN(Date.parse(res1.processed_at)), "response.processed_at is an ISO timestamp");
assert(res1.output !== undefined && (res1.output as any).summary !== undefined, "response.output carries the agent output");

// ── Scenario 2 — Legacy mode (backward compatibility) ─────────────
console.log("\n── SCENARIO 2 — Legacy mode ──────────────────────");
const legacyInput = SAMPLE_DATA;
const parsed2 = parseEnvelope<DistillInput>(legacyInput);
assert(parsed2.isEnvelope === false, "detected as legacy mode");
assert(JSON.stringify(parsed2.payload) === JSON.stringify(SAMPLE_DATA), "payload === bare input");
assert(typeof parsed2.sessionId === "string" && parsed2.sessionId.length >= 32, "session_id auto-generated (UUID)");
assert(parsed2.agentId === null, "agent_id null in legacy mode");

const res2 = await runHandler(legacyInput);
console.log(JSON.stringify({ ...res2, output: "<omitted>" }, null, 2));
assert(res2.distill_version === "1.0", "response.distill_version === '1.0'");
assert(typeof res2.session_id === "string" && res2.session_id.length >= 32, "response.session_id is generated UUID");
assert(res2.agent_id === null, "response.agent_id null");
assert(res2.status === "ok", "response.status === 'ok'");
assert((res2.output as any).summary !== undefined, "legacy response still returns the agent output, wrapped in envelope");

console.log(process.exitCode ? "\n❌ SOME CHECKS FAILED" : "\n✅ ALL CHECKS PASSED");
