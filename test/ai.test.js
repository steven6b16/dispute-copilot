import { describe, it, expect, vi } from 'vitest';
import { heuristicTriage, sanitize, createTriageEngine, buildPrompt } from '../src/ai.js';
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

describe('Claude engine', () => {
  it('forces the triage tool and returns sanitized output', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'submit_triage',
          input: {
            riskLevel: 'MEDIUM',
            winLikelihood: 62,
            recommendedAction: 'OFFER_PARTIAL_REFUND',
            offerAmount: 20,
            rationale: 'r',
            evidenceChecklist: [],
            evidenceType: 'OTHER',
            evidenceNote: 'n',
            buyerMessage: 'm',
          },
        },
      ],
    });
    const engine = createTriageEngine({ client: { messages: { create } }, model: 'test-model' });
    const t = await engine.triage(cases['PP-D-48297C'], 'policy');
    expect(engine.engine).toBe('claude');
    expect(create.mock.calls[0][0].tool_choice).toEqual({ type: 'tool', name: 'submit_triage' });
    expect(create.mock.calls[0][0].messages[0].content).toContain('Supplier batch');
    expect(t).toMatchObject({ source: 'claude', offerAmount: 20, winLikelihood: 62 });
  });

  it('falls back to heuristics without a key', () => {
    expect(createTriageEngine({}).engine).toBe('heuristic');
  });

  it('includes merchant records and policy in the prompt', () => {
    const p = buildPrompt(cases['PP-D-48211A'], 'POLICY TEXT');
    expect(p).toContain('9400 1118');
    expect(p).toContain('POLICY TEXT');
  });
});
