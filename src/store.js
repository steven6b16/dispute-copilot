// Single place that knows whether we're talking to PayPal or to demo data.

import { normalizeDispute, isActionable } from './normalize.js';
import { demoDisputes, demoMerchantFacts } from './fixtures.js';

export function createStore({ paypal = null } = {}) {
  const mode = paypal ? 'sandbox' : 'demo';
  const demo = mode === 'demo' ? demoDisputes() : null;
  const facts = mode === 'demo' ? demoMerchantFacts() : {};
  const triages = new Map(); // disputeId -> triage
  const log = []; // audit trail of everything sent

  async function rawList() {
    if (demo) return demo;
    const summaries = await paypal.listDisputes();
    // The list endpoint omits transactions and messages, so fetch details.
    return Promise.all(summaries.map((s) => paypal.getDispute(s.dispute_id)));
  }

  async function rawGet(id) {
    if (demo) {
      const d = demo.find((x) => x.dispute_id === id);
      if (!d) throw Object.assign(new Error('Dispute not found'), { status: 404 });
      return d;
    }
    return paypal.getDispute(id);
  }

  function toCase(d) {
    const c = normalizeDispute(d);
    c.merchantFacts = facts[c.transactionId] ?? {};
    c.triage = triages.get(c.id) ?? null;
    c.actionable = isActionable(c);
    return c;
  }

  function demoUpdate(id, patch, message) {
    const d = demo.find((x) => x.dispute_id === id);
    Object.assign(d, patch, { update_time: new Date().toISOString() });
    if (message) {
      d.messages = [...(d.messages ?? []), { posted_by: 'SELLER', time_posted: new Date().toISOString(), content: message }];
    }
  }

  async function act(id, kind, payload) {
    const c = toCase(await rawGet(id));
    if (!c.actionable) throw Object.assign(new Error('This dispute can no longer be changed'), { status: 409 });

    if (demo) {
      if (kind === 'accept') demoUpdate(id, { status: 'RESOLVED' }, payload.note);
      if (kind === 'offer') demoUpdate(id, { status: 'WAITING_FOR_BUYER_RESPONSE' }, `${payload.note}\n(Offered refund: ${Number(payload.amount).toFixed(2)} ${c.currency})`);
      if (kind === 'evidence') demoUpdate(id, { status: 'UNDER_REVIEW' }, payload.note);
      if (kind === 'message') demoUpdate(id, {}, payload.message);
    } else {
      if (kind === 'accept') await paypal.acceptClaim(id, { note: payload.note });
      if (kind === 'offer') await paypal.makeOffer(id, { note: payload.note, amount: payload.amount, currency: c.currency });
      if (kind === 'evidence') await paypal.provideEvidence(id, payload);
      if (kind === 'message') await paypal.sendMessage(id, { message: payload.message });
    }
    log.unshift({ at: new Date().toISOString(), disputeId: id, kind, mode, payload });
    return toCase(await rawGet(id));
  }

  return {
    mode,
    async list() {
      return (await rawList()).map(toCase);
    },
    async get(id) {
      return toCase(await rawGet(id));
    },
    setFacts(transactionId, f) {
      facts[transactionId] = { fulfillment: String(f.fulfillment ?? ''), notes: String(f.notes ?? '') };
    },
    setTriage(id, t) {
      triages.set(id, { ...t, at: new Date().toISOString() });
    },
    act,
    log: () => log.slice(0, 100),
  };
}
