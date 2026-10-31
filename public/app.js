const $ = (sel) => document.querySelector(sel);

const ACTION_LABELS = {
  CONTEST_WITH_EVIDENCE: 'Contest with evidence',
  OFFER_PARTIAL_REFUND: 'Offer a partial refund',
  ACCEPT_CLAIM: 'Refund in full',
  REQUEST_INFO: 'Ask the buyer for details',
};

const SHORT_ACTION = {
  CONTEST_WITH_EVIDENCE: 'Contest',
  OFFER_PARTIAL_REFUND: 'Partial refund',
  ACCEPT_CLAIM: 'Refund in full',
  REQUEST_INFO: 'Ask buyer',
};

const STATUS_LABELS = {
  OPEN: 'Open',
  WAITING_FOR_SELLER_RESPONSE: 'Your move',
  WAITING_FOR_BUYER_RESPONSE: 'Waiting on buyer',
  UNDER_REVIEW: 'In review',
  RESOLVED: 'Closed',
  OTHER: 'Other',
};

const state = { cases: [], selectedId: null, status: null, grid: null, source: null };

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const money = (n, cur = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n);

// A random ID per browser so each visitor gets their own sample shop on the server.
const session = (() => {
  const fresh = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
  try {
    let id = localStorage.getItem('demoSession');
    if (!id) localStorage.setItem('demoSession', (id = fresh()));
    return id;
  } catch {
    return fresh();
  }
})();

// The owner can unlock sandbox sending on the public demo by opening the page once with ?admin=TOKEN.
const adminToken = (() => {
  try {
    const fromUrl = new URLSearchParams(location.search).get('admin');
    if (fromUrl) {
      localStorage.setItem('adminToken', fromUrl);
      history.replaceState(null, '', location.pathname);
    }
    return localStorage.getItem('adminToken') || '';
  } catch {
    return '';
  }
})();

async function api(path, opts = {}) {
  const url = new URL(path, location.origin);
  if (state.source) url.searchParams.set('source', state.source);
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Demo-Session': session,
      ...(adminToken ? { 'X-Admin-Token': adminToken } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'toast error' : 'toast';
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4000);
}

/* ---------- Grid ---------- */

function initGrid() {
  const g = window.agGrid;
  try { g.ModuleRegistry.registerModules([g.AllCommunityModule]); } catch { /* already registered */ }
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = g.themeQuartz.withParams({
    fontFamily: 'inherit',
    fontSize: 15,
    backgroundColor: dark ? '#1c2533' : '#fbfcfd',
    foregroundColor: dark ? '#e4e9f2' : '#1b2a4a',
    headerBackgroundColor: dark ? '#141b26' : '#e8edf1',
    borderColor: dark ? '#33405a' : '#c9d3dc',
    selectedRowBackgroundColor: dark ? '#2a3850' : '#dfe8f3',
    accentColor: '#2b6cd6',
    wrapperBorderRadius: 3,
    rowHeight: 48,
  });

  state.grid = g.createGrid($('#grid'), {
    theme,
    rowData: [],
    getRowId: (p) => p.data.id,
    rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
    onRowClicked: (e) => select(e.data.id),
    onCellKeyDown: (e) => { if (e.event.key === 'Enter') select(e.data.id); },
    defaultColDef: { sortable: true, resizable: true, filter: false },
    columnDefs: [
      {
        headerName: 'Due',
        field: 'daysLeft',
        width: 92,
        sort: 'asc',
        comparator: (a, b, na, nb) => sortKey(na.data) - sortKey(nb.data),
        cellRenderer: (p) => {
          if (!p.data.actionable) return '<span class="risk-LOW">Done</span>';
          if (p.value === null) return '—';
          const cls = p.value <= 3 ? 'risk-HIGH' : 'risk-MEDIUM';
          return `<span class="${cls}">${p.value <= 0 ? 'Today' : `${p.value}d`}</span>`;
        },
      },
      { headerName: 'Buyer', field: 'buyerName', flex: 1, minWidth: 100, tooltipField: 'buyerName' },
      { headerName: 'Reason', field: 'reasonLabel', flex: 1, minWidth: 110, tooltipField: 'reasonLabel' },
      {
        headerName: 'Amount',
        field: 'amount',
        width: 100,
        type: 'rightAligned',
        valueFormatter: (p) => money(p.value, p.data.currency),
      },
      { headerName: 'Status', field: 'status', width: 124, valueFormatter: (p) => STATUS_LABELS[p.value] || p.value },
      {
        headerName: 'Copilot says',
        colId: 'call',
        width: 128,
        valueGetter: (p) => (p.data.triage ? SHORT_ACTION[p.data.triage.recommendedAction] : ''),
        cellRenderer: (p) => (p.value ? esc(p.value) : p.data.actionable ? '<span class="risk-LOW">Not reviewed</span>' : ''),
      },
      {
        headerName: 'Odds',
        colId: 'odds',
        width: 84,
        type: 'rightAligned',
        valueGetter: (p) => p.data.triage?.winLikelihood ?? null,
        cellRenderer: (p) => (p.value === null ? '' : `<span class="risk-${esc(p.data.triage.riskLevel)}">${p.value}%</span>`),
      },
    ],
  });
}

