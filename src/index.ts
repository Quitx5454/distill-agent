import express from 'express';
import { app as agentApp } from './lib/agent';
import agentCard from '../agent-card.json';

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

console.log(`Starting agent server on port ${port}...`);

// CORS runs FIRST — before the Lucid agent app and its x402 payment middleware —
// so browser clients can read the PAYMENT-REQUIRED header and OPTIONS preflights
// short-circuit with 200 instead of hitting the paywall.
const wrapper = express();
wrapper.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE, X-Payment");
  res.header("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, WWW-Authenticate");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// Public A2A Agent Card — static, no payment wall. Registered on the wrapper
// BEFORE the agent app so it takes precedence over the manifest that Lucid's
// createAgentApp() serves at this same path.
wrapper.get('/.well-known/agent-card.json', (_req, res) => {
  res.type('application/json').send(JSON.stringify(agentCard));
});

wrapper.use('/', agentApp);

const server = wrapper.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

export default server;
