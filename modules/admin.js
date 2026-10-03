const bot = require('../bot');
const store = require('../store');
const log = require('./logger');
const { animatedText } = require('./utils');
const { ADMIN_CHAT_ID } = require('../config');
const { fmtVN, discountPct } = require('./format');

const adminState = new Map();
const ADMIN_STATE_TTL_MS = 10 * 60 * 1000;
const _origAdminStateSet = adminState.set.bind(adminState);
adminState.set = function(k, v) {
  const stamped = (v && typeof v === 'object') ? { ...v, _ts: Date.now() } : v;
  return _origAdminStateSet(k, stamped);
};
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of adminState.entries()) {
    if (v && v._ts && now - v._ts > ADMIN_STATE_TTL_MS) adminState.delete(k);
  }
}, 60 * 1000).unref();
const adminMsgId = {};
const ITEMS_PER_PAGE = 8;

const TEXT_LABELS = {
  'welcome_new': 'Lời chào (khách mới)',
  'welcome_return': 'Lời chào (quay lại)',
  'menu_title': 'Tiêu đề menu',
  'buy_title': 'Tiêu đề thanh toán',
  'buy_footer': 'Ghi chú thanh toán',
  'cancel_warning': 'Cảnh báo khi đổi phim',
  'preview_intro': 'Thông báo trước preview phim — biến thể 1 (4s, tự xoá)',
  'preview_intro_2': 'Thông báo trước preview phim — biến thể 2 (4s, tự xoá)',
  'preview_intro_3': 'Thông báo trước preview phim — biến thể 3 (4s, tự xoá)',
  'qr_intro_1': 'Thông báo trước QR thanh toán — biến thể 1 (4s, tự xoá)',
  'qr_intro_2': 'Thông báo trước QR thanh toán — biến thể 2 (4s, tự xoá)',
  'qr_intro_3': 'Thông báo trước QR thanh toán — biến thể 3 (4s, tự xoá)',
  'before_payment_notice': 'Thông báo 5s trước khi hiện 2 nút thanh toán (Xem ngay)',
  'topup_title': '💰 Tiêu đề bảng nạp tiền',
  'topup_amounts': '💰 Mệnh giá nạp (CSV: 10000,20000,…)',
  'topup_success': '💰 Thông báo nạp ví thành công ({amount},{balance})',
  'topup_x2_notice': '🎁 Banner KM x2 trên bảng nạp tiền ({min} = ngưỡng tối thiểu)',
  'promo_x2_min_amount': '🎁 Ngưỡng KM x2 (VND) — chỉ nhập số, ví dụ 50000',
  'topup_zero_balance_notice': '💰 Cảnh báo ví trống (5s rồi mở nạp)',
  'insufficient_balance_msg': '💰 Cảnh báo ví không đủ ({balance},{price})',
  'wallet_purchase_success': '💰 Thông báo trừ ví khi mua phim ({amount},{balance})',
  'wallet_balance_label': '💰 Nhãn "Số dư ví:" trong menu',
  // === Editable button labels (icon + chữ) ===
  'btn_hot':           '🔘 Nút "Phim HOT"',
  'btn_list':          '🔘 Nút "Tất cả phim"',
  'btn_myfilms':       '🔘 Nút "Phim của tôi"',
  'btn_mypoints':      '🔘 Nút "Điểm thưởng"',
  'btn_nap':           '🔘 Nút "Nạp tiền"',
  'btn_support':       '🔘 Nút "Hỗ trợ"',
  'btn_back_menu':     '🔘 Nút "Quay lại menu" (chung)',
  'btn_back':          '🔘 Nút "Quay lại" (chung)',
  'btn_view_now':      '🔘 Nút "Xem ngay" (preview — thay 2 nút mua)',
  'btn_buy':           '🔘 Nút mua bằng ví (preview, lộ sau Xem ngay)',
  'btn_buyqr':         '🔘 Nút QR Bank (preview, lộ sau Xem ngay)',
  'btn_coupon':        '🔘 Nút "Nhập mã giảm giá"',
  'btn_reset':         '🔘 Nút "Đổi phim"',
  'btn_skip_coupon':   '🔘 Nút bỏ qua mã giảm giá',
  'btn_topup_more':    '🔘 Nút "Nạp thêm vào ví" (khi ví không đủ)',
  'btn_pay_with_qr':   '🔘 Nút "Thanh toán bằng QR" (khi ví không đủ)',
  'btn_topup_cancel':  '🔘 Nút "Huỷ đơn nạp"',
  'btn_topup_again':   '🔘 Nút "Nạp thêm" sau khi nạp thành công',
  'btn_topup_retry':   '🔘 Nút "Nạp lại" sau khi nạp thất bại',
  'btn_view_films':    '🔘 Nút "Xem phim ngay" (khi chưa có phim)',
  'btn_vip_group':     '🔘 Nút "Vào nhóm VIP"',
  'btn_rebuy':         '🔘 Nút "Mua lại {name}" (re-engagement) — {name} = tên phim',
  // === Membership ===
  'membership_checking':    '🎟 Thông báo "Đang kiểm tra ID" (loading)',
  'membership_not_joined':  '🎟 Dashboard khi chưa là thành viên',
  'membership_qr_title':    '🎟 Tiêu đề trang QR tham gia',
  'membership_price':       '🎟 Phí tham gia (VNĐ, chỉ nhập số — ví dụ: 10000)',
  'membership_join_success':'🎟 Thông báo chào mừng sau khi tham gia thành công',
  'btn_join_member':        '🔘 Nút "Tham gia" trên dashboard membership'
};

function extractEntities(msg) {
  if (!msg || !msg.entities) return null;
  const skip = new Set(['bot_command']);
  const kept = msg.entities.filter(e => !skip.has(e.type));
  return kept.length > 0 ? kept : null;
}

function adjustEntitiesForTrim(text, entities) {
  if (!entities || !text) return entities;
  const leading = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const trimmedLen = trimmed.length;
  if (leading === 0 && trimmedLen === text.length) return entities;
  const adjusted = [];
  for (const e of entities) {
    const newOffset = e.offset - leading;
    if (newOffset + e.length <= 0 || newOffset >= trimmedLen) continue;
    const clampedOffset = Math.max(0, newOffset);
    const clampedLength = Math.min(e.length + Math.min(0, newOffset), trimmedLen - clampedOffset);
    if (clampedLength <= 0) continue;
    adjusted.push({ ...e, offset: clampedOffset, length: clampedLength });
  }
  return adjusted.length > 0 ? adjusted : null;
}

function isAdmin(chatId) {
  return ADMIN_CHAT_ID && String(chatId) === String(ADMIN_CHAT_ID);
}

function clearState(chatId) {
  adminState.delete(chatId);
}

function isInState(chatId) {
  const s = adminState.get(chatId);
  if (!s) return false;
  if (s._ts && Date.now() - s._ts > ADMIN_STATE_TTL_MS) {
    adminState.delete(chatId);
    return false;
  }
  return true;
}

async function editOrSend(chatId, text, keyboard) {
  if (adminMsgId[chatId]) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: adminMsgId[chatId],
        reply_markup: { inline_keyboard: keyboard }
      });
      return adminMsgId[chatId];
    } catch {}
  }
  const sent = await bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: keyboard }
  }).catch(() => null);
  if (sent) adminMsgId[chatId] = sent.message_id;
  return sent ? sent.message_id : null;
}

async function toast(chatId, text, ttlMs = 3500) {
  const sent = await bot.sendMessage(chatId, text).catch(() => null);
  if (sent) {
    setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(() => {}), ttlMs);
  }
  return sent;
}

const undoCache = new Map(); // id -> { fn, expiresAt }
let undoCounter = 0;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of undoCache.entries()) {
    if (v.expiresAt < now) undoCache.delete(k);
  }
}, 30_000).unref();

async function toastWithUndo(chatId, text, undoFn, ttlMs = 8000) {
  const id = `u${++undoCounter}`;
  undoCache.set(id, { fn: undoFn, expiresAt: Date.now() + ttlMs });
  const sent = await bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: [[{ text: '↩ Hoàn tác', callback_data: `undo_${id}` }]] }
  }).catch(() => null);
  if (sent) setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(() => {}), ttlMs);
  return sent;
}

async function handleUndo(chatId, undoId) {
  const entry = undoCache.get(undoId);
  if (!entry || entry.expiresAt < Date.now()) {
    return toast(chatId, '⚠️ Không thể hoàn tác (đã quá hạn)');
  }
  undoCache.delete(undoId);
  try {
    await entry.fn();
    await toast(chatId, '↩ Đã hoàn tác');
  } catch (e) {
    await toast(chatId, `❌ Lỗi hoàn tác: ${e.message}`);
  }
}

async function repositionAdminPanel(chatId) {
  if (adminMsgId[chatId]) {
    await bot.deleteMessage(chatId, adminMsgId[chatId]).catch(() => {});
    delete adminMsgId[chatId];
  }
}

async function finishAdminUpdate(chatId, successText, nextView) {
  await toast(chatId, successText);
  await repositionAdminPanel(chatId);
  if (typeof nextView === 'function') return nextView();
}

async function finishAdminUpdateWithUndo(chatId, successText, undoFn, nextView) {
  await toastWithUndo(chatId, successText, async () => {
    await undoFn();
    await repositionAdminPanel(chatId);
    if (typeof nextView === 'function') await nextView();
  });
  await repositionAdminPanel(chatId);
  if (typeof nextView === 'function') return nextView();
}

async function showAdminHome(chatId) {
  clearState(chatId);
  const allProducts = store.getAllProductsList();
  const activeCount = allProducts.filter(p => p.active).length;
  const totalUsers = await store.getTotalUsersCount();
  const activeBuyers = await store.getActiveBuyersCount();
  const convRate = totalUsers > 0 ? ((activeBuyers / totalUsers) * 100).toFixed(1) : '0.0';

  const text =
    `🔧 ADMIN PANEL\n\n` +
    `🎬 Sản phẩm: ${activeCount} hoạt động / ${allProducts.length} tổng\n` +
    `👥 Users: ${totalUsers} | Mua hàng: ${activeBuyers}\n` +
    `📈 Tỉ lệ chuyển đổi: ${convRate}%\n` +
    `💰 Tổng doanh thu: ${store.analytics.totalRevenue.toLocaleString()} VND\n` +
    `✅ Đơn thành công: ${store.analytics.successfulOrders}`;

  const keyboard = [
    [{ text: '📊 Dashboard', callback_data: 'adm_dash' }],
    [{ text: '🎬 Quản lý Phim', callback_data: 'adm_movies' }],
    [{ text: '👑 Quản lý VIP', callback_data: 'adm_vip' }],
    [{ text: '📝 Nội dung hiển thị', callback_data: 'adm_texts' }],
    [{ text: '🎟 Mã giảm giá', callback_data: 'adm_coupons' }],
    [{ text: '📋 Đơn hàng', callback_data: 'adm_orders' }],
    [{ text: '🚫 Cấm user', callback_data: 'adm_bans' }],
    [{ text: '⚙️ Cài đặt', callback_data: 'adm_settings' }],
    [{ text: '🎟 Membership', callback_data: 'adm_membership' }],
    [{ text: '❌ Đóng', callback_data: 'adm_close' }]
  ];

  await editOrSend(chatId, text, keyboard);
}

