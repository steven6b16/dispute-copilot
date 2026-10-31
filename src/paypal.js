// Thin client for the PayPal Disputes API (sandbox by default).
// Docs: https://developer.paypal.com/docs/api/customer-disputes/v1/

const BASES = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

export class PayPalError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.details = details;
  }
}

export function createPayPalClient({ clientId, clientSecret, env = 'sandbox', fetchImpl = fetch } = {}) {
  if (!clientId || !clientSecret) throw new Error('PayPal client ID and secret are required');
  const base = BASES[env];
  if (!base) throw new Error(`Unknown PayPal environment: ${env}`);

  let token = null;
  let tokenExpiresAt = 0;

  async function getToken() {
    if (token && Date.now() < tokenExpiresAt - 60_000) return token;
    const res = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError('PayPal authentication failed', res.status, body);
    token = body.access_token;
    tokenExpiresAt = Date.now() + (body.expires_in ?? 3000) * 1000;
    return token;
  }

  async function request(method, path, { json, form } = {}) {
    const headers = { Authorization: `Bearer ${await getToken()}` };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) {
      body = form; // fetch sets the multipart boundary itself
    }
    const res = await fetchImpl(`${base}${path}`, { method, headers, body });
    const text = await res.text();
    const data = text ? safeJson(text) : {};
    if (!res.ok) {
      throw new PayPalError(data?.message || `PayPal ${method} ${path} failed`, res.status, data);
    }
    return data;
  }

  // Some dispute endpoints require multipart/form-data with a JSON "input" part.
  function multipart(input) {
    const form = new FormData();
    form.append('input', new Blob([JSON.stringify(input)], { type: 'application/json' }));
    return form;
  }

  return {
    env,
    async listDisputes({ pageSize = 50 } = {}) {
      const data = await request('GET', `/v1/customer/disputes?page_size=${pageSize}`);
      return data.items ?? [];
    },
    getDispute(id) {
      return request('GET', `/v1/customer/disputes/${encodeURIComponent(id)}`);
    },
    acceptClaim(id, { note }) {
      return request('POST', `/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`, {
        json: { note },
      });
    },
    makeOffer(id, { note, amount, currency }) {
      return request('POST', `/v1/customer/disputes/${encodeURIComponent(id)}/make-offer`, {
        json: {
          note,
          offer_type: 'REFUND',
          offer_amount: { currency_code: currency, value: Number(amount).toFixed(2) },
        },
      });
    },
    provideEvidence(id, { note, evidenceType = 'OTHER', trackingNumber, carrier }) {
      const evidence = { evidence_type: evidenceType, notes: note };
      if (evidenceType === 'PROOF_OF_FULFILLMENT' && trackingNumber) {
        evidence.evidence_info = {
          tracking_info: [{ carrier_name: carrier || 'OTHER', tracking_number: trackingNumber }],
        };
      }
      return request('POST', `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, {
        form: multipart({ evidences: [evidence] }),
      });
    },
    sendMessage(id, { message }) {
      return request('POST', `/v1/customer/disputes/${encodeURIComponent(id)}/send-message`, {
        form: multipart({ message }),
      });
    },
    // Sandbox-only helper: move a dispute to the "waiting for seller evidence" stage.
    requireSellerEvidence(id) {
      if (env !== 'sandbox') throw new Error('Only available in sandbox');
      return request('POST', `/v1/customer/disputes/${encodeURIComponent(id)}/require-evidence`, {
        json: { action: 'SELLER_EVIDENCE' },
      });
    },
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
