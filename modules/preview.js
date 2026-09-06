const bot = require('../bot');
const store = require('../store');
const { animatedText, pickRandomText } = require('./utils');
const { priceDisplay, discountPct, displayProductPrice, displayProductPriceWithEntities } = require('./format');

// Các key admin-editable cho thông báo 4s trước preview phim. Bot chọn ngẫu nhiên 1.
const PREVIEW_INTRO_KEYS = ['preview_intro', 'preview_intro_2', 'preview_intro_3'];

const activeSessions = new Map();
const liveDashboards = new Map();
const viewerPool     = new Map();
const buyerPool      = new Map();
const slotsPool      = new Map();

setInterval(() => {
  const maxSize = 500;
  for (const pool of [viewerPool, buyerPool, slotsPool]) {
    if (pool.size > maxSize) {
      const keys = [...pool.keys()];
      keys.slice(0, keys.length - maxSize).forEach(k => pool.delete(k));
    }
  }
}, 300000);

const VIEWER_CAP = 25;
const BUYER_CAP = 15;
const DASHBOARD_TTL = 300000;

const BAR_LEN = 10;
const FILLED = '▰';
const EMPTY  = '▱';
const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

const statusPhases = [
  { max: 25,  text: 'Kết nối' },
  { max: 55,  text: 'Tải dữ liệu' },
  { max: 80,  text: 'Xử lý video' },
  { max: 100, text: 'Hoàn tất' }
];

function getPhaseText(progress) {
  for (const p of statusPhases) {
    if (progress < p.max) return p.text;
  }
  return statusPhases[statusPhases.length - 1].text;
}

function renderBar(progress) {
  const cells = Math.max(0, Math.min(BAR_LEN, Math.round((progress / 100) * BAR_LEN)));
  return FILLED.repeat(cells) + EMPTY.repeat(BAR_LEN - cells);
}

function buildLoadingText(progress, tick) {
  const spin = SPINNER[tick % SPINNER.length];
  const pct  = String(progress).padStart(3, ' ');
  return `${spin}  ${renderBar(progress)}  ${pct}%\n` +
         `🎬  ${getPhaseText(progress)}…`;
}

// Hiển thị thông báo ngắn (mặc định 4s) ngay sau khi loading 100% xong, trước preview phim.
// Nội dung lấy từ store.getText('preview_intro'); nếu trống thì dùng default. Admin sửa qua /admin → Nội dung hiển thị.
// Truyền session vào để có thể abort sớm nếu user bấm menu/xem phim khác trong lúc đợi 4s.
async function showPreviewIntro(chatId, session) {
  if (session && session.cancelled) return;
  // Bot tự chọn ngẫu nhiên 1 trong 3 biến thể (bỏ qua biến thể trống) để chat đỡ nhàm.
  // Nếu admin để trống cả 3 thì rơi về câu mặc định cũ.
  const picked = pickRandomText(store, PREVIEW_INTRO_KEYS);
  const text = (picked && picked.text) || 'Phim Cổ Ngừng Chiếu Chỉ Có Tại KhoPhimRe';
  if (!text) return;
  const entities = picked ? picked.entities : null;
  const opts = {};
  if (entities) opts.entities = entities;
  const sent = await bot.sendMessage(chatId, text, opts).catch(() => null);
  if (!sent) return;
  // Sleep theo chunk 200ms để có thể abort sớm khi cancelled.
  const totalMs = 4000;
  const stepMs = 200;
  for (let waited = 0; waited < totalMs; waited += stepMs) {
    if (session && session.cancelled) break;
    await new Promise(r => setTimeout(r, stepMs));
  }
  await bot.deleteMessage(chatId, sent.message_id).catch(() => {});
}

async function fadeOut(chatId, msgId) {
  const opts = { chat_id: chatId, message_id: msgId };
  try {
    await bot.editMessageText('🎬  ✓', { ...opts, reply_markup: { inline_keyboard: [] } });
    await new Promise(r => setTimeout(r, 80));
  } catch {}
}