async function showDashboard(chatId) {
  clearState(chatId);
  const a = await store.getAllAnalytics();
  const totalUsers = await store.getTotalUsersCount();
  const activeBuyers = await store.getActiveBuyersCount();
  const allProducts = store.getAllProductsList();
  const activeProducts = allProducts.filter(p => p.active).length;
  const convRate = totalUsers > 0 ? ((activeBuyers / totalUsers) * 100).toFixed(1) : '0.0';

  const text =
    `📊 DASHBOARD\n\n` +
    `💰 Tổng doanh thu: ${(a.total_revenue || 0).toLocaleString()} VND\n` +
    `✅ Đơn thành công: ${a.successful_orders || 0}\n` +
    `❌ Đơn hết hạn: ${a.expired_orders || 0}\n` +
    `🛒 Tổng đơn: ${a.total_orders || 0}\n` +
    `📈 Tỉ lệ thành công: ${a.total_orders > 0 ? ((a.successful_orders / a.total_orders) * 100).toFixed(1) : '0.0'}%\n\n` +
    `👥 Tổng users: ${totalUsers}\n` +
    `🛍 Đã mua hàng: ${activeBuyers}\n` +
    `📈 Tỉ lệ chuyển đổi: ${convRate}%\n\n` +
    `🎬 Sản phẩm: ${activeProducts}/${allProducts.length}`;

  const keyboard = [
    [
      { text: '📅 Hôm nay', callback_data: 'adm_stt' },
      { text: '📅 7 ngày', callback_data: 'adm_st7' },
      { text: '📅 30 ngày', callback_data: 'adm_s30' }
    ],
    [
      { text: '🏆 Top bán chạy', callback_data: 'adm_stp' },
      { text: '📊 Theo sản phẩm', callback_data: 'adm_stb' }
    ],
    [{ text: '🔙 Quay lại', callback_data: 'adm_home' }]
  ];

  await editOrSend(chatId, text, keyboard);
}

async function showPeriodStats(chatId, days, label) {
  const data = await store.getRevenueByPeriod(days);

  const text =
    `📅 THỐNG KÊ ${label.toUpperCase()}\n\n` +
    `💰 Doanh thu: ${data.revenue.toLocaleString()} VND\n` +
    `✅ Đơn thành công: ${data.count}\n` +
    `💵 TB/đơn: ${data.count > 0 ? Math.round(data.revenue / data.count).toLocaleString() : '0'} VND`;

  const keyboard = [
    [{ text: '🔙 Quay lại Dashboard', callback_data: 'adm_dash' }]
  ];

  await editOrSend(chatId, text, keyboard);
}

async function showTopProducts(chatId) {
  const top = await store.getTopProducts(10);

  let text = '🏆 TOP SẢN PHẨM BÁN CHẠY\n\n';
  if (top.length === 0) {
    text += 'Chưa có dữ liệu bán hàng.';
  } else {
    top.forEach((item, i) => {
      const p = store.getProductById(item.productId);
      const name = p ? p.name : `#${item.productId}`;
      text += `${i + 1}. ${name}\n   📦 ${item.count} đơn | 💰 ${item.revenue.toLocaleString()} VND\n\n`;
    });
  }

  const keyboard = [
    [{ text: '🔙 Quay lại Dashboard', callback_data: 'adm_dash' }]
  ];

  await editOrSend(chatId, text, keyboard);
}

async function showSalesByProduct(chatId) {
  const sales = await store.getSalesByProduct();

  let text = '📊 DOANH SỐ THEO SẢN PHẨM\n\n';
  if (sales.length === 0) {
    text += 'Chưa có dữ liệu bán hàng.';
  } else {
    sales.forEach(item => {
      const p = store.getProductById(item.productId);
      const name = p ? p.name : `#${item.productId}`;
      text += `📌 ${name}\n   📦 ${item.count} đơn | 💰 ${item.revenue.toLocaleString()} VND\n\n`;
    });
  }

  const keyboard = [
    [{ text: '🔙 Quay lại Dashboard', callback_data: 'adm_dash' }]
  ];

  await editOrSend(chatId, text, keyboard);
}

async function showMoviesList(chatId, page = 1) {
  clearState(chatId);
  const vipId = store.getText('vip_product_id');
  const all = store.getAllProductsList().filter(p => !vipId || String(p.id) !== vipId);
  const totalPages = Math.max(1, Math.ceil(all.length / ITEMS_PER_PAGE));
  page = Math.max(1, Math.min(page, totalPages));

  const start = (page - 1) * ITEMS_PER_PAGE;
  const items = all.slice(start, start + ITEMS_PER_PAGE);

  let text = `🎬 QUẢN LÝ PHIM (${all.length} sản phẩm)\n`;
  if (totalPages > 1) text += `📄 Trang ${page}/${totalPages}\n`;

  const keyboard = [];
  for (const p of items) {
    const status = p.active ? '✅' : '🚫';
    const hotTag = p.hot ? ' 🔥' : '';
    const usdTag = (p.priceUsd && p.priceUsd > 0) ? ` / $${p.priceUsd.toFixed(2)}` : '';
    keyboard.push([{
      text: `${status} ${p.name} — ${p.price.toLocaleString()}đ${usdTag}${hotTag}`,
      callback_data: `adm_mov_${p.id}`
    }]);
  }

  keyboard.push([{ text: '➕ Thêm phim mới', callback_data: 'adm_add' }]);

  if (totalPages > 1) {
    const nav = [];
    if (page > 1) nav.push({ text: '◀️ Trước', callback_data: `adm_mp_${page - 1}` });
    if (page < totalPages) nav.push({ text: '▶️ Sau', callback_data: `adm_mp_${page + 1}` });
    if (nav.length) keyboard.push(nav);
  }

  keyboard.push([{ text: '🔙 Quay lại', callback_data: 'adm_home' }]);

  await editOrSend(chatId, text, keyboard);
}

async function showMovieDetail(chatId, productId) {
  clearState(chatId);
  const p = store.getProductById(productId);
  if (!p) return showMoviesList(chatId);

  const hotStatus = p.hot ? '🔥 BẬT' : '— TẮT';
  const activeStatus = p.active ? '✅ BẬT' : '🚫 TẮT';
  const hasVideo = p.videoFileId ? '✅' : '❌';
  const hasPreview = p.previewFileId ? '✅' : '❌';
  const desc = p.description ? p.description.slice(0, 100) : '(chưa có)';

  const origLine = p.originalPrice && p.originalPrice > p.price
    ? `🏷 Giá gốc: ${fmtVN(p.originalPrice)} VND  (giảm ${discountPct(p.price, p.originalPrice)}%)\n`
    : `🏷 Giá gốc: (chưa đặt)\n`;

  const usdLine = (p.priceUsd && p.priceUsd > 0)
    ? `💵 Giá USD: $${p.priceUsd.toFixed(2)}\n`
    : `💵 Giá USD: (chưa đặt)\n`;

  const text =
    `🎬 CHI TIẾT SẢN PHẨM\n\n` +
    `📌 ID: ${p.id}\n` +
    `📌 Tên: ${p.name}\n` +
    `💰 Giá bán: ${fmtVN(p.price)} VND\n` +
    usdLine +
    origLine +
    `📝 Mô tả: ${desc}\n` +
    `🔥 Hot: ${hotStatus}\n` +
    `👁 Hiển thị: ${activeStatus}\n` +
    `🎥 Video: ${hasVideo}\n` +
    `🖼 Ảnh: ${hasPreview}`;

  const keyboard = [
    [
      { text: '✏️ Tên', callback_data: `adm_en_${p.id}` },
      { text: '💰 Giá', callback_data: `adm_ep_${p.id}` },
      { text: '🏷 Giá gốc', callback_data: `adm_eop_${p.id}` }
    ],
    [
      { text: '💵 Giá USD', callback_data: `adm_eu_${p.id}` }
    ],
    [
      { text: '📝 Mô tả', callback_data: `adm_ed_${p.id}` }
    ],
    [
      { text: `🔥 Hot: ${p.hot ? 'BẬT' : 'TẮT'}`, callback_data: `adm_th_${p.id}` },
      { text: `👁 ${p.active ? 'BẬT' : 'TẮT'}`, callback_data: `adm_ta_${p.id}` }
    ]
  ];

  const mediaRow = [];
  if (p.videoFileId) {
    mediaRow.push({ text: '🎥 Xóa Video', callback_data: `adm_rv_${p.id}` });
  } else {
    mediaRow.push({ text: '🎥 Gán Video', callback_data: `adm_sv_${p.id}` });
  }
  if (p.previewFileId) {
    mediaRow.push({ text: '🖼 Xóa Ảnh', callback_data: `adm_rp_${p.id}` });
  } else {
    mediaRow.push({ text: '🖼 Gán Ảnh', callback_data: `adm_sp_${p.id}` });
  }
  keyboard.push(mediaRow);

  const dlvMedia = p.deliveryMedia || [];
  const dlvPhotos = dlvMedia.filter(m => m.type === 'photo').length;
  const dlvVideos = dlvMedia.filter(m => m.type === 'video').length;
  const dlvDesc = p.deliveryDescription ? '✅' : '❌';
  keyboard.push([{
    text: `📦 Giao hàng (${dlvPhotos}📷 ${dlvVideos}🎥 ${dlvDesc}📝)`,
    callback_data: `adm_dlv_${p.id}`
  }]);

  keyboard.push([
    { text: '⬆️ Lên', callback_data: `adm_mu_${p.id}` },
    { text: '⬇️ Xuống', callback_data: `adm_md_${p.id}` }
  ]);

  keyboard.push([{ text: '🗑 Xóa phim', callback_data: `adm_del_${p.id}` }]);
  keyboard.push([{ text: '🔙 Quay lại danh sách', callback_data: 'adm_movies' }]);

  await editOrSend(chatId, text, keyboard);
}

async function showDeliveryDetail(chatId, productId) {
  clearState(chatId);
  const p = store.getProductById(productId);
  if (!p) return showMoviesList(chatId);

  const media = p.deliveryMedia || [];
  const photos = media.filter(m => m.type === 'photo');
  const videos = media.filter(m => m.type === 'video');
  const descPreview = p.deliveryDescription ? p.deliveryDescription.slice(0, 80) : '(chưa có)';

  let text =
    `📦 GIAO HÀNG — ${p.name}\n\n` +
    `📝 Mô tả: ${descPreview}${p.deliveryDescription && p.deliveryDescription.length > 80 ? '...' : ''}\n\n` +
    `📷 Ảnh: ${photos.length}/1\n` +
    `🎥 Video: ${videos.length}/3\n\n` +
    `💡 Nội dung này sẽ gửi cho user sau khi thanh toán thành công.`;

  const keyboard = [];

  keyboard.push([{ text: '📝 Sửa mô tả giao hàng', callback_data: `adm_dld_${productId}` }]);

  if (photos.length < 1) {
    keyboard.push([{ text: '📷 Thêm ảnh', callback_data: `adm_dlap_${productId}` }]);
  } else {
    keyboard.push([{ text: `📷 Xóa ảnh #${photos[0].id}`, callback_data: `adm_dlrm_${photos[0].id}_${productId}` }]);
  }

  if (videos.length < 3) {
    keyboard.push([{ text: '🎥 Thêm video', callback_data: `adm_dlav_${productId}` }]);
  }

  for (const v of videos) {
    keyboard.push([{ text: `🎥 Xóa video #${v.id}`, callback_data: `adm_dlrm_${v.id}_${productId}` }]);
  }

  keyboard.push([{ text: '🔙 Quay lại sản phẩm', callback_data: `adm_mov_${productId}` }]);

  await editOrSend(chatId, text, keyboard);
}

