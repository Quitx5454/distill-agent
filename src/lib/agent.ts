import { z } from "zod";
import { createAgentApp } from "@lucid-agents/express";
import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";
import { wallets } from "@lucid-agents/wallet";
import { identity, identityFromEnv } from "@lucid-agents/identity";
import { normalizeInput } from "../utils/flatten";
import { defineSchema } from "../layers/schema";
import { detectBots } from "../layers/botDetection";
import { extractFeatures } from "../layers/features";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { getAuthHeaders } from "@coinbase/cdp-sdk/auth";

const agent = await createAgent({
  name: process.env.AGENT_NAME ?? "distill",
  version: process.env.AGENT_VERSION ?? "0.1.0",
  description: process.env.AGENT_DESCRIPTION ?? "Cleans raw blockchain transaction data, filters bots, and returns structured output for AI agents",
})
  .use(http())
  .use(wallets({
    config: (() => {
      const pk = process.env.AGENT_WALLET_PRIVATE_KEY ?? process.env.DEVELOPER_WALLET_PRIVATE_KEY;
      if (!pk) return undefined;
      const walletCfg = {
        type: "local" as const,
        privateKey: pk.startsWith("0x") ? pk : `0x${pk}`,
        walletClient: {
          rpcUrl: process.env.RPC_URL ?? "https://sepolia.base.org",
          chainId: parseInt(process.env.CHAIN_ID ?? "84532"),
        },
      };
      return { agent: walletCfg, developer: walletCfg };
    })(),
  }))
  .use(payments({ config: paymentsFromEnv() }))
  .use(identity({
    config: {
      ...identityFromEnv(),
      // ERC-8004 kayıt tamamlandı — trust config manuel geçiriliyor (wallet connector EIP-1559 bug bypass)
      trust: process.env.AGENT_ID ? {
        registrations: [{
          agentId: process.env.AGENT_ID,
          agentRegistry: `eip155:${process.env.CHAIN_ID ?? "84532"}:0x8004A818BFB912233c491871b3d84c89A494BD9e`,
          agentAddress: `eip155:${process.env.CHAIN_ID ?? "84532"}:0x0D85F85B3556404553F0F3b3Ed1F08BCBF7B7951`,
          agentURI: `https://${process.env.AGENT_DOMAIN}/.well-known/agent-registration.json`,
        }],
        trustModels: ["feedback", "inference-validation"],
      } : undefined,
    },
  }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// x402 ödeme duvarı — addEntrypoint'ten ÖNCE
const CDP_HOST = "api.cdp.coinbase.com";
const CDP_BASE = "/platform/v2/x402";
const cdpKeyId = process.env.CDP_API_KEY_ID!;
const cdpKeySecret = process.env.CDP_API_KEY_SECRET!;

const facilitator = new HTTPFacilitatorClient({
  url: `https://${CDP_HOST}${CDP_BASE}`,
  createAuthHeaders: async () => {
    const [verify, settle, supported] = await Promise.all([
      getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "POST", requestHost: CDP_HOST, requestPath: `${CDP_BASE}/verify` }),
      getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "POST", requestHost: CDP_HOST, requestPath: `${CDP_BASE}/settle` }),
      getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "GET",  requestHost: CDP_HOST, requestPath: `${CDP_BASE}/supported` }),
    ]);
    return {
      verify:    { Authorization: verify.Authorization },
      settle:    { Authorization: settle.Authorization },
      supported: { Authorization: supported.Authorization },
    };
  },
});
const resourceServer = new x402ResourceServer(facilitator);
registerExactEvmScheme(resourceServer);

// Decode PAYMENT-REQUIRED header into body for crawlers like xgate that don't read headers
app.use((_req: any, res: any, next: any) => {
  const origJson = res.json.bind(res);
  res.json = function (body: any) {
    if (res.statusCode === 402 && (!body || Object.keys(body).length === 0)) {
      const header = (res.getHeader("PAYMENT-REQUIRED") ?? res.getHeader("payment-required")) as string | undefined;
      if (header) {
        try {
          const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
          return origJson(decoded);
        } catch {}
      }
    }
    return origJson(body);
  };
  next();
});

app.use(paymentMiddleware({
  "/entrypoints/process/invoke": {
    accepts: [{
      scheme: "exact",
      price: "$0.02",
      network: "eip155:8453",
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
