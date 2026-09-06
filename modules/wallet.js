const bot = require('../bot');
const store = require('../store');
const log = require('./logger');
const { generateMemo, generateQR, formatTime, delay, prefixWithEntities, applyTemplate, runLoadingAnimation, pickRandomText } = require('./utils');

// Cùng bộ key intro QR như payment.js — bot chọn ngẫu nhiên 1 trong 3 (admin sửa qua /admin).
const QR_INTRO_KEYS = ['qr_intro_1', 'qr_intro_2', 'qr_intro_3'];

// Phases riêng cho nạp ví — KHÔNG dùng "Xử lý dữ liệu…", có sắc thái "nạp tiền vào ví".
const TOPUP_LOADING_PHASES = [
  { max: 30,  text: '💰 Tạo đơn nạp ví' },
  { max: 60,  text: '🔐 Sinh mã QR an toàn' },
  { max: 90,  text: '🏦 Kết nối ngân hàng' },
  { max: 100, text: '✅ Sẵn sàng nhận nạp' }
];

async function showQrIntro(chatId) {
  const picked = pickRandomText(store, QR_INTRO_KEYS);
  if (!picked) return;
  const opts = {};
  if (picked.entities) opts.entities = picked.entities;
  const sent = await bot.sendMessage(chatId, picked.text, opts).catch(() => null);
  if (!sent) return;
  await delay(4000);
  await bot.deleteMessage(chatId, sent.message_id).catch(() => {});
}
const crypto = require('crypto');
const { fmtVN } = require('./format');
const { ORDER_TIMEOUT_SEC, ADMIN_CHAT_ID } = require('../config');
const { watchOrder, unwatchOrder } = require('./sepayPoll');

const TOPUP_PRODUCT_ID = '0';
const sendingLock = {};

if (!global.topupLoop) global.topupLoop = new Map();
if (!global.topupMessages) global.topupMessages = new Map();

function stopTopupLoop(chatId) {
  if (global.topupLoop.has(chatId)) {
    clearInterval(global.topupLoop.get(chatId));
    global.topupLoop.delete(chatId);
  }
}

function generateTopupCode() {
  // Same shape as product order codes ("od" + 6 hex + numeric productId)
  // so the SePay regex /\b(od[a-f0-9]{6}\d+)\b/i still captures it. We use
  // productId="0" as the topup sentinel — no real product has id=0.
  const raw = 'topup' + Date.now() + Math.random();
  return 'od' + crypto.createHash('md5').update(raw).digest('hex').slice(0, 6) + TOPUP_PRODUCT_ID;
}

function parseTopupAmounts() {
  const raw = (store.getText('topup_amounts') || '10000,20000,50000,100000').trim();
  const arr = raw.split(/[,\s]+/).map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n >= 1000);
  return arr.length ? arr : [10000, 20000, 50000, 100000];
}

function renderTopupTitle(chatId) {
  const balance = store.getWalletBalance(chatId);
  const defaultTitle = '💰 NẠP TIỀN VÀO VÍ\n\nChọn mệnh giá nạp:';
  const titleRawFull = (store.getText('topup_title') || defaultTitle);
  const titleRaw = titleRawFull.trim();
  // Carry custom_emoji / formatting entities from the admin-edited title and
  // shift them by the leading-trim + balance-line prefix so animated emojis
  // line up correctly when Telegram renders the message.
  const rawEntities = store.getTextEntities('topup_title');
  let entities = null;
  if (rawEntities && rawEntities.length) {
    const leading = titleRawFull.length - titleRawFull.trimStart().length;
    let leadingUtf16 = 0;
    for (const ch of titleRawFull.slice(0, leading)) {
      leadingUtf16 += ch.codePointAt(0) > 0xffff ? 2 : 1;
    }
    entities = rawEntities
      .map(e => ({ ...e, offset: e.offset - leadingUtf16 }))
      .filter(e => e.offset >= 0);
  }
  // Banner KM x2 hiện trên đầu (trước số dư) khi admin đang bật KM.
  let promoPrefix = '';
  if (store.isTopupPromoActive()) {
    const min = store.getTopupPromoMin();
    const tplRaw = (store.getText('topup_x2_notice') ||
      '🎁 KHUYẾN MÃI x2 NẠP TIỀN!\n💰 Nạp từ {min}đ trở lên → nhận GẤP ĐÔI vào ví!').trim();
    promoPrefix = tplRaw.replace(/\{min\}/g, fmtVN(min)) + '\n\n';
  }
  const prefix = `${promoPrefix}💎 Số dư: ${fmtVN(balance)} VNĐ\n\n`;
  return prefixWithEntities(prefix, titleRaw, entities);
}

