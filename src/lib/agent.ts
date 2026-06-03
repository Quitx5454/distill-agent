import { z } from "zod";
import { createAgentApp } from "@lucid-agents/express";
import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";
import { wallets } from "@lucid-agents/wallet";
import { identity, identityFromEnv } from "@lucid-agents/identity";
import { processDistill, type DistillInput } from "./process";
import { parseEnvelope, wrapResponse, withEnvelope } from "./envelope";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
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

// NOTE: CORS is handled by the wrapper Express app in src/index.ts so it runs
// before this agent app's x402 payment middleware (and OPTIONS preflights).
// The public A2A /.well-known/agent-card.json route is also served from the
// wrapper, since it must take precedence over the manifest that
// createAgentApp() registers internally at that same path.

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
// x402 Bazaar discovery extension — registered explicitly BEFORE the payment
// middleware so the CDP facilitator indexes this resource into the Bazaar
// catalog. Per-route input/output schemas are declared via the route's
// `extensions` block below (declareDiscoveryExtension).
resourceServer.registerExtension(bazaarResourceServerExtension);

// Decode PAYMENT-REQUIRED header into body for crawlers like xgate
// xgate expects: resource=string, accepts[].resource, accepts[].description, accepts[].maxAmountRequired
app.use((_req: any, res: any, next: any) => {
  const origJson = res.json.bind(res);
  res.json = function (body: any) {
    if (res.statusCode === 402 && (!body || Object.keys(body).length === 0)) {
      const header = (res.getHeader("PAYMENT-REQUIRED") ?? res.getHeader("payment-required")) as string | undefined;
      if (header) {
        try {
          const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
          const resourceUrl: string = typeof decoded.resource === "string"
            ? decoded.resource
            : decoded.resource?.url ?? "";
          const resourceDesc: string = decoded.resource?.description ?? "";
          const xgateBody = {
            x402Version: decoded.x402Version,
            resource: resourceUrl,
            accepts: (decoded.accepts ?? []).map((a: any) => ({
              scheme: a.scheme,
              network: a.network,
              asset: a.asset,
              payTo: a.payTo,
              maxAmountRequired: a.amount ?? a.maxAmountRequired,
              maxTimeoutSeconds: a.maxTimeoutSeconds,
              resource: resourceUrl,
              description: resourceDesc,
              mimeType: a.mimeType ?? "",
              extra: a.extra,
              input: { method: "POST", type: "http", bodyType: "json" },
            })),
          };
          return origJson(xgateBody);
        } catch {}
      }
    }
    return origJson(body);
  };
  next();
});

// Row limit pre-check BEFORE payment — reads Content-Length header only,
// no stream consumption. Blocks clearly oversized requests (10k rows ≈ 2MB max).
// The handler also enforces exact row count as a second line of defence.
app.use("/entrypoints/process/invoke", (req: any, res: any, next: any) => {
  const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
  if (contentLength > 3 * 1024 * 1024) {
    return res.status(413).json({
      error: "Payload too large",
      message: "Request body exceeds the 10,000 row limit (~3MB). Send fewer rows per request.",
      limit: 10000,
    });
  }
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
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: {
        data: [
          { hash: "0xaaa1", from: "0x104b5768fe505c400dd98f447665cb5c6fca388a", to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", value: "1000000", timestamp: 1717400000 },
          { hash: "0xaaa2", from: "0x0000000000000000000000000000000000000bot", to: "0x104b5768fe505c400dd98f447665cb5c6fca388a", value: "1", timestamp: 1717400001 },
        ],
      },
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          data: {
            type: "array",
            description: "Raw transaction rows. Column names are flexible and auto-detected.",
            items: { type: "object", additionalProperties: true },
          },
        },
        required: ["data"],
        additionalProperties: false,
      },
      output: {
        example: {
          summary: { total_transactions: 2, bot_filtered: 1, suspicious: 0, clean_transactions: 1, bot_ratio: 0.5 },
          warnings: [],
          features: { totalVolume: "1000001", cleanVolume: "1000000" },
          clean_data: [{ hash: "0xaaa1", from: "0x104b5768fe505c400dd98f447665cb5c6fca388a", to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", value: "1000000", timestamp: 1717400000 }],
          suspicious_data: [],
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            summary: {
              type: "object",
              properties: {
                total_transactions: { type: "integer" },
                bot_filtered: { type: "integer" },
                suspicious: { type: "integer" },
                clean_transactions: { type: "integer" },
                bot_ratio: { type: "number" },
              },
              required: ["total_transactions", "bot_filtered", "suspicious", "clean_transactions", "bot_ratio"],
            },
            warnings: { type: "array", items: { type: "string" } },
            features: { type: "object", additionalProperties: true },
            clean_data: { type: "array", items: { type: "object", additionalProperties: true } },
            suspicious_data: { type: "array", items: { type: "object", additionalProperties: true } },
          },
          required: ["summary", "warnings", "features", "clean_data", "suspicious_data"],
        },
      },
    }),
  },
}, resourceServer));

const inputSchema = z.object({
  data: z.unknown(),
});

addEntrypoint({
  key: "process",
  description: "Clean raw blockchain transaction data, filter bots, and return structured output",
  // Accept either the Distill envelope ({ ..., payload: { data } }) or the
  // legacy bare input ({ data }). The handler unwraps via parseEnvelope.
  input: withEnvelope(inputSchema),
  handler: async (ctx) => {
    const { payload, sessionId, agentId } = parseEnvelope<DistillInput>(ctx.input);

    const result = await processDistill(payload);
    if (!result.ok) {
      return { output: wrapResponse({ error: result.error }, sessionId, agentId, "error") };
    }

    return { output: wrapResponse(result.output, sessionId, agentId, "ok") };
  },
});

export { app };
