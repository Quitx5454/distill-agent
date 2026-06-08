## distill-agent

This project was scaffolded with `create-agent-kit` and ships with a ready-to-run agent app built on [`@lucid-agents/core`](https://www.npmjs.com/package/@lucid-agents/core).

### Quick start

```sh
bun install
bun run dev
```

The dev command runs `bun` in watch mode, starts the HTTP server, and reloads when you change files inside `src/`.

### Project structure

- `src/agent.ts` – defines the agent manifest and entrypoints.
- `src/index.ts` – boots a Bun HTTP server with the agent.
- `src/lib/process.ts` – core cleaning pipeline + hybrid cascade scoring.
- `src/lib/ml-scorer.ts` – embedded v3 LightGBM cascade bot detector (manual tree traversal, zero external deps).
- `models/` – `refine_bot_detector_cascade.json`, `feature_config_cascade.json`, `known_bots.bloom`.

### Entrypoints

- `process` – clean raw blockchain transaction data, filter bots, and return structured features + per-tx cascade scores. `POST /entrypoints/process/invoke` (0.02 USDC, x402, Base Mainnet).

### Available scripts

- `bun run dev` – start the agent in watch mode.
- `bun run start` – start the agent once.
- `bun run agent` – run the agent module directly (helpful for quick experiments).
- `bunx tsc --noEmit` – type-check the project.

### Request Format

The transaction array **must** be wrapped inside a `data` object. A bare array is rejected.

✅ **Correct** — array wrapped in `data`:

```json
{
  "data": [
    {
      "hash": "0x...",
      "from": "0x...",
      "to": "0x...",
      "value": "500000000000000000",
      "gas_limit": "150000",
      "input": "0x7ff36ab5...",
      "timestamp": 1716543215
    }
  ]
}
```

❌ **Wrong** — a top-level array (`Invalid input: expected array or { data: [...] } format`):

```json
[
  { "hash": "0x...", "from": "0x...", "to": "0x..." }
]
```

Column names are flexible and auto-detected. Up to 10,000 rows per request. (You can also send this `data` object wrapped in the [Distill Standard Envelope](#distill-standard-envelope) under `payload` — see below.)

### Hybrid Cascade Architecture

Refine v3 layers an embedded **LightGBM** model on top of the existing rule-based detector. The rule score acts as a gate; only genuinely ambiguous transactions reach the ML model.

- **Rule-based gate (instant):**
  - `rule_score × 100 > 85` → **bot**, decided by the rule alone (no ML call).
  - `rule_score × 100 < 15` → **human**, decided by the rule alone (no ML call).
- **Gray zone (15–85):** the **LightGBM model decides on its own**. There is **no blending** with the rule score — in the gray zone the ML output is the sole decision maker, which avoids double-counting the rule signal.
- **Embedded, zero external calls:** the model is loaded from `models/` and evaluated via manual tree traversal in `src/lib/ml-scorer.ts`. No network round-trips, microsecond-scale latency, zero new dependencies.
- **Shadow mode:** the cascade is **purely additive**. It annotates every response with `ml_score` and `scoring_method` (and the rest of the fields below) but **does not change** the existing clean/suspicious/bot partitioning or any production decision yet. If the model file is missing, scoring transparently falls back to `rule_only`.

#### Cascade output fields

The cascade result is attached to the agent output under `cascade`, with a per-transaction entry (in input order) in `cascade.rows[]`:

```json
{
  "cascade": {
    "enabled": true,
    "ml_threshold": 0.7,
    "scoring_method_counts": { "rule_only": 1, "cascade": 1 },
    "ml_bot_count": 1,
    "ml_human_count": 1,
    "rows": [
      { "index": 0, "rule_score": 0.04, "ml_score": null, "scoring_method": "rule_only", "is_bot": false },
      { "index": 1, "rule_score": 0.52, "ml_score": 0.83, "scoring_method": "cascade",  "is_bot": true  }
    ]
  }
}
```

Per-row fields:

| field            | type            | notes                                                                                  |
| ---------------- | --------------- | -------------------------------------------------------------------------------------- |
| `rule_score`     | float `0–1`     | rule-based bot probability. Multiply by 100 for the gate the 15 / 85 cutoffs apply to. |
| `ml_score`       | float `0–1`     | LightGBM probability; `null` when `scoring_method` is `"rule_only"`.                    |
| `scoring_method` | string          | `"rule_only"` (rule gate decided) or `"cascade"` (ML decided in the gray zone).         |
| `is_bot`         | boolean         | final per-tx classification.                                                            |

The cascade summary also carries `enabled` (whether the model loaded), `ml_threshold` (default `0.7`), `scoring_method_counts`, and `ml_bot_count` / `ml_human_count`.

### Distill Standard Envelope

Every agent in the Distill ecosystem accepts an **optional** standard envelope on input and **always** returns the standard envelope on output. It is fully backward compatible: existing (legacy) requests keep working unchanged.

#### Input — envelope mode

Wrap your normal input in `payload`:

```json
{
  "distill_version": "1.0",
  "agent_id": "6482",
  "session_id": "test-session-001",
  "payload": {
    "data": [
      { "tx_hash": "0xabc1", "amount": "500" }
    ]
  }
}
```

`distill_version`, `agent_id`, and `session_id` are all optional. If `session_id` is omitted, a UUID is generated for you (`crypto.randomUUID()`).

#### Input — legacy mode (backward compatible)

Send your input directly, with no wrapper — exactly as before:

```json
{
  "data": [
    { "tx_hash": "0xabc1", "amount": "500" }
  ]
}
```

#### Output — always enveloped

Both input modes produce the same envelope response:

```json
{
  "distill_version": "1.0",
  "agent_id": "6482",
  "session_id": "test-session-001",
  "status": "ok",
  "output": {
    "summary": { "total_transactions": 2, "bot_filtered": 0, "clean_transactions": 2 },
    "features": { "totalVolume": 1250, "cleanVolume": 1250 },
    "clean_data": [ "..." ],
    "suspicious_data": [],
    "cascade": {
      "enabled": true,
      "ml_threshold": 0.7,
      "scoring_method_counts": { "rule_only": 2, "cascade": 0 },
      "ml_bot_count": 0,
      "ml_human_count": 2,
      "rows": [
        { "index": 0, "rule_score": 0.04, "ml_score": null, "scoring_method": "rule_only", "is_bot": false }
      ]
    }
  },
  "processed_at": "2026-06-02T16:21:11.827Z"
}
```

| field          | notes                                                |
| -------------- | ---------------------------------------------------- |
| `status`       | `"ok"` or `"error"`                                  |
| `agent_id`     | echoed from the request, or `null` in legacy mode    |
| `session_id`   | from the request, or a generated UUID                |
| `output`       | the agent's normal output                            |
| `processed_at` | ISO 8601 timestamp                                   |

> The Lucid runtime nests this envelope under the top-level `output` field of its HTTP response: `{ "run_id": "...", "status": "succeeded", "output": { ...envelope... } }`.

The envelope helpers live in `src/lib/envelope.ts` (`parseEnvelope`, `wrapResponse`, `withEnvelope`). Run `bun run test-envelope.ts` to exercise both modes.

### Next steps

- Update `src/agent.ts` with your use case.
- Wire up `@lucid-agents/core` configuration and secrets (see `AGENTS.md` in the repo for details).
- Update `.env` with your actual PRIVATE_KEY and configuration values.
- Deploy with your preferred Bun-compatible platform when you're ready.


## Discovery — x402 Bazaar + A2A Agent Card

Refine is discoverable two ways:

- **x402 Bazaar** — the server registers `bazaarResourceServerExtension` (from `@x402/extensions`) on the resource server *before* the payment middleware, and the `/entrypoints/process/invoke` route declares its input/output examples + JSON Schemas via `declareDiscoveryExtension({ bodyType: "json", ... })`. That discovery metadata rides in the `PAYMENT-REQUIRED` header of every `402` challenge, so the CDP facilitator indexes Refine into the [x402 Bazaar](https://docs.cdp.coinbase.com) catalog after a settled payment. (Note: the discovery extension lives in the **header**, not the JSON body — the body is reshaped for crawlers like xgate.)
- **A2A Agent Card** — a full, static [A2A](https://a2a-protocol.org) Agent Card is served at [`/.well-known/agent-card.json`](https://distill-agent-production.up.railway.app/.well-known/agent-card.json) (public, no paywall) with skills, `securitySchemes`, x402 payment metadata, and the ERC-8004 registration (agentId `6482`).

The MCP Gateway also exposes Refine as the `refine` tool — see the [MCP Gateway docs](https://quitx5454.github.io/pulse/docs/mcp-gateway.html).

## Part of Distill

This agent is part of the **Distill** middleware suite (Refine · Shield · Trace). See the [Distill docs](https://quitx5454.github.io/pulse/docs/).
