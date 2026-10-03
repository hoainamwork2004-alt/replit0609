const bot = require('../bot');
const store = require('../store');
const log = require('./logger');
const { fmtVN, displayProductPrice } = require('./format');

const POINTS_PER_10K_VND = 1;

function pointsForOrder(amount) {
  return Math.floor((amount || 0) / 10000) * POINTS_PER_10K_VND;
}

async function awardOrderPoints(chatId, amount) {
  const pts = pointsForOrder(amount);
  if (pts > 0) {
    await store.addPoints(chatId, pts);
    bot.sendMessage(chatId, `🎁 Bạn vừa nhận ${pts} điểm thưởng!\n💎 Tổng điểm: ${(await store.getPoints(chatId))} điểm\n\n👉 Tích đủ điểm để đổi voucher giảm giá.`).catch(() => {});
  }
  return pts;
}

async function reengageSleepers() {
  const ids = await store.getSleepingUsers(7, 14, 30);
  if (!ids.length) return;
  const product = await store.getHotProductForReengage();
  if (!product) return;

  log.info(`Re-engage cycle: ${ids.length} sleeping users`);

  for (const chatId of ids) {
    try {
      const text =
        `👋 Chào mừng bạn quay lại!\n\n` +
        `🔥 Phim đang hot tuần này:\n` +
        `🎬 ${product.name}\n` +
        `💸 Chỉ ${displayProductPrice(product)}\n\n` +
        `🎁 Tặng riêng bạn voucher COMEBACK10 — Giảm 10% đơn này!`;
      const kb = {
        inline_keyboard: [
          [{ text: '🔥 Xem ngay', callback_data: `view_${product.id}` }],
          [{ text: '📂 Mở menu', callback_data: 'menu' }]
        ]
      };
      await bot.sendMessage(chatId, text, { reply_markup: kb });
      await store.markReengageSent(chatId);
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      if (e && e.response && e.response.body && e.response.body.error_code === 403) {
        // user blocked the bot — mark as reengaged so we don't keep trying
        await store.markReengageSent(chatId).catch(() => {});
      }
    }
  }

  // Make sure COMEBACK10 coupon exists
  const existing = await store.getCoupon('COMEBACK10');
  if (!existing) {
    await store.createCoupon({ code: 'COMEBACK10', discountType: 'percent', discountValue: 10, maxUses: 0 });
  }
}

function startLoyaltyCron() {
  // Run every 6h, and immediately 60s after boot
  setTimeout(() => reengageSleepers().catch(() => {}), 60_000);
  setInterval(() => reengageSleepers().catch(() => {}), 6 * 60 * 60 * 1000).unref();

  // Daily cleanup of expired purchase history
  setInterval(() => store.cleanupExpiredPurchases().catch(() => {}), 24 * 60 * 60 * 1000).unref();
  setInterval(() => store.cleanupOldCancels && store.cleanupOldCancels().catch(() => {}), 24 * 60 * 60 * 1000).unref();
}

module.exports = { awardOrderPoints, pointsForOrder, reengageSleepers, startLoyaltyCron };
