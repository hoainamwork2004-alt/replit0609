const bot   = require('../bot');
const store = require('../store');
const log   = require('./logger');
const { generateOrderCode, generateMemo, generateQR, formatTime, delay, applyTemplate, runLoadingAnimation, pickRandomText } = require('./utils');

// Các biến thể text "thông báo trước QR" — bot chọn ngẫu nhiên 1 (giống cơ chế của preview).
const QR_INTRO_KEYS = ['qr_intro_1', 'qr_intro_2', 'qr_intro_3'];

// Phases cho thanh loading trước khi hiện QR ngân hàng. Ngắn gọn, có hint cho user.
const QR_LOADING_PHASES = [
  { max: 30,  text: '💳 Tạo đơn hàng' },
  { max: 60,  text: '🔐 Sinh mã QR an toàn' },
  { max: 90,  text: '🏦 Kết nối ngân hàng' },
  { max: 100, text: '✅ Sẵn sàng nhận tiền' }
];

// Phases cho mua bằng Ví KhoPhim — không có QR, mang sắc thái "mở khoá phim".
const WALLET_LOADING_PHASES = [
  { max: 30,  text: '💎 Kiểm tra ví KhoPhim' },
  { max: 60,  text: '💸 Trừ tiền' },
  { max: 90,  text: '🎬 Mở khoá phim cho bạn' },
  { max: 100, text: '✅ Hoàn tất' }
];

// Hiện thông báo random qr_intro_* trong ~4s rồi tự xoá. An toàn nếu admin để trống cả 3 key.
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
const { stopActiveSession, stopLiveDashboard, pauseLiveDashboard, showPreview } = require('./preview');
const { mainMenu, lastMenuMessage } = require('./menu');
const { SUPPORT_USERNAME, ORDER_TIMEOUT_SEC, ADMIN_CHAT_ID } = require('../config');
const { watchOrder, unwatchOrder } = require('./sepayPoll');
const { fmtVN, priceDisplay, getEffectivePriceVnd, getCurrencySettings, fmtUsd, displayProductPrice, strike, priceDisplayWithEntities } = require('./format');

const couponState = new Map(); // chatId -> { orderCode }
function setAwaitingCoupon(chatId, code) { couponState.set(chatId, { orderCode: code, ts: Date.now() }); }
function isAwaitingCoupon(chatId) {
  const s = couponState.get(chatId);
  if (!s) return null;
  if (Date.now() - s.ts > 5 * 60 * 1000) { couponState.delete(chatId); return null; }
  return s;
}
function clearAwaitingCoupon(chatId) { couponState.delete(chatId); }

if (!global.paymentLoop) global.paymentLoop = new Map();
if (!global.paymentMessages) global.paymentMessages = new Map();

// === Anti-cancel-abuse: warn on 1st-2nd cancel, ban 24h on 3rd+ within 24h ===
// Persisted in DB via store.recordCancel / store.setBan / store.isBanned.
const BAN_DURATION_MS = 24 * 60 * 60 * 1000;
const CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;
const CANCEL_LIMIT = 2; // > limit → ban

function isBanned(chatId) {
  return store.isBanned(chatId);
}

