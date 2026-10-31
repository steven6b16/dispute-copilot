import { describe, it, expect, vi } from 'vitest';
import { createPayPalClient, PayPalError } from '../src/paypal.js';

function mockFetch(routes) {
  return vi.fn(async (url, opts) => {
    const path = new URL(url).pathname;
    const handler = routes[`${opts.method} ${path}`];
    if (!handler) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    const { status = 200, body = {} } = await handler(opts);
    return new Response(JSON.stringify(body), { status });
  });
}

const tokenRoute = { 'POST /v1/oauth2/token': () => ({ body: { access_token: 'tok', expires_in: 3600 } }) };

describe('PayPal client', () => {
  it('uses the sandbox host and caches the token', async () => {
    const fetchImpl = mockFetch({
      ...tokenRoute,
      'GET /v1/customer/disputes': () => ({ body: { items: [{ dispute_id: 'A' }] } }),
    });
    const pp = createPayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
    await pp.listDisputes();
    const items = await pp.listDisputes();
    expect(items).toEqual([{ dispute_id: 'A' }]);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/^https:\/\/api-m\.sandbox\.paypal\.com/);
    const tokenCalls = fetchImpl.mock.calls.filter(([u]) => u.endsWith('/v1/oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('sends evidence as multipart with tracking info', async () => {
    let received;
    const fetchImpl = mockFetch({
      ...tokenRoute,
      'POST /v1/customer/disputes/D1/provide-evidence': (opts) => {
        received = opts.body;
        return { body: { links: [] } };
      },
    });
    const pp = createPayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
    await pp.provideEvidence('D1', { note: 'Delivered', evidenceType: 'PROOF_OF_FULFILLMENT', trackingNumber: '123', carrier: 'USPS' });
    expect(received).toBeInstanceOf(FormData);
    const input = JSON.parse(await received.get('input').text());
    expect(input.evidences[0]).toMatchObject({
      evidence_type: 'PROOF_OF_FULFILLMENT',
      notes: 'Delivered',
      evidence_info: { tracking_info: [{ carrier_name: 'USPS', tracking_number: '123' }] },
    });
  });

  it('formats refund offers to two decimals', async () => {
    let body;
    const fetchImpl = mockFetch({
      ...tokenRoute,
      'POST /v1/customer/disputes/D1/make-offer': (opts) => {
        body = JSON.parse(opts.body);
        return { body: {} };
      },
    });
    const pp = createPayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
    await pp.makeOffer('D1', { note: 'n', amount: 12.5, currency: 'USD' });
    expect(body.offer_amount).toEqual({ currency_code: 'USD', value: '12.50' });
  });

  it('raises PayPalError with status on failure', async () => {
    const fetchImpl = mockFetch({
      ...tokenRoute,
      'POST /v1/customer/disputes/D1/accept-claim': () => ({ status: 422, body: { message: 'Not allowed' } }),
    });
    const pp = createPayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
    await expect(pp.acceptClaim('D1', { note: 'n' })).rejects.toMatchObject({ name: 'PayPalError', status: 422 });
    expect(PayPalError).toBeDefined();
  });

  it('refuses sandbox-only helpers outside sandbox', () => {
    const pp = createPayPalClient({ clientId: 'id', clientSecret: 'secret', env: 'live', fetchImpl: vi.fn() });
    expect(() => pp.requireSellerEvidence('D1')).toThrow();
  });
});

describe('PayPal documents and tracking', () => {
  it('refuses to fetch documents from other hosts', async () => {
    const pp = createPayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl: mockFetch(tokenRoute) });
    await expect(pp.fetchDocument('https://evil.example.com/x')).rejects.toMatchObject({ status: 400 });
  });

  it('looks up trackers by transaction', async () => {
    const fetchImpl = mockFetch({ ...tokenRoute, 'GET /v1/shipping/trackers': () => ({ body: { trackers: [{ tracking_number: '1' }] } }) });
    const pp = createPayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
    expect(await pp.getTrackers('TX1')).toEqual([{ tracking_number: '1' }]);
    expect(fetchImpl.mock.calls.at(-1)[0]).toContain('transaction_id=TX1');
  });
});