function getState(productId, product) {
  if (!viewerPool.has(productId)) {
    let base = Math.floor(Math.random() * 10) + 5;
    const hour = new Date().getHours();
    if (hour >= 19 && hour <= 23) base += 10;
    if (product.hot) base += 10;
    viewerPool.set(productId, { current: base, base });
  }
  if (!buyerPool.has(productId)) {
    const bBase = Math.floor(Math.random() * 3) + 1;
    buyerPool.set(productId, { count: bBase, base: bBase });
  }
  if (!slotsPool.has(productId)) {
    slotsPool.set(productId, Math.floor(Math.random() * 5) + 3);
  }
  return {
    viewerState: viewerPool.get(productId),
    buyerState: buyerPool.get(productId),
    slots: slotsPool.get(productId)
  };
}

function buildCaption(p, viewer, buyers, slots) {
  const pct = discountPct(p.price, p.originalPrice);
  const saleTag = pct > 0 ? ` 🏷 -${pct}%` : '';
  // Dựng caption theo từng đoạn để tính offset chính xác cho strikethrough entity của giá gốc.
  const namePart = `${animatedText(p.name)}\n\n💸 Giá: `;
  const priceBaseOffset = namePart.length;
  const priceData = displayProductPriceWithEntities(p, priceBaseOffset);
  let caption = namePart + priceData.text + saleTag + '\n';
  let entities = priceData.entities && priceData.entities.length > 0 ? [...priceData.entities] : null;
  if (p.description) {
    const prefix = caption + '\n📝 ';
    const prefixOffset = prefix.length;
    caption = prefix + p.description + '\n';
    if (p.descriptionEntities) {
      try {
        const rawEntities = typeof p.descriptionEntities === 'string'
          ? JSON.parse(p.descriptionEntities)
          : p.descriptionEntities;
        if (Array.isArray(rawEntities) && rawEntities.length > 0) {
          const desc = rawEntities.map(e => ({ ...e, offset: e.offset + prefixOffset }));
          entities = entities ? [...entities, ...desc] : desc;
        }
      } catch {}
    }
  }
  return { caption, entities };
}

let sessionIdCounter = 0;

async function stopActiveSession(chatId) {
  if (activeSessions.has(chatId)) {
    const s = activeSessions.get(chatId);
    s.cancelled = true;
    if (s && typeof s.stop === 'function') s.stop();
    if (s && s.messageId) {
      await fadeOut(chatId, s.messageId);
      await bot.deleteMessage(chatId, s.messageId).catch(() => {});
    }
    activeSessions.delete(chatId);
  }
}

async function stopLiveDashboard(chatId) {
  if (liveDashboards.has(chatId)) {
    const dash = liveDashboards.get(chatId);
    if (dash.interval) clearInterval(dash.interval);
    if (dash.autoStop) clearTimeout(dash.autoStop);
    if (dash.messageId) {
      await bot.deleteMessage(chatId, dash.messageId).catch(() => {});
    }
    liveDashboards.delete(chatId);
  }
}

function pauseLiveDashboard(chatId) {
  if (liveDashboards.has(chatId)) {
    const dash = liveDashboards.get(chatId);
    if (dash.interval) clearInterval(dash.interval);
    if (dash.autoStop) clearTimeout(dash.autoStop);
    liveDashboards.delete(chatId);
  }
}

