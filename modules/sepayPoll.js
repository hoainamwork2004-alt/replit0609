const store = require('../store');
const log = require('./logger');
const { SEPAY_API_TOKEN } = require('../config');

const SEPAY_API_BASE = 'https://my.sepay.vn/userapi';

// In-memory tracker — { code: { startedAt, lastPolled, fulfilled } }
const watch = new Map();

function watchOrder(code) {
  if (!SEPAY_API_TOKEN) return;
  watch.set(code, { startedAt: Date.now(), lastPolled: 0 });
}

function unwatchOrder(code) {
  watch.delete(code);
}

async function pollSepayOnce(code) {
  if (!SEPAY_API_TOKEN) return;
  try {
    const url = `${SEPAY_API_BASE}/transactions/list?limit=20`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${SEPAY_API_TOKEN}` } });
    if (!res.ok) {
      log.warn(`SePay poll HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    const list = (data && (data.transactions || data.data)) || [];
    for (const tx of list) {
      const desc = String(tx.transaction_content || tx.content || tx.description || '');
      if (!desc.toUpperCase().includes(code.toUpperCase())) continue;
      const amount = Number(tx.amount_in || tx.amount || 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const webhookId = `poll_${tx.id || tx.reference_number || code}_${amount}`;
      const result = await store.processPayment(code, amount, webhookId);
      if (result && (result.duplicate || result.notFound)) continue;
      if (result && result.fulfilled) {
        log.payment(`✅ SePay POLL fulfilled order ${code} (${amount} VND)`);
        const { handleFulfillmentDelivery } = require('./payment');
        if (handleFulfillmentDelivery) await handleFulfillmentDelivery(result, code).catch(() => {});
        unwatchOrder(code);
        return;
      }
    }
  } catch (e) {
    log.error('SePay poll error:', e.message);
  }
}

function startSepayPollCron() {
  if (!SEPAY_API_TOKEN) {
    log.info('SePay polling disabled — SEPAY_API_TOKEN not set');
    return;
  }
  log.info('SePay polling enabled');
  setInterval(async () => {
    const now = Date.now();
    for (const [code, info] of watch.entries()) {
      // Only start polling 30s after order was created (give webhook a chance first)
      if (now - info.startedAt < 30_000) continue;
      // Stop watching after 15 min — order will have expired
      if (now - info.startedAt > 15 * 60 * 1000) { unwatchOrder(code); continue; }
      // Throttle: poll once every 25s per order
      if (now - info.lastPolled < 25_000) continue;
      info.lastPolled = now;
      pollSepayOnce(code).catch(() => {});
    }
  }, 5_000).unref();
}

module.exports = { watchOrder, unwatchOrder, startSepayPollCron };
