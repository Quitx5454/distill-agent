import { z } from "zod";
import { createAgentApp } from "@lucid-agents/express";
import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";
import { normalizeInput } from "../utils/flatten";
import { defineSchema } from "../layers/schema";
import { detectBots } from "../layers/botDetection";
import { extractFeatures } from "../layers/features";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";

const agent = await createAgent({
  name: process.env.AGENT_NAME ?? "distill",
  version: process.env.AGENT_VERSION ?? "0.1.0",
  description: process.env.AGENT_DESCRIPTION ?? "Cleans raw blockchain transaction data, filters bots, and returns structured output for AI agents",
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// x402 ödeme duvarı — addEntrypoint'ten ÖNCE
const facilitator = new HTTPFacilitatorClient({
  url: process.env.PAYMENTS_FACILITATOR_URL ?? "https://www.x402.org/facilitator"
});
const resourceServer = new x402ResourceServer(facilitator);
registerExactEvmScheme(resourceServer);

app.use(paymentMiddleware({
  "/entrypoints/process/invoke": {
    accepts: [{
      scheme: "exact",
      price: "$0.02",
      network: "eip155:84532",
      payTo: process.env.PAYMENTS_RECEIVABLE_ADDRESS as `0x${string}`,
    }],
    description: "Clean raw blockchain transaction data and filter bots",
  },
}, resourceServer));

const inputSchema = z.object({
  data: z.unknown(),
});

addEntrypoint({
  key: "process",
  description: "Clean raw blockchain transaction data, filter bots, and return structured output",
  input: inputSchema,
  handler: async (ctx) => {
    const input = ctx.input as z.infer<typeof inputSchema>;

    let rawArray: unknown[];
    if (Array.isArray(input.data)) {
      rawArray = input.data;
    } else if (
      typeof input.data === 'object' &&
      input.data !== null &&
      Array.isArray((input.data as Record<string, unknown>)['data'])
    ) {
      rawArray = (input.data as Record<string, unknown>)['data'] as unknown[];
    } else {
      return { output: { error: "Invalid input: expected array or { data: [...] } format" } };
    }

    const rows = normalizeInput(rawArray);

    if (rows.length === 0) {
      return { output: { error: "No rows found in input data" } };
    }

    if (rows.length > 10000) {
      return { output: { error: "Too many rows. Maximum 10,000 rows per request." } };
    }

    const schemaResult = await defineSchema(rows);
    if (!schemaResult.success) {
      return { output: { error: schemaResult.error } };
    }
    const columns = schemaResult.columns;

    const botResult = detectBots(rows, columns);
    const output = extractFeatures(botResult, columns);

    return { output };
  },
});

export { app };
