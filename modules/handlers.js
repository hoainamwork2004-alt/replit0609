const bot   = require('../bot');
const store = require('../store');
const log   = require('./logger');
const { mainMenu, markGreetedToday, showList, showHot, showMyFilms, showMyPoints, lastMenuMessage, renderMenuMessage, repositionMenu, sendTempWarning } = require('./menu');
const { handleJoin: handleMembershipJoin, cancelMembershipOrder } = require('./membership');
const { showPreview, stopActiveSession, stopLiveDashboard, revealPaymentButtons, getActiveDashboardSnapshot } = require('./preview');
const { handleBuyPro, handleBuyEntry, handleBuyFromWallet,
  cancelOrderWithLoading, backToPreviewFromQr, stopPaymentLoop, checkPaymentStatus,
  promptCouponEntry, skipCouponEntry, tryApplyCouponText, isAwaitingCoupon, clearAwaitingCoupon,
  isBanned, formatBanRemaining } = require('./payment');
const wallet = require('./wallet');
const { sendDeliveryDashboard } = require('./delivery');
const { SPAM_DELAY, ADMIN_CHAT_ID, SUPPORT_USERNAME } = require('../config');
const { animatedText } = require('./utils');
const admin = require('./admin');

const lastMsg = {};

setInterval(() => {
  const now = Date.now();
  const maxAge = 3600000;
  for (const key of Object.keys(lastMsg)) {
    if (now - lastMsg[key] > maxAge) delete lastMsg[key];
  }
}, 600000);

function isAdmin(chatId) {
  return ADMIN_CHAT_ID && String(chatId) === String(ADMIN_CHAT_ID);
}

async function blockIfBanned(chatId, replyFn) {
  if (isAdmin(chatId)) return false;
  const banUntil = isBanned(chatId);
  if (!banUntil) return false;
  await replyFn(banUntil);
  return true;
}

async function clearAllUserFlows(chatId) {
  await stopActiveSession(chatId);
  await stopLiveDashboard(chatId);
  stopPaymentLoop(chatId);
  clearAwaitingCoupon(chatId);
  // Also stop any in-progress topup countdown so leaving the screen doesn't
  // leave an orphan timer ticking until expiry.
  wallet.stopTopupLoop(chatId);
}

async function smoothMenuReturn(chatId) {
  await clearAllUserFlows(chatId);
  delete lastMenuMessage[chatId];
  await mainMenu(chatId, false);
}


const processingLock = new Map();

