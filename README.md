## distill-agent

This project was scaffolded with `create-agent-kit` and ships with a ready-to-run agent app built on [`@lucid-agents/core`](https://www.npmjs.com/package/@lucid-agents/core).

### Quick start

```sh
bun install
bun run dev
```

The dev command runs `bun` in watch mode, starts the HTTP server, and reloads when you change files inside `src/`.

### Project structure

- `src/agent.ts` – defines your agent manifest and entrypoints.
- `src/index.ts` – boots a Bun HTTP server with the agent.

### Default entrypoints

- `echo` – Echo input text

### Available scripts

- `bun run dev` – start the agent in watch mode.
- `bun run start` – start the agent once.
- `bun run agent` – run the agent module directly (helpful for quick experiments).
- `bunx tsc --noEmit` – type-check the project.

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
    "suspicious_data": []
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


## Part of Distill

This agent is part of the **Distill** middleware suite. Use the Pipeline agent to chain multiple agents in one call: [Pipeline docs](https://quitx5454.github.io/pulse/docs/pipeline.html).