async function showTexts(chatId) {
  clearState(chatId);
  const texts = store.getAllTexts();

  let text = '📝 NỘI DUNG HIỂN THỊ\n\nChọn mục cần chỉnh sửa:\n';
  text += '\n💡 Mẹo: muốn dùng emoji động (Telegram Premium), khi sửa hãy chèn emoji từ gói có dấu ⭐ trong picker. Bot sẽ lưu cả entities để hiển thị động.\n';

  const keyboard = [];
  for (const [key, label] of Object.entries(TEXT_LABELS)) {
    const current = texts[key] || '(trống)';
    const preview = current.replace(/\n/g, ' ').slice(0, 30);
    const ents = store.getTextEntities(key) || [];
    const animCount = ents.filter(e => e.type === 'custom_emoji').length;
    const animTag = animCount > 0 ? ` ✨×${animCount}` : '';
    text += `\n${label}${animTag}:\n  "${preview}${current.length > 30 ? '...' : ''}"\n`;
    keyboard.push([{ text: `✏️ ${label}${animTag}`, callback_data: `adm_tx_${key}` }]);
  }

  keyboard.push([{ text: '🔙 Quay lại', callback_data: 'adm_home' }]);

  await editOrSend(chatId, text, keyboard);
}

async function showOrders(chatId) {
  clearState(chatId);
  const orders = await store.getActiveOrders();

  if (!orders.length) {
    const text = '📋 ĐƠN HÀNG\n\nKhông có đơn hàng nào đang chờ.';
    const keyboard = [[{ text: '🔙 Quay lại', callback_data: 'adm_home' }]];
    return editOrSend(chatId, text, keyboard);
  }

  let text = `📋 ĐƠN HÀNG ĐANG CHỜ (${orders.length})\n\n`;
  const keyboard = [];

  const display = orders.slice(0, 10);
  display.forEach((o, i) => {
    const p = store.getProductById(o.product_id);
    const name = p ? p.name : `#${o.product_id}`;
    const time = new Date(o.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    text += `${i + 1}. ${o.code}\n   👤 ${o.chat_id} | 🎬 ${name}\n   💰 ${o.amount_paid}/${o.amount_required} VND\n   🕐 ${time}\n\n`;
    keyboard.push([{ text: `✅ Xác nhận ${o.code}`, callback_data: `adm_oc_${o.code}` }]);
  });

  if (orders.length > 10) {
    text += `... và ${orders.length - 10} đơn khác\n`;
    text += `Dùng /confirm <mã đơn> để xác nhận`;
  }

  keyboard.push([{ text: '🔙 Quay lại', callback_data: 'adm_home' }]);

  await editOrSend(chatId, text, keyboard);
}

async function handleConfirmOrder(chatId, code) {
  try {
    const result = await store.adminConfirmOrder(code);
    if (!result) {
      await bot.sendMessage(chatId, `❌ Không tìm thấy đơn đang chờ: ${code}`).catch(() => {});
      return;
    }

    // Topup orders: route to wallet handler (notify user, refresh dashboard).
    // adminConfirmOrder already credited the wallet atomically + wrote the audit row.
    if (result.orderKind === 'topup') {
      const wallet = require('./wallet');
      await wallet.handleTopupFulfillment(result, code).catch(e => log.error('Admin topup confirm delivery error:', e.message));
      const bonusInfo = (Number.isFinite(result.bonus) && result.bonus > 0)
        ? ` + 🎁 KM x2 +${result.bonus.toLocaleString()}đ`
        : '';
      log.payment(`✅ Manual TOPUP confirm by admin: ${code} | User: ${result.chatId} | Amount: ${result.amountRequired}${bonusInfo}`);
      await bot.sendMessage(chatId, `✅ Đã xác nhận nạp ví ${code} cho user ${result.chatId} (+${result.amountRequired.toLocaleString()}đ${bonusInfo})`).catch(() => {});
      await showOrders(chatId);
      return;
    }

    const p = store.getProductById(result.productId);

    if (global.paymentLoop && global.paymentLoop.has(result.chatId)) {
      clearInterval(global.paymentLoop.get(result.chatId));
      global.paymentLoop.delete(result.chatId);
    }

    if (global.paymentMessages && global.paymentMessages.has(result.chatId)) {
      await bot.deleteMessage(result.chatId, global.paymentMessages.get(result.chatId)).catch(() => {});
      global.paymentMessages.delete(result.chatId);
    }

    const productName = p ? p.name : `#${result.productId}`;

    if (p) {
      const { sendDeliveryDashboard } = require('./delivery');
      await sendDeliveryDashboard(result.chatId, p);
    } else {
      await bot.sendMessage(result.chatId, `🎉 ${animatedText(productName)}\n\n✅ Đã xác nhận thành công!`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại menu', callback_data: 'menu' }]] }
      }).catch(() => {});
    }

    log.payment(`✅ Manual confirm by admin: ${code} | User: ${result.chatId} | Product: ${productName}`);
    await bot.sendMessage(chatId, `✅ Đã xác nhận đơn ${code} cho user ${result.chatId}`).catch(() => {});

    await showOrders(chatId);
  } catch (e) {
    log.error('Admin confirm error:', e.message);
    await bot.sendMessage(chatId, `❌ Lỗi khi xác nhận: ${e.message}`).catch(() => {});
  }
}

async function showSettings(chatId) {
  clearState(chatId);
  const notifyOn = store.getText('admin_notify_payment') !== 'off';
  const notifyLabel = notifyOn ? '🔔 Thông báo đơn hàng: BẬT' : '🔕 Thông báo đơn hàng: TẮT';

  const layout = store.getText('menu_layout') || '2,2,2';
  const currMode = (store.getText('currency_mode') || 'vnd').toLowerCase();
  const currLabel = currMode === 'usd' ? '💵 USD'
    : currMode === 'both' ? '💵 USD + 🇻🇳 VND'
    : '🇻🇳 VND';
  const promoOn = store.isTopupPromoActive();
  const promoMin = store.getTopupPromoMin();
  const promoLabel = promoOn
    ? `🎁 KM x2 nạp tiền: BẬT (≥ ${fmtVN(promoMin)}đ)`
    : `🎁 KM x2 nạp tiền: TẮT`;
  const text = `⚙️ CÀI ĐẶT\n\nQuản lý các tùy chọn hệ thống:`;
  const keyboard = [
    [{ text: notifyLabel, callback_data: 'adm_tgl_notify' }],
    [{ text: promoLabel, callback_data: 'adm_tgl_promo_x2' }],
    [{ text: `🎁 Đặt ngưỡng KM x2 (${fmtVN(promoMin)}đ)`, callback_data: 'adm_set_promo_min' }],
    [{ text: '💱 Cập nhật giá hàng loạt', callback_data: 'adm_bulk' }],
    [{ text: `💱 Tiền tệ: ${currLabel}`, callback_data: 'adm_curr' }],
    [{ text: `🧩 Bố cục menu: ${layout}`, callback_data: 'adm_menulayout' }],
    [{ text: '🔙 Quay lại', callback_data: 'adm_home' }]
  ];
  await editOrSend(chatId, text, keyboard);
}

async function togglePromoX2(chatId) {
  const on = store.isTopupPromoActive();
  await store.setText('promo_x2_topup', on ? 'off' : 'on');
  log.info(`Admin toggled KM x2 nạp tiền → ${on ? 'OFF' : 'ON'}`);
  return showSettings(chatId);
}

async function promptPromoMin(chatId) {
  adminState.set(chatId, { action: 'edit_promo_min' });
  const cur = store.getTopupPromoMin();
  const text =
    `🎁 NGƯỠNG KM x2 NẠP TIỀN\n\n` +
    `Hiện tại: ${fmtVN(cur)}đ\n\n` +
    `Nhập số tiền tối thiểu (VND) để được hưởng khuyến mãi x2.\n` +
    `Ví dụ: 50000  (nạp từ 50.000đ trở lên sẽ được nhân đôi).`;
  const kb = [[{ text: '❌ Hủy', callback_data: 'adm_settings' }]];
  return editOrSend(chatId, text, kb);
}

async function showCurrencySettings(chatId) {
  clearState(chatId);
  const mode = (store.getText('currency_mode') || 'vnd').toLowerCase();
  const rate = parseFloat(store.getText('usd_to_vnd_rate') || '25500') || 25500;
  const modeLabel = mode === 'usd' ? '💵 USD (chỉ USD)'
    : mode === 'both' ? '💵 USD + 🇻🇳 VND (cả hai)'
    : '🇻🇳 VND (chỉ VND)';
  const text =
    `💱 CÀI ĐẶT TIỀN TỆ\n\n` +
    `Chế độ hiện tại: ${modeLabel}\n` +
    `Tỷ giá USD → VND: ${fmtVN(rate)}\n\n` +
    `• 🇻🇳 VND: chỉ hiển thị giá VNĐ.\n` +
    `• 💵 USD: chỉ hiển thị giá $ (tự quy đổi từ VND theo tỷ giá).\n` +
    `• 🔀 USD + VND: hiển thị $ kèm (~VNĐ) khắp nơi.\n` +
    `• SePay vẫn nhận VND như thường — số VND đã được nhúng trong mã QR, khách quét là tự động đúng.\n` +
    `• (Tùy chọn) Có thể đặt giá USD riêng cho từng phim trong CHI TIẾT → 💵 Giá USD để ghi đè quy đổi tự động.`;
  const keyboard = [
    [
      { text: mode === 'vnd'  ? '✅ 🇻🇳 VND'      : '🇻🇳 VND',      callback_data: 'adm_curr_set_vnd' },
      { text: mode === 'usd'  ? '✅ 💵 USD'       : '💵 USD',       callback_data: 'adm_curr_set_usd' },
      { text: mode === 'both' ? '✅ 🔀 Cả hai'    : '🔀 Cả hai',    callback_data: 'adm_curr_set_both' }
    ],
    [{ text: `✏️ Tỷ giá (${fmtVN(rate)})`, callback_data: 'adm_curr_rate' }],
    [{ text: '🔙 Quay lại', callback_data: 'adm_settings' }]
  ];
  await editOrSend(chatId, text, keyboard);
}

const bulkScopeState = new Map(); // chatId -> 'all'|'hot'|'cold'

function getBulkScope(chatId) {
  return bulkScopeState.get(chatId) || 'all';
}
function scopeLabel(s) {
  if (s === 'hot') return '🔥 Chỉ HOT';
  if (s === 'cold') return '📂 Không HOT';
  return '🌐 Tất cả';
}
function scopeCount(s) {
  const all = store.getAllProductsList().filter(p => p.active);
  if (s === 'hot') return all.filter(p => p.hot).length;
  if (s === 'cold') return all.filter(p => !p.hot).length;
  return all.length;
}

