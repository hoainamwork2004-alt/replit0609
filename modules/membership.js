/**
 * Membership module — quản lý flow tham gia thành viên Before2000s.
 *
 * Flow:
 *  /start → mainMenu → isMember? NO → handleMembershipCheck
 *    → user nhấn "Tham gia" → handleJoin → QR + countdown
 *    → thanh toán thành công → handleMembershipFulfillment
 *    → setMember + welcome + mainMenu
 */

const bot    = require('../bot');
const store  = require('../store');
const log    = require('./logger');
const {
  generateOrderCode,
  generateMemo,
  generateQR,
  formatTime,
  runLoadingAnimation,
} = require('./utils');
const { watchOrder, unwatchOrder } = require('./sepayPoll');

const MEMBERSHIP_TIMEOUT_SEC = 15 * 60; // 15 phút

// Phases loading ngắn khi kiểm tra ID
const CHECK_PHASES = [
  { max: 40,  text: '🔍 Đang tra cứu hệ thống...' },
  { max: 100, text: '✅ Xác nhận hoàn tất' },
];

// Phases loading khi tạo QR tham gia
const QR_PHASES = [
  { max: 50,  text: '🔐 Tạo mã QR an toàn...' },
  { max: 100, text: '💳 Sẵn sàng nhận thanh toán!' },
];

// chatId → message_id của dashboard "chưa tham gia"
const dashboardMessages = new Map();
// chatId → message_id của tin nhắn QR tham gia
const membershipQrMessages = new Map();
// chatId → interval ID của countdown
const membershipLoops = new Map();

function stopMembershipLoop(chatId) {
  if (membershipLoops.has(chatId)) {
    clearInterval(membershipLoops.get(chatId));
    membershipLoops.delete(chatId);
  }
}

/**
 * Hiển thị thông báo kiểm tra ID rồi chuyển sang dashboard tham gia.
 * Gọi từ mainMenu khi user chưa là thành viên.
 */
async function handleMembershipCheck(chatId) {
  // Xóa dashboard cũ nếu còn
  if (dashboardMessages.has(chatId)) {
    await bot.deleteMessage(chatId, dashboardMessages.get(chatId)).catch(() => {});
    dashboardMessages.delete(chatId);
  }

  // --- Thông báo "Đang kiểm tra ID" ---
  const checkText     = store.getText('membership_checking')         || '🔎 Đang kiểm tra ID của bạn...';
  const checkEntities = store.getTextEntities('membership_checking');
  const checkOpts = {};
  if (checkEntities) checkOpts.entities = checkEntities;

  const loadingMsgId = await runLoadingAnimation(bot, chatId, {
    phases:    CHECK_PHASES,
    totalMs:   1800,
    icon:      '🔎',
    doneText:  `✅  ▰▰▰▰▰▰▰▰▰▰  100%`,
  });
  if (loadingMsgId) await bot.deleteMessage(chatId, loadingMsgId).catch(() => {});

  // Kiểm tra lại sau loading (phòng trường hợp thanh toán xong trong lúc chờ)
  if (store.isMember(chatId)) {
    const { mainMenu } = require('./menu');
    return mainMenu(chatId);
  }

  // --- Dashboard tham gia thành viên ---
  const price        = parseInt(store.getText('membership_price') || '10000', 10) || 10000;
  const dashText     = store.getText('membership_not_joined')
    || '🎬 Bạn chưa tham gia Before2000s\n\n✨ Tham gia ngay để trải nghiệm kho phim độc quyền!';
  const dashEntities = store.getTextEntities('membership_not_joined');
  const btnText      = store.getText('btn_join_member')
    || `🚀 Tham gia · ${price.toLocaleString('vi-VN')}đ`;

  const keyboard    = { inline_keyboard: [[{ text: btnText, callback_data: 'join_member' }]] };
  const mediaFileId = store.getText('membership_media_file_id');
  const mediaType   = store.getText('membership_media_type');

  let sent = null;
  if (mediaFileId && (mediaType === 'photo' || mediaType === 'video')) {
    const mediaOpts = { caption: dashText, reply_markup: keyboard };
    if (dashEntities) mediaOpts.caption_entities = dashEntities;
    if (mediaType === 'video') {
      sent = await bot.sendVideo(chatId, mediaFileId, mediaOpts).catch(() => null);
    } else {
      sent = await bot.sendPhoto(chatId, mediaFileId, mediaOpts).catch(() => null);
    }
  }
  // Fallback sang text nếu không có media hoặc gửi media thất bại
  if (!sent) {
    const textOpts = { reply_markup: keyboard };
    if (dashEntities) textOpts.entities = dashEntities;
    sent = await bot.sendMessage(chatId, dashText, textOpts).catch(() => null);
  }
  if (sent) dashboardMessages.set(chatId, sent.message_id);
}

