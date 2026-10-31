// AI triage: reads a dispute plus the merchant's own records and returns a
// structured recommendation with ready-to-send drafts. Nothing is ever sent
// to PayPal without a human clicking "Approve".

export const ACTIONS = ['CONTEST_WITH_EVIDENCE', 'OFFER_PARTIAL_REFUND', 'ACCEPT_CLAIM', 'REQUEST_INFO'];

const TRIAGE_TOOL = {
  name: 'submit_triage',
  description: 'Submit the triage decision and drafts for one PayPal dispute.',
  parameters: {
    type: 'object',
    properties: {
      riskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'], description: 'Risk of losing money if handled badly.' },
      winLikelihood: { type: 'integer', minimum: 0, maximum: 100, description: 'Estimated chance PayPal rules for the seller if contested.' },
      recommendedAction: { type: 'string', enum: ACTIONS },
      offerAmount: { type: 'number', description: 'Refund to offer, only for OFFER_PARTIAL_REFUND. Use 0 otherwise.' },
      rationale: { type: 'string', description: '2-4 sentences a busy shop owner can read in 10 seconds.' },
      fraudSignals: { type: 'array', items: { type: 'string' } },
      evidenceChecklist: {
        type: 'array',
        items: {
          type: 'object',
          properties: { item: { type: 'string' }, have: { type: 'boolean' } },
          required: ['item', 'have'],
        },
      },
      evidenceType: { type: 'string', enum: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER'] },
      trackingNumber: { type: 'string', description: 'Only if present in the merchant records, else empty.' },
      carrier: { type: 'string', description: 'Only if present in the merchant records, else empty.' },
      evidenceNote: { type: 'string', description: 'Statement to PayPal. Factual, only uses facts provided.' },
      buyerMessage: { type: 'string', description: 'Polite, short message to the buyer.' },
    },
    required: ['riskLevel', 'winLikelihood', 'recommendedAction', 'rationale', 'evidenceChecklist', 'evidenceType', 'evidenceNote', 'buyerMessage'],
  },
};

const SYSTEM = `You are a PayPal dispute specialist working for a small online shop.
For each dispute you decide the most profitable honest response, considering:
- PayPal seller protection rules (proof of delivery to the buyer's address wins "not received"; "not as described" is decided on whether the item matches the listing; unauthorised claims with fraud signals usually go against the seller unless delivery matched the billing address).
- The cost of fighting vs. the amount at stake (a $20 dispute is rarely worth a long fight, but repeat abuse matters).
- The deadline.
- The shop's own policy.
Rules:
- You can see attachment file names but not their contents; never claim to know what a file shows.
- Never invent facts, tracking numbers, dates or documents. If evidence is missing, list it in evidenceChecklist with have=false and lower winLikelihood.
- If the shop is clearly at fault, recommend ACCEPT_CLAIM or a refund and say so plainly.
- Drafts must be ready to send: no placeholders like [NAME].
Always answer by calling submit_triage. If you cannot call tools, reply with only the JSON object for submit_triage.`;

export function buildPrompt(c, policy) {
  return [
    `Dispute ${c.id}`,
    `Reason: ${c.reasonLabel} (${c.reason})`,
    `Stage: ${c.stage}, status: ${c.status}`,
    `Amount: ${c.amount.toFixed(2)} ${c.currency}`,
    `Seller response due in: ${c.daysLeft ?? 'unknown'} days`,
    `Buyer: ${c.buyerName}`,
    `Items: ${c.items.map((i) => `${i.quantity} x ${i.name}`).join('; ') || 'unknown'}`,
    `Invoice: ${c.invoiceNumber ?? 'n/a'}`,
    '',
    'Messages:',
    ...(c.messages.length
      ? c.messages.map((m) => `- ${m.from}: ${m.text}${m.documents?.length ? ` [attached: ${m.documents.map((x) => x.name).join(', ')}]` : ''}`)
      : ['- (none)']),
    ...(c.documents?.length ? ['', `Other attachments on the case: ${c.documents.map((x) => x.name).join(', ')}`] : []),
    '',
    'Merchant records:',
    `- Fulfillment: ${c.merchantFacts?.fulfillment || '(none provided)'}`,
    `- Notes: ${c.merchantFacts?.notes || '(none provided)'}`,
    '',
    policy ? `Shop policy:\n${policy}` : 'Shop policy: (not provided)',
  ].join('\n');
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

class BadAnswerError extends Error {}

export function createTriageEngine({
  apiKey,
  model = 'openrouter/free',
  maxCallsPerHour = 60,
  timeoutMs = 30_000,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const engine = apiKey ? 'openrouter' : 'heuristic';
  const calls = []; // timestamps of model calls in the last hour

  // The demo is public, so cap model calls to protect the API budget.
  function underBudget() {
    const cutoff = now() - 3_600_000;
    while (calls.length && calls[0] < cutoff) calls.shift();
    if (calls.length >= maxCallsPerHour) return false;
    calls.push(now());
    return true;
  }

  async function callModel(c, policy) {
    const res = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Dispute Copilot',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildPrompt(c, policy) },
        ],
        tools: [{ type: 'function', function: TRIAGE_TOOL }],
        tool_choice: { type: 'function', function: { name: TRIAGE_TOOL.name } },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `OpenRouter request failed (${res.status})`);
    const msg = data.choices?.[0]?.message ?? {};
    const args = msg.tool_calls?.[0]?.function?.arguments ?? extractJson(msg.content);
    let input;
    try {
      input = typeof args === 'string' ? JSON.parse(args) : args;
    } catch {
      input = null;
    }
    input = unwrap(input);
    if (!input) throw new BadAnswerError('Model did not return a triage');
    return { input, usedModel: data.model || model };
  }

  async function triage(c, policy) {
    if (!apiKey) return heuristicTriage(c);
    if (!underBudget()) return { ...heuristicTriage(c), fallbackReason: 'the hourly AI limit for this public demo was reached' };
    try {
      let result;
      try {
        result = await callModel(c, policy);
      } catch (err) {
        // A bad answer is worth one retry (openrouter/free picks another model); slow or rate-limited calls are not.
        if (!(err instanceof BadAnswerError) || !underBudget()) throw err;
        result = await callModel(c, policy);
      }
      return sanitize({ ...result.input, source: 'ai', model: result.usedModel }, c);
    } catch (err) {
      // Free models are rate limited and sometimes return bad output: keep the app usable.
      const reason = err.name === 'TimeoutError' ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : err.message;
      console.error('AI triage failed, using rules:', reason);
      return { ...heuristicTriage(c), fallbackReason: `the AI model was unavailable (${reason})` };
    }
  }

  return { engine, model: apiKey ? model : null, triage };
}

// Weaker models sometimes nest the answer ({"submit_triage": {...}}, {"parameters": {...}})
// or send it as a JSON string; dig one or two levels for the object that has a decision.
export function unwrap(value, depth = 0) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || depth > 2) return null;
  if (typeof value.recommendedAction === 'string') return value;
  for (const v of Object.values(value)) {
    const found = unwrap(v, depth + 1);
    if (found) return found;
  }
  return null;
}