function formatBanRemaining(untilMs) {
  const remainMs = Math.max(0, untilMs - Date.now());
  const h = Math.floor(remainMs / 3_600_000);
  const m = Math.floor((remainMs % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const sendingLock = {};

function stopPaymentLoop(chatId) {
  if (global.paymentLoop.has(chatId)) {
    clearInterval(global.paymentLoop.get(chatId));
    global.paymentLoop.delete(chatId);
  }
}

function startExpiryWatcher() {
  setInterval(async () => {
    const expired = await store.expireOverdueOrders();
    if (expired > 0) {
      log.info(`Expiry watcher cleaned up ${expired} overdue orders`);
    }
  }, 30000);
}

// Triage hit when user taps "💳 Thanh toán" on a film. Three branches:
//  - Wallet >= price → debit wallet + deliver immediately (no QR).
//  - 0 < wallet < price → show 2 buttons (top up wallet OR pay by QR).
//  - Wallet == 0 → show admin-editable notice for ~5s, then auto-open topup dashboard.
// `messageId` is the dashboard/preview message that hosts the Thanh toán button.
async function handleBuyEntry(chatId, productId, messageId) {
  if (sendingLock[chatId]) return;
  // Don't set the lock here — handleBuyPro / handleBuyFromWallet will set it themselves.

  const products = store.products;
  const p = products[productId];
  if (!p) return bot.sendMessage(chatId, '❌ Sản phẩm không tồn tại').catch(() => {});

  const priceVnd = getEffectivePriceVnd(p);
  if (!priceVnd || priceVnd <= 0) {
    return bot.sendMessage(chatId, '⚠️ Sản phẩm này chưa được niêm yết giá. Vui lòng liên hệ admin.').catch(() => {});
  }

  const balance = store.getWalletBalance(chatId);

  if (balance >= priceVnd) {
    return handleBuyFromWallet(chatId, productId, messageId);
  }

  if (balance === 0) {
    const zeroRaw = store.getText('topup_zero_balance_notice') ||
      '💰 Ví của bạn đang trống.\n\n👉 Mở bảng nạp tiền trong giây lát…';
    const zeroEntities = store.getTextEntities('topup_zero_balance_notice');
    const zeroOpts = {};
    if (zeroEntities && zeroEntities.length) zeroOpts.entities = zeroEntities;
    const sent = await bot.sendMessage(chatId, zeroRaw, zeroOpts).catch(() => null);
    setTimeout(async () => {
      if (sent) await bot.deleteMessage(chatId, sent.message_id).catch(() => {});
      const wallet = require('./wallet');
      await wallet.showTopupDashboard(chatId, { forceFresh: true });
    }, 5000);
    return;
  }

  // Insufficient but > 0: ask user to choose top up or pay by QR.
  const tplRaw = store.getText('insufficient_balance_msg') ||
    '⚠️ Số dư trong ví không đủ.\n\n💎 Số dư: {balance} VNĐ\n💸 Cần: {price} VNĐ\n\n' +
    'Bạn có thể nạp thêm tiền vào ví hoặc thanh toán trực tiếp bằng QR.';
  const tplEntities = store.getTextEntities('insufficient_balance_msg');
  const { text, entities } = applyTemplate(tplRaw, tplEntities, {
    balance: fmtVN(balance),
    price:   fmtVN(priceVnd)
  });
  const sendOpts = {
    reply_markup: {
      inline_keyboard: [
        [{ text: store.getText('btn_topup_more')  || '💰 Nạp thêm vào ví',  callback_data: 'nap' }],
        [{ text: store.getText('btn_pay_with_qr') || '📱 Thanh toán bằng QR', callback_data: `buyqr_${productId}` }],
        [{ text: store.getText('btn_back_menu')   || '🔙 Quay lại menu',    callback_data: 'menu' }]
      ]
    }
  };
  if (entities) sendOpts.entities = entities;
  await bot.sendMessage(chatId, text, sendOpts).catch(() => {});
}

// Pay using wallet balance — no QR, instant delivery. Wraps debit + delivery
// in a single user-visible flow.
async function handleBuyFromWallet(chatId, productId, messageId) {
  if (sendingLock[chatId]) return;
  sendingLock[chatId] = true;
  setTimeout(() => { delete sendingLock[chatId]; }, 2000);

  const products = store.products;
  const p = products[productId];
  if (!p) return bot.sendMessage(chatId, '❌ Sản phẩm không tồn tại').catch(() => {});

  const priceVnd = getEffectivePriceVnd(p);
  if (!priceVnd || priceVnd <= 0) {
    return bot.sendMessage(chatId, '⚠️ Sản phẩm này chưa được niêm yết giá.').catch(() => {});
  }

  // Atomic debit. If concurrent purchase / topup races and balance went below,
  // store.debitWallet returns ok=false and we re-trigger the triage to show
  // the right insufficient/zero branch.
  const refCode = generateOrderCode(productId);
  const debit = await store.debitWallet(chatId, priceVnd, 'purchase', refCode, `product:${productId}`);
  if (!debit.ok) {
    return handleBuyEntry(chatId, productId, messageId);
  }

  // Increment total_buy ONLY (not total_spent / not analytics revenue —
  // money was already counted at topup time).
  await store.incrementUserBuyCount(chatId).catch(() => {});

  // Đóng dashboard preview trước, rồi chạy thanh loading riêng cho mua bằng ví — KHÔNG dùng
  // text "Xử lý dữ liệu…", các phase mang sắc thái "kiểm tra ví → trừ tiền → mở khoá phim".
  if (messageId) {
    await bot.deleteMessage(chatId, messageId).catch(() => {});
  }
  const walletLoadingId = await runLoadingAnimation(bot, chatId, {
    phases: WALLET_LOADING_PHASES,
    totalMs: 2400,
    icon: '💎',
    doneText: `✅  ▰▰▰▰▰▰▰▰▰▰  100%\n💎  Sẵn sàng giao phim!`
  });
  if (walletLoadingId) {
    await bot.deleteMessage(chatId, walletLoadingId).catch(() => {});
  }

  // Notify deduction.
  const tplRaw = store.getText('wallet_purchase_success') ||
    '✅ Đã trừ {amount} VNĐ từ ví của bạn.\n💎 Số dư còn lại: {balance} VNĐ';
  const tplEntities = store.getTextEntities('wallet_purchase_success');
  const { text: msg, entities: msgEntities } = applyTemplate(tplRaw, tplEntities, {
    amount:  fmtVN(priceVnd),
    balance: fmtVN(debit.balance)
  });
  const msgOpts = {};
  if (msgEntities) msgOpts.entities = msgEntities;
  await bot.sendMessage(chatId, msg, msgOpts).catch(() => {});

  // Record purchase + loyalty + delivery (mirrors handleFulfillmentDelivery).
  await store.recordPurchase(chatId, productId, p.name, refCode).catch(() => {});
  try {
    const { awardOrderPoints } = require('./loyalty');
    await awardOrderPoints(chatId, priceVnd).catch(() => {});
  } catch {}

  const { sendDeliveryDashboard } = require('./delivery');
  await sendDeliveryDashboard(chatId, p);

  await bot.sendMessage(chatId,
    `⚠️ Lưu ý: Nội dung "Phim của tôi" sẽ tự động xoá sau 30 ngày.\n` +
    `👉 Hãy lưu/xem ngay nội dung phía trên về máy của bạn.`
  ).catch(() => {});

  log.payment(`Wallet purchase: ${refCode} | User: ${chatId} | Product: ${p.name} | Price: ${priceVnd.toLocaleString()} | Bal after: ${debit.balance}`);
}

async function handleBuyPro(chatId, productId, messageId) {
  if (sendingLock[chatId]) return;
  sendingLock[chatId] = true;
  setTimeout(() => { delete sendingLock[chatId]; }, 2000);

  const products = store.products;
  const p = products[productId];
  if (!p) return bot.sendMessage(chatId, '❌ Sản phẩm không tồn tại').catch(() => {});

  const priceVnd = getEffectivePriceVnd(p);
  if (!priceVnd || priceVnd <= 0) {
    return bot.sendMessage(chatId, '⚠️ Sản phẩm này chưa được niêm yết giá. Vui lòng liên hệ admin.').catch(() => {});
  }

  if (store.userLastOrder[chatId]) {
    return bot.sendMessage(chatId, `⚠️ Đang có đơn chưa thanh toán\n\n👉 Mã đơn: ${store.userLastOrder[chatId]}`).catch(() => {});
  }

  await stopActiveSession(chatId);
  pauseLiveDashboard(chatId);
  stopPaymentLoop(chatId);

  const code = generateOrderCode(productId);
  const memo = generateMemo(code);

  try {
    await store.createOrder(code, chatId, productId, priceVnd, ORDER_TIMEOUT_SEC, 'product');
    if (store.orders[code]) store.orders[code].memo = memo;
  } catch (e) {
    if (e.message === 'ACTIVE_ORDER_EXISTS') {
      return bot.sendMessage(chatId, `⚠️ Đang có đơn chưa thanh toán`).catch(() => {});
    }
    return bot.sendMessage(chatId, '❌ Lỗi tạo đơn hàng. Vui lòng thử lại.').catch(() => {});
  }

  log.payment(`New order: ${code} | User: ${chatId} | Product: ${p.name} | Price: ${priceVnd.toLocaleString()} VND`);

  const qr = generateQR(priceVnd, memo);

  // Đóng dashboard preview trước khi chạy thanh loading + thông báo intro QR cho gọn chat.
  // (Trong nhánh buyqr_, handler đã xoá messageId rồi — deleteMessage thứ 2 chỉ no-op.)
  await bot.deleteMessage(chatId, messageId).catch(() => {});

  // Thanh loading 2.4s với phase text riêng cho QR (không dùng "Xử lý dữ liệu…").
  const loadingMsgId = await runLoadingAnimation(bot, chatId, {
    phases: QR_LOADING_PHASES,
    totalMs: 2400,
    icon: '💳',
    doneText: `✅  ▰▰▰▰▰▰▰▰▰▰  100%\n💳  Sẵn sàng nhận tiền!`
  });
  if (loadingMsgId) {
    await bot.deleteMessage(chatId, loadingMsgId).catch(() => {});
  }

  // Thông báo random (1 trong 3 biến thể admin sửa được) hiện ~4s rồi tự xoá, ngay trước khi QR xuất hiện.
  await showQrIntro(chatId);

  const keyboard = {
    inline_keyboard: [
      [{ text: store.getText('btn_coupon') || '🎟 Nhập mã giảm giá', callback_data: `coup_${code}`       }],
      [{ text: store.getText('btn_back')   || '🔙 Quay lại',         callback_data: `bk2pv_${productId}` }],
      [{ text: store.getText('btn_reset')  || '🔄 Đổi phim',         callback_data: 'reset'              }]
    ]
  };

  const buyTitle = store.getText('buy_title') || '💳 THANH TOÁN';
  const buyTitleEntities = store.getTextEntities('buy_title');
  const buyFooter = store.getText('buy_footer') || '';
  const buyFooterEntities = store.getTextEntities('buy_footer');

  const expireAt = Date.now() + ORDER_TIMEOUT_SEC * 1000;

  const buildCaption = (extra = '') => {
    const remaining = Math.max(0, Math.ceil((expireAt - Date.now()) / 1000));
    const prefix = `\n${buyTitle}\n\n`;
    const order = store.orders[code];
    const currentAmount = order ? order.amountRequired : priceVnd;
    const discount = order ? (order.discount || 0) : 0;
    const couponLine = (order && order.couponCode)
      ? `🎟 Mã giảm: ${order.couponCode} (-${fmtVN(discount)} VNĐ)\n`
      : '';
    // Hiển thị giá theo chế độ tiền tệ. SePay luôn nhận VND (đã nhúng trong QR), nên USD-only chỉ cần show $.
    // Giá gốc được gạch ngang BẰNG ENTITY (strikethrough) — không dùng combining char để tránh
    // bị một số font Android hiển thị nhầm thành gạch chân.
    const { mode, rate } = getCurrencySettings();
    const baselineVnd = p.originalPrice && p.originalPrice > currentAmount
      ? p.originalPrice
      : (discount > 0 ? p.price : 0);

    const nameLine = `🎬 ${p.name}\n`;
    const pricePrefix = `💸 Giá: `;
    // Offset (UTF-16) tới đầu phần giá tính từ đầu caption (sau prefix + nameLine).
    const priceTextOffset = prefix.length + nameLine.length + pricePrefix.length;

    let priceContent = '';
    let priceEntity = null; // { type:'strikethrough', offset, length } hoặc null
    if (mode === 'usd' || mode === 'both') {
      const liveUsd = rate > 0 ? (currentAmount / rate) : 0;
      if (liveUsd > 0) {
        const origUsd = baselineVnd > 0 && rate > 0 ? (baselineVnd / rate) : 0;
        const hasDiscount = origUsd > liveUsd;
        const origStr = hasDiscount ? fmtUsd(origUsd) : '';
        const usdPart = hasDiscount ? `${origStr} ${fmtUsd(liveUsd)}` : fmtUsd(liveUsd);
        if (hasDiscount) {
          priceEntity = { type: 'strikethrough', offset: priceTextOffset, length: origStr.length };
        }
        priceContent = (mode === 'usd')
          ? usdPart
          : `${usdPart} (≈ ${fmtVN(currentAmount)} VNĐ — số tiền cần CK)`;
      } else {
        const pd = priceDisplayWithEntities(currentAmount, baselineVnd, priceTextOffset);
        priceContent = pd.text;
        if (pd.entities.length > 0) priceEntity = pd.entities[0];
      }
    } else {
      const pd = priceDisplayWithEntities(currentAmount, baselineVnd, priceTextOffset);
      priceContent = pd.text;
      if (pd.entities.length > 0) priceEntity = pd.entities[0];
    }
    const priceLine = `${pricePrefix}${priceContent}\n`;

    const body = nameLine + priceLine + couponLine + `\n` +
      `📌 Nội dung CK:\n${memo}\n\n` +
      `⏳ ĐH hết hạn sau: ${formatTime(remaining)}${extra}\n`;
    let text = prefix + body;

    const captionEntities = [];
    if (buyTitleEntities) {
      for (const e of buyTitleEntities) {
        captionEntities.push({ ...e, offset: e.offset + 1 });
      }
    }
    if (priceEntity) captionEntities.push(priceEntity);
    if (buyFooter) {
      const footerOffset = text.length + 1;
      text += `\n${buyFooter}`;
      if (buyFooterEntities) {
        for (const e of buyFooterEntities) {
          captionEntities.push({ ...e, offset: e.offset + footerOffset });
        }
      }
    }
    return { text, captionEntities: captionEntities.length > 0 ? captionEntities : null };
  };

  const initial = buildCaption();
  const sendOpts = { caption: initial.text, reply_markup: keyboard };
  if (initial.captionEntities) sendOpts.caption_entities = initial.captionEntities;
  const sent = await bot.sendPhoto(chatId, qr, sendOpts).catch(() => null);
  if (!sent) {
    await store.cancelOrder(code, chatId);
    log.error(`QR send failed for order ${code}, order cancelled`);
    return bot.sendMessage(chatId, '❌ Lỗi hiển thị QR. Vui lòng thử lại.').catch(() => {});
  }

  global.paymentMessages.set(chatId, sent.message_id);
  watchOrder(code);

  let halfwayReminded = false;
  let currentMessageId = sent.message_id;
  let resendCount = 0;
  const MAX_RESEND = 2;

  const tryResendQr = async () => {
    if (resendCount >= MAX_RESEND) return false;
    resendCount++;
    try {
      const order = store.orders[code];
      if (!order || order.paid) return false;
      const amount = order.amountRequired || priceVnd;
      const memoForQr = order.memo || memo;
      const newQr = generateQR(amount, memoForQr);
      const fresh = buildCaption('\n♻️ QR đã được gửi lại do tin nhắn cũ bị xoá.');
      const opts = { caption: fresh.text, reply_markup: keyboard };
      if (fresh.captionEntities) opts.caption_entities = fresh.captionEntities;
      const resent = await bot.sendPhoto(chatId, newQr, opts).catch(() => null);
      if (!resent) return false;
      currentMessageId = resent.message_id;
      global.paymentMessages.set(chatId, resent.message_id);
      log.warn(`Resent QR for ${code} (attempt ${resendCount}/${MAX_RESEND})`);
      return true;
    } catch (e) {
      log.error('Resend QR error:', e.message);
      return false;
    }
  };

  const interval = setInterval(async () => {
    try {
      const remaining = Math.max(0, Math.ceil((expireAt - Date.now()) / 1000));

      if (!store.orders[code] || store.orders[code].paid) {
        clearInterval(interval);
        global.paymentLoop.delete(chatId);
        return;
      }

      if (remaining <= 0) {
        clearInterval(interval);
        global.paymentLoop.delete(chatId);
        global.paymentMessages.delete(chatId);
        unwatchOrder(code);

        await store.expireOrder(code, chatId);
        log.payment(`Order expired: ${code}`);

        await bot.editMessageCaption(
          `❌ HẾT THỜI GIAN\n\n🎬 ${p.name}\n👉 Mã: ${code}`,
          { chat_id: chatId, message_id: currentMessageId, reply_markup: { inline_keyboard: [[{ text: store.getText('btn_back_menu') || '🔙 Quay lại menu', callback_data: 'menu' }]] } }
        ).catch(() => {});

        scheduleReengagement(chatId, productId, p.name, code);
        return;
      }

      // Nhắc nhở khi còn ~ 5 phút (1 lần duy nhất)
      if (!halfwayReminded && remaining <= 300 && remaining > 280) {
        halfwayReminded = true;
        bot.sendMessage(chatId,
          `⏰ NHẮC NHỞ THANH TOÁN\n\n` +
          `🎬 ${p.name}\n` +
          `📋 Mã đơn: ${code}\n` +
          `⏳ Đơn còn lại 5 phút. Vui lòng chuyển khoản theo QR phía trên để nhận phim ngay nha 💝`
        ).catch(() => {});
      }

      let extra = '';
      if (remaining < 60) extra = '\n⚠️ Sắp hết thời gian!';
      if (remaining < 30) extra = '\n🚨 SẮP HẾT HẠN!';

      const updated = buildCaption(extra);
      const editOpts = { chat_id: chatId, message_id: currentMessageId, reply_markup: keyboard };
      if (updated.captionEntities) editOpts.caption_entities = updated.captionEntities;
      await bot.editMessageCaption(updated.text, editOpts);
    } catch (err) {
      const msg = err && err.message ? err.message : '';
      if (msg.includes('message is not modified')) return;
      if (msg.includes('Too Many Requests')) return;
      // Lỗi mạng tạm thời từ Telegram API — bỏ qua tick này, tick sau retry.
      if (msg.includes('ECONNRESET') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('ENOTFOUND') ||
          msg.includes('EAI_AGAIN') ||
          msg.includes('socket hang up') ||
          msg.includes('network socket disconnected') ||
          msg.includes('EFATAL')) {
        return;
      }
      const lower = msg.toLowerCase();
      // Bot bị chặn / user xoá tài khoản / chat không còn → dừng hẳn loop.
      if (lower.includes('chat not found') ||
          lower.includes('bot was blocked') ||
          lower.includes('user is deactivated') ||
          lower.includes('peer_id_invalid') ||
          lower.includes('forbidden')) {
        clearInterval(interval);
        global.paymentLoop.delete(chatId);
        global.paymentMessages.delete(chatId);
        unwatchOrder(code);
        log.warn(`Payment loop stopped (${code}): ${msg}`);
        return;
      }
      // Tin nhắn QR bị xoá → thử gửi lại QR mới (tối đa 2 lần) để user vẫn trả tiền được.
      // Telegram trả "Bad Request: not Found" (chữ F hoa) khi message bị xoá hẳn → cũng coi là cần gửi lại.
      if (lower.includes('message to edit not found') ||
          lower.includes('message_id_invalid') ||
          lower.includes("message can't be edited") ||
          lower.includes('not found')) {
        const ok = await tryResendQr();
        if (!ok) {
          clearInterval(interval);
          global.paymentLoop.delete(chatId);
          global.paymentMessages.delete(chatId);
          unwatchOrder(code);
          log.warn(`Payment loop stopped (${code}) — could not resend QR: ${msg}`);
        }
        return;
      }
      log.error('Payment loop:', msg);
    }
  }, 1000);

  global.paymentLoop.set(chatId, interval);
}

async function checkPaymentStatus(chatId, code) {
  const order = store.orders[code];
  if (!order) {
    return bot.sendMessage(chatId, '❌ Đơn hàng không tồn tại hoặc đã hết hạn').catch(() => {});
  }

  if (order.chatId !== chatId) {
    return bot.sendMessage(chatId, '❌ Đơn hàng không thuộc về bạn').catch(() => {});
  }

  const payments = await store.getPartialPayments(code);
  const totalPaid = order.amountPaid || 0;
  const remaining = order.amountRequired - totalPaid;

  if (totalPaid === 0) {
    const ckMemo = (order && order.memo) ? order.memo : ('SEVQR ' + code);
    let msg = '⏳ Chưa nhận được thanh toán nào.\n\n📌 Hãy chắc chắn bạn đã ghi đúng nội dung chuyển khoản:\n' + ckMemo;
    if (SUPPORT_USERNAME) {
      msg += `\n\n📞 Cần hỗ trợ? Liên hệ: @${SUPPORT_USERNAME}`;
    }
    return bot.sendMessage(chatId, msg).catch(() => {});
  }

  let msg = `📊 TÌNH TRẠNG THANH TOÁN\n\n` +
    `📋 Mã đơn: ${code}\n` +
    `💰 Đã nhận: ${totalPaid.toLocaleString()} / ${order.amountRequired.toLocaleString()} VND\n`;

  if (remaining > 0) {
    msg += `⚠️ Còn thiếu: ${remaining.toLocaleString()} VND\n\n`;
    msg += `💸 Lịch sử chuyển khoản:\n`;
    payments.forEach((p, i) => {
      const time = new Date(p.received_at).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      msg += `  ${i + 1}. ${Number(p.amount).toLocaleString()} VND — ${time}\n`;
    });
    msg += `\n👉 Vui lòng chuyển thêm ${remaining.toLocaleString()} VND`;
  } else {
    msg += `✅ Đã đủ tiền — đang xử lý...`;
  }

  if (SUPPORT_USERNAME) {
    msg += `\n\n📞 Cần hỗ trợ? Liên hệ: @${SUPPORT_USERNAME}`;
  }

  return bot.sendMessage(chatId, msg).catch(() => {});
}

// NOTE: downloadOrderQr / fetchPng / isPng helpers were removed as part of the
// wallet rollout — users top up the wallet once instead of downloading a fresh
// QR per purchase. The dlqr_ callback route was removed from handlers.js.

async function cancelOrderWithLoading(chatId, paymentMessageId) {
  await bot.editMessageCaption('⏳ Đang huỷ đơn...', {
    chat_id: chatId, message_id: paymentMessageId,
    reply_markup: { inline_keyboard: [] }
  }).catch(() => {});

  await delay(350);

  const code = store.userLastOrder[chatId];
  if (code) {
    await store.cancelOrder(code, chatId);
    log.info(`Order cancelled: ${code} | User: ${chatId}`);
  }

  // Track abuse (DB-persisted): count cancels in 24h. If exceeds limit → ban 24h.
  // Admin is fully exempt — never tracked, never banned, never receives the
  // ban notice. Without this guard the admin would see "BẠN ĐÃ BỊ TẠM KHOÁ"
  // when stress-testing cancels even though the message-handler ban guard
  // already lets admin bypass the lockout.
  const adminExempt = ADMIN_CHAT_ID && String(chatId) === String(ADMIN_CHAT_ID);
  let cancelCount = 0;
  let willBan = false;
  let banUntil = 0;
  if (!adminExempt) {
    cancelCount = await store.recordCancel(chatId, CANCEL_WINDOW_MS);
    willBan = cancelCount > CANCEL_LIMIT;
    if (willBan) {
      banUntil = await store.setBan(chatId, BAN_DURATION_MS, 'excessive_cancellations');
    }
  }

  await bot.editMessageCaption('✅ Đã huỷ đơn hàng', {
    chat_id: chatId, message_id: paymentMessageId
  }).catch(() => {});

  await delay(300);

  stopPaymentLoop(chatId);
  unwatchOrder(code);
  clearAwaitingCoupon(chatId);
  global.paymentMessages.delete(chatId);
  await bot.deleteMessage(chatId, paymentMessageId).catch(() => {});
  if (lastMenuMessage[chatId]) {
    await bot.deleteMessage(chatId, lastMenuMessage[chatId]).catch(() => {});
    delete lastMenuMessage[chatId];
  }

  if (willBan) {
    await bot.sendMessage(chatId,
      `🚫 BẠN ĐÃ BỊ TẠM KHOÁ 24H\n\n` +
      `Bạn đã huỷ đơn quá nhiều lần.\n` +
      `⏱ Vui lòng quay lại sau: ${formatBanRemaining(banUntil)}`
    ).catch(() => {});
    log.warn(`User ${chatId} banned 24h after ${cancelCount} cancels in 24h`);
    return;
  }

  // Show editable warning ~4s, then auto-delete; do not block menu return.
  const warnTextRaw = store.getText('cancel_warning') || '';
  const warnText = warnTextRaw.trim();
  if (warnText) {
    // Preserve custom_emoji & formatting entities — adjust offsets if leading whitespace was trimmed.
    const rawEntities = store.getTextEntities('cancel_warning');
    let entities = null;
    if (Array.isArray(rawEntities) && rawEntities.length > 0) {
      const leading = warnTextRaw.length - warnTextRaw.trimStart().length;
      const trimmedLen = warnText.length;
      const adjusted = [];
      for (const e of rawEntities) {
        const newOffset = e.offset - leading;
        if (newOffset + e.length <= 0 || newOffset >= trimmedLen) continue;
        const clampedOffset = Math.max(0, newOffset);
        const clampedLength = Math.min(e.length + Math.min(0, newOffset), trimmedLen - clampedOffset);
        if (clampedLength > 0) adjusted.push({ ...e, offset: clampedOffset, length: clampedLength });
      }
      if (adjusted.length > 0) entities = adjusted;
    }
    const opts = entities ? { entities } : {};
    const sent = await bot.sendMessage(chatId, warnText, opts).catch(() => null);
    if (sent) {
      setTimeout(() => {
        bot.deleteMessage(chatId, sent.message_id).catch(() => {});
      }, 4000);
    }
  }

  await mainMenu(chatId);
}

// Back-from-QR-dashboard navigation. Quietly cancels the pending QR order
// and reopens the film preview. Differs from cancelOrderWithLoading in that
// it (a) does NOT count toward the cancel-abuse limit because the user is
// merely navigating back, and (b) does NOT show the cancel_warning popup.
async function backToPreviewFromQr(chatId, productId, paymentMessageId) {
  const code = store.userLastOrder[chatId];
  if (code) {
    await store.cancelOrder(code, chatId).catch(() => {});
    log.info(`Order cancelled (back-to-preview): ${code} | User: ${chatId}`);
    unwatchOrder(code);
  }
  stopPaymentLoop(chatId);
  clearAwaitingCoupon(chatId);
  if (global.paymentMessages) global.paymentMessages.delete(chatId);
  await bot.deleteMessage(chatId, paymentMessageId).catch(() => {});
  await showPreview(chatId, productId);
}

async function handleFulfillmentDelivery(result, code) {
  // Topup orders take a different path: they don't deliver a film, they just
  // credit the wallet (already done atomically inside store.processPayment)
  // and notify the user. Route them away from product delivery early.
  if (result && result.orderKind === 'topup') {
    const wallet = require('./wallet');
    return wallet.handleTopupFulfillment(result, code);
  }
  if (result && result.orderKind === 'membership') {
    const membership = require('./membership');
    return membership.handleMembershipFulfillment(result, code);
  }

  if (global.paymentLoop && global.paymentLoop.has(result.chatId)) {
    clearInterval(global.paymentLoop.get(result.chatId));
    global.paymentLoop.delete(result.chatId);
  }
  if (global.paymentMessages && global.paymentMessages.has(result.chatId)) {
    await bot.deleteMessage(result.chatId, global.paymentMessages.get(result.chatId)).catch(() => {});
    global.paymentMessages.delete(result.chatId);
  }
  unwatchOrder(code);

  const product = store.getProductById(result.productId);
  const productName = product ? product.name : `#${result.productId}`;

  // Persist coupon usage if any
  if (result.couponCode) {
    await store.commitCouponUse(result.couponCode, result.chatId, code).catch(() => {});
  }

  // Record purchase history (30-day TTL)
  await store.recordPurchase(result.chatId, result.productId, productName, code).catch(() => {});

  // Award loyalty points
  try {
    const { awardOrderPoints } = require('./loyalty');
    await awardOrderPoints(result.chatId, result.totalPaid).catch(() => {});
  } catch {}

  if (product) {
    const { sendDeliveryDashboard } = require('./delivery');
    await sendDeliveryDashboard(result.chatId, product);
  } else {
    await bot.sendMessage(result.chatId,
      `🎉 ${productName}\n\n✅ Đã thanh toán thành công!`,
      { reply_markup: { inline_keyboard: [[{ text: store.getText('btn_back_menu') || '🔙 Quay lại menu', callback_data: 'menu' }]] } }
    ).catch(() => {});
  }

  // 30-day TTL warning
  await bot.sendMessage(result.chatId,
    `⚠️ Lưu ý: Nội dung "Phim của tôi" sẽ tự động xoá sau 30 ngày.\n` +
    `👉 Hãy lưu/xem ngay nội dung phía trên về máy của bạn.`
  ).catch(() => {});
}

async function promptCouponEntry(chatId, code, paymentMessageId) {
  const order = store.orders[code];
  if (!order || order.paid) {
    return bot.sendMessage(chatId, '❌ Đơn hàng không còn khả dụng.').catch(() => {});
  }
  if (order.couponCode) {
    return bot.sendMessage(chatId,
      `❌ Đơn này đã áp dụng mã ${order.couponCode}. Mỗi đơn chỉ dùng 1 mã.`
    ).catch(() => {});
  }
  setAwaitingCoupon(chatId, code);
  await bot.sendMessage(chatId,
    `🎟 NHẬP MÃ GIẢM GIÁ\n\n📋 Đơn: ${code}\n\n👉 Gõ mã của bạn vào tin nhắn (vd: SALE20).\n` +
    `⏱ Mã có hiệu lực trong 5 phút.`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: store.getText('btn_skip_coupon') || '↩️ Tôi không có mã, bỏ qua', callback_data: `coupskip_${code}` }
        ]]
      }
    }
  ).catch(() => {});
}