function buildTopupKeyboard() {
  const amounts = parseTopupAmounts();
  const buttons = amounts.map(a => ({
    text: `${fmtVN(a)}đ`,
    callback_data: `nap_${a}`
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: store.getText('btn_back_menu') || '🔙 Quay lại menu', callback_data: 'menu' }]);
  return rows;
}

// Show the topup dashboard. If `forceFresh`, always send a new message; otherwise
// reuse the last menu message (edit in place) — same UX as other menu screens.
async function showTopupDashboard(chatId, opts = {}) {
  const { renderMenuMessage, lastMenuMessage } = require('./menu');
  const { text, entities } = renderTopupTitle(chatId);
  const kb = buildTopupKeyboard();
  if (opts.forceFresh) {
    if (lastMenuMessage[chatId]) {
      await bot.deleteMessage(chatId, lastMenuMessage[chatId]).catch(() => {});
      delete lastMenuMessage[chatId];
    }
  }
  await renderMenuMessage(chatId, text, kb, true, entities);
}

// Render text with placeholder substitution (same lightweight approach as
// payment.js uses for buy_title). Supported tokens: {amount}, {balance}, {price}.
function renderTemplate(text, vars) {
  if (!text) return '';
  return text
    .replace(/\{amount\}/g, fmtVN(vars.amount || 0))
    .replace(/\{balance\}/g, fmtVN(vars.balance || 0))
    .replace(/\{price\}/g, fmtVN(vars.price || 0));
}

