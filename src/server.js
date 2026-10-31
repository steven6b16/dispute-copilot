import 'dotenv/config';
import { createApp } from './app.js';
import { createStore } from './store.js';
import { createPayPalClient } from './paypal.js';
import { createTriageEngine } from './ai.js';
import { STORE_POLICY } from './fixtures.js';

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV = 'sandbox',
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL,
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

const stores = { demo: createStore() };
if (paypal) stores.sandbox = createStore({ paypal });
const ai = createTriageEngine({ apiKey: ANTHROPIC_API_KEY, model: ANTHROPIC_MODEL || undefined });
const app = createApp({ stores, ai, policy: STORE_POLICY_TEXT || STORE_POLICY });

app.listen(PORT, () => {
  console.log(`Dispute Copilot on http://localhost:${PORT}`);
  console.log(`  data: ${stores.sandbox ? 'PayPal sandbox + sample disputes' : 'sample disputes only (no PayPal credentials set)'}`);
  console.log(`  AI:   ${ai.engine === 'claude' ? `Claude (${ai.model})` : 'built-in heuristic (no ANTHROPIC_API_KEY set)'}`);
});