async function showBulkPrice(chatId) {
  clearState(chatId);
  const scope = getBulkScope(chatId);
  const cnt = scopeCount(scope);
  const text =
    `💱 CẬP NHẬT GIÁ HÀNG LOẠT\n\n` +
    `Phạm vi: ${scopeLabel(scope)}  (${cnt} phim)\n` +
    `• Khi giảm: tự lưu giá cũ vào "Giá gốc" để khách thấy strikethrough\n` +
    `• Khi tăng về ≥ giá gốc: tự xoá tag sale\n` +
    `• Giá làm tròn 1.000đ\n` +
    `• Có thể hoàn tác trong 8s`;
  const kb = [
    [
      { text: scope === 'all'  ? '✅ Tất cả'  : '🌐 Tất cả',  callback_data: 'adm_bks_all' },
      { text: scope === 'hot'  ? '✅ HOT'     : '🔥 HOT',     callback_data: 'adm_bks_hot' },
      { text: scope === 'cold' ? '✅ Không HOT' : '📂 Không HOT', callback_data: 'adm_bks_cold' }
    ],
    [
      { text: '−10%', callback_data: 'adm_bk_-10' },
      { text: '−20%', callback_data: 'adm_bk_-20' },
      { text: '−30%', callback_data: 'adm_bk_-30' }
    ],
    [
      { text: '+10%', callback_data: 'adm_bk_10' },
      { text: '+20%', callback_data: 'adm_bk_20' }
    ],
    [{ text: '↩ Khôi phục giá gốc', callback_data: 'adm_restore' }],
    [{ text: '📅 Lịch khuyến mãi', callback_data: 'adm_sales' }],
    [{ text: '🔙 Quay lại', callback_data: 'adm_settings' }]
  ];
  await editOrSend(chatId, text, kb);
}

async function applyBulkPrice(chatId, pct) {
  const scope = getBulkScope(chatId);
  const snapshot = await store.snapshotProductsForScope(scope);
  if (!snapshot.length) {
    return finishAdminUpdate(chatId, '⚠️ Không có sản phẩm trong phạm vi này', () => showBulkPrice(chatId));
  }
  const updated = await store.bulkUpdatePrices(pct, scope, true);
  if (!updated) {
    return finishAdminUpdate(chatId, '❌ Cập nhật thất bại (lỗi DB). Xem log.', () => showBulkPrice(chatId));
  }
  return finishAdminUpdateWithUndo(chatId,
    `✅ ${pct > 0 ? '+' : ''}${pct}% • ${scopeLabel(scope)} • ${updated} phim`,
    async () => { await store.applyPriceSnapshot(snapshot); },
    () => showBulkPrice(chatId));
}

async function applyRestoreOriginalPrices(chatId) {
  const scope = getBulkScope(chatId);
  const { count, snapshot } = await store.restoreOriginalPrices(scope);
  if (!count) {
    return finishAdminUpdate(chatId, '⚠️ Không có phim nào đang sale', () => showBulkPrice(chatId));
  }
  return finishAdminUpdateWithUndo(chatId,
    `↩ Đã khôi phục giá gốc cho ${count} phim (${scopeLabel(scope)})`,
    async () => { await store.applyPriceSnapshot(snapshot); },
    () => showBulkPrice(chatId));
}

// ----- scheduled sales -----

async function showScheduledSales(chatId) {
  clearState(chatId);
  const list = await store.listScheduledSales();
  let text = `📅 LỊCH KHUYẾN MÃI\n\n`;
  if (!list.length) {
    text += '(Chưa có lịch nào)\n\n';
  } else {
    for (const s of list) {
      const fmtT = (d) => new Date(d).toLocaleString('vi-VN', { hour12: false });
      const stage = s.applied_at ? '🟢 ĐANG CHẠY' : '⏳ CHỜ';
      text += `${stage} #${s.id} — ${s.pct >= 0 ? '+' : ''}${s.pct}% • ${scopeLabel(s.scope)}\n   ${fmtT(s.starts_at)} → ${fmtT(s.ends_at)}\n\n`;
    }
  }
  text += `💡 Cú pháp tạo:\n   <pct> <scope> <start> <end>\n   pct: -10..-90 hoặc 5..50\n   scope: all|hot|cold\n   thời gian: YYYY-MM-DD HH:MM\n\nVí dụ:\n   -20 all 2026-04-23 20:00 2026-04-24 23:59`;

  const kb = list.map(s => [{ text: `🗑 Huỷ lịch #${s.id}`, callback_data: `adm_sdel_${s.id}` }]);
  kb.push([{ text: '➕ Tạo lịch mới', callback_data: 'adm_sadd' }]);
  kb.push([{ text: '🔙 Quay lại', callback_data: 'adm_bulk' }]);
  await editOrSend(chatId, text, kb);
}

// ----- menu layout -----

async function showMenuLayout(chatId) {
  clearState(chatId);
  const cur = store.getText('menu_layout') || '2,2,2';
  const text =
    `🧩 BỐ CỤC MENU CHÍNH\n\n` +
    `Hiện tại: ${cur}\n\n` +
    `Có 6 nút: HOT, Tất cả, Phim của tôi, Điểm thưởng, VIP, Hỗ trợ.\n\n` +
    `Nhập dãy số (1-3) ngăn cách bằng dấu phẩy, mỗi số là số nút trên 1 hàng. Tổng phải bằng 6.\n\n` +
    `Ví dụ:\n• 2,2,2  (mặc định, 3 hàng × 2 cột)\n• 3,3    (2 hàng × 3 cột)\n• 1,2,2,1\n• 2,2,1,1`;
  adminState.set(chatId, { action: 'edit_menu_layout' });
  const kb = [
    [{ text: '↺ Mặc định 2,2,2', callback_data: 'adm_ml_def' }],
    [{ text: '🔙 Hủy', callback_data: 'adm_settings' }]
  ];
  await editOrSend(chatId, text, kb);
}

async function showCouponAdmin(chatId) {
  clearState(chatId);
  const list = await store.listCoupons();
  let text = `🎟 MÃ GIẢM GIÁ\n\n`;
  if (!list.length) {
    text += '(Chưa có mã nào)';
  } else {
    for (const c of list.slice(0, 30)) {
      const valStr = c.discount_type === 'percent' ? `${c.discount_value}%` : `${fmtVN(c.discount_value)}đ`;
      const max = c.max_uses && c.max_uses > 0 ? '/' + c.max_uses : '';
      text += `• ${c.code} — ${valStr}  (đã dùng ${c.used_count || 0}${max})\n`;
    }
  }
  const kb = list.slice(0, 30).map(c => [
    { text: `🗑 ${c.code}`, callback_data: `adm_cdel_${c.code}` }
  ]);
  kb.push([{ text: '➕ Tạo mã mới', callback_data: 'adm_cadd' }]);
  kb.push([{ text: '🔙 Quay lại', callback_data: 'adm_home' }]);
  await editOrSend(chatId, text, kb);
}

// ----- ban management -----

function fmtRemainHours(ms) {
  const totalMin = Math.max(1, Math.ceil(ms / 60000));
  const days = Math.floor(totalMin / 1440);
  const hrs  = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days) parts.push(`${days} ngày`);
  if (hrs)  parts.push(`${hrs}h`);
  if (mins && !days) parts.push(`${mins}p`);
  return parts.length ? parts.join(' ') : `${totalMin}p`;
}

async function showBans(chatId) {
  clearState(chatId);
  const list = await store.listActiveBans();
  let text = `🚫 CẤM USER\n\n`;
  if (!list.length) {
    text += '(Hiện không có user nào bị cấm)\n\n';
  } else {
    text += `Đang cấm: ${list.length} user\n\n`;
    for (const b of list.slice(0, 20)) {
      const remain = fmtRemainHours(b.bannedUntil - Date.now());
      const reason = b.reason ? ` — ${b.reason}` : '';
      text += `• ${b.chatId} (còn ${remain})${reason}\n`;
    }
    if (list.length > 20) text += `… và ${list.length - 20} user khác\n`;
    text += '\n';
  }
  text +=
    `💡 Cú pháp cấm:\n` +
    `   <id> [giờ] [lý do]\n` +
    `• Mặc định 24 giờ nếu không nhập.\n` +
    `• VD: 8646176401 48 spam tin nhắn\n` +
    `• VD: 8646176401   (cấm 24h, không lý do)`;

  adminState.set(chatId, { action: 'ban_user_input' });
  const kb = list.slice(0, 20).map(b => [
    { text: `🔓 Mở khoá ${b.chatId}`, callback_data: `adm_unban_${b.chatId}` }
  ]);
  kb.push([{ text: '🔙 Quay lại', callback_data: 'adm_home' }]);
  await editOrSend(chatId, text, kb);
}

async function handleUnban(chatId, targetId) {
  const ok = await store.unbanUser(targetId);
  if (!ok) {
    await toast(chatId, `⚠️ User ${targetId} không có trong danh sách bị cấm`, 4000);
    return showBans(chatId);
  }
  log.info(`Admin unbanned user ${targetId}`);
  return finishAdminUpdate(chatId, `🔓 Đã mở khoá user ${targetId}`, () => showBans(chatId));
}

async function toggleAdminNotify(chatId) {
  const current = store.getText('admin_notify_payment');
  const newVal = current === 'off' ? 'on' : 'off';
  await store.setText('admin_notify_payment', newVal);
  return showSettings(chatId);
}

async function getOrCreateVipProduct() {
  const vipId = store.getText('vip_product_id');
  if (vipId) {
    const existing = store.getProductById(parseInt(vipId));
    if (existing) return existing;
  }
  const product = await store.createProduct({
    name: 'Gói VIP',
    price: 0,
    link: '',
    description: '',
    hot: false
  });
  await store.updateProduct(product.id, { active: false });
  await store.setText('vip_product_id', String(product.id));
  return store.getProductById(product.id);
}

async function showVipDetail(chatId) {
  clearState(chatId);
  const vip = await getOrCreateVipProduct();

  const hasVideo = vip.videoFileId ? '✅' : '❌';
  const hasPreview = vip.previewFileId ? '✅' : '❌';
  const vipLink = store.getText('vip_invite_link');
  const linkStatus = vipLink ? '✅' : '❌';
  const desc = vip.description ? vip.description.slice(0, 100) : '(chưa có)';
  const priceDisplay = vip.price > 0 ? `${vip.price.toLocaleString()} VND` : '(chưa đặt)';

  const text =
    `👑 QUẢN LÝ GÓI VIP\n\n` +
    `📌 Tên: ${vip.name}\n` +
    `💰 Giá: ${priceDisplay}\n` +
    `📝 Mô tả: ${desc}\n` +
    `🎥 Video: ${hasVideo}\n` +
    `🖼 Ảnh: ${hasPreview}\n` +
    `🔗 Link nhóm: ${linkStatus}`;

  const keyboard = [
    [
      { text: '✏️ Tên', callback_data: 'adm_vn' },
      { text: '💰 Giá', callback_data: 'adm_vp' }
    ],
    [{ text: '📝 Mô tả', callback_data: 'adm_vd' }]
  ];

  const mediaRow = [];
  if (vip.videoFileId) {
    mediaRow.push({ text: '🎥 Xóa Video', callback_data: 'adm_vrv' });
  } else {
    mediaRow.push({ text: '🎥 Gán Video', callback_data: 'adm_vsv' });
  }
  if (vip.previewFileId) {
    mediaRow.push({ text: '🖼 Xóa Ảnh', callback_data: 'adm_vrp' });
  } else {
    mediaRow.push({ text: '🖼 Gán Ảnh', callback_data: 'adm_vsp' });
  }
  keyboard.push(mediaRow);

  if (vipLink) {
    keyboard.push([{ text: `🔗 Link nhóm: đã cài`, callback_data: 'adm_vip_link' }]);
  } else {
    keyboard.push([{ text: '🔗 Cài link nhóm VIP', callback_data: 'adm_vip_link' }]);
  }

  keyboard.push([{ text: '🔙 Quay lại', callback_data: 'adm_home' }]);

  await editOrSend(chatId, text, keyboard);
}