// Create a topup order + QR + countdown loop. Mirrors handleBuyPro but simpler
// (no product, no coupon).
async function startTopup(chatId, amount, originatingMessageId) {
  if (sendingLock[chatId]) return;
  sendingLock[chatId] = true;
  setTimeout(() => { delete sendingLock[chatId]; }, 2000);

  const validAmounts = parseTopupAmounts();
  if (!validAmounts.includes(amount)) {
    return bot.sendMessage(chatId, '❌ Mệnh giá không hợp lệ.').catch(() => {});
  }

  // Cancel any existing topup-in-progress for the same user (allows retry).
  const existingTopup = store.userLastTopup && store.userLastTopup[chatId];
  if (existingTopup) {
    stopTopupLoop(chatId);
    unwatchOrder(existingTopup);
    if (global.topupMessages.has(chatId)) {
      await bot.deleteMessage(chatId, global.topupMessages.get(chatId)).catch(() => {});
      global.topupMessages.delete(chatId);
    }
    await store.cancelOrder(existingTopup, chatId).catch(() => {});
  }

  const code = generateTopupCode();
  const memo = generateMemo(code);

  // Tính bonus theo trạng thái KM x2 hiện tại — KHOÁ vào đơn (orders.bonus_amount).
  // Sau này admin có tắt KM thì bonus đã hứa lúc tạo QR vẫn được giữ nguyên cho user.
  const bonus = store.getTopupBonus(amount);
  const totalCredit = amount + bonus;

  try {
    await store.createOrder(code, chatId, TOPUP_PRODUCT_ID, amount, ORDER_TIMEOUT_SEC, 'topup', bonus);
    if (store.orders[code]) store.orders[code].memo = memo;
  } catch (e) {
    if (e.message === 'ACTIVE_ORDER_EXISTS') {
      return bot.sendMessage(chatId, '⚠️ Bạn đang có một đơn nạp tiền chưa hoàn tất.').catch(() => {});
    }
    log.error('startTopup createOrder error:', e.message);
    return bot.sendMessage(chatId, '❌ Lỗi tạo đơn nạp. Vui lòng thử lại.').catch(() => {});
  }

  log.payment(`New topup order: ${code} | User: ${chatId} | Amount: ${amount.toLocaleString()} VND`);

  const qr = generateQR(amount, memo);
  const expireAt = Date.now() + ORDER_TIMEOUT_SEC * 1000;

  // Remove the originating menu/dashboard message so the QR replaces it visually.
  if (originatingMessageId) {
    await bot.deleteMessage(chatId, originatingMessageId).catch(() => {});
    const { lastMenuMessage } = require('./menu');
    if (lastMenuMessage[chatId] === originatingMessageId) delete lastMenuMessage[chatId];
  }

  // Thanh loading 2.4s + thông báo random trước khi QR xuất hiện (đồng bộ UX với mua phim qua QR).
  const loadingMsgId = await runLoadingAnimation(bot, chatId, {
    phases: TOPUP_LOADING_PHASES,
    totalMs: 2400,
    icon: '💰',
    doneText: `✅  ▰▰▰▰▰▰▰▰▰▰  100%\n💰  Sẵn sàng nhận nạp!`
  });
  if (loadingMsgId) {
    await bot.deleteMessage(chatId, loadingMsgId).catch(() => {});
  }
  await showQrIntro(chatId);

  const keyboard = {
    inline_keyboard: [
      [{ text: store.getText('btn_topup_cancel') || '🔄 Huỷ đơn nạp', callback_data: `napcancel_${code}` }],
      [{ text: store.getText('btn_back_menu')    || '🔙 Quay lại menu', callback_data: 'menu' }]
    ]
  };

  const buildCaption = (extra = '') => {
    const remaining = Math.max(0, Math.ceil((expireAt - Date.now()) / 1000));
    const bonusLine = bonus > 0
      ? `🎁 KM x2: +${fmtVN(bonus)} VNĐ\n💎 Tổng nhận: ${fmtVN(totalCredit)} VNĐ\n`
      : '';
    return (
      `💰 NẠP TIỀN VÀO VÍ\n\n` +
      `💵 Mệnh giá: ${fmtVN(amount)} VNĐ\n` +
      bonusLine +
      `📌 Nội dung CK:\n${memo}\n\n` +
      `⏳ Đơn hết hạn sau: ${formatTime(remaining)}${extra}\n\n` +
      `📱 Quét QR bằng app ngân hàng để nạp tiền vào ví.`
    );
  };

  const sent = await bot.sendPhoto(chatId, qr, {
    caption: buildCaption(),
    reply_markup: keyboard
  }).catch(e => { log.error('Topup QR send failed:', e.message); return null; });

  if (!sent) {
    await store.cancelOrder(code, chatId);
    return bot.sendMessage(chatId, '❌ Lỗi hiển thị QR. Vui lòng thử lại.').catch(() => {});
  }

  global.topupMessages.set(chatId, sent.message_id);
  watchOrder(code);

  let currentMessageId = sent.message_id;

  const interval = setInterval(async () => {
    try {
      const remaining = Math.max(0, Math.ceil((expireAt - Date.now()) / 1000));

      if (!store.orders[code] || store.orders[code].paid) {
        clearInterval(interval);
        global.topupLoop.delete(chatId);
        return;
      }

      if (remaining <= 0) {
        clearInterval(interval);
        global.topupLoop.delete(chatId);
        global.topupMessages.delete(chatId);
        unwatchOrder(code);
        await store.expireOrder(code, chatId);
        log.payment(`Topup order expired: ${code}`);
        await bot.editMessageCaption(
          `❌ HẾT THỜI GIAN NẠP TIỀN\n\n💵 Mệnh giá: ${fmtVN(amount)} VNĐ\n📋 Mã: ${code}`,
          {
            chat_id: chatId, message_id: currentMessageId,
            reply_markup: { inline_keyboard: [
              [{ text: store.getText('btn_topup_retry') || '💰 Nạp lại', callback_data: 'nap' }],
              [{ text: store.getText('btn_back_menu')   || '🔙 Quay lại menu', callback_data: 'menu' }]
            ] }
          }
        ).catch(() => {});
        return;
      }

      let extra = '';
      if (remaining < 60) extra = '\n⚠️ Sắp hết thời gian!';
      if (remaining < 30) extra = '\n🚨 SẮP HẾT HẠN!';

      await bot.editMessageCaption(buildCaption(extra), {
        chat_id: chatId, message_id: currentMessageId,
        reply_markup: keyboard
      });
    } catch (err) {
      const msg = (err && err.message) || '';
      if (msg.includes('message is not modified')) return;
      if (msg.includes('Too Many Requests')) return;
      const lower = msg.toLowerCase();
      if (lower.includes('chat not found') || lower.includes('bot was blocked') ||
          lower.includes('user is deactivated') || lower.includes('forbidden')) {
        clearInterval(interval);
        global.topupLoop.delete(chatId);
        global.topupMessages.delete(chatId);
        unwatchOrder(code);
        return;
      }
    }
  }, 1000);

  global.topupLoop.set(chatId, interval);
}