// Open disputes first, ordered by deadline; closed ones sink to the bottom.
function sortKey(c) {
  if (!c.actionable) return 10_000;
  return c.daysLeft ?? 9_999;
}

/* ---------- Data ---------- */

async function load() {
  const { cases, summary } = await api('/api/disputes');
  state.cases = cases;
  state.grid.setGridOption('rowData', cases);
  state.grid.refreshCells({ force: true });
  state.grid.onSortChanged();
  renderBrief(summary);
  if (state.selectedId) renderSlip(cases.find((c) => c.id === state.selectedId));
  await loadLog();
}

async function loadLog() {
  const entries = await api('/api/log');
  const verbs = { accept: 'Refunded in full', offer: 'Offered refund', evidence: 'Sent evidence', message: 'Messaged buyer' };
  $('#log').innerHTML = entries.length
    ? entries
        .map((e) => `<li>${esc(verbs[e.kind] || e.kind)} on ${esc(e.disputeId)}, ${new Date(e.at).toLocaleString()}</li>`)
        .join('')
    : '<li class="muted">Nothing sent yet. Every response waits for your approval.</li>';
}

function renderBrief(s) {
  $('#loadSample').hidden = !(state.source === 'sandbox' && !s.open);
  if (!s.open) {
    $('#headline').textContent = state.source === 'sandbox' ? 'Your PayPal sandbox has no open disputes.' : 'No open disputes. Nice.';
    $('#subline').textContent = state.source === 'sandbox'
      ? 'New disputes appear here as soon as a buyer files one. To try the copilot now, load the sample shop.'
      : 'New PayPal disputes show up here as soon as buyers file them.';
    $('#triageAll').disabled = true;
    return;
  }
  const word = s.open === 1 ? 'dispute' : 'disputes';
  $('#headline').textContent = `${s.open} open ${word}, ${money(s.atRisk)} on the line.`;
  const parts = [];
  if (s.dueSoon) parts.push(`${s.dueSoon} ${s.dueSoon === 1 ? 'needs' : 'need'} an answer within 3 days`);
  if (s.triaged < s.open) parts.push(`${s.open - s.triaged} not reviewed yet`);
  else if (s.expectedRecovery > 0) parts.push(`all reviewed, about ${money(s.expectedRecovery)} likely recoverable by contesting`);
  else parts.push('all reviewed');
  $('#subline').textContent = parts.join('; ') + '.';
  $('#triageAll').disabled = false;
  $('#triageAll').textContent = s.triaged < s.open ? 'Review all open disputes' : 'Review again';
}

/* ---------- Slip ---------- */

function filesHtml(c, files = []) {
  if (!files.length) return '';
  const items = files.map((f) => {
    if (!f.url) return `<li>${esc(f.name)}</li>`;
    const href = `/api/disputes/${encodeURIComponent(c.id)}/document?source=${encodeURIComponent(state.source)}&u=${encodeURIComponent(f.url)}`;
    return `<li><a href="${esc(href)}" target="_blank" rel="noopener">${esc(f.name)}</a></li>`;
  });
  return `<ul class="files" aria-label="Attachments">${items.join('')}</ul>`;
}

