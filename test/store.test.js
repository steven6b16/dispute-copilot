import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../src/store.js';
import { normalizeDispute } from '../src/normalize.js';

const raw = {
  dispute_id: 'D1',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  dispute_amount: { currency_code: 'HKD', value: '382.00' },
  disputed_transactions: [{ seller_transaction_id: 'TX1', buyer: { name: 'John Doe' } }],
  messages: [
    { posted_by: 'BUYER', content: 'see receipt', documents: [{ name: 'receipt.jpg', url: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/D1/docs/1' }] },
  ],
  supporting_info: [{ source: 'SUBMITTED_BY_BUYER', documents: [{ name: 'photo.png', url: 'https://api-m.sandbox.paypal.com/x/2' }] }],
};

function fakePayPal(overrides = {}) {
  return {
    listDisputes: vi.fn(async () => [{ dispute_id: 'D1' }]),
    getDispute: vi.fn(async () => structuredClone(raw)),
    getTrackers: vi.fn(async () => [{ carrier: 'USPS', tracking_number: '9400111', status: 'SHIPPED' }]),
    fetchDocument: vi.fn(async () => new Response('img')),
    ...overrides,
  };
}

describe('attachments', () => {
  it('normalizes message and case attachments', () => {
    const c = normalizeDispute(raw);
    expect(c.messages[0].documents).toEqual([{ name: 'receipt.jpg', url: raw.messages[0].documents[0].url }]);
    expect(c.documents[0]).toMatchObject({ name: 'photo.png', source: 'SUBMITTED_BY_BUYER' });
  });

  it('only proxies attachments that belong to the dispute', async () => {
    const paypal = fakePayPal();
    const store = createStore({ paypal });
    await store.document('D1', raw.messages[0].documents[0].url);
    expect(paypal.fetchDocument).toHaveBeenCalledOnce();
    await expect(store.document('D1', 'https://api-m.sandbox.paypal.com/other')).rejects.toMatchObject({ status: 404 });
  });
});

describe('tracking autofill', () => {
  it('fills records from PayPal tracking once per transaction', async () => {
    const paypal = fakePayPal();
    const store = createStore({ paypal });
    const [c] = await store.list();
    expect(c.merchantFacts).toMatchObject({ source: 'paypal' });
    expect(c.merchantFacts.fulfillment).toContain('tracking 9400111');
    await store.get('D1');
    expect(paypal.getTrackers).toHaveBeenCalledOnce();
  });

  it('never overwrites records the merchant typed', async () => {
    const paypal = fakePayPal();
    const store = createStore({ paypal });
    store.setFacts('TX1', { fulfillment: 'hand delivered', notes: '' });
    const c = await store.get('D1');
    expect(c.merchantFacts.fulfillment).toBe('hand delivered');
    expect(paypal.getTrackers).not.toHaveBeenCalled();
  });

  it('keeps working when tracking lookup fails', async () => {
    const paypal = fakePayPal({ getTrackers: vi.fn(async () => { throw new Error('no permission'); }) });
    const c = await createStore({ paypal }).get('D1');
    expect(c.merchantFacts).toEqual({});
  });
});
