// One-time helper: print the RFC 8785 (JCS) canonical form of agent-card.json.
//
// Canonicalization only — this does NOT sign the card. Signing (filling the
// `signatures` array) is a separate, future step that will consume this output.
//
//   bun run scripts/canonicalize-card.ts
//
import { canonicalize } from "json-canonicalize";
import card from "../agent-card.json";

process.stdout.write(canonicalize(card) + "\n");