function select(id) {
  state.selectedId = id;
  renderSlip(state.cases.find((c) => c.id === id));
  if (matchMedia('(max-width: 900px)').matches) $('#slip').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

function renderSlip(c) {
  const slip = $('#slip');
  if (!c) return;
  const due = !c.actionable
    ? `<span class="due calm">${c.status === 'UNDER_REVIEW' ? 'Sent. PayPal is reviewing' : 'Closed'}</span>`
    : c.daysLeft === null
      ? ''
      : `<span class="due ${c.daysLeft > 3 ? 'calm' : ''}">${c.daysLeft <= 0 ? 'Answer due today' : `Answer due in ${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'}`}</span>`;

  slip.innerHTML = `
    <h2>${esc(c.reasonLabel)}, ${money(c.amount, c.currency)}</h2>
    <p class="meta">${esc(c.buyerName)}, invoice ${esc(c.invoiceNumber || 'n/a')}, PayPal case ${esc(c.id)}${c.stage === 'CHARGEBACK' ? ', filed as a card chargeback' : ''}</p>
    ${due}

    ${c.triage && c.actionable ? verdictHtml(c) : ''}
    ${c.actionable ? `<div class="row"><button class="${c.triage ? '' : 'primary'}" id="triageOne">${c.triage ? 'Review again' : 'Review this dispute'}</button></div>` : ''}

    <details class="case" ${c.triage ? '' : 'open'}>
      <summary>What they bought and said</summary>
      <p>${c.items.map((i) => `${i.quantity} × ${esc(i.name)}`).join('<br>') || 'No item details from PayPal.'}</p>
      <ul class="thread">${c.messages.length ? c.messages.map((m) => `<li><div class="who">${m.from === 'SELLER' ? 'You' : 'Buyer'}${m.at ? `, ${new Date(m.at).toLocaleDateString()}` : ''}</div>${esc(m.text)}${filesHtml(c, m.documents)}</li>`).join('') : '<li class="muted">No messages yet.</li>'}</ul>
      ${c.documents.length ? `<p class="who">Other files on this case</p>${filesHtml(c, c.documents)}` : ''}
    </details>

    <details class="case" ${c.triage ? '' : 'open'}>
      <summary>Your records</summary>
      <form class="facts" id="factsForm">
        <label for="fFul">Shipping and delivery${c.merchantFacts.source === 'paypal' ? ' (filled in from the tracking you added in PayPal)' : ''}</label>
        <textarea id="fFul" name="fulfillment" placeholder="Carrier, tracking number, delivery status">${esc(c.merchantFacts.fulfillment)}</textarea>
        <label for="fNotes">Anything else the copilot should know</label>
        <textarea id="fNotes" name="notes" placeholder="Listing details, refunds already issued, customer history">${esc(c.merchantFacts.notes)}</textarea>
        <div class="row"><button type="submit">Save records</button></div>
      </form>
    </details>
  `;

  $('#factsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await guard(e.submitter, async () => {
      await api(`/api/disputes/${c.id}/facts`, { method: 'PUT', body: Object.fromEntries(fd) });
      toast('Records saved. Review again to update the recommendation.');
      await load();
    });
  });

  $('#triageOne')?.addEventListener('click', (e) =>
    guard(e.target, async () => {
      e.target.textContent = 'Reviewing…';
      await api(`/api/disputes/${c.id}/triage`, { method: 'POST' });
      await load();
    }),
  );

  if (c.triage && c.actionable) wireDrafts(c);
}

