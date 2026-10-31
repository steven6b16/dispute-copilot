import { describe, it, expect, vi } from 'vitest';
import { heuristicTriage, sanitize, createTriageEngine, buildPrompt, extractJson } from '../src/ai.js';
import { normalizeDispute } from '../src/normalize.js';
import { demoDisputes, demoMerchantFacts } from '../src/fixtures.js';

const facts = demoMerchantFacts();
const cases = Object.fromEntries(
  demoDisputes().map((d) => {
    const c = normalizeDispute(d);
    c.merchantFacts = facts[c.transactionId] ?? {};
    return [c.id, c];
  }),
);

describe('heuristic triage', () => {
  it('contests "not received" when tracking shows delivery', () => {
    const t = heuristicTriage(cases['PP-D-48211A']);
    expect(t.recommendedAction).toBe('CONTEST_WITH_EVIDENCE');
    expect(t.evidenceType).toBe('PROOF_OF_FULFILLMENT');
    expect(t.trackingNumber).toBe('9400111899223344552107');
    expect(t.winLikelihood).toBeGreaterThan(70);
  });

  it('asks for info when there is no tracking', () => {
    const c = { ...cases['PP-D-48211A'], merchantFacts: {} };
    expect(heuristicTriage(c).recommendedAction).toBe('REQUEST_INFO');
  });

  it('accepts when the shop is at fault', () => {
    expect(heuristicTriage(cases['PP-D-48355B']).recommendedAction).toBe('ACCEPT_CLAIM');
    expect(heuristicTriage(cases['PP-D-48390E']).recommendedAction).toBe('ACCEPT_CLAIM');
  });

  it('flags fraud signals on unauthorised claims', () => {
    const t = heuristicTriage(cases['PP-D-48302F']);
    expect(t.fraudSignals.length).toBeGreaterThanOrEqual(2);
    expect(t.recommendedAction).toBe('ACCEPT_CLAIM');
  });

  it('offers a partial refund on small "not as described" claims', () => {
    const t = heuristicTriage(cases['PP-D-48412D']);
    expect(t.recommendedAction).toBe('OFFER_PARTIAL_REFUND');
    expect(t.offerAmount).toBeGreaterThan(0);
    expect(t.offerAmount).toBeLessThan(22);
  });

  it('never leaves template placeholders in drafts', () => {
    for (const c of Object.values(cases)) {
      const t = heuristicTriage(c);
      expect(t.buyerMessage).not.toMatch(/\[[A-Z ]+\]/);
      expect(t.evidenceNote).not.toMatch(/\[[A-Z ]+\]/);
    }
  });
});

describe('sanitize', () => {
  const c = cases['PP-D-48297C'];
  it('caps offers at the disputed amount', () => {
    expect(sanitize({ recommendedAction: 'OFFER_PARTIAL_REFUND', offerAmount: 9999 }, c).offerAmount).toBe(c.amount);
  });
  it('clamps odds and rejects unknown actions', () => {
    const t = sanitize({ recommendedAction: 'SUE_THEM', winLikelihood: 140 }, c);
    expect(t.recommendedAction).toBe('REQUEST_INFO');
    expect(t.winLikelihood).toBe(100);
  });
  it('drops offer amounts for non-offer actions', () => {
    expect(sanitize({ recommendedAction: 'ACCEPT_CLAIM', offerAmount: 10 }, c).offerAmount).toBeNull();
  });
});

const triageArgs = {
  riskLevel: 'MEDIUM',
  winLikelihood: 62,
  recommendedAction: 'OFFER_PARTIAL_REFUND',
  offerAmount: 20,
  rationale: 'r',
  evidenceChecklist: [{ item: 'Listing copy', have: true }],
  evidenceType: 'OTHER',
  evidenceNote: 'n',
  buyerMessage: 'm',
};

function openRouterReply(message, status = 200, model = 'some/free-model') {
  return vi.fn(async () => new Response(JSON.stringify(status === 200 ? { model, choices: [{ message }] } : { error: { message: 'Rate limit exceeded' } }), { status }));
}

describe('OpenRouter engine', () => {
  it('forces the triage tool and returns sanitized output', async () => {
    const fetchImpl = openRouterReply({ tool_calls: [{ function: { name: 'submit_triage', arguments: JSON.stringify(triageArgs) } }] });
    const engine = createTriageEngine({ apiKey: 'k', fetchImpl });
    const t = await engine.triage(cases['PP-D-48297C'], 'policy');
    const [url, opts] = fetchImpl.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(opts.headers.Authorization).toBe('Bearer k');
    expect(body.model).toBe('openrouter/free');
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'submit_triage' } });
    expect(body.messages[1].content).toContain('Supplier batch');
    expect(t).toMatchObject({ source: 'ai', model: 'some/free-model', offerAmount: 20, winLikelihood: 62 });
  });

  it('accepts a plain JSON answer when the model skips the tool', async () => {
    const fetchImpl = openRouterReply({ content: `Here you go:\n${JSON.stringify(triageArgs)}` });
    const t = await createTriageEngine({ apiKey: 'k', fetchImpl }).triage(cases['PP-D-48297C']);
    expect(t.source).toBe('ai');
    expect(t.recommendedAction).toBe('OFFER_PARTIAL_REFUND');
  });

  it('falls back to rules when the model is rate limited', async () => {
    const t = await createTriageEngine({ apiKey: 'k', fetchImpl: openRouterReply(null, 429) }).triage(cases['PP-D-48211A']);
    expect(t.source).toBe('heuristic');
    expect(t.fallbackReason).toMatch(/Rate limit/);
  });

  it('falls back to rules once the hourly budget is used', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(triageArgs) } }] } }] })));
    let t = 0;
    const engine = createTriageEngine({ apiKey: 'k', fetchImpl, maxCallsPerHour: 2, now: () => t });
    const c = cases['PP-D-48211A'];
    await engine.triage(c);
    await engine.triage(c);
    const third = await engine.triage(c);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(third.source).toBe('heuristic');
    expect(third.fallbackReason).toMatch(/hourly/);
    t += 3_600_001;
    expect((await engine.triage(c)).source).toBe('ai');
  });

  it('uses rules without a key', () => {
    expect(createTriageEngine({}).engine).toBe('heuristic');
  });

  it('includes merchant records and policy in the prompt', () => {
    const p = buildPrompt(cases['PP-D-48211A'], 'POLICY TEXT');
    expect(p).toContain('9400 1118');
    expect(p).toContain('POLICY TEXT');
  });

  it('extracts JSON from text and ignores junk', () => {
    expect(extractJson('x {"a":1} y')).toEqual({ a: 1 });
    expect(extractJson('no json')).toBeNull();
  });
});

describe('sanitize hardening', () => {
  it('repairs missing or invalid fields from weaker models', () => {
    const t = sanitize({ recommendedAction: 'CONTEST_WITH_EVIDENCE', riskLevel: 'extreme', evidenceChecklist: [{ item: 'x' }, null] }, cases['PP-D-48211A']);
    expect(t.riskLevel).toBe('MEDIUM');
    expect(t.evidenceType).toBe('OTHER');
    expect(t.buyerMessage).toBe('');
    expect(t.evidenceChecklist).toEqual([{ item: 'x', have: false }]);
  });
});
