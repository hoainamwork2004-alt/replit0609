const crypto = require('crypto');
const bot    = require('../bot');
const store  = require('../store');
const log    = require('./logger');
const { animatedText } = require('./utils');
const { SEPAY_SECRET, ADMIN_CHAT_ID } = require('../config');


function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractOrderCode(body) {
  const description = String(body.content || body.description || body.transferContent || body.addInfo || '');
  // Match the order code anywhere in the memo. Memo now also contains a
  // Vietnamese phrase + filler words, so we no longer require a SEVQR/NAP prefix.
  const match = description.match(/\b(od[a-f0-9]{6}\d+)\b/i);
  return match ? match[1] : null;
}

function setupSepayWebhook(app) {
  app.post('/webhook', async (req, res) => {
    const authHeader = req.headers['authorization'] || '';
    const sepayHeader = req.headers['x-sepay-secret'] || '';
    const incoming = (authHeader || sepayHeader).replace('Bearer ', '').replace('Apikey ', '').trim();

    log.info(`SePay webhook auth — Authorization: "${authHeader.slice(0, 20)}...", x-sepay-secret: "${sepayHeader ? 'present' : 'empty'}"`);

    if (!constantTimeCompare(incoming, SEPAY_SECRET)) {
      log.warn('Unauthorized SePay webhook — request rejected');
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const body = req.body;
    const money = Number(body.transferAmount || body.amount || 0);

    if (!Number.isFinite(money) || money <= 0) {
      log.warn(`SePay webhook rejected — invalid amount: ${body.transferAmount || body.amount}`);
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    const webhookId = body.id
      ? String(body.id)
      : crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

    log.info(`SePay webhook received — amount: ${money}, webhookId: ${webhookId}`);

    const key = extractOrderCode(body);
    if (!key) {
      log.info('SePay webhook — no order code found in payload');
      return res.json({ success: true });
    }

    try {
      const result = await store.processPayment(key, money, webhookId);

      if (result.duplicate) {
        log.warn(`Duplicate webhook ignored for ${key}`);
        return res.json({ success: true });
      }

      if (result.notFound) {
        return res.json({ success: true });
      }

      if (!result.fulfilled) {
        const remaining = result.amountRequired - result.totalPaid;
        log.warn(`Partial payment for ${key}: received ${money}, total ${result.totalPaid}/${result.amountRequired}`);
        bot.sendMessage(
          result.chatId,
          `💸 Đã nhận: ${money.toLocaleString()} VND\n` +
          `📊 Tổng đã chuyển: ${result.totalPaid.toLocaleString()} / ${result.amountRequired.toLocaleString()} VND\n` +
          `⚠️ Còn thiếu: ${remaining.toLocaleString()} VND\n\n` +
          `👉 Vui lòng chuyển thêm ${remaining.toLocaleString()} VND`
        ).catch(() => {});
        return res.json({ success: true });
      }

      const deliveryProduct = store.getProductById(result.productId);
      const productName = deliveryProduct ? deliveryProduct.name : `Sản phẩm #${result.productId}`;
      log.payment(`✅ Payment confirmed: ${key} | Amount: ${result.totalPaid} | Product: ${productName} | User: ${result.chatId}`);

      // Carry coupon code from cached order
      if (store.orders && store.orders[key] && store.orders[key].couponCode) {
        result.couponCode = store.orders[key].couponCode;
      }

      const { handleFulfillmentDelivery } = require('./payment');
      await handleFulfillmentDelivery(result, key).catch(e => log.error('Delivery error:', e.message));

      if (ADMIN_CHAT_ID && store.getText('admin_notify_payment') !== 'off') {
        const rate = store.analytics.totalOrders > 0
          ? ((store.analytics.successfulOrders / store.analytics.totalOrders) * 100).toFixed(1)
          : '0.0';
        bot.sendMessage(ADMIN_CHAT_ID,
          `💰 ĐƠN THÀNH CÔNG\n\n` +
          `📋 Mã: ${key}\n` +
          `👤 User: ${result.chatId}\n` +
          `🎬 ${productName}\n` +
          `💸 ${result.totalPaid.toLocaleString()} VND\n\n` +
          `📊 Doanh thu: ${store.analytics.totalRevenue.toLocaleString()} VND\n` +
          `✅ Đơn: ${store.analytics.successfulOrders}/${store.analytics.totalOrders} (${rate}%)`
        ).catch(() => {});
      }

      return res.json({ success: true });
    } catch (e) {
      log.error('Webhook processing error:', e.message);
      return res.status(500).json({ success: false, message: 'Internal error' });
    }
  });
}

module.exports = { setupSepayWebhook };
