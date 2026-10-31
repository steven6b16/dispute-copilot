// Demo data in the exact shape the PayPal Disputes API returns, so demo mode
// exercises the same normalisation and AI code paths as a live sandbox account.
// The shop ("Kettle & Crumb", a small coffee-gear store) is fictional.

const day = 86_400_000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * day).toISOString();

function dispute({ id, reason, status, stage = 'INQUIRY', amount, buyer, items, created, due, messages = [], invoice }) {
  return {
    dispute_id: id,
    create_time: iso(created),
    update_time: iso(created + 1),
    reason,
    status,
    dispute_life_cycle_stage: stage,
    dispute_channel: stage === 'CHARGEBACK' ? 'EXTERNAL' : 'INTERNAL',
    dispute_amount: { currency_code: 'USD', value: amount.toFixed(2) },
    seller_response_due_date: due === null ? undefined : iso(due),
    disputed_transactions: [
      {
        seller_transaction_id: `TX-${id.slice(-6)}`,
        create_time: iso(created - 9),
        invoice_number: invoice,
        gross_amount: { currency_code: 'USD', value: amount.toFixed(2) },
        buyer: { name: buyer },
        items: items.map(([name, qty]) => ({ item_name: name, item_quantity: String(qty) })),
      },
    ],
    messages: messages.map(([who, offset, content]) => ({
      posted_by: who,
      time_posted: iso(offset),
      content,
    })),
  };
}

export const STORE_POLICY = `Kettle & Crumb — store policy
- Ships within 2 business days from Portland, OR via USPS Ground Advantage (domestic) or USPS International.
- 30-day returns on unused items; buyer pays return shipping unless the item arrived damaged.
- Opened coffee beans are non-returnable.
- Damaged-in-transit claims require a photo within 7 days of delivery.`;

export function demoDisputes() {
  return [
    dispute({
      id: 'PP-D-48211A',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: 189.0,
      buyer: 'Dana Whitfield',
      items: [['Gooseneck pour-over kettle (matte black)', 1]],
      invoice: 'KC-10482',
      created: -3,
      due: 4,
      messages: [['BUYER', -3, 'It has been two weeks and my kettle never arrived. I want a refund.']],
    }),
    dispute({
      id: 'PP-D-48297C',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: 64.5,
      buyer: 'Marcus Oyelaran',
      items: [['Hand grinder, ceramic burr', 1]],
      invoice: 'KC-10517',
      created: -2,
      due: 1,
      messages: [
        ['BUYER', -2, 'The grinder handle snapped the first time I used it. This is not the "solid steel" build you advertised.'],
      ],
    }),
    dispute({
      id: 'PP-D-48302F',
      reason: 'UNAUTHORISED',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      stage: 'CHARGEBACK',
      amount: 412.0,
      buyer: 'Account holder: J. Park',
      items: [['Espresso machine starter bundle', 1]],
      invoice: 'KC-10533',
      created: -5,
      due: 2,
    }),
    dispute({
      id: 'PP-D-48355B',
      reason: 'CREDIT_NOT_PROCESSED',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: 38.0,
      buyer: 'Priya Natarajan',
      items: [['Single-origin beans 1kg (Ethiopia)', 1]],
      invoice: 'KC-10541',
      created: -1,
      due: 9,
      messages: [['BUYER', -1, 'I returned the unopened bag 3 weeks ago and still have no refund.']],
    }),
    dispute({
      id: 'PP-D-48390E',
      reason: 'DUPLICATE_TRANSACTION',
      status: 'OPEN',
      amount: 27.0,
      buyer: 'Tom Halvorsen',
      items: [['Paper filters (200 pack)', 3]],
      invoice: 'KC-10560',
      created: 0,
      due: 19,
      messages: [['BUYER', 0, 'I was charged twice for the same filters order.']],
    }),
    dispute({
      id: 'PP-D-48412D',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: 22.0,
      buyer: 'Elena Brandt',
      items: [['House blend beans 500g', 1]],
      invoice: 'KC-10571',
      created: -4,
      due: 6,
      messages: [['BUYER', -4, 'The coffee tastes stale and bitter. Not what I expected for the price.']],
    }),
    dispute({
      id: 'PP-D-47950A',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      status: 'RESOLVED',
      amount: 54.0,
      buyer: 'Grace Liu',
      items: [['Glass server 600ml', 1]],
      invoice: 'KC-10301',
      created: -30,
      due: null,
    }),
  ];
}

// What the merchant knows from their own store / shipping records.
export function demoMerchantFacts() {
  return {
    'TX-48211A': {
      fulfillment: 'Shipped USPS Ground Advantage, tracking 9400 1118 9922 3344 5521 07. Tracking shows DELIVERED to buyer ZIP 98103, left at front door, 6 days ago.',
      notes: 'No signature requested. Buyer has 2 previous orders with no issues.',
    },
    'TX-48297C': {
      fulfillment: 'Delivered 10 days ago.',
      notes: 'Listing says "ceramic burrs, aluminium body". It never claimed solid steel. Supplier batch #G-22 had 3 other handle complaints this month.',
    },
    'TX-48302F': {
      fulfillment: 'Shipped to a different address than the card billing address (freight forwarder in Delaware). Delivered.',
      notes: 'First-time customer, account created 20 minutes before purchase, expedited shipping.',
    },
    'TX-48355B': {
      fulfillment: 'Return received at warehouse 12 days ago, bag unopened.',
      notes: 'Refund was never issued — staff missed it.',
    },
    'TX-48390E': {
      fulfillment: 'One shipment sent.',
      notes: 'Payment logs show two captures 4 seconds apart from a checkout double-click.',
    },
    'TX-48412D': {
      fulfillment: 'Delivered 9 days ago. Roast date printed on bag: 5 days before shipping.',
      notes: 'Opened beans are non-returnable per policy.',
    },
  };
}