async function showPreview(chatId, productId) {
  const products = store.products;
  const p = products[productId];
  if (!p) return bot.sendMessage(chatId, '❌ Sản phẩm không tồn tại').catch(() => {});

  await stopActiveSession(chatId);
  await stopLiveDashboard(chatId);

  let progress = 0;
  let tick = 0;
  const TOTAL_DURATION_MS = 2400;
  const TICK_MS = 180;
  const TOTAL_TICKS = Math.ceil(TOTAL_DURATION_MS / TICK_MS);
  const { viewerState, buyerState, slots } = getState(productId, p);
  let viewer = viewerState.current;
  let buyers = buyerState.count;
  let currentSlots = slots;
  let messageId;
  let loopTimer;

  const sessionId = ++sessionIdCounter;
  const session = { stop: () => clearInterval(loopTimer), messageId: null, cancelled: false, id: sessionId };
  activeSessions.set(chatId, session);

  const initText = buildLoadingText(0, 0);
  const msg = await bot.sendMessage(chatId, initText).catch(() => null);
  if (!msg) return;

  if (session.cancelled) {
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    return;
  }

  messageId = msg.message_id;
  session.messageId = messageId;

  loopTimer = setInterval(async () => {
    if (session.cancelled) {
      clearInterval(loopTimer);
      return;
    }

    try {
      tick++;

      const ratio = Math.min(1, tick / TOTAL_TICKS);
      const eased = 1 - Math.pow(1 - ratio, 2);
      const targetProgress = Math.floor(eased * 100);
      progress = Math.min(100, Math.max(progress + 1, targetProgress));

      if (progress >= 100 || tick >= TOTAL_TICKS) {
        progress = 100;
        clearInterval(loopTimer);

        if (session.cancelled) return;

        const doneText =
          `✅  ${FILLED.repeat(BAR_LEN)}  100%\n` +
          `🎬  Sẵn sàng!`;

        await bot.editMessageText(doneText, {
          chat_id: chatId, message_id: messageId
        }).catch(() => {});

        await new Promise(r => setTimeout(r, 280));

        // Giữ session trong activeSessions xuyên suốt intro để stopActiveSession có thể
        // set cancelled=true nếu user thoát giữa chừng. Chỉ delete sau khi intro xong + re-check.
        const currentBefore = activeSessions.get(chatId);
        if (!currentBefore || currentBefore.id !== sessionId) return;

        if (session.cancelled) return;

        await fadeOut(chatId, messageId);
        await bot.deleteMessage(chatId, messageId).catch(() => {});
        await showPreviewIntro(chatId, session);

        // Re-check sau khi đợi 4s — nếu user đã navigate đi chỗ khác thì bỏ qua dashboard.
        const currentAfter = activeSessions.get(chatId);
        if (!currentAfter || currentAfter.id !== sessionId || session.cancelled) return;
        activeSessions.delete(chatId);

        await sendLiveDashboard(chatId, productId, viewer, buyers, currentSlots);
        return;
      }

      if (session.cancelled) return;

      const text = buildLoadingText(progress, tick);
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
    } catch {}
  }, TICK_MS);
}

async function sendLiveDashboard(chatId, productId, viewer, buyers, slots) {
  const products = store.products;
  const p = products[productId];
  if (!p) return;

  await stopLiveDashboard(chatId);

  // Mặc định chỉ hiện 1 nút "Xem ngay". Khi user bấm:
  //   - Nếu đã mua phim này → giao phim ngay
  //   - Nếu chưa mua → hiện thông báo 5s rồi chuyển dashboard sang 2 nút thanh toán (Ví + QR).
  // QUAN TRỌNG: object `keyboard` được mutate trực tiếp (qua replaceKeyboard) khi
  // revealPaymentButtons() chạy, nên interval cập nhật caption mỗi 2s sẽ luôn đọc đúng
  // bộ nút mới — không bị ghi đè ngược về nút "Xem ngay".
  const keyboard = {
    inline_keyboard: [
      [{ text: store.getText('btn_view_now') || '▶️ Xem ngay', callback_data: `xn_${productId}` }],
      [{ text: store.getText('btn_back')     || '🔙 Quay lại', callback_data: 'menu' }]
    ]
  };
  const replaceKeyboard = (newRows) => { keyboard.inline_keyboard = newRows; };

  const { caption, entities } = buildCaption(p, viewer, buyers, slots);

  let sent;
  let isVideoMsg = false;

  if (p.videoFileId) {
    try {
      const opts = { caption, reply_markup: keyboard, supports_streaming: true };
      if (entities) opts.caption_entities = entities;
      sent = await bot.sendVideo(chatId, p.videoFileId, opts);
      isVideoMsg = true;
    } catch {
      await store.removeProductMedia(p.id, 'video');
    }
  }

  if (!sent && p.previewFileId) {
    try {
      const opts = { caption, reply_markup: keyboard };
      if (entities) opts.caption_entities = entities;
      sent = await bot.sendPhoto(chatId, p.previewFileId, opts);
    } catch {
      await store.removeProductMedia(p.id, 'preview');
    }
  }

  if (!sent) {
    const opts = { reply_markup: keyboard };
    if (entities) opts.entities = entities;
    sent = await bot.sendMessage(chatId, caption, opts).catch(() => null);
    if (!sent) return;
  }

  if (isVideoMsg) {
    const autoStop = setTimeout(() => {
      liveDashboards.delete(chatId);
    }, DASHBOARD_TTL);
    // Video dashboards không có interval edit liên tục — replaceKeyboard chỉ cần đổi
    // markup 1 lần qua editMessageReplyMarkup (xem revealPaymentButtons).
    liveDashboards.set(chatId, { interval: null, messageId: sent.message_id, autoStop, productId, replaceKeyboard });
    return;
  }

  const isMediaMsg = !!(sent.photo);

  const interval = setInterval(async () => {
    try {
      const { viewerState, buyerState } = getState(productId, p);
      let vNow = viewerState.current;
      let bNow = buyerState.count;
      const r = Math.random();
      if (r > 0.4)  vNow++;
      if (r < 0.1)  vNow += 2;
      if (vNow > viewerState.base + VIEWER_CAP) vNow = viewerState.base + VIEWER_CAP;
      if (Math.random() > 0.85 && bNow < buyerState.base + BUYER_CAP) bNow++;
      if (Math.random() > 0.98 && vNow > viewerState.base) vNow--;
      viewerState.current = vNow;
      buyerState.count    = bNow;

      const updated = buildCaption(p, vNow, bNow, slots);
      if (isMediaMsg) {
        const editOpts = { chat_id: chatId, message_id: sent.message_id, reply_markup: keyboard };
        if (updated.entities) editOpts.caption_entities = updated.entities;
        await bot.editMessageCaption(updated.caption, editOpts);
      } else {
        const editOpts = { chat_id: chatId, message_id: sent.message_id, reply_markup: { inline_keyboard: keyboard.inline_keyboard } };
        if (updated.entities) editOpts.entities = updated.entities;
        await bot.editMessageText(updated.caption, editOpts);
      }
    } catch {}
  }, 2000);

  const autoStop = setTimeout(() => {
    clearInterval(interval);
    liveDashboards.delete(chatId);
  }, DASHBOARD_TTL);

  liveDashboards.set(chatId, { interval, messageId: sent.message_id, autoStop, productId, replaceKeyboard });
}