async function showMembershipAdmin(chatId) {
  clearState(chatId);
  const mediaFileId = store.getText('membership_media_file_id');
  const mediaType   = store.getText('membership_media_type');
  const price       = store.getText('membership_price') || '10000';
  const enabled     = (store.getText('membership_enabled') || 'on') === 'on';
  const gateLabel   = enabled ? '🚪 Gate: BẬT' : '🚪 Gate: TẮT';

  const mediaStatus = mediaFileId
    ? (mediaType === 'video' ? '🎥 Video đã gán' : '🖼 Ảnh đã gán')
    : '❌ Chưa có media';

  const text =
    `🎟 QUẢN LÝ MEMBERSHIP\n\n` +
    `${gateLabel}\n` +
    `💸 Phí tham gia: ${parseInt(price, 10).toLocaleString()} VNĐ\n` +
    `🖼 Media dashboard: ${mediaStatus}\n\n` +
    `Chọn hành động:`;

  const keyboard = [
    [{ text: gateLabel, callback_data: 'adm_mem_tgl_gate' }],
    [{ text: '🖼 Gán ảnh dashboard', callback_data: 'adm_mem_sp' }],
    [{ text: '🎥 Gán video dashboard', callback_data: 'adm_mem_sv' }],
  ];
  if (mediaFileId) {
    keyboard.push([{ text: '🗑 Xóa media dashboard', callback_data: 'adm_mem_rm' }]);
  }
  keyboard.push([{ text: '🔙 Quay lại', callback_data: 'adm_home' }]);

  await editOrSend(chatId, text, keyboard);
}

async function toggleMembershipGate(chatId) {
  const on = (store.getText('membership_enabled') || 'on') === 'on';
  await store.setText('membership_enabled', on ? 'off' : 'on');
  log.info(`Admin toggled membership gate → ${on ? 'OFF' : 'ON'}`);
  return showMembershipAdmin(chatId);
}

