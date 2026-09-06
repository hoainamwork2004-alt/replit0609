const bot   = require('../bot');
const store = require('../store');
const { SUPPORT_USERNAME, ADMIN_CHAT_ID } = require('../config');
const { fmtVN, strike, discountPct } = require('./format');

const lastMenuMessage = {};
const greetedToday   = {};

setInterval(() => {
  const today = getTodayKey();
  for (const key of Object.keys(greetedToday)) {
    if (greetedToday[key] !== today) delete greetedToday[key];
  }
  const maxMenuEntries = 500;
  const menuKeys = Object.keys(lastMenuMessage);
  if (menuKeys.length > maxMenuEntries) {
    menuKeys.slice(0, menuKeys.length - maxMenuEntries).forEach(k => delete lastMenuMessage[k]);
  }
}, 600000);

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

const TRANSITION_FRAMES = ['░', '▒', '▓'];

async function sendGreeting(chatId) {
  const today = getTodayKey();
  if (greetedToday[chatId] === today) return;
  greetedToday[chatId] = today;

  const s = store.userStats[chatId];
  const isFirstVisit = !s;

  if (isFirstVisit) {
    const t = store.getText('welcome_new') || '👋 Chào mừng bạn!';
    const e = store.getTextEntities('welcome_new');
    const opts = {};
    if (e) opts.entities = e;
    await bot.sendMessage(chatId, t, opts).catch(() => {});
  } else {
    const t = store.getText('welcome_return') || '👑 Chào mừng trở lại!';
    const e = store.getTextEntities('welcome_return');
    const opts = {};
    if (e) opts.entities = e;
    await bot.sendMessage(chatId, t, opts).catch(() => {});
  }
}

async function smoothTransition(chatId, msgId, finalText, finalKeyboard, finalEntities) {
  const opts = { chat_id: chatId, message_id: msgId };

  try {
    await bot.editMessageText(TRANSITION_FRAMES[0], { ...opts, reply_markup: { inline_keyboard: [] } });
    await new Promise(r => setTimeout(r, 80));
    await bot.editMessageText(TRANSITION_FRAMES[1], opts);
    await new Promise(r => setTimeout(r, 80));
    await bot.editMessageText(TRANSITION_FRAMES[0], opts);
    await new Promise(r => setTimeout(r, 60));
  } catch {}

  try {
    const editOpts = { ...opts, reply_markup: { inline_keyboard: finalKeyboard } };
    if (finalEntities) editOpts.entities = finalEntities;
    await bot.editMessageText(finalText, editOpts);
    return msgId;
  } catch {
    return null;
  }
}

async function renderMenuMessage(chatId, text, keyboard, transition = false, entities = null) {
  const currentId = lastMenuMessage[chatId];

  if (currentId) {
    if (transition) {
      const result = await smoothTransition(chatId, currentId, text, keyboard, entities);
      if (result) return result;
    } else {
      try {
        const editOpts = {
          chat_id: chatId, message_id: currentId,
          reply_markup: { inline_keyboard: keyboard }
        };
        if (entities) editOpts.entities = entities;
        await bot.editMessageText(text, editOpts);
        return currentId;
      } catch (e) {
        if (e.message && e.message.includes('not modified')) return currentId;
      }
    }
  }

  const sendOpts = { reply_markup: { inline_keyboard: keyboard } };
  if (entities) sendOpts.entities = entities;
  const sent = await bot.sendMessage(chatId, text, sendOpts).catch(() => null);
  if (sent) lastMenuMessage[chatId] = sent.message_id;
  return sent ? sent.message_id : null;
}

// Menu button labels are admin-editable via /admin → Nội dung hiển thị.
// Defaults live in store.seedTexts() so admin edits persist across restarts.
function buildMenuKeyboard() {
  const buttons = [
    { text: store.getText('btn_hot')      || '🔥 Phim HOT',      callback_data: 'hot' },
    { text: store.getText('btn_list')     || '📂 Tất cả phim',   callback_data: 'list' },
    { text: store.getText('btn_myfilms')  || '🎬 Phim của tôi',  callback_data: 'myfilms' },
    { text: store.getText('btn_mypoints') || '🎁 Điểm thưởng',   callback_data: 'mypoints' },
    { text: store.getText('btn_nap')      || '💰 Nạp tiền',      callback_data: 'nap' },
    { text: store.getText('btn_support')  || '📞 Hỗ trợ',        callback_data: 'support' }
  ];
  const layoutRaw = (store.getText('menu_layout') || '2,2,2').trim();
  let sizes = layoutRaw.split(/[,\s]+/).map(n => parseInt(n)).filter(n => Number.isFinite(n) && n >= 1 && n <= 3);
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (!sizes.length || sum !== buttons.length) sizes = [2, 2, 2];
  const rows = [];
  let i = 0;
  for (const sz of sizes) {
    if (i >= buttons.length) break;
    rows.push(buttons.slice(i, i + sz));
    i += sz;
  }
  while (i < buttons.length) rows.push([buttons[i++]]);
  return rows;
}