// Some models answer in plain text instead of calling the tool; take the JSON object out.
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Keeps model output inside safe bounds before it reaches the UI or PayPal.
export function sanitize(t, c) {
  const out = { ...t };
  if (!ACTIONS.includes(out.recommendedAction)) out.recommendedAction = 'REQUEST_INFO';
  out.winLikelihood = Math.max(0, Math.min(100, Math.round(Number(out.winLikelihood) || 0)));
  if (out.recommendedAction === 'OFFER_PARTIAL_REFUND') {
    const amt = Number(out.offerAmount);
    out.offerAmount = Number.isFinite(amt) && amt > 0 ? Math.min(amt, c.amount) : Math.round(c.amount * 0.5 * 100) / 100;
  } else {
    out.offerAmount = null;
  }
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(out.riskLevel)) out.riskLevel = 'MEDIUM';
  if (!['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER'].includes(out.evidenceType)) out.evidenceType = 'OTHER';
  for (const k of ['rationale', 'evidenceNote', 'buyerMessage']) out[k] = typeof out[k] === 'string' ? out[k] : '';
  out.trackingNumber = out.trackingNumber ? String(out.trackingNumber) : null;
  out.carrier = out.carrier ? String(out.carrier) : null;
  out.fraudSignals = Array.isArray(out.fraudSignals) ? out.fraudSignals.map(String) : [];
  out.evidenceChecklist = Array.isArray(out.evidenceChecklist)
    ? out.evidenceChecklist.filter((i) => i && i.item).map((i) => ({ item: String(i.item), have: Boolean(i.have) }))
    : [];
  return out;
}

const TRACKING_RE = /\b(\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{2}|1Z[0-9A-Z]{16})\b/;

