// Single place that knows whether we're talking to PayPal or to demo data.

import { normalizeDispute, isActionable } from './normalize.js';
import { demoDisputes, demoMerchantFacts } from './fixtures.js';

export function createStore({ paypal = null, savedReviews = {} } = {}) {
  const mode = paypal ? 'sandbox' : 'demo';
  let demo = mode === 'demo' ? demoDisputes() : null;
  let facts = mode === 'demo' ? demoMerchantFacts() : {};
  const triages = new Map(); // disputeId -> triage
  const trackerChecked = new Set(); // transaction IDs already looked up in PayPal tracking
  const log = []; // audit trail of everything sent

  // The sample shop opens with AI reviews recorded earlier, so visitors see results
  // instantly without spending the shared free-model quota. "Review again" runs live.
  function seedReviews() {
    for (const [id, t] of Object.entries(savedReviews)) triages.set(id, { ...t, saved: true });
  }
  if (mode === 'demo') seedReviews();

  function reset() {
    if (mode !== 'demo') return;
    demo = demoDisputes();
    facts = demoMerchantFacts();
    triages.clear();
    log.length = 0;
    seedReviews();
  }

  async function rawList() {
    if (demo) return demo;
    const summaries = await paypal.listDisputes();
    // The list endpoint omits transactions and messages, so fetch details.
    const details = await Promise.all(summaries.map((s) => paypal.getDispute(s.dispute_id)));
    await Promise.all(details.map(autofill));
    return details;
  }

  async function rawGet(id) {
    if (demo) {
      const d = demo.find((x) => x.dispute_id === id);
      if (!d) throw Object.assign(new Error('Dispute not found'), { status: 404 });
      return d;
    }
    const d = await paypal.getDispute(id);
    await autofill(d);
    return d;
  }

  // Fill "Your records" from tracking the merchant already gave PayPal, so they don't retype it.
  async function autofill(d) {
    if (demo) return;
    const txId = d.disputed_transactions?.[0]?.seller_transaction_id;
    if (!txId || facts[txId] || trackerChecked.has(txId)) return;
    trackerChecked.add(txId);
    try {
      const trackers = await paypal.getTrackers(txId);
      if (!trackers.length) return;
      const lines = trackers.map((t) =>
        [t.carrier_name_other || t.carrier, t.tracking_number && `tracking ${t.tracking_number}`, t.status && `status ${t.status}`]
          .filter(Boolean)
          .join(', '),
      );
      facts[txId] = { fulfillment: lines.join('\n'), notes: '', source: 'paypal' };
    } catch (err) {
      console.error('Tracking lookup failed for', txId, err.message);
    }
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
    async document(id, url) {
      if (demo) throw Object.assign(new Error('Sample attachments have no file'), { status: 404 });
      const c = toCase(await rawGet(id));
      const known = [...c.documents, ...c.messages.flatMap((m) => m.documents)].some((x) => x.url === url);
      if (!known) throw Object.assign(new Error('Attachment not found on this dispute'), { status: 404 });
      return paypal.fetchDocument(url);
    },
    setTriage(id, t) {
      triages.set(id, { ...t, at: new Date().toISOString() });
    },
    act,
    reset,
    log: () => log.slice(0, 100),
  };
}