// Đổi inline keyboard của dashboard preview hiện tại (chứa video/ảnh + giá) sang 2 nút
// thanh toán Ví KhoPhim + QR Bank. Gọi từ handler "Xem ngay" sau khi user đợi 5s notice.
// expectedMessageId: id dashboard tại thời điểm user bấm "Xem ngay" — nếu khi reveal mà
// dashboard hiện tại không còn match (user đã navigate đi nơi khác / dashboard mới sinh ra)
// thì TRẢ VỀ false và KHÔNG làm gì để tránh kéo user trở lại.
// Trả về true nếu cập nhật thành công, false nếu không tìm thấy dashboard hoặc đã đổi.
async function revealPaymentButtons(chatId, productId, expectedMessageId) {
  const dash = liveDashboards.get(chatId);
  if (!dash || !dash.messageId) return false;
  if (expectedMessageId && dash.messageId !== expectedMessageId) return false;
  if (String(dash.productId) !== String(productId)) return false;
  const newRows = [
    [
      { text: store.getText('btn_buy')   || '💎 Ví KhoPhim', callback_data: `buy_${productId}`   },
      { text: store.getText('btn_buyqr') || '🏦 QR Bank',    callback_data: `buyqr_${productId}` }
    ],
    [{ text: store.getText('btn_back') || '🔙 Quay lại', callback_data: 'menu' }]
  ];
  // Cập nhật state mutable (cho interval đọc tiếp) trước, rồi mới gọi Telegram.
  if (typeof dash.replaceKeyboard === 'function') {
    dash.replaceKeyboard(newRows);
  }
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: newRows }, { chat_id: chatId, message_id: dash.messageId });
    return true;
  } catch {
    return false;
  }
}

// Trả về { messageId, productId } của dashboard preview hiện tại nếu có, null nếu không.
// Handler dùng để snapshot bối cảnh trước khi sleep 5s (chống race khi user navigate đi).
function getActiveDashboardSnapshot(chatId) {
  const dash = liveDashboards.get(chatId);
  if (!dash || !dash.messageId) return null;
  return { messageId: dash.messageId, productId: dash.productId };
}

module.exports = { showPreview, stopActiveSession, stopLiveDashboard, pauseLiveDashboard, revealPaymentButtons, getActiveDashboardSnapshot };