function markGreetedToday(chatId) {
  greetedToday[chatId] = getTodayKey();
}

async function mainMenu(chatId, transition = false) {
  // Kiểm tra tư cách thành viên trước khi hiện menu (admin được miễn)
  const isAdmin = ADMIN_CHAT_ID && String(chatId) === String(ADMIN_CHAT_ID);
  const membershipEnabled = (store.getText('membership_enabled') || 'on') === 'on';
  if (membershipEnabled && !isAdmin && !store.isMember(chatId)) {
    const { handleMembershipCheck } = require('./membership');
    return handleMembershipCheck(chatId);
  }

  await sendGreeting(chatId);

  const keyboard = buildMenuKeyboard();

  const menuTitleRaw = store.getText('menu_title') || '🎬 MENU PHIM\n\n🔥 Chọn phim để xem';
  const menuEntitiesRaw = store.getTextEntities('menu_title');

  const balance = store.getWalletBalance(chatId);
  const balanceLabel = store.getText('wallet_balance_label') || '💎 Số dư ví:';
  const balanceLabelEntitiesRaw = store.getTextEntities('wallet_balance_label');
  const balanceLine = `${balanceLabel} ${fmtVN(balance)} VNĐ`;

  // Insert the wallet balance line directly under the first line of menu_title
  // (e.g. right under "🎬 MENU PHIM"). If menu_title has no newline, append it.
  const firstNl = menuTitleRaw.indexOf('\n');
  let menuTitle;
  let insertOffset;     // character index where the inserted text begins
  let insertedText;     // exact text we injected (used to compute UTF-16 length)
  let labelCharOffset;  // character index where balanceLabel starts inside menuTitle
  if (firstNl === -1) {
    insertedText = `\n${balanceLine}`;
    insertOffset = menuTitleRaw.length;
    menuTitle = menuTitleRaw + insertedText;
    labelCharOffset = insertOffset + 1; // after the leading \n
  } else {
    insertedText = `${balanceLine}\n`;
    insertOffset = firstNl + 1; // right after the first '\n'
    menuTitle = menuTitleRaw.slice(0, insertOffset) + insertedText + menuTitleRaw.slice(insertOffset);
    labelCharOffset = insertOffset; // balanceLine starts here
  }

  // Telegram measures entity offsets in UTF-16 code units.
  const utf16LenOf = (s) => {
    let n = 0;
    for (const ch of s) n += ch.codePointAt(0) > 0xffff ? 2 : 1;
    return n;
  };

  let menuEntities = [];

  // 1) Carry menu_title entities, shifting any that land at/after our insert
  //    point by the UTF-16 length of the entire inserted segment.
  if (menuEntitiesRaw && menuEntitiesRaw.length) {
    const insertedLen16 = utf16LenOf(insertedText);
    const insertOffset16 = utf16LenOf(menuTitleRaw.slice(0, insertOffset));
    for (const e of menuEntitiesRaw) {
      menuEntities.push(
        e.offset >= insertOffset16 ? { ...e, offset: e.offset + insertedLen16 } : e
      );
    }
  }

  // 2) Carry wallet_balance_label entities (e.g. animated 💲 emoji), shifting
  //    them by the UTF-16 position where the label sits inside menuTitle.
  if (balanceLabelEntitiesRaw && balanceLabelEntitiesRaw.length) {
    const labelOffset16 = utf16LenOf(menuTitle.slice(0, labelCharOffset));
    const labelLen16 = utf16LenOf(balanceLabel);
    for (const e of balanceLabelEntitiesRaw) {
      // Only entities that fall within the label text itself are valid.
      if (e.offset >= 0 && e.offset + (e.length || 0) <= labelLen16) {
        menuEntities.push({ ...e, offset: e.offset + labelOffset16 });
      }
    }
  }

  if (menuEntities.length === 0) menuEntities = null;
  await renderMenuMessage(chatId, menuTitle, keyboard, transition, menuEntities);
}

