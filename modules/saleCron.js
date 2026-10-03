const log = require('./logger');
const store = require('../store');

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const toApply = await store.getDueSalesToApply();
    for (const s of toApply) {
      const snapshot = await store.snapshotProductsForScope(s.scope);
      if (!snapshot.length) {
        await store.markSaleApplied(s.id, []);
        log.info(`Sale #${s.id}: no products in scope, marked applied`);
        continue;
      }
      // Mark applied BEFORE mutating so a concurrent admin delete will see it
      // as active and trigger snapshot restore.
      await store.markSaleApplied(s.id, snapshot);
      const updated = await store.bulkUpdatePrices(s.pct, s.scope, true);
      log.info(`Sale #${s.id} APPLIED: ${s.pct}% on ${s.scope} (${updated} products)`);
    }

    const toRevert = await store.getDueSalesToRevert();
    for (const s of toRevert) {
      if (s.snapshot && Array.isArray(s.snapshot) && s.snapshot.length) {
        await store.applyPriceSnapshot(s.snapshot);
      }
      await store.markSaleReverted(s.id);
      log.info(`Sale #${s.id} REVERTED`);
    }
  } catch (e) {
    log.error('saleCron tick error:', e.message);
  } finally {
    running = false;
  }
}

function startSaleCron() {
  if (timer) return;
  tick().catch(() => {});
  timer = setInterval(() => tick().catch(() => {}), 60_000);
  if (timer.unref) timer.unref();
  log.info('Sale cron started (60s tick)');
}

module.exports = { startSaleCron };
