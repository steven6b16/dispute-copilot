import 'dotenv/config';
import { createApp } from './app.js';
import { createStore } from './store.js';
import { createPayPalClient } from './paypal.js';
import { createTriageEngine } from './ai.js';
import { STORE_POLICY } from './fixtures.js';
import { readFileSync, existsSync } from 'node:fs';

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV = 'sandbox',
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL,
  STORE_POLICY_TEXT,
  PORT = 3000,
} = process.env;

if (PAYPAL_ENV !== 'sandbox') {
  console.error('This project only runs against the PayPal sandbox. Set PAYPAL_ENV=sandbox.');
  process.exit(1);
}

const paypal = PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET
  ? createPayPalClient({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, env: 'sandbox' })
  : null;

const reviewsFile = new URL('./sample-reviews.json', import.meta.url);
const savedReviews = existsSync(reviewsFile) ? JSON.parse(readFileSync(reviewsFile, 'utf8')) : {};
const sandbox = paypal ? createStore({ paypal }) : null;
const demoFactory = () => createStore({ savedReviews });
const ai = createTriageEngine({
  apiKey: OPENROUTER_API_KEY,
  model: OPENROUTER_MODEL || undefined,
  maxCallsPerHour: Number(process.env.AI_MAX_CALLS_PER_HOUR) || 60,
  timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 30_000,
});
const app = createApp({
  sandbox,
  demoFactory,
  ai,
  policy: STORE_POLICY_TEXT || STORE_POLICY,
  // Render sets RENDER=true; treat a Render deploy as the public demo unless told otherwise.
  publicDemo: process.env.PUBLIC_DEMO ? process.env.PUBLIC_DEMO === 'true' : process.env.RENDER === 'true',
  adminToken: process.env.DEMO_ADMIN_TOKEN || '',
});

app.listen(PORT, () => {
  console.log(`Dispute Copilot on http://localhost:${PORT}`);
  console.log(`  data: ${sandbox ? 'PayPal sandbox + sample shop' : 'sample shop only (no PayPal credentials set)'}`);
  console.log(`  AI:   ${ai.engine === 'openrouter' ? `OpenRouter (${ai.model})` : 'built-in rules (no OPENROUTER_API_KEY set)'}`);
});