async function handleAdminCallback(chatId, data, messageId) {
  if (!isAdmin(chatId)) return false;
  if (!data.startsWith('adm_')) return false;

  if (data === 'adm_home') return showAdminHome(chatId);
  if (data === 'adm_membership') return showMembershipAdmin(chatId);
  if (data === 'adm_mem_tgl_gate') return toggleMembershipGate(chatId);
  if (data === 'adm_mem_sp') {
    adminState.set(chatId, { action: 'set_membership_photo' });
    return editOrSend(chatId, '🖼 GÁN ẢNH DASHBOARD MEMBERSHIP\n\nGửi ảnh bạn muốn hiển thị:', [[{ text: '❌ Hủy', callback_data: 'adm_membership' }]]);
  }
  if (data === 'adm_mem_sv') {
    adminState.set(chatId, { action: 'set_membership_video' });
    return editOrSend(chatId, '🎥 GÁN VIDEO DASHBOARD MEMBERSHIP\n\nGửi video bạn muốn hiển thị:', [[{ text: '❌ Hủy', callback_data: 'adm_membership' }]]);
  }
  if (data === 'adm_mem_rm') {
    await store.setText('membership_media_file_id', '');
    await store.setText('membership_media_type', '');
    return finishAdminUpdate(chatId, '✅ Đã xóa media dashboard membership', () => showMembershipAdmin(chatId));
  }
  if (data === 'adm_dash') return showDashboard(chatId);
  if (data === 'adm_movies') return showMoviesList(chatId);
  if (data === 'adm_texts') return showTexts(chatId);
  if (data === 'adm_orders') return showOrders(chatId);
  if (data === 'adm_settings') return showSettings(chatId);
  if (data === 'adm_coupons') return showCouponAdmin(chatId);
  if (data === 'adm_bans') return showBans(chatId);
  if (data.startsWith('adm_unban_')) {
    const targetId = parseInt(data.replace('adm_unban_', ''), 10);
    if (!targetId) { await toast(chatId, '❌ ID không hợp lệ'); return showBans(chatId); }
    return handleUnban(chatId, targetId);
  }
  if (data === 'adm_bulk') return showBulkPrice(chatId);
  if (data === 'adm_restore') return applyRestoreOriginalPrices(chatId);
  if (data === 'adm_sales') return showScheduledSales(chatId);
  if (data === 'adm_menulayout') return showMenuLayout(chatId);

  if (data === 'adm_ml_def') {
    await store.setText('menu_layout', '2,2,2');
    clearState(chatId);
    return finishAdminUpdate(chatId, '✅ Đã đặt bố cục mặc định: 2,2,2', () => showSettings(chatId));
  }

  if (data.startsWith('adm_bks_')) {
    const sc = data.replace('adm_bks_', '');
    if (['all', 'hot', 'cold'].includes(sc)) bulkScopeState.set(chatId, sc);
    return showBulkPrice(chatId);
  }

  if (data.startsWith('adm_bk_')) {
    const pct = parseInt(data.replace('adm_bk_', ''));
    if (!Number.isFinite(pct) || pct === 0) return showBulkPrice(chatId);
    return applyBulkPrice(chatId, pct);
  }

  if (data === 'adm_sadd') {
    adminState.set(chatId, { action: 'sale_create' });
    const text =
      `➕ TẠO LỊCH KHUYẾN MÃI\n\n` +
      `Cú pháp:\n  <pct> <scope> <YYYY-MM-DD HH:MM> <YYYY-MM-DD HH:MM>\n\n` +
      `pct: -90..-1 (giảm) hoặc 1..50 (tăng)\nscope: all | hot | cold\n\n` +
      `Ví dụ:\n  -20 all 2026-04-23 20:00 2026-04-24 23:59\n  -30 hot 2026-05-01 00:00 2026-05-03 23:59`;
    const kb = [[{ text: '❌ Hủy', callback_data: 'adm_sales' }]];
    return editOrSend(chatId, text, kb);
  }

  if (data.startsWith('adm_sdel_')) {
    const id = parseInt(data.replace('adm_sdel_', ''));
    const ok = await store.deleteScheduledSale(id);
    return finishAdminUpdate(chatId,
      ok ? `🗑 Đã huỷ lịch #${id}` : '❌ Không huỷ được',
      () => showScheduledSales(chatId));
  }

  if (data === 'adm_cadd') {
    adminState.set(chatId, { action: 'coupon_create' });
    const text =
      `➕ TẠO MÃ GIẢM GIÁ\n\n` +
      `Cú pháp:\n  CODE percent 10\n  CODE fixed 50000 [maxUses]\n\n` +
      `Ví dụ:\n  SUMMER10 percent 10\n  WELCOME fixed 20000 100`;
    const kb = [[{ text: '❌ Hủy', callback_data: 'adm_coupons' }]];
    return editOrSend(chatId, text, kb);
  }

  if (data.startsWith('adm_cdel_')) {
    const code = data.replace('adm_cdel_', '');
    const existing = await store.getCoupon(code);
    await store.deleteCoupon(code);
    return finishAdminUpdateWithUndo(chatId,
      `🗑 Đã xoá mã: ${code}`,
      async () => {
        if (existing) {
          await store.createCoupon({
            code: existing.code,
            discountType: existing.discount_type,
            discountValue: existing.discount_value,
            maxUses: existing.max_uses,
            expiresAt: existing.expires_at
          });
        }
      },
      () => showCouponAdmin(chatId));
  }
  if (data === 'adm_tgl_notify') return toggleAdminNotify(chatId);
  if (data === 'adm_tgl_promo_x2') return togglePromoX2(chatId);
  if (data === 'adm_set_promo_min') return promptPromoMin(chatId);
  if (data === 'adm_vip') return showVipDetail(chatId);
  if (data === 'adm_vn') {
    const vip = await getOrCreateVipProduct();
    adminState.set(chatId, { action: 'edit_name', productId: vip.id });
    const text = `✏️ SỬA TÊN VIP\n\nTên hiện tại: ${vip.name}\n\nNhập tên mới:`;
    return editOrSend(chatId, text, [[{ text: '❌ Hủy', callback_data: 'adm_vip' }]]);
  }
  if (data === 'adm_vp') {
    const vip = await getOrCreateVipProduct();
    adminState.set(chatId, { action: 'edit_price', productId: vip.id });
    const text = `💰 SỬA GIÁ VIP\n\nGiá hiện tại: ${vip.price > 0 ? vip.price.toLocaleString() + ' VND' : '(chưa đặt)'}\n\nNhập giá mới (VND):`;
    return editOrSend(chatId, text, [[{ text: '❌ Hủy', callback_data: 'adm_vip' }]]);
  }
  if (data === 'adm_vd') {
    const vip = await getOrCreateVipProduct();
    adminState.set(chatId, { action: 'edit_desc', productId: vip.id });
    const text = `📝 SỬA MÔ TẢ VIP\n\nMô tả hiện tại:\n${vip.description || '(chưa có)'}\n\nNhập mô tả mới:`;
    return editOrSend(chatId, text, [[{ text: '❌ Hủy', callback_data: 'adm_vip' }]]);
  }
  if (data === 'adm_vsv') {
    const vip = await getOrCreateVipProduct();
    adminState.set(chatId, { action: 'set_video', productId: vip.id });
    const text = `🎥 GÁN VIDEO VIP\n\nGửi video preview cho gói VIP:`;
    return editOrSend(chatId, text, [[{ text: '❌ Hủy', callback_data: 'adm_vip' }]]);
  }
  if (data === 'adm_vsp') {
    const vip = await getOrCreateVipProduct();
    adminState.set(chatId, { action: 'set_preview', productId: vip.id });
    const text = `🖼 GÁN ẢNH VIP\n\nGửi ảnh preview cho gói VIP:`;
    return editOrSend(chatId, text, [[{ text: '❌ Hủy', callback_data: 'adm_vip' }]]);
  }
  if (data === 'adm_vrv') {
    const vip = await getOrCreateVipProduct();
    await store.removeProductMedia(vip.id, 'video');
    return showVipDetail(chatId);
  }
  if (data === 'adm_vrp') {
    const vip = await getOrCreateVipProduct();
    await store.removeProductMedia(vip.id, 'preview');
    return showVipDetail(chatId);
  }
  if (data === 'adm_vip_link') {
    adminState.set(chatId, { action: 'waiting_vip_link' });
    const currentLink = store.getText('vip_invite_link');
    let text = '🔗 LINK NHÓM VIP\n\n';
    if (currentLink) {
      text += `Link hiện tại: ${currentLink}\n\n`;
    }
    text += 'Gửi link mời nhóm Telegram (vd: https://t.me/+xxxxx):';
    const kb = [];
    if (currentLink) {
      kb.push([{ text: '❌ Xóa link', callback_data: 'adm_vip_link_clear' }]);
    }
    kb.push([{ text: '🔙 Quay lại', callback_data: 'adm_vip' }]);
    return editOrSend(chatId, text, kb);
  }
  if (data === 'adm_vip_link_clear') {
    await store.setText('vip_invite_link', '');
    return showVipDetail(chatId);
  }

  if (data === 'adm_close') {
    clearState(chatId);
    if (adminMsgId[chatId]) {
      await bot.deleteMessage(chatId, adminMsgId[chatId]).catch(() => {});
      delete adminMsgId[chatId];
    }
    return;
  }

  if (data === 'adm_stt') return showPeriodStats(chatId, 1, 'hôm nay');
  if (data === 'adm_st7') return showPeriodStats(chatId, 7, '7 ngày qua');
  if (data === 'adm_s30') return showPeriodStats(chatId, 30, '30 ngày qua');
  if (data === 'adm_stp') return showTopProducts(chatId);
  if (data === 'adm_stb') return showSalesByProduct(chatId);

  if (data.startsWith('adm_mp_')) {
    const page = parseInt(data.replace('adm_mp_', ''));
    return showMoviesList(chatId, page);
  }

  if (data.startsWith('adm_mov_')) {
    const id = parseInt(data.replace('adm_mov_', ''));
    return showMovieDetail(chatId, id);
  }

  if (data === 'adm_add') {
    adminState.set(chatId, { action: 'add_name' });
    const text = '➕ THÊM PHIM MỚI\n\nNhập tên phim:';
    const keyboard = [[{ text: '❌ Hủy', callback_data: 'adm_movies' }]];
    return editOrSend(chatId, text, keyboard);
  }

  if (data.startsWith('adm_en_')) {
    const id = parseInt(data.replace('adm_en_', ''));
    const p = store.getProductById(id);
    if (!p) return showMoviesList(chatId);
    adminState.set(chatId, { action: 'edit_name', productId: id });
    const text = `✏️ SỬA TÊN\n\nTên hiện tại: ${p.name}\n\nNhập tên mới:`;
    const keyboard = [[{ text: '❌ Hủy', callback_data: `adm_mov_${id}` }]];
    return editOrSend(chatId, text, keyboard);
  }

  if (data.startsWith('adm_ep_')) {
    const id = parseInt(data.replace('adm_ep_', ''));
    const p = store.getProductById(id);
    if (!p) return showMoviesList(chatId);
    adminState.set(chatId, { action: 'edit_price', productId: id });
    const text = `💰 SỬA GIÁ\n\nGiá hiện tại: ${fmtVN(p.price)} VND\n\nNhập giá mới (số nguyên, VND):`;
    const keyboard = [[{ text: '❌ Hủy', callback_data: `adm_mov_${id}` }]];
    return editOrSend(chatId, text, keyboard);
  }

  if (data.startsWith('adm_eu_')) {
    const id = parseInt(data.replace('adm_eu_', ''));
    const p = store.getProductById(id);
    if (!p) return showMoviesList(chatId);
    adminState.set(chatId, { action: 'edit_price_usd', productId: id });
    const cur = (p.priceUsd && p.priceUsd > 0) ? `$${p.priceUsd.toFixed(2)}` : '(chưa đặt)';
    const text = `💵 SỬA GIÁ USD\n\nGiá USD hiện tại: ${cur}\nGiá VND: ${fmtVN(p.price)} VND\n\nNhập giá USD mới (vd: 9.99) hoặc gõ "0" để xoá:`;
    const keyboard = [[{ text: '❌ Hủy', callback_data: `adm_mov_${id}` }]];
    return editOrSend(chatId, text, keyboard);
  }

  if (data === 'adm_curr') return showCurrencySettings(chatId);

  if (data === 'adm_curr_set_vnd' || data === 'adm_curr_set_usd' || data === 'adm_curr_set_both') {
    const next = data.replace('adm_curr_set_', '');
    await store.setText('currency_mode', next);
    return showCurrencySettings(chatId);
  }

  if (data === 'adm_curr_rate') {
    const rate = parseFloat(store.getText('usd_to_vnd_rate') || '25500') || 25500;
    adminState.set(chatId, { action: 'edit_usd_rate' });
    const text = `✏️ TỶ GIÁ USD → VND\n\nTỷ giá hiện tại: ${fmtVN(rate)}\n\nNhập tỷ giá mới (số nguyên, vd: 25500):`;
    const keyboard = [[{ text: '❌ Hủy', callback_data: 'adm_curr' }]];
    return editOrSend(chatId, text, keyboard);
  }

  if (data.startsWith('adm_eop_')) {
    const id = parseInt(data.replace('adm_eop_', ''));
    const p = store.getProductById(id);
    if (!p) return showMoviesList(chatId);
    adminState.set(chatId, { action: 'edit_orig_price', productId: id });
    const cur = p.originalPrice ? `${fmtVN(p.originalPrice)} VND` : '(chưa đặt)';
    const text = `🏷 SỬA GIÁ GỐC\n\nGiá gốc hiện tại: ${cur}\nGiá bán: ${fmtVN(p.price)} VND\n\nNhập giá gốc mới (lớn hơn giá bán) hoặc gõ "0" để xoá:`;
    const keyboard = [[{ text: '❌ Hủy', callback_data: `adm_mov_${id}` }]];
    return editOrSend(chatId, text, keyboard);
  }

  if (data.startsWith('adm_dcok_')) {
    const id = parseInt(data.replace('adm_dcok_', ''));
    const state = adminState.get(chatId);
    if (!state || state.action !== 'edit_desc_confirm' || state.productId !== id) {
      return showMovieDetail(chatId, id);
    }
    const prev = store.getProductById(id);
    const oldDesc = prev ? prev.description : null;
    const oldEnt = prev ? prev.descriptionEntities : null;
    await store.updateProduct(id, {
      description: state.pendingDesc,
      descriptionEntities: state.pendingEntities ? JSON.stringify(state.pendingEntities) : null
    });
    if (state.previewMsgId) bot.deleteMessage(chatId, state.previewMsgId).catch(() => {});
    clearState(chatId);
    return finishAdminUpdateWithUndo(chatId, '✅ Đã cập nhật mô tả',
      async () => { await store.updateProduct(id, { description: oldDesc, descriptionEntities: oldEnt ? JSON.stringify(oldEnt) : null }); },
      () => showMovieDetail(chatId, id));
  }

  if (data.startsWith('adm_emv_')) {
    const id = parseInt(data.replace('adm_emv_', ''));
    const state = adminState.get(chatId);
    if (state && state.previewMsgId) bot.deleteMessage(chatId, state.previewMsgId).catch(() => {});
    clearState(chatId);
    return showMovieDetail(chatId, id);
  }

  if (data.startsWith('adm_ed_')) {
    const id = parseInt(data.replace('adm_ed_', ''));
    const p = store.getProductById(id);
    if (!p) return showMoviesList(chatId);
    adminState.set(chatId, { action: 'edit_desc', productId: id });
    const text = `📝 SỬA MÔ TẢ\n\nMô tả hiện tại:\n${p.description || '(chưa có)'}\n\nNhập mô tả mới:`;
    const keyboard = [[{ text: '❌ Hủy', callback_data: `adm_mov_${id}` }]];
    return editOrSend(chatId, text, keyboard);
  }

  if (data.startsWith('adm_th_')) {
    const id = parseInt(data.replace('adm_th_', ''));
    const p = store.getProductById(id);
    if (!p) return showMoviesList(chatId);
    await store.updateProduct(id, { hot: !p.hot });
    return showMovieDetail(chatId, id);
  }

  if (data.startsWith('adm_ta_')) {
    const id = parseInt(data.replace('adm_ta_', ''));
    const p = store.getProductById(id);
    if (!p) return showMoviesList(chatId);
    await store.updateProduct(id, { active: !p.active });
    return showMovieDetail(chatId, id);
  }

  if (data.startsWith('adm_sv_')) {
    const id = parseInt(data.replace('adm_sv_', ''));
    const p = store.getProductById(id);
    if (!p) return showMoviesList(chatId);
    adminState.set(chatId, { action: 'set_video', productId: id });
    const text = `🎥 GÁN VIDEO\n\n📌 Sản phẩm: ${p.name}\n\nGửi video cho sản phẩm này:`;
    const keyboard = [[{ text: '❌ Hủy', callback_data: `adm_mov_${id}` }]];
    return editOrSend(chatId, text, keyboard);
  }

  if (data.startsWith('adm_sp_')) {
    const id = parseInt(data.replace('adm_sp_', ''));
    const p = store.getProductById(id);
    if (!p) return showMoviesList(chatId);
    adminState.set(chatId, { action: 'set_preview', productId: id });
    const text = `🖼 GÁN ẢNH PREVIEW\n\n📌 Sản phẩm: ${p.name}\n\nGửi ảnh preview cho sản phẩm này:`;
    const keyboard = [[{ text: '❌ Hủy', callback_data: `adm_mov_${id}` }]];
    return editOrSend(chatId, text, keyboard);
  }

  if (data.startsWith('adm_rv_')) {
    const id = parseInt(data.replace('adm_rv_', ''));
    await store.removeProductMedia(id, 'video');
    return showMovieDetail(chatId, id);
  }

  if (data.startsWith('adm_rp_')) {
    const id = parseInt(data.replace('adm_rp_', ''));
    await store.removeProductMedia(id, 'preview');
    return showMovieDetail(chatId, id);
  }

  if (data.startsWith('adm_mu_')) {
    const id = parseInt(data.replace('adm_mu_', ''));
    await store.reorderProduct(id, 'up');
    return showMovieDetail(chatId, id);
  }

  if (data.startsWith('adm_md_')) {
    const id = parseInt(data.replace('adm_md_', ''));
    await store.reorderProduct(id, 'down');
    return showMovieDetail(chatId, id);
  }

  if (data.startsWith('adm_dlv_')) {
    const id = parseInt(data.replace('adm_dlv_', ''));
    return showDeliveryDetail(chatId, id);
  }

  if (data.startsWith('adm_dld_')) {
    const id = parseInt(data.replace('adm_dld_', ''));
    const p = store.getProductById(id);
    if (!p) return showMoviesList(chatId);
    adminState.set(chatId, { action: 'edit_delivery_desc', productId: id });
    const text = `📝 SỬA MÔ TẢ GIAO HÀNG\n\nMô tả hiện tại:\n${p.deliveryDescription || '(chưa có)'}\n\nNhập mô tả mới:`;
    const keyboard = [[{ text: '❌ Hủy', callback_data: `adm_dlv_${id}` }]];
    return editOrSend(chatId, text, keyboard);
  }

  if (data.startsWith('adm_dlap_')) {
    const id = parseInt(data.replace('adm_dlap_', ''));
    const p = store.getProductById(id);
    if (!p) return showMoviesList(chatId);
    adminState.set(chatId, { action: 'add_delivery_photo', productId: id });
    const text = `📷 THÊM ẢNH GIAO HÀNG\n\n📌 Sản phẩm: ${p.name}\n\nGửi ảnh cho nội dung giao hàng:`;
    const keyboard = [[{ text: '❌ Hủy', callback_data: `adm_dlv_${id}` }]];
    return editOrSend(chatId, text, keyboard);
  }

  if (data.startsWith('adm_dlav_')) {
    const id = parseInt(data.replace('adm_dlav_', ''));
    const p = store.getProductById(id);
    if (!p) return showMoviesList(chatId);
    adminState.set(chatId, { action: 'add_delivery_video', productId: id });
    const text = `🎥 THÊM VIDEO GIAO HÀNG\n\n📌 Sản phẩm: ${p.name}\n\nGửi video cho nội dung giao hàng:`;
    const keyboard = [[{ text: '❌ Hủy', callback_data: `adm_dlv_${id}` }]];
    return editOrSend(chatId, text, keyboard);
  }

  if (data.startsWith('adm_dlrm_')) {
    const parts = data.replace('adm_dlrm_', '').split('_');
    const mediaId = parseInt(parts[0]);
    const productId = parseInt(parts[1]);
    await store.removeDeliveryMedia(mediaId);
    return finishAdminUpdate(chatId, '✅ Đã xóa media', () => showDeliveryDetail(chatId, productId));
  }

  if (data.startsWith('adm_del_')) {
    const id = parseInt(data.replace('adm_del_', ''));
    const p = store.getProductById(id);
    if (!p) return showMoviesList(chatId);
    const text = `🗑 XÓA SẢN PHẨM\n\n⚠️ Bạn chắc chắn muốn xóa "${p.name}"?\n\nHành động này không thể hoàn tác!`;
    const keyboard = [
      [{ text: '✅ Xác nhận xóa', callback_data: `adm_cfd_${id}` }],
      [{ text: '❌ Hủy', callback_data: `adm_mov_${id}` }]
    ];
    return editOrSend(chatId, text, keyboard);
  }

  if (data.startsWith('adm_cfd_')) {
    const id = parseInt(data.replace('adm_cfd_', ''));
    const p = store.getProductById(id);
    const name = p ? p.name : `#${id}`;
    const activeOrders = await store.getActiveOrders();
    const hasOrders = activeOrders.some(o => String(o.product_id) === String(id));
    if (hasOrders) {
      await toast(chatId, `❌ Không thể xóa "${name}" — còn đơn hàng chưa xử lý.\n\n💡 Hãy tắt hiển thị thay vì xóa.`, 6000);
      return showMovieDetail(chatId, id);
    }
    await store.deleteProduct(id);
    log.info(`Admin deleted product: ${name} (ID: ${id})`);
    return finishAdminUpdate(chatId, `✅ Đã xóa sản phẩm: ${name}`, () => showMoviesList(chatId));
  }

  if (data.startsWith('adm_tx_')) {
    const key = data.replace('adm_tx_', '');
    const label = TEXT_LABELS[key] || key;
    const current = store.getText(key) || '(trống)';
    adminState.set(chatId, { action: 'edit_text', key });
    const text = `✏️ SỬA NỘI DUNG\n\n📌 ${label}\n\nGiá trị hiện tại:\n"${current}"\n\nNhập nội dung mới:`;
    const keyboard = [[{ text: '❌ Hủy', callback_data: 'adm_texts' }]];
    return editOrSend(chatId, text, keyboard);
  }

  if (data.startsWith('adm_oc_')) {
    const code = data.replace('adm_oc_', '');
    return handleConfirmOrder(chatId, code);
  }

  if (data === 'adm_cancel') {
    clearState(chatId);
    return showAdminHome(chatId);
  }

  return false;
}