async function cancelTopup(chatId, code, paymentMessageId) {
  stopTopupLoop(chatId);
  unwatchOrder(code);
  global.topupMessages.delete(chatId);
  await store.cancelOrder(code, chatId).catch(() => {});
  if (paymentMessageId) {
    await bot.deleteMessage(chatId, paymentMessageId).catch(() => {});
  }
  await showTopupDashboard(chatId, { forceFresh: true });
}

// Called by sepay.js / sepayPoll.js once a topup order is fully paid. Wallet
// is already credited inside store.processPayment (atomic), so this just
// notifies the user and refreshes the topup dashboard.
async function handleTopupFulfillment(result, code) {
  const chatId = result.chatId;

  stopTopupLoop(chatId);
  if (global.topupMessages.has(chatId)) {
    await bot.deleteMessage(chatId, global.topupMessages.get(chatId)).catch(() => {});
    global.topupMessages.delete(chatId);
  }
  unwatchOrder(code);

  const balance = (result.newWalletBalance != null) ? result.newWalletBalance : store.getWalletBalance(chatId);
  const bonus = Number.isFinite(result.bonus) && result.bonus > 0 ? result.bonus : 0;
  const tplRaw = store.getText('topup_success') ||
    '✅ Nạp ví thành công!\n\n💵 Số tiền nạp: {amount} VNĐ\n💎 Số dư hiện tại: {balance} VNĐ';
  const tplEntities = store.getTextEntities('topup_success');
  const { text: tplMsg, entities: tplEnt } = applyTemplate(tplRaw, tplEntities, {
    amount: fmtVN(result.amountRequired),
    balance: fmtVN(balance)
  });
  // Khi có bonus: prepend banner "🎁 KM x2 ..." trên template (entities được dịch offset
  // theo độ dài banner để custom_emoji của admin không bị lệch).
  let msg = tplMsg;
  let msgEntities = tplEnt;
  if (bonus > 0) {
    const banner = `🎁 KM x2 ĐÃ ÁP DỤNG!\n💵 Bạn nạp: ${fmtVN(result.amountRequired)} VNĐ\n🎉 Cộng thêm: ${fmtVN(bonus)} VNĐ\n\n`;
    let bannerUtf16 = 0;
    for (const ch of banner) bannerUtf16 += ch.codePointAt(0) > 0xffff ? 2 : 1;
    msg = banner + tplMsg;
    if (tplEnt && tplEnt.length) {
      msgEntities = tplEnt.map(e => ({ ...e, offset: e.offset + bannerUtf16 }));
    }
  }

  const sendOpts = {
    reply_markup: {
      inline_keyboard: [
        [{ text: store.getText('btn_topup_again') || '💰 Nạp thêm', callback_data: 'nap' }],
        [{ text: store.getText('btn_back_menu')   || '🔙 Quay lại menu', callback_data: 'menu' }]
      ]
    }
  };
  if (msgEntities) sendOpts.entities = msgEntities;
  await bot.sendMessage(chatId, msg, sendOpts).catch(() => {});

  if (ADMIN_CHAT_ID && store.getText('admin_notify_payment') !== 'off') {
    const bonusLineAdmin = bonus > 0 ? `🎁 Bonus x2: +${bonus.toLocaleString()} VND\n` : '';
    bot.sendMessage(ADMIN_CHAT_ID,
      `💰 NẠP VÍ THÀNH CÔNG\n\n` +
      `📋 Mã: ${code}\n` +
      `👤 User: ${chatId}\n` +
      `💵 ${result.amountRequired.toLocaleString()} VND\n` +
      bonusLineAdmin +
      `💎 Số dư mới: ${balance.toLocaleString()} VND`
    ).catch(() => {});
  }
}

module.exports = {
  showTopupDashboard,
  startTopup,
  cancelTopup,
  handleTopupFulfillment,
  stopTopupLoop,
  parseTopupAmounts,
  renderTemplate,
  TOPUP_PRODUCT_ID
};
