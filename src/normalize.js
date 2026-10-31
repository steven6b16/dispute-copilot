// Turns a PayPal dispute detail object into the flat "case" shape the UI and AI use.

export const REASON_LABELS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Not as described',
  UNAUTHORISED: 'Unauthorised transaction',
  CREDIT_NOT_PROCESSED: 'Refund not processed',
  DUPLICATE_TRANSACTION: 'Duplicate charge',
  INCORRECT_AMOUNT: 'Incorrect amount',
  PAYMENT_BY_OTHER_MEANS: 'Paid by other means',
  CANCELED_RECURRING_BILLING: 'Cancelled subscription',
  PROBLEM_WITH_REMITTANCE: 'Remittance problem',
  OTHER: 'Other',
};

export function normalizeDispute(d, merchantFacts = {}) {
  const tx = d.disputed_transactions?.[0] ?? {};
  const amount = d.dispute_amount ?? tx.gross_amount ?? {};
  const due = d.seller_response_due_date ?? null;
  return {
    id: d.dispute_id,
    createdAt: d.create_time ?? null,
    updatedAt: d.update_time ?? null,
    reason: d.reason ?? 'OTHER',
    reasonLabel: REASON_LABELS[d.reason] ?? d.reason ?? 'Other',
    status: d.status ?? 'OPEN',
    stage: d.dispute_life_cycle_stage ?? 'INQUIRY',
    channel: d.dispute_channel ?? 'INTERNAL',
    amount: Number(amount.value ?? 0),
    currency: amount.currency_code ?? 'USD',
    dueDate: due,
    daysLeft: due ? daysUntil(due) : null,
    buyerName: tx.buyer?.name ?? 'Unknown buyer',
    transactionId: tx.seller_transaction_id ?? null,
    invoiceNumber: tx.invoice_number ?? null,
    transactionDate: tx.create_time ?? null,
    items: (tx.items ?? []).map((i) => ({
      name: i.item_name ?? i.item_description ?? 'Item',
      quantity: Number(i.item_quantity ?? 1),
    })),
    messages: (d.messages ?? []).map((m) => ({
      from: m.posted_by ?? 'BUYER',
      at: m.time_posted ?? null,
      text: m.content ?? '',
      documents: docs(m.documents),
    })),
    // Files attached outside the message thread (buyer supporting info, earlier evidence).
    documents: [
      ...(d.supporting_info ?? []).flatMap((s) => docs(s.documents, s.source)),
      ...(d.evidences ?? []).flatMap((e) => docs(e.documents, e.source)),
    ],
    merchantFacts,
  };
}

function docs(list, source) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && (x.name || x.url))
    .map((x) => ({ name: x.name || 'Attachment', url: x.url || null, ...(source ? { source } : {}) }));
}

export function daysUntil(iso, now = Date.now()) {
  return Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
}

export function isActionable(c) {
  return !['RESOLVED', 'UNDER_REVIEW'].includes(c.status);
}