function verdictHtml(c) {
  const t = c.triage;
  return `
    <div class="verdict">
      <p class="call">${esc(ACTION_LABELS[t.recommendedAction])}</p>
      <p class="odds">${t.winLikelihood}% chance of winning if contested, ${esc(t.riskLevel.toLowerCase())} risk</p>
      <p>${esc(t.rationale)}</p>
      ${t.fraudSignals.length ? `<ul class="signals">${t.fraudSignals.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      ${t.evidenceChecklist.length ? `<ul class="checklist">${t.evidenceChecklist.map((i) => `<li class="${i.have ? '' : 'missing'}">${esc(i.item)}</li>`).join('')}</ul>` : ''}
    </div>

    <div class="draft">
      <label for="dAction">Respond with</label>
      <select id="dAction">${Object.entries(ACTION_LABELS).map(([k, v]) => `<option value="${k}" ${k === t.recommendedAction ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <div id="draftBody"></div>
    </div>
    <p class="source">${draftedBy(t)} Nothing is sent until you approve it.${state.source === 'demo' ? ' In the sample shop, approving simulates the PayPal call.' : ''}</p>
  `;
}

function draftedBy(t) {
  if (t.source === 'ai') {
    return t.saved
      ? `Reviewed earlier by ${esc(t.model)} via OpenRouter and saved for this demo. Choose Review again to run it live.`
      : `Drafted by ${esc(t.model)} via OpenRouter.`;
  }
  return t.fallbackReason ? `Drafted by the built-in rules engine, because ${esc(t.fallbackReason)}.` : 'Drafted by the built-in rules engine.';
}

function sandboxLocked() {
  return state.source === 'sandbox' && state.status?.sandboxSendLocked;
}

function wireDrafts(c) {
  const t = c.triage;
  const body = $('#draftBody');
  const render = (action) => {
    if (action === 'CONTEST_WITH_EVIDENCE') {
      body.innerHTML = `
        <label for="dNote">Statement to PayPal</label>
        <textarea id="dNote">${esc(t.evidenceNote)}</textarea>
        <div class="row">
          <select id="dType" aria-label="Evidence type">
            <option value="PROOF_OF_FULFILLMENT" ${t.evidenceType === 'PROOF_OF_FULFILLMENT' ? 'selected' : ''}>Proof of delivery</option>
            <option value="PROOF_OF_REFUND" ${t.evidenceType === 'PROOF_OF_REFUND' ? 'selected' : ''}>Proof of refund</option>
            <option value="OTHER" ${t.evidenceType === 'OTHER' ? 'selected' : ''}>Other</option>
          </select>
        </div>
        <label for="dTrack">Tracking number</label>
        <input id="dTrack" value="${esc(t.trackingNumber || '')}">
        <label for="dCarrier">Carrier</label>
        <input id="dCarrier" value="${esc(t.carrier || '')}">
        <div class="row"><button class="approve" id="send">Approve and send evidence</button></div>`;
      $('#send').onclick = (e) =>
        send(e.target, c, 'evidence', {
          note: $('#dNote').value,
          evidenceType: $('#dType').value,
          trackingNumber: $('#dTrack').value.trim() || undefined,
          carrier: $('#dCarrier').value.trim() || undefined,
        }, 'Evidence sent to PayPal.');
    } else if (action === 'OFFER_PARTIAL_REFUND') {
      const amt = t.offerAmount ?? Math.round(c.amount * 50) / 100;
      body.innerHTML = `
        <label for="dAmt">Refund to offer (${esc(c.currency)}, up to ${c.amount.toFixed(2)})</label>
        <input id="dAmt" type="number" min="0.01" step="0.01" max="${c.amount}" value="${amt}">
        <label for="dNote">Message to the buyer</label>
        <textarea id="dNote">${esc(t.buyerMessage)}</textarea>
        <div class="row"><button class="approve" id="send">Approve and send offer</button></div>`;
      $('#send').onclick = (e) =>
        send(e.target, c, 'offer', { amount: Number($('#dAmt').value), note: $('#dNote').value }, 'Offer sent to the buyer.');
    } else if (action === 'ACCEPT_CLAIM') {
      body.innerHTML = `
        <label for="dNote">Note to the buyer</label>
        <textarea id="dNote">${esc(t.buyerMessage)}</textarea>
        <div class="row"><button class="approve" id="send">Approve full refund of ${money(c.amount, c.currency)}</button></div>`;
      $('#send').onclick = (e) => send(e.target, c, 'accept', { note: $('#dNote').value }, 'Claim accepted and buyer refunded.');
    } else {
      body.innerHTML = `
        <label for="dNote">Message to the buyer</label>
        <textarea id="dNote">${esc(t.buyerMessage)}</textarea>
        <div class="row"><button class="approve" id="send">Approve and send message</button></div>`;
      $('#send').onclick = (e) => send(e.target, c, 'message', { message: $('#dNote').value }, 'Message sent to the buyer.');
    }
  };
  const show = (action) => {
    render(action);
    if (sandboxLocked()) {
      $('#send').disabled = true;
      $('#send').insertAdjacentHTML('afterend', '<span class="locked">Sending is turned off on the public demo so the shared PayPal sandbox stays intact. Try sending in the sample shop.</span>');
    }
  };
  $('#dAction').onchange = (e) => show(e.target.value);
  show(t.recommendedAction);
}

async function send(btn, c, kind, payload, done) {
  await guard(btn, async () => {
    await api(`/api/disputes/${c.id}/actions/${kind}`, { method: 'POST', body: payload });
    toast(done);
    await load();
  });
}

async function guard(btn, fn) {
  const label = btn?.textContent;
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
    if (btn) btn.textContent = label;
  } finally {
    if (btn && document.body.contains(btn)) btn.disabled = false;
  }
}

/* ---------- Boot ---------- */

async function boot() {
  initGrid();
  $('#triageAll').addEventListener('click', (e) =>
    guard(e.target, async () => {
      // One request per dispute keeps each call short and shows progress as results land.
      const open = state.cases.filter((c) => c.actionable);
      let failed = 0;
      for (const [i, c] of open.entries()) {
        e.target.textContent = `Reviewing ${i + 1} of ${open.length}…`;
        try {
          const updated = await api(`/api/disputes/${c.id}/triage`, { method: 'POST' });
          state.cases = state.cases.map((x) => (x.id === updated.id ? updated : x));
          state.grid.applyTransaction({ update: [updated] });
          if (state.selectedId === updated.id) renderSlip(updated);
        } catch {
          failed += 1;
        }
      }
      toast(failed ? `Reviewed ${open.length - failed}, ${failed} failed. Try those again.` : `Reviewed ${open.length} disputes.`, Boolean(failed));
      await load();
    }),
  );
  try {
    state.status = await api('/api/status');
    state.source = state.status.defaultSource;
    if (!state.status.sources.includes(state.source)) state.source = state.status.defaultSource;
    renderSources();
    await load();
  } catch (err) {
    $('#headline').textContent = 'Could not load disputes.';
    $('#subline').textContent = err.message;
  }
}

function renderSources() {
  const ai = state.status.ai === 'openrouter' ? `AI via OpenRouter (${state.status.model})` : 'built-in rules (add an OpenRouter key for AI)';
  $('#env').textContent = `Reviewed by ${ai}`;
  const tabs = $('#sources');
  tabs.hidden = state.status.sources.length < 2;
  tabs.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.source === state.source));
  });
  $('#resetSample').hidden = state.source !== 'demo';
}

async function switchSource(source) {
  state.source = source;
  state.selectedId = null;
  $('#slip').innerHTML = '<div class="slip-empty"><p>Pick a dispute from the list to see what happened and what to do next.</p></div>';
  renderSources();
  await load();
}

$('#sources').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-source]');
  if (b && b.dataset.source !== state.source) switchSource(b.dataset.source).catch((err) => toast(err.message, true));
});
$('#loadSample').addEventListener('click', () => switchSource('demo').catch((err) => toast(err.message, true)));
$('#resetSample').addEventListener('click', (e) =>
  guard(e.target, async () => {
    await api('/api/demo/reset', { method: 'POST' });
    state.selectedId = null;
    $('#slip').innerHTML = '<div class="slip-empty"><p>Pick a dispute from the list to see what happened and what to do next.</p></div>';
    toast('Sample shop reset.');
    await load();
  }),
);

boot();