async function skipCouponEntry(chatId, code, messageId) {
  clearAwaitingCoupon(chatId);
  if (messageId) {
    await bot.editMessageText(
      `↩️ Đã bỏ qua nhập mã.\n\n👉 Vui lòng quay lại QR phía trên để chuyển khoản.`,
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});
  } else {
    await bot.sendMessage(chatId,
      `↩️ Đã bỏ qua nhập mã.\n\n👉 Vui lòng quay lại QR phía trên để chuyển khoản.`
    ).catch(() => {});
  }
}

// === Re-engagement: gửi coupon -10% sau khi đơn hết hạn ===
const REENGAGE_DELAY_MS = 15 * 60 * 1000; // 15 phút sau khi expire
const reengagementTimers = new Map(); // chatId -> timer

function scheduleReengagement(chatId, productId, productName, originalCode) {
  if (reengagementTimers.has(chatId)) {
    clearTimeout(reengagementTimers.get(chatId));
  }
  const timer = setTimeout(async () => {
    reengagementTimers.delete(chatId);
    try {
      // 1) Nếu user đã có đơn mới đang chạy hoặc đã mua → bỏ qua
      if (store.userLastOrder && store.userLastOrder[chatId]) return;
      const recent = await store.getUserPurchases(chatId).catch(() => []);
      if (recent && recent.find(p => p.productId == productId)) return;

      // 2) Xác nhận đơn gốc thật sự đã hết hạn (paid=false, expired=true) — query DB vì cache
      //    đã bị xoá khi expireOrder chạy. Chống gửi nhầm khi user thanh toán muộn qua webhook SePay.
      const status = await store.getOrderStatus(originalCode);
      if (!status || status.paid || !status.expired) return;

      // 3) Cooldown 1 ngày + né nếu user vừa tương tác trong 5 phút qua
      //    (giảm độ "chủ động", tránh push khi user đang dùng bot).
      const eligible = await store.canReengageUser(chatId, 24, 5);
      if (!eligible) return;

      const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
      const couponCode = `BACK10${rand}`;
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const ok = await store.createCoupon({
        code: couponCode,
        discountType: 'percent',
        discountValue: 10,
        maxUses: 1,
        expiresAt
      });
      if (!ok) return;

      const rebuyTpl = store.getText('btn_rebuy') || '🎬 Mua lại {name}';
      const rebuyText = rebuyTpl.replace(/\{name\}/g, productName);
      const buyKb = productId
        ? { inline_keyboard: [[{ text: rebuyText, callback_data: `buy_${productId}` }]] }
        : { inline_keyboard: [[{ text: store.getText('btn_back_menu') || '🔙 Quay lại menu', callback_data: 'menu' }]] };

      const sent = await bot.sendMessage(chatId,
        `🎁 ƯU ĐÃI DÀNH RIÊNG CHO BẠN\n\n` +
        `Phim "${productName}" bạn xem dở vẫn còn nguyên 💝\n\n` +
        `🎟 Mã giảm giá: ${couponCode}\n` +
        `💰 Giảm 10% — chỉ dùng 1 lần\n` +
        `⏰ Hết hạn sau 24 giờ\n\n` +
        `👉 Bấm "Mua lại" và nhập mã trên để nhận ưu đãi.`,
        { reply_markup: buyKb }
      ).catch(() => null);

      // Chỉ tính cooldown khi đã gửi thành công (user không chặn bot, không lỗi mạng).
      if (sent) {
        await store.markReengageSent(chatId).catch(() => {});
        log.payment(`Re-engage coupon sent: ${couponCode} | User: ${chatId} | Product: ${productId} | Origin: ${originalCode}`);
      }
    } catch (e) {
      log.error('Re-engagement error:', e.message);
    }
  }, REENGAGE_DELAY_MS);
  reengagementTimers.set(chatId, timer);
}

