import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const agGridPath = path.join(root, 'node_modules', 'ag-grid-community', 'dist', 'ag-grid-community.min.js');

export function createApp({ store, ai, policy = '' }) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(publicDir));
  app.get('/vendor/ag-grid.js', (req, res) => res.sendFile(agGridPath));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  app.get('/api/status', (req, res) => {
    res.json({ mode: store.mode, ai: ai.engine, model: ai.model, policy });
  });

  app.get('/api/disputes', wrap(async (req, res) => {
    const cases = await store.list();
    res.json({ cases, summary: summarize(cases) });
  }));

  app.get('/api/disputes/:id', wrap(async (req, res) => {
    res.json(await store.get(req.params.id));
  }));

  app.put('/api/disputes/:id/facts', wrap(async (req, res) => {
    const c = await store.get(req.params.id);
    if (!c.transactionId) return res.status(400).json({ error: 'Dispute has no transaction ID' });
    store.setFacts(c.transactionId, req.body ?? {});
    res.json(await store.get(req.params.id));
  }));

  app.post('/api/disputes/:id/triage', wrap(async (req, res) => {
    const c = await store.get(req.params.id);
    store.setTriage(c.id, await ai.triage(c, policy));
    res.json(await store.get(c.id));
  }));

  app.post('/api/triage-all', wrap(async (req, res) => {
    const cases = (await store.list()).filter((c) => c.actionable);
    const results = await Promise.allSettled(cases.map((c) => ai.triage(c, policy)));
    let failed = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') store.setTriage(cases[i].id, r.value);
      else failed += 1;
    });
    res.json({ triaged: cases.length - failed, failed });
  }));

  app.post('/api/disputes/:id/actions/:kind', wrap(async (req, res) => {
    const { kind } = req.params;
    const body = req.body ?? {};
    const error = validateAction(kind, body, await store.get(req.params.id));
    if (error) return res.status(400).json({ error });
    res.json(await store.act(req.params.id, kind, body));
  }));

  app.get('/api/log', (req, res) => res.json(store.log()));

  app.use((err, req, res, next) => {
    const status = err.status && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message, details: err.details?.details ?? undefined });
  });

  return app;
}

export function validateAction(kind, body, c) {
  const text = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 2000;
  switch (kind) {
    case 'accept':
      return text(body.note) ? null : 'A note (1-2000 characters) is required';
    case 'offer': {
      if (!text(body.note)) return 'A note (1-2000 characters) is required';
      const amt = Number(body.amount);
      if (!(amt > 0)) return 'Offer amount must be greater than 0';
      if (amt > c.amount) return `Offer cannot exceed the disputed amount (${c.amount.toFixed(2)})`;
      return null;
    }
    case 'evidence':
      if (!text(body.note)) return 'An evidence statement (1-2000 characters) is required';
      if (body.evidenceType === 'PROOF_OF_FULFILLMENT' && !body.trackingNumber) return 'Proof of fulfillment needs a tracking number';
      return null;
    case 'message':
      return text(body.message) ? null : 'A message (1-2000 characters) is required';
    default:
      return `Unknown action: ${kind}`;
  }
}

export function summarize(cases) {
  const open = cases.filter((c) => c.actionable);
  const atRisk = open.reduce((s, c) => s + c.amount, 0);
  const dueSoon = open.filter((c) => c.daysLeft !== null && c.daysLeft <= 3).length;
  const contestable = open
    .filter((c) => c.triage?.recommendedAction === 'CONTEST_WITH_EVIDENCE')
    .reduce((s, c) => s + c.amount * (c.triage.winLikelihood / 100), 0);
  return {
    open: open.length,
    atRisk: round(atRisk),
    dueSoon,
    triaged: open.filter((c) => c.triage).length,
    expectedRecovery: round(contestable),
  };
}

const round = (n) => Math.round(n * 100) / 100;