function priceLabel(p) {
  const pct = discountPct(p.price, p.originalPrice);
  if (pct > 0) {
    return `${strike(fmtVN(p.originalPrice))} ${fmtVN(p.price)}đ (-${pct}%)`;
  }
  return `${fmtVN(p.price)}đ`;
}

async function showList(chatId) {
  const products = store.getProductsList();
  const keyboard = products.map(p => [
    { text: `${p.name}`, callback_data: `view_${p.id}` }
  ]);
  keyboard.push([{ text: store.getText('btn_back') || '🔙 Quay lại', callback_data: 'menu' }]);
  await renderMenuMessage(chatId, '🎬 Danh sách phim:', keyboard, true);
}

async function showHot(chatId) {
  const products = store.getProductsList().filter(p => p.hot);
  const keyboard = products.map(p => [
    { text: `🔥 ${p.name}`, callback_data: `view_${p.id}` }
  ]);
  keyboard.push([{ text: store.getText('btn_back') || '🔙 Quay lại', callback_data: 'menu' }]);
  await renderMenuMessage(chatId, '🔥 Phim HOT:', keyboard, true);
}

async function showMyFilms(chatId) {
  const list = await store.getUserPurchases(chatId);
  if (!list.length) {
    const kb = [
      [{ text: store.getText('btn_view_films') || '📂 Xem phim ngay', callback_data: 'list' }],
      [{ text: store.getText('btn_back_menu')  || '🔙 Quay lại menu', callback_data: 'menu' }]
    ];
    return renderMenuMessage(chatId,
      '🎬 PHIM CỦA TÔI\n\nBạn chưa mua phim nào.\n\n👉 Hãy chọn phim để bắt đầu!',
      kb, true);
  }
  let text = `🎬 PHIM CỦA TÔI (${list.length})\n\n⚠️ Lịch sử tự xoá sau 30 ngày — vui lòng lưu nội dung về máy.\n\n`;
  const keyboard = [];
  for (const it of list.slice(0, 20)) {
    const daysLeft = Math.max(0, Math.ceil((new Date(it.expiresAt) - Date.now()) / 86400000));
    text += `• ${it.productName} — còn ${daysLeft} ngày\n`;
    keyboard.push([{ text: `▶️ ${it.productName}`, callback_data: `mf_${it.id}` }]);
  }
  keyboard.push([{ text: store.getText('btn_back_menu') || '🔙 Quay lại menu', callback_data: 'menu' }]);
  await renderMenuMessage(chatId, text, keyboard, true);
}

async function showMyPoints(chatId) {
  const pts = await store.getPoints(chatId);
  const stats = store.userStats[chatId] || { totalBuy: 0, totalSpent: 0 };
  const text =
    `🎁 ĐIỂM THƯỞNG\n\n` +
    `💎 Điểm hiện có: ${pts}\n` +
    `🛒 Tổng đơn: ${stats.totalBuy || 0}\n` +
    `💰 Tổng chi: ${fmtVN(stats.totalSpent || 0)} VNĐ\n\n` +
    `📌 Cách kiếm điểm:\n` +
    `   • Mỗi 10.000đ chi tiêu = 1 điểm\n\n` +
    `📌 Cách dùng điểm:\n` +
    `   • Đổi voucher giảm giá (sắp ra mắt)\n` +
    `   • Liên hệ admin để biết ưu đãi`;
  const kb = [[{ text: store.getText('btn_back_menu') || '🔙 Quay lại menu', callback_data: 'menu' }]];
  await renderMenuMessage(chatId, text, kb, true);
}

async function repositionMenu(chatId) {
  if (lastMenuMessage[chatId]) {
    await bot.deleteMessage(chatId, lastMenuMessage[chatId]).catch(() => {});
    delete lastMenuMessage[chatId];
  }
  await mainMenu(chatId, false);
}

async function sendTempWarning(chatId, text, ttlMs = 5000) {
  const sent = await bot.sendMessage(chatId, text).catch(() => null);
  if (sent) {
    setTimeout(() => {
      bot.deleteMessage(chatId, sent.message_id).catch(() => {});
    }, ttlMs);
  }
  return sent;
}

module.exports = { mainMenu, markGreetedToday, showList, showHot, showMyFilms, showMyPoints, lastMenuMessage, renderMenuMessage, repositionMenu, sendTempWarning };