async function handleAdminText(chatId, msg) {
  const state = adminState.get(chatId);
  if (!state) return false;

  const text = msg.text || '';

  if (state.action === 'waiting_vip_link') {
    const link = text.trim();
    if (!link.startsWith('https://t.me/') && !link.startsWith('https://telegram.me/') && !link.startsWith('t.me/')) {
      await toast(chatId, '❌ Link không hợp lệ. Gửi link Telegram (vd: https://t.me/+xxxxx)', 5000);
      return true;
    }
    const fullLink = link.startsWith('https://') ? link : `https://${link}`;
    await store.setText('vip_invite_link', fullLink);
    clearState(chatId);
    return finishAdminUpdate(chatId, `✅ Đã cập nhật link nhóm VIP!`, () => showVipDetail(chatId));
  }

  if (state.action === 'add_name') {
    const name = text.trim();
    if (!name || name.length > 200) {
      await toast(chatId, '❌ Tên không hợp lệ (1-200 ký tự)');
      return true;
    }
    adminState.set(chatId, { action: 'add_price', temp: { name } });
    const reply = `✅ Tên: ${name}\n\n💰 Nhập giá (VND):`;
    const keyboard = [[{ text: '❌ Hủy', callback_data: 'adm_movies' }]];
    await repositionAdminPanel(chatId);
    await editOrSend(chatId, reply, keyboard);
    return true;
  }

  if (state.action === 'add_price') {
    const price = parseInt(text.replace(/[^0-9]/g, ''));
    if (!price || price <= 0 || price > 100000000) {
      await toast(chatId, '❌ Giá không hợp lệ (1 - 100,000,000 VND)');
      return true;
    }
    const product = await store.createProduct({
      name: state.temp.name,
      price,
      link: '',
      description: '',
      hot: false
    });
    clearState(chatId);
    log.info(`Admin created product: ${product.name} (ID: ${product.id})`);
    return finishAdminUpdate(chatId,
      `✅ Đã tạo sản phẩm: ${product.name}\n💰 ${product.price.toLocaleString()} VND`,
      () => showMovieDetail(chatId, product.id));
  }

  if (state.action === 'edit_name') {
    const name = text.trim();
    if (!name || name.length > 200) {
      await toast(chatId, '❌ Tên không hợp lệ (1-200 ký tự)');
      return true;
    }
    const prev = store.getProductById(state.productId);
    const oldName = prev ? prev.name : null;
    await store.updateProduct(state.productId, { name });
    const isVip = String(state.productId) === store.getText('vip_product_id');
    clearState(chatId);
    return finishAdminUpdateWithUndo(chatId,
      `✅ Đã cập nhật tên: ${name}`,
      async () => { if (oldName != null) await store.updateProduct(state.productId, { name: oldName }); },
      () => isVip ? showVipDetail(chatId) : showMovieDetail(chatId, state.productId));
  }

  if (state.action === 'edit_price') {
    const price = parseInt(text.replace(/[^0-9]/g, ''));
    if (!price || price <= 0 || price > 100000000) {
      await toast(chatId, '❌ Giá không hợp lệ (1 - 100,000,000 VND)');
      return true;
    }
    const prev = store.getProductById(state.productId);
    const oldPrice = prev ? prev.price : null;
    await store.updateProduct(state.productId, { price });
    const isVip = String(state.productId) === store.getText('vip_product_id');
    clearState(chatId);
    return finishAdminUpdateWithUndo(chatId,
      `✅ Đã cập nhật giá: ${fmtVN(price)} VND`,
      async () => { if (oldPrice != null) await store.updateProduct(state.productId, { price: oldPrice }); },
      () => isVip ? showVipDetail(chatId) : showMovieDetail(chatId, state.productId));
  }

  if (state.action === 'edit_orig_price') {
    const v = text.trim();
    let originalPrice = null;
    if (v && v !== '0' && v !== '-') {
      originalPrice = parseInt(v.replace(/[^0-9]/g, ''));
      if (!originalPrice || originalPrice <= 0 || originalPrice > 100000000) {
        await toast(chatId, '❌ Giá không hợp lệ. Gõ "0" để xoá giá gốc.');
        return true;
      }
    }
    const prev = store.getProductById(state.productId);
    const oldOrig = prev ? prev.originalPrice : null;
    await store.updateProduct(state.productId, { originalPrice });
    clearState(chatId);
    return finishAdminUpdateWithUndo(chatId,
      originalPrice ? `✅ Đã đặt giá gốc: ${fmtVN(originalPrice)} VND` : `✅ Đã xoá giá gốc`,
      async () => { await store.updateProduct(state.productId, { originalPrice: oldOrig }); },
      () => showMovieDetail(chatId, state.productId));
  }

  if (state.action === 'edit_price_usd') {
    const v = text.trim().replace(',', '.');
    let priceUsd = 0;
    if (v && v !== '0') {
      priceUsd = parseFloat(v.replace(/[^0-9.]/g, ''));
      if (!priceUsd || priceUsd <= 0 || priceUsd > 100000) {
        await toast(chatId, '❌ Giá USD không hợp lệ (0.01 - 100000). Gõ "0" để xoá.');
        return true;
      }
      priceUsd = Math.round(priceUsd * 100) / 100;
    }
    const prev = store.getProductById(state.productId);
    const oldUsd = prev ? prev.priceUsd : 0;
    await store.updateProduct(state.productId, { priceUsd });
    clearState(chatId);
    return finishAdminUpdateWithUndo(chatId,
      priceUsd ? `✅ Đã đặt giá USD: $${priceUsd.toFixed(2)}` : `✅ Đã xoá giá USD`,
      async () => { await store.updateProduct(state.productId, { priceUsd: oldUsd || 0 }); },
      () => showMovieDetail(chatId, state.productId));
  }

  if (state.action === 'edit_usd_rate') {
    const rate = parseInt(text.replace(/[^0-9]/g, ''));
    if (!rate || rate < 1000 || rate > 1000000) {
      await toast(chatId, '❌ Tỷ giá không hợp lệ (1.000 - 1.000.000)');
      return true;
    }
    const oldRate = store.getText('usd_to_vnd_rate') || '25500';
    await store.setText('usd_to_vnd_rate', String(rate));
    clearState(chatId);
    return finishAdminUpdateWithUndo(chatId,
      `✅ Đã đặt tỷ giá: ${fmtVN(rate)}`,
      async () => { await store.setText('usd_to_vnd_rate', oldRate); },
      () => showCurrencySettings(chatId));
  }

  if (state.action === 'edit_desc') {
    const description = text;
    const descriptionEntities = extractEntities(msg);
    adminState.set(chatId, {
      action: 'edit_desc_confirm',
      productId: state.productId,
      pendingDesc: description,
      pendingEntities: descriptionEntities
    });
    const previewKb = [[
      { text: '✅ Lưu', callback_data: `adm_dcok_${state.productId}` },
      { text: '✏️ Sửa lại', callback_data: `adm_ed_${state.productId}` },
      { text: '❌ Huỷ', callback_data: `adm_emv_${state.productId}` }
    ]];
    const previewPrefix = `👀 XEM TRƯỚC MÔ TẢ:\n\n`;
    const shift = previewPrefix.length;
    const previewEntities = descriptionEntities
      ? descriptionEntities.map(e => ({ ...e, offset: e.offset + shift }))
      : null;
    let sent = await bot.sendMessage(chatId,
      previewPrefix + description,
      { reply_markup: { inline_keyboard: previewKb }, entities: previewEntities || undefined }
    ).catch(err => { log.error('Desc preview send error:', err && err.message); return null; });
    // Fallback: nếu entities lỗi → gửi lại dạng plain để admin vẫn xem được & bấm Lưu
    if (!sent && previewEntities) {
      sent = await bot.sendMessage(chatId,
        previewPrefix + description + `\n\n⚠️ (Định dạng sẽ được lưu nguyên gốc, chỉ phần xem trước hiện thị thuần text)`,
        { reply_markup: { inline_keyboard: previewKb } }
      ).catch(() => null);
    }
    if (sent) {
      const cur = adminState.get(chatId) || {};
      cur.previewMsgId = sent.message_id;
      adminState.set(chatId, cur);
    } else {
      await toast(chatId, '❌ Không gửi được xem trước. Vui lòng thử lại.', 5000);
    }
    return true;
  }

  if (state.action === 'edit_delivery_desc') {
    const deliveryDescription = text;
    const deliveryDescriptionEntities = extractEntities(msg);
    await store.updateProduct(state.productId, {
      deliveryDescription,
      deliveryDescriptionEntities: deliveryDescriptionEntities ? JSON.stringify(deliveryDescriptionEntities) : null
    });
    clearState(chatId);
    return finishAdminUpdate(chatId, `✅ Đã cập nhật mô tả giao hàng`,
      () => showDeliveryDetail(chatId, state.productId));
  }

  if (state.action === 'edit_menu_layout') {
    const raw = text.trim();
    const parts = raw.split(/[,\s]+/).map(n => parseInt(n));
    if (parts.some(n => !Number.isFinite(n) || n < 1 || n > 3)) {
      await toast(chatId, '❌ Mỗi số phải từ 1 đến 3');
      return true;
    }
    const sum = parts.reduce((a, b) => a + b, 0);
    if (sum !== 6) {
      await toast(chatId, `❌ Tổng các số phải bằng 6 (hiện: ${sum})`);
      return true;
    }
    const normalized = parts.join(',');
    const prev = store.getText('menu_layout') || '2,2,2';
    await store.setText('menu_layout', normalized);
    clearState(chatId);
    return finishAdminUpdateWithUndo(chatId,
      `✅ Đã đặt bố cục: ${normalized}`,
      async () => { await store.setText('menu_layout', prev); },
      () => showSettings(chatId));
  }

  if (state.action === 'edit_promo_min') {
    const raw = text.trim().replace(/[^\d]/g, '');
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1000) {
      await toast(chatId, '❌ Nhập số ≥ 1.000 (đơn vị VND, không có dấu)');
      return true;
    }
    const prev = store.getTopupPromoMin();
    await store.setText('promo_x2_min_amount', String(n));
    clearState(chatId);
    return finishAdminUpdateWithUndo(chatId,
      `✅ Đã đặt ngưỡng KM x2: ${fmtVN(n)}đ`,
      async () => { await store.setText('promo_x2_min_amount', String(prev)); },
      () => showSettings(chatId));
  }

  if (state.action === 'sale_create') {
    const m = text.trim().match(/^(-?\d+)\s+(all|hot|cold)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})$/i);
    if (!m) {
      await toast(chatId, '❌ Sai cú pháp. Xem ví dụ ở màn hình trước.');
      return true;
    }
    const pct = parseInt(m[1]);
    const scope = m[2].toLowerCase();
    const startsAt = new Date(m[3].replace(' ', 'T') + ':00');
    const endsAt = new Date(m[4].replace(' ', 'T') + ':00');
    if (!Number.isFinite(pct) || pct === 0 || pct < -90 || pct > 50) {
      await toast(chatId, '❌ % không hợp lệ (-90..-1 hoặc 1..50)');
      return true;
    }
    if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime())) {
      await toast(chatId, '❌ Thời gian không hợp lệ');
      return true;
    }
    if (endsAt <= startsAt) {
      await toast(chatId, '❌ Giờ kết thúc phải sau giờ bắt đầu');
      return true;
    }
    const id = await store.createScheduledSale({ pct, scope, startsAt, endsAt });
    clearState(chatId);
    if (!id) {
      return finishAdminUpdate(chatId, '❌ Không tạo được lịch (lỗi DB)', () => showScheduledSales(chatId));
    }
    return finishAdminUpdateWithUndo(chatId,
      `✅ Đã tạo lịch #${id}`,
      async () => { await store.deleteScheduledSale(id); },
      () => showScheduledSales(chatId));
  }

  if (state.action === 'coupon_create') {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) {
      await toast(chatId, '❌ Cú pháp sai. Ví dụ: SUMMER10 percent 10');
      return true;
    }
    const code = parts[0].toUpperCase();
    const type = parts[1].toLowerCase();
    const value = parseInt(parts[2].replace(/[^0-9]/g, ''));
    const maxUses = parts[3] ? parseInt(parts[3]) : null;
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
      await toast(chatId, '❌ Mã không hợp lệ (3-32 ký tự A-Z 0-9 _ -)');
      return true;
    }
    if (type !== 'percent' && type !== 'fixed') {
      await toast(chatId, '❌ Loại phải là "percent" hoặc "fixed"');
      return true;
    }
    if (!value || value <= 0 || (type === 'percent' && value > 90)) {
      await toast(chatId, '❌ Giá trị không hợp lệ');
      return true;
    }
    const existed = await store.getCoupon(code);
    if (existed) {
      await toast(chatId, '❌ Mã đã tồn tại');
      return true;
    }
    const ok = await store.createCoupon({
      code, discountType: type, discountValue: value, maxUses, expiresAt: null
    });
    clearState(chatId);
    if (!ok) {
      return finishAdminUpdate(chatId, '❌ Không tạo được mã (lỗi DB)', () => showCouponAdmin(chatId));
    }
    return finishAdminUpdateWithUndo(chatId,
      `✅ Đã tạo mã: ${code}`,
      async () => { await store.deleteCoupon(code); },
      () => showCouponAdmin(chatId));
  }

  if (state.action === 'ban_user_input') {
    const parts = text.trim().split(/\s+/);
    const targetId = parseInt(parts[0], 10);
    if (!targetId || targetId <= 0) {
      await toast(chatId, '❌ ID không hợp lệ. Nhập số ID Telegram của user.', 5000);
      return true;
    }
    if (String(targetId) === String(ADMIN_CHAT_ID)) {
      await toast(chatId, '❌ Không thể tự cấm chính mình.', 5000);
      return true;
    }
    let hours = 24;
    let reason = '';
    if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
      hours = Math.max(1, Math.min(24 * 365, parseInt(parts[1], 10)));
      reason = parts.slice(2).join(' ').trim();
    } else if (parts.length >= 2) {
      reason = parts.slice(1).join(' ').trim();
    }
    if (reason.length > 200) reason = reason.slice(0, 200);
    const durationMs = hours * 3600 * 1000;
    const untilMs = await store.setBan(targetId, durationMs, reason || 'admin_manual');
    clearState(chatId);
    log.info(`Admin banned user ${targetId} for ${hours}h. Reason: ${reason || '(none)'}`);
    const remain = fmtRemainHours(untilMs - Date.now());
    return finishAdminUpdate(chatId,
      `🚫 Đã cấm user ${targetId} trong ${remain}${reason ? ` — ${reason}` : ''}`,
      () => showBans(chatId));
  }

  if (state.action === 'edit_text') {
    const value = text.trim();
    const rawEntities = extractEntities(msg);
    const textEntities = adjustEntitiesForTrim(text, rawEntities);
    await store.setText(state.key, value, textEntities);
    clearState(chatId);
    const label = TEXT_LABELS[state.key] || state.key;
    const animCount = (textEntities || []).filter(e => e.type === 'custom_emoji').length;
    const suffix = animCount > 0
      ? ` (đã giữ ${animCount} emoji động ✨)`
      : ' (không phát hiện emoji động — chèn từ gói ⭐ Premium nếu muốn động)';
    return finishAdminUpdate(chatId, `✅ Đã cập nhật: ${label}${suffix}`, () => showTexts(chatId));
  }

  return false;
}