bot.on('callback_query', async (q) => {
  const chatId    = q.message.chat.id;
  const messageId = q.message.message_id;
  const data      = q.data;

  log.info(`Callback from ${chatId}: ${data}`);

  // Block banned users (admin always exempt)
  if (await blockIfBanned(chatId, async (banUntil) => {
    await bot.answerCallbackQuery(q.id, {
      text: `🚫 Bạn đang bị tạm khoá. Còn ${formatBanRemaining(banUntil)}.`,
      show_alert: true
    }).catch(() => {});
  })) {
    return;
  }

  bot.answerCallbackQuery(q.id).catch(() => {});

  if (data.startsWith('adm_')) {
    if (isAdmin(chatId)) {
      try {
        await admin.handleAdminCallback(chatId, data, messageId);
      } catch (e) {
        log.error('Admin callback error:', e.message);
      }
    }
    return;
  }

  if (data.startsWith('view_') || data.startsWith('buy_') ||
      data.startsWith('buyqr_') || data.startsWith('buywallet_') ||
      data.startsWith('bk2pv_') || data.startsWith('xn_') ||
      data === 'nap' || data.startsWith('nap_')) {
    if (processingLock.get(chatId)) return;
    processingLock.set(chatId, true);
  }

  try {
    if (data === 'menu') {
      await clearAllUserFlows(chatId);
      admin.clearState(chatId);
      if (messageId === lastMenuMessage[chatId]) {
        return mainMenu(chatId, true);
      } else {
        await bot.deleteMessage(chatId, messageId).catch(() => {});
        if (lastMenuMessage[chatId] && lastMenuMessage[chatId] !== messageId) {
          await bot.deleteMessage(chatId, lastMenuMessage[chatId]).catch(() => {});
        }
        delete lastMenuMessage[chatId];
        return mainMenu(chatId, false);
      }
    }
    if (data === 'list') {
      await clearAllUserFlows(chatId);
      return showList(chatId);
    }
    if (data === 'hot') {
      await clearAllUserFlows(chatId);
      return showHot(chatId);
    }
    if (data === 'reset') return cancelOrderWithLoading(chatId, messageId);

    // === Membership ===
    if (data === 'join_member')       return handleMembershipJoin(chatId, messageId);
    if (data === 'cancel_membership') return cancelMembershipOrder(chatId, messageId);
    // VIP user-facing entry point intentionally removed — admin still manages
    // VIP-tagged products, but the menu button no longer routes here.
    // === Wallet / top-up routes ===
    // IMPORTANT: handle napcancel_ before nap_ — the latter is a prefix of the
    // former and would otherwise NaN-parse "cancel_<code>" as the amount.
    if (data.startsWith('napcancel_')) {
      const code = data.replace('napcancel_', '');
      return wallet.cancelTopup(chatId, code, messageId);
    }
    if (data === 'nap') {
      await clearAllUserFlows(chatId);
      return wallet.showTopupDashboard(chatId);
    }
    if (data.startsWith('nap_')) {
      const amount = parseInt(data.replace('nap_', ''), 10);
      if (!Number.isFinite(amount)) return;
      await clearAllUserFlows(chatId);
      return wallet.startTopup(chatId, amount, messageId);
    }
    // === Buy variants ===
    // buyqr_<id>  → user explicitly chose QR over wallet (insufficient case).
    if (data.startsWith('buyqr_')) {
      const productId = data.replace('buyqr_', '');
      await bot.deleteMessage(chatId, messageId).catch(() => {});
      return handleBuyPro(chatId, productId, messageId);
    }
    // buywallet_<id> → explicit wallet payment (kept for future / admin UX).
    if (data.startsWith('buywallet_')) {
      const productId = data.replace('buywallet_', '');
      return handleBuyFromWallet(chatId, productId, messageId);
    }
    // bk2pv_<id> → "Quay lại" from QR dashboard back to film preview.
    // Quietly cancels the pending order (does NOT count toward ban limit).
    if (data.startsWith('bk2pv_')) {
      const productId = data.replace('bk2pv_', '');
      return backToPreviewFromQr(chatId, productId, messageId);
    }
    if (data === 'support') {
      let msg = '📞 HỖ TRỢ KHÁCH HÀNG\n\n';
      if (SUPPORT_USERNAME) {
        msg += `👉 Liên hệ: @${SUPPORT_USERNAME}\n`;
      }
      msg += `\n💬 Gửi mã đơn hàng khi liên hệ để được hỗ trợ nhanh hơn.`;
      const kb = [[{ text: '🔙 Quay lại', callback_data: 'menu' }]];
      return renderMenuMessage(chatId, msg, kb, true);
    }

    if (data === 'myfilms') {
      await clearAllUserFlows(chatId);
      return showMyFilms(chatId);
    }
    if (data === 'mypoints') {
      await clearAllUserFlows(chatId);
      return showMyPoints(chatId);
    }
    if (data.startsWith('mf_')) {
      const purchaseId = parseInt(data.replace('mf_', ''));
      const list = await store.getUserPurchases(chatId);
      const item = list.find(x => x.id === purchaseId);
      if (!item) {
        await sendTempWarning(chatId, '❌ Đã hết hạn hoặc không tìm thấy.', 4000);
        return showMyFilms(chatId);
      }
      const product = store.getProductById(item.productId);
      if (!product) {
        await sendTempWarning(chatId, '❌ Sản phẩm không còn tồn tại.', 4000);
        return;
      }
      return sendDeliveryDashboard(chatId, product);
    }
    if (data.startsWith('coupskip_')) {
      const orderCode = data.replace('coupskip_', '');
      return skipCouponEntry(chatId, orderCode, messageId);
    }
    if (data.startsWith('coup_')) {
      const orderCode = data.replace('coup_', '');
      return promptCouponEntry(chatId, orderCode, messageId);
    }
    if (data.startsWith('undo_')) {
      if (!isAdmin(chatId)) return;
      const undoId = data.replace('undo_', '');
      return admin.handleUndo(chatId, undoId);
    }
    // xn_<id> → "Xem ngay" trên dashboard preview. Nếu user đã mua phim này → giao luôn.
    // Nếu chưa mua → hiện thông báo (admin sửa được) trong 5s rồi đổi keyboard của
    // dashboard preview hiện tại sang 2 nút Ví KhoPhim + QR Bank để user chọn.
    if (data.startsWith('xn_')) {
      const productId = data.replace('xn_', '');
      const product = store.getProductById(productId);
      if (!product) {
        await sendTempWarning(chatId, '❌ Sản phẩm không tồn tại.', 4000);
        return;
      }
      // Kiểm tra phim đã mua (purchase còn hạn). Match theo productId (string vs number an toàn).
      const purchases = await store.getUserPurchases(chatId).catch(() => []);
      const owned = purchases.find(x => String(x.productId) === String(productId));
      if (owned) {
        // Đã sở hữu → giao phim ngay, đóng dashboard preview cho gọn chat.
        await stopLiveDashboard(chatId);
        return sendDeliveryDashboard(chatId, product);
      }
      // Snapshot dashboard tại thời điểm bấm — nếu sau 5s không còn match (user navigate đi
      // nơi khác / dashboard mới mở) thì abort silently, không kéo user trở lại.
      const snapshot = getActiveDashboardSnapshot(chatId);
      // Không có dashboard active (TTL expire / đã đóng) → bỏ qua, tránh hiện notice 5s vô nghĩa.
      if (!snapshot) {
        await sendTempWarning(chatId, '⏳ Phiên xem trước đã kết thúc, vui lòng mở lại phim.', 4000);
        return;
      }
      // Chưa mua → hiện notice 5s rồi lộ 2 nút thanh toán trên dashboard hiện tại.
      const noticeRaw = (store.getText('before_payment_notice') ||
        '🛒 Bạn chưa mua phim này.\n\n👉 Vui lòng chọn phương thức thanh toán bên dưới sau giây lát.').trim();
      const noticeEntities = store.getTextEntities('before_payment_notice');
      const noticeOpts = {};
      if (noticeEntities) noticeOpts.entities = noticeEntities;
      const noticeMsg = noticeRaw ? await bot.sendMessage(chatId, noticeRaw, noticeOpts).catch(() => null) : null;
      await new Promise(r => setTimeout(r, 5000));
      if (noticeMsg) {
        await bot.deleteMessage(chatId, noticeMsg.message_id).catch(() => {});
      }
      // Pass expectedMessageId — revealPaymentButtons sẽ tự noop nếu user đã navigate đi.
      await revealPaymentButtons(chatId, productId, snapshot ? snapshot.messageId : null);
      return;
    }
    if (data.startsWith('view_')) return await showPreview(chatId, data.split('_')[1]);
    // buy_<id> → wallet triage entry. Decides between wallet debit, mixed
    // (wallet+QR choice), or auto-topup based on current balance.
    if (data.startsWith('buy_'))  return handleBuyEntry(chatId, data.split('_')[1], messageId);
    if (data.startsWith('paid_')) return checkPaymentStatus(chatId, data.replace('paid_', ''));
  } catch (e) {
    log.error('Callback error:', e.message);
  } finally {
    processingLock.delete(chatId);
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Block banned users (admin always exempt)
  if (await blockIfBanned(chatId, async (banUntil) => {
    await sendTempWarning(chatId,
      `🚫 Bạn đang bị tạm khoá do huỷ đơn quá nhiều.\n⏱ Còn lại: ${formatBanRemaining(banUntil)}`,
      6000
    );
  })) {
    return;
  }

  if (isAdmin(chatId) && admin.isInState(chatId)) {
    if (msg.text === '/start' || msg.text === '/admin' || msg.text === '/cancel') {
      admin.clearState(chatId);
      if (msg.text === '/start') return mainMenu(chatId);
      return admin.showAdminHome(chatId);
    }
    if (msg.video || (msg.photo && msg.photo.length)) {
      try {
        const handled = await admin.handleAdminMedia(chatId, msg);
        if (handled) {
          bot.deleteMessage(chatId, msg.message_id).catch(() => {});
          return;
        }
      } catch (e) {
        log.error('Admin media error:', e.message);
      }
    }
    if (msg.text) {
      try {
        const handled = await admin.handleAdminText(chatId, msg);
        if (handled) {
          bot.deleteMessage(chatId, msg.message_id).catch(() => {});
          return;
        }
      } catch (e) {
        log.error('Admin text error:', e.message);
      }
    }
    return;
  }

  if (!msg.text) return;

  // User awaiting coupon entry — but never intercept bot commands
  if (!msg.text.startsWith('/') && await tryApplyCouponText(chatId, msg.text)) {
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    return;
  }

  if (lastMsg[chatId] && Date.now() - lastMsg[chatId] < SPAM_DELAY) return;
  lastMsg[chatId] = Date.now();

  await store.trackUser(chatId);
  store.touchUserActive(chatId).catch(() => {});
  log.info(`Message from ${chatId}: ${msg.text.slice(0, 80)}`);

  if (isAdmin(chatId)) {
    if (msg.text === '/admin') {
      return admin.showAdminHome(chatId);
    }
    if (msg.text.startsWith('/confirm ')) {
      const code = msg.text.split(' ')[1];
      if (code) return admin.handleConfirmOrder(chatId, code);
    }
  }

  if (msg.text === '/start') return mainMenu(chatId);

  if (msg.text === '/help' || msg.text === '/menu') {
    return repositionMenu(chatId);
  }

  const pendingProduct = store.userLastOrder[chatId];
  const pendingTopup = store.userLastTopup && store.userLastTopup[chatId];
  if (pendingProduct || pendingTopup) {
    const code = pendingProduct || pendingTopup;
    const kind = pendingProduct ? 'đơn phim' : 'đơn nạp ví';
    await sendTempWarning(chatId,
      `⚠️ Bạn đang có ${kind} chờ thanh toán\n` +
      `👉 Mã đơn: ${code}\n\n` +
      `Vui lòng dùng các nút trên màn hình thanh toán hoặc gõ /menu để mở menu chính.`,
      8000
    );
    return;
  }

  await sendTempWarning(chatId, '💡 Vui lòng dùng các nút bên dưới để tương tác với bot.');
  return repositionMenu(chatId);
});

module.exports = {};