/**
 * Callback "join_member" — tạo đơn và hiển thị QR thanh toán.
 */
async function handleJoin(chatId, messageId) {
  // Xóa dashboard
  const dashId = dashboardMessages.get(chatId) || messageId;
  if (dashId) await bot.deleteMessage(chatId, dashId).catch(() => {});
  dashboardMessages.delete(chatId);

  // Nếu đã thành viên rồi (nhấn nhanh trùng)
  if (store.isMember(chatId)) {
    const { mainMenu } = require('./menu');
    return mainMenu(chatId);
  }

  // Dừng countdown cũ nếu có
  stopMembershipLoop(chatId);

  const price = parseInt(store.getText('membership_price') || '10000', 10) || 10000;
  const code  = generateOrderCode('M');
  const memo  = generateMemo(code);

  // Tạo đơn membership
  try {
    await store.createOrder(code, chatId, 'membership', price, MEMBERSHIP_TIMEOUT_SEC, 'membership');
    if (store.orders[code]) store.orders[code].memo = memo;
  } catch (e) {
    if (e.message === 'ACTIVE_ORDER_EXISTS') {
      // Có đơn cũ chưa hết hạn — vẫn hiện QR nhưng không tạo mới
      // (rare case; user có thể đóng app giữa chừng)
      log.warn(`Membership order already active for ${chatId}`);
    } else {
      log.error('handleJoin createOrder error:', e.message);
      return bot.sendMessage(chatId, '❌ Lỗi tạo đơn. Vui lòng thử lại.').catch(() => {});
    }
  }

  log.info(`Membership order ${code} | User: ${chatId} | Price: ${price.toLocaleString()} VND`);

  // Loading animation
  const loadId = await runLoadingAnimation(bot, chatId, {
    phases:   QR_PHASES,
    totalMs:  2000,
    icon:     '💳',
    doneText: `✅  ▰▰▰▰▰▰▰▰▰▰  100%\n💳  Sẵn sàng nhận tiền!`,
  });
  if (loadId) await bot.deleteMessage(chatId, loadId).catch(() => {});

  // Tạo QR
  const qr = generateQR(price, memo);

  const expireAt = Date.now() + MEMBERSHIP_TIMEOUT_SEC * 1000;

  const qrTitleRaw     = store.getText('membership_qr_title')         || '🎬 THAM GIA BEFORE2000S';
  const qrTitleEntities = store.getTextEntities('membership_qr_title');

  const buildCaption = (extra = '') => {
    const remaining = Math.max(0, Math.ceil((expireAt - Date.now()) / 1000));
    const text = `\n${qrTitleRaw}\n\n` +
      `💸 Phí tham gia: ${price.toLocaleString('vi-VN')} VNĐ\n` +
      `📌 Nội dung CK:\n${memo}\n\n` +
      `⏳ Hết hạn sau: ${formatTime(remaining)}${extra}`;
    const entities = [];
    if (qrTitleEntities) {
      for (const e of qrTitleEntities) {
        entities.push({ ...e, offset: e.offset + 1 }); // +1 cho '\n' đầu
      }
    }
    return { text, captionEntities: entities.length > 0 ? entities : null };
  };

  const keyboard = { inline_keyboard: [[{ text: '❌ Huỷ', callback_data: 'cancel_membership' }]] };
  const initial  = buildCaption();
  const sendOpts = { caption: initial.text, reply_markup: keyboard };
  if (initial.captionEntities) sendOpts.caption_entities = initial.captionEntities;

  const sent = await bot.sendPhoto(chatId, qr, sendOpts).catch(() => null);
  if (!sent) {
    await store.cancelOrder(code, chatId);
    return bot.sendMessage(chatId, '❌ Lỗi hiển thị QR. Vui lòng thử lại.').catch(() => {});
  }

  membershipQrMessages.set(chatId, sent.message_id);
  watchOrder(code);

  // Countdown loop — cập nhật caption mỗi 15s
  const interval = setInterval(async () => {
    try {
      if (!store.orders[code] || store.orders[code].paid) {
        clearInterval(interval);
        membershipLoops.delete(chatId);
        return;
      }
      const remaining = Math.max(0, Math.ceil((expireAt - Date.now()) / 1000));
      if (remaining <= 0) {
        clearInterval(interval);
        membershipLoops.delete(chatId);
        unwatchOrder(code);
        membershipQrMessages.delete(chatId);
        return;
      }
      const updated = buildCaption();
      const editOpts = { chat_id: chatId, message_id: membershipQrMessages.get(chatId) || sent.message_id, reply_markup: keyboard };
      if (updated.captionEntities) editOpts.caption_entities = updated.captionEntities;
      await bot.editMessageCaption(updated.text, editOpts).catch(() => {});
    } catch (e) {
      log.error('Membership loop error:', e.message);
    }
  }, 15000);

  membershipLoops.set(chatId, interval);
}