// Rule-based fallback so the app is fully usable without an AI key.
export function heuristicTriage(c) {
  const facts = `${c.merchantFacts?.fulfillment ?? ''} ${c.merchantFacts?.notes ?? ''}`.toLowerCase();
  const tracking = (c.merchantFacts?.fulfillment ?? '').match(TRACKING_RE)?.[0]?.replace(/\s/g, '') ?? null;
  const delivered = facts.includes('delivered');
  const base = {
    source: 'heuristic',
    fraudSignals: [],
    trackingNumber: null,
    carrier: null,
    offerAmount: null,
  };

  if (/never issued|missed it|two captures|double/.test(facts)) {
    return sanitize({
      ...base,
      riskLevel: 'LOW',
      winLikelihood: 5,
      recommendedAction: 'ACCEPT_CLAIM',
      rationale: 'Your own records show the buyer is right. Refunding now avoids a loss on your dispute ratio and any extra fees.',
      evidenceChecklist: [{ item: 'Shop records confirm the error', have: true }],
      evidenceType: 'PROOF_OF_REFUND',
      evidenceNote: 'We have confirmed the error on our side and are refunding the buyer in full.',
      buyerMessage: `Hi ${firstName(c)}, you're right and we're sorry. We've issued your refund in full. Thank you for your patience.`,
    }, c);
  }

  if (c.reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED') {
    const have = Boolean(tracking && delivered);
    return sanitize({
      ...base,
      riskLevel: c.amount > 100 ? 'HIGH' : 'MEDIUM',
      winLikelihood: have ? 85 : 25,
      recommendedAction: have ? 'CONTEST_WITH_EVIDENCE' : 'REQUEST_INFO',
      trackingNumber: tracking,
      carrier: tracking ? 'USPS' : null,
      rationale: have
        ? 'Tracking shows delivery to the buyer\'s address, which is what PayPal needs for "item not received". Submit the tracking as proof of fulfillment.'
        : 'No delivery confirmation on file. Find tracking before the deadline or this will likely be lost.',
      evidenceChecklist: [
        { item: 'Tracking number', have: Boolean(tracking) },
        { item: 'Carrier shows delivered to buyer address', have: delivered },
      ],
      evidenceType: 'PROOF_OF_FULFILLMENT',
      evidenceNote: have
        ? `The order was shipped and the carrier confirms delivery to the buyer's address. Tracking number: ${tracking}.`
        : 'We are gathering shipping records for this order.',
      buyerMessage: have
        ? `Hi ${firstName(c)}, the carrier shows your parcel was delivered to your address. Could you check with neighbours or your building's mail area? We're happy to help further.`
        : `Hi ${firstName(c)}, sorry for the trouble. We're checking with the carrier and will update you shortly.`,
    }, c);
  }

  if (c.reason === 'UNAUTHORISED') {
    const signals = [];
    if (facts.includes('different address')) signals.push('Shipping address differs from billing address');
    if (facts.includes('forwarder')) signals.push('Shipped to a freight forwarder');
    if (facts.includes('first-time') || facts.includes('minutes before')) signals.push('Brand-new account');
    if (facts.includes('expedited')) signals.push('Expedited shipping');
    return sanitize({
      ...base,
      riskLevel: 'HIGH',
      winLikelihood: signals.length >= 2 ? 15 : 45,
      recommendedAction: signals.length >= 2 ? 'ACCEPT_CLAIM' : 'CONTEST_WITH_EVIDENCE',
      fraudSignals: signals,
      rationale: signals.length >= 2
        ? 'This looks like real card fraud, and the item went to an address that does not match the account holder, so seller protection is unlikely to apply. Accept, then block this buyer pattern.'
        : 'Few fraud signals. Contest with proof of delivery to the account address.',
      evidenceChecklist: [{ item: 'Delivery matches account holder address', have: !facts.includes('different address') }],
      evidenceType: 'OTHER',
      evidenceNote: 'We are reviewing this unauthorised transaction claim.',
      buyerMessage: 'We are sorry your account was used without permission. We have flagged the order on our side.',
    }, c);
  }

  // Not as described / other: low amounts are usually cheaper to settle.
  const small = c.amount < 30;
  const listingContradicts = /never claimed|listing says/.test(facts);
  return sanitize({
    ...base,
    riskLevel: small ? 'LOW' : 'MEDIUM',
    winLikelihood: listingContradicts ? 55 : 35,
    recommendedAction: small ? 'OFFER_PARTIAL_REFUND' : listingContradicts ? 'OFFER_PARTIAL_REFUND' : 'CONTEST_WITH_EVIDENCE',
    offerAmount: Math.round(c.amount * (small ? 0.5 : 0.3) * 100) / 100,
    rationale: small
      ? 'The amount is small and taste complaints are hard to win. A partial refund keeps the customer and closes the case fast.'
      : 'The listing does not promise what the buyer claims, but there is a known quality issue with this batch. A partial refund is cheaper than a return fight.',
    evidenceChecklist: [
      { item: 'Copy of the product listing', have: listingContradicts },
      { item: 'Photos from the buyer', have: false },
    ],
    evidenceType: 'OTHER',
    evidenceNote: 'The item was delivered as listed. We have offered the buyer a partial refund as a goodwill resolution.',
    buyerMessage: `Hi ${firstName(c)}, sorry this wasn't what you hoped for. We'd like to make it right with a partial refund. Let us know if that works for you.`,
  }, c);
}

function firstName(c) {
  const n = (c.buyerName || '').replace(/^Account holder:\s*/i, '').split(' ')[0];
  return n && !n.endsWith('.') ? n : 'there';
}
