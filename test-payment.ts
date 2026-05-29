import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { toClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";

const PRIVATE_KEY = process.env.TEST_PRIVATE_KEY as `0x${string}`;
if (!PRIVATE_KEY) {
  console.error("TEST_PRIVATE_KEY env var is required");
  process.exit(1);
}

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4000";

const account = privateKeyToAccount(PRIVATE_KEY);
console.log("Payer address:", account.address);

const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(),
});

const signer = { ...toClientEvmSigner(walletClient), address: account.address };
const client = new x402Client();
registerExactEvmScheme(client, { signer });

const fetch402 = wrapFetchWithPayment(fetch, client);

console.log(`\nSending request to ${SERVER_URL}/entrypoints/process/invoke ...`);

const response = await fetch402(`${SERVER_URL}/entrypoints/process/invoke`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    input: { data: [{ tx_hash: "0xabc1", amount: "500" }] },
  }),
});

console.log("Final status:", response.status);
const result = await response.json();
console.log("Result:", JSON.stringify(result, null, 2));
