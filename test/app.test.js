import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';
import { createTriageEngine } from '../src/ai.js';

let app;
beforeEach(() => {
  app = createApp({ store: createStore(), ai: createTriageEngine({}), policy: 'p' });
});

describe('API (demo mode)', () => {
  it('reports status', async () => {
    const res = await request(app).get('/api/status');
    expect(res.body).toMatchObject({ mode: 'demo', ai: 'heuristic' });
  });

  it('lists disputes with a summary', async () => {
    const res = await request(app).get('/api/disputes');
    expect(res.status).toBe(200);
    expect(res.body.cases).toHaveLength(7);
    expect(res.body.summary.open).toBe(6);
    expect(res.body.summary.atRisk).toBeCloseTo(752.5);
  });

  it('triages all open disputes', async () => {
    const res = await request(app).post('/api/triage-all');
    expect(res.body).toEqual({ triaged: 6, failed: 0 });
    const list = await request(app).get('/api/disputes');
    expect(list.body.summary.triaged).toBe(6);
    expect(list.body.summary.expectedRecovery).toBeGreaterThan(0);
  });

  it('sends evidence and moves the case to review', async () => {
    const res = await request(app)
      .post('/api/disputes/PP-D-48211A/actions/evidence')
      .send({ note: 'Delivered per USPS', evidenceType: 'PROOF_OF_FULFILLMENT', trackingNumber: '9400', carrier: 'USPS' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('UNDER_REVIEW');
    expect(res.body.actionable).toBe(false);
    const log = await request(app).get('/api/log');
    expect(log.body[0]).toMatchObject({ disputeId: 'PP-D-48211A', kind: 'evidence' });
  });

  it('rejects offers above the disputed amount', async () => {
    const res = await request(app).post('/api/disputes/PP-D-48412D/actions/offer').send({ note: 'n', amount: 500 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot exceed/);
  });

  it('requires tracking for proof of fulfillment', async () => {
    const res = await request(app)
      .post('/api/disputes/PP-D-48211A/actions/evidence')
      .send({ note: 'n', evidenceType: 'PROOF_OF_FULFILLMENT' });
    expect(res.status).toBe(400);
  });

  it('blocks actions on resolved disputes', async () => {
    const res = await request(app).post('/api/disputes/PP-D-47950A/actions/message').send({ message: 'hi' });
    expect(res.status).toBe(409);
  });

  it('updates merchant records used by triage', async () => {
    await request(app).put('/api/disputes/PP-D-48211A/facts').send({ fulfillment: 'Not shipped yet', notes: '' });
    const res = await request(app).post('/api/disputes/PP-D-48211A/triage');
    expect(res.body.merchantFacts.fulfillment).toBe('Not shipped yet');
    expect(res.body.triage.recommendedAction).toBe('REQUEST_INFO');
  });

  it('returns 404 for unknown disputes', async () => {
    expect((await request(app).get('/api/disputes/nope')).status).toBe(404);
  });

  it('serves the UI and the grid library', async () => {
    expect((await request(app).get('/')).text).toContain('Dispute Copilot');
    const grid = await request(app).get('/vendor/ag-grid.js');
    expect(grid.status).toBe(200);
  });
});