/**
 * Gọi sau khi payment thành công (từ handleFulfillmentDelivery).
 * Wallet đã được credit bởi store.processPayment — chỉ cần setMember + welcome + menu.
 */
async function handleMembershipFulfillment(result, code) {
  const chatId = result.chatId;

  // Dừng countdown
  stopMembershipLoop(chatId);
  unwatchOrder(code);

  // Xóa QR message
  if (membershipQrMessages.has(chatId)) {
    await bot.deleteMessage(chatId, membershipQrMessages.get(chatId)).catch(() => {});
    membershipQrMessages.delete(chatId);
  }

  // Đánh dấu thành viên trong DB + cache
  await store.setMember(chatId);

  // Gửi thông báo chào mừng
  const welcomeText     = store.getText('membership_join_success')
    || '🎉 Chào mừng bạn đến với Before2000s!\n\n✨ Bạn đã chính thức là thành viên. Khám phá kho phim ngay!';
  const welcomeEntities = store.getTextEntities('membership_join_success');
  const wOpts = {};
  if (welcomeEntities) wOpts.entities = welcomeEntities;
  await bot.sendMessage(chatId, welcomeText, wOpts).catch(() => {});

  // Hiện menu chính (đánh dấu đã chào hôm nay để tránh double-greeting)
  const { mainMenu, markGreetedToday } = require('./menu');
  markGreetedToday(chatId);
  await mainMenu(chatId);
}

/**
 * Callback "cancel_membership" — hủy đơn và quay lại dashboard.
 */
async function cancelMembershipOrder(chatId, messageId) {
  stopMembershipLoop(chatId);

  // Tìm và xóa đơn membership đang active
  for (const [code, order] of Object.entries(store.orders)) {
    if (order.chatId === chatId && order.orderKind === 'membership') {
      unwatchOrder(code);
      await store.cancelOrder(code, chatId).catch(() => {});
      break;
    }
  }

  if (messageId) await bot.deleteMessage(chatId, messageId).catch(() => {});
  membershipQrMessages.delete(chatId);

  // Hiện lại dashboard
  await handleMembershipCheck(chatId);
}

module.exports = {
  handleMembershipCheck,
  handleJoin,
  handleMembershipFulfillment,
  cancelMembershipOrder,
  stopMembershipLoop,
  membershipQrMessages,
};