async function handleAdminMedia(chatId, msg) {
  const state = adminState.get(chatId);
  if (!state) return false;

  if (state.action === 'set_video') {
    if (!msg.video) {
      await toast(chatId, '❌ Vui lòng gửi video');
      return true;
    }
    await store.setProductMedia(state.productId, 'video', msg.video.file_id);
    const isVip = String(state.productId) === store.getText('vip_product_id');
    clearState(chatId);
    const p = store.getProductById(state.productId);
    const name = p ? p.name : `#${state.productId}`;
    return finishAdminUpdate(chatId, `✅ Đã gán video cho ${name}`,
      () => isVip ? showVipDetail(chatId) : showMovieDetail(chatId, state.productId));
  }

  if (state.action === 'set_preview') {
    if (!msg.photo || !msg.photo.length) {
      await toast(chatId, '❌ Vui lòng gửi ảnh');
      return true;
    }
    const bestPhoto = msg.photo[msg.photo.length - 1];
    await store.setProductMedia(state.productId, 'preview', bestPhoto.file_id);
    const isVip = String(state.productId) === store.getText('vip_product_id');
    clearState(chatId);
    const p = store.getProductById(state.productId);
    const name = p ? p.name : `#${state.productId}`;
    return finishAdminUpdate(chatId, `✅ Đã gán ảnh preview cho ${name}`,
      () => isVip ? showVipDetail(chatId) : showMovieDetail(chatId, state.productId));
  }

  if (state.action === 'add_delivery_photo') {
    if (!msg.photo || !msg.photo.length) {
      await toast(chatId, '❌ Vui lòng gửi ảnh');
      return true;
    }
    const bestPhoto = msg.photo[msg.photo.length - 1];
    await store.addDeliveryMedia(state.productId, 'photo', bestPhoto.file_id);
    clearState(chatId);
    return finishAdminUpdate(chatId, '✅ Đã thêm ảnh giao hàng',
      () => showDeliveryDetail(chatId, state.productId));
  }

  if (state.action === 'set_membership_photo') {
    if (!msg.photo || !msg.photo.length) {
      await toast(chatId, '❌ Vui lòng gửi ảnh');
      return true;
    }
    const bestPhoto = msg.photo[msg.photo.length - 1];
    await store.setText('membership_media_file_id', bestPhoto.file_id);
    await store.setText('membership_media_type', 'photo');
    clearState(chatId);
    return finishAdminUpdate(chatId, '✅ Đã gán ảnh dashboard membership', () => showMembershipAdmin(chatId));
  }

  if (state.action === 'set_membership_video') {
    if (!msg.video) {
      await toast(chatId, '❌ Vui lòng gửi video');
      return true;
    }
    await store.setText('membership_media_file_id', msg.video.file_id);
    await store.setText('membership_media_type', 'video');
    clearState(chatId);
    return finishAdminUpdate(chatId, '✅ Đã gán video dashboard membership', () => showMembershipAdmin(chatId));
  }

  if (state.action === 'add_delivery_video') {
    if (!msg.video) {
      await toast(chatId, '❌ Vui lòng gửi video');
      return true;
    }
    await store.addDeliveryMedia(state.productId, 'video', msg.video.file_id);
    clearState(chatId);
    return finishAdminUpdate(chatId, '✅ Đã thêm video giao hàng',
      () => showDeliveryDetail(chatId, state.productId));
  }

  return false;
}

module.exports = {
  showAdminHome,
  handleAdminCallback,
  handleAdminText,
  handleAdminMedia,
  handleConfirmOrder,
  isInState,
  clearState,
  isAdmin,
  handleUndo
};