async function tryApplyCouponText(chatId, text) {
  const s = isAwaitingCoupon(chatId);
  if (!s) return false;
  const code = s.orderCode;
  const order = store.orders[code];
  if (!order || order.paid) {
    clearAwaitingCoupon(chatId);
    await bot.sendMessage(chatId, '❌ Đơn hàng không còn khả dụng.').catch(() => {});
    return true;
  }
  if (order.couponCode) {
    clearAwaitingCoupon(chatId);
    await bot.sendMessage(chatId, `❌ Đơn này đã áp dụng mã ${order.couponCode}.`).catch(() => {});
    return true;
  }

  const couponCode = text.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,30}$/.test(couponCode)) {
    await bot.sendMessage(chatId, '❌ Mã không hợp lệ. Hãy gõ mã giảm giá (chữ + số).').catch(() => {});
    return true;
  }

  // Anchor coupon base on the order's locked amount (no coupon applied yet — early-returned above).
  // Avoids drift if admin changes price / USD rate / currency mode after order creation.
  const baseAmount = order.amountRequired;
  const v = await store.validateAndConsumeCoupon(couponCode, chatId, baseAmount);

  if (!v.ok) {
    await bot.sendMessage(chatId, `❌ ${v.reason}`).catch(() => {});
    return true;
  }

  const newAmount = baseAmount - v.discount;
  await store.applyDiscountToOrder(code, v.coupon.code, newAmount, v.discount);
  clearAwaitingCoupon(chatId);

  // Sepay receives the new amount via QR — regenerate QR using same memo
  const memoForQr = (store.orders[code] && store.orders[code].memo) ? store.orders[code].memo : ('SEVQR ' + code);
  const newQr = generateQR(newAmount, memoForQr);
  const paymentMsgId = global.paymentMessages.get(chatId);

  await bot.sendMessage(chatId,
    `✅ Áp dụng mã ${v.coupon.code}!\n💰 Giảm: ${fmtVN(v.discount)} VNĐ\n💸 Cần chuyển: ${fmtVN(newAmount)} VNĐ\n\n` +
    `⚠️ Lưu ý: QR thanh toán đã được cập nhật theo số tiền mới.`
  ).catch(() => {});

  if (paymentMsgId) {
    try {
      await bot.editMessageMedia({
        type: 'photo',
        media: newQr,
        caption: '⏳ QR đã cập nhật theo mã giảm giá...'
      }, { chat_id: chatId, message_id: paymentMsgId });
    } catch (e) {
      // Fallback: delete + resend (loop will re-edit caption next tick)
    }
  }
  return true;
}

module.exports = {
  handleBuyPro,
  handleBuyEntry,
  handleBuyFromWallet,
  cancelOrderWithLoading,
  backToPreviewFromQr,
  stopPaymentLoop,
  checkPaymentStatus,
  startExpiryWatcher,
  handleFulfillmentDelivery,
  promptCouponEntry,
  skipCouponEntry,
  tryApplyCouponText,
  isAwaitingCoupon,
  clearAwaitingCoupon,
  isBanned,
  formatBanRemaining
};
