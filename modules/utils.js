const crypto = require('crypto');
const { BANK, ACCOUNT, ACCOUNT_NAME } = require('../config');

function generateOrderCode(productId) {
  const raw = productId + Date.now() + Math.random();
  return 'od' + crypto.createHash('md5').update(String(raw)).digest('hex').slice(0, 6) + productId;
}

const MEMO_PHRASES = [
  'gui xe', 'tra tien', 'nap tien', 'rut tien', 'mua cafe', 'uong tra',
  'an sang', 'an toi', 'di hoc', 'tan ca', 'vao ca', 'ra ngoai', 'vao nha',
  'goi dien', 'nhan tin', 'check mail', 'doc sach', 'viet bai', 'chup anh',
  'quay phim', 'lam bai', 'nop bai', 'giu xe', 'lay hang', 'giao hang',
  'dat mon', 'ship nhanh', 'nhan do', 'doi hang', 'tra hang'
];

// Bank transfer memo. Format: "SEVQR <orderCode> <vietnamese phrase>".
// SEVQR + order code stay at the front so the SePay webhook regex captures it
// reliably; the trailing phrase makes the memo look like a normal personal
// transfer instead of a bot-generated payment.
function generateMemo(orderCode) {
  const phrase = MEMO_PHRASES[Math.floor(Math.random() * MEMO_PHRASES.length)];
  return `SEVQR ${orderCode} ${phrase}`;
}

function generateQR(amount, content) {
  return `https://img.vietqr.io/image/${BANK}-${ACCOUNT}-compact.png?amount=${amount}&addInfo=${encodeURIComponent(content)}&accountName=${encodeURIComponent(ACCOUNT_NAME)}`;
}

const productIcons = {};
function animatedText(text) {
  if (!productIcons[text]) {
    const icons = ['🔥', '⚡', '✨', '💥'];
    productIcons[text] = icons[Math.abs(text.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % icons.length];
  }
  return `${productIcons[text]} ${text}`;
}

function formatTime(s) {
  const m   = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// === Shared loading animation (cùng style với preview phim) ===
const LOADING_BAR_LEN = 10;
const LOADING_FILLED  = '▰';
const LOADING_EMPTY   = '▱';
const LOADING_SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

function renderLoadingBar(progress) {
  const cells = Math.max(0, Math.min(LOADING_BAR_LEN, Math.round((progress / 100) * LOADING_BAR_LEN)));
  return LOADING_FILLED.repeat(cells) + LOADING_EMPTY.repeat(LOADING_BAR_LEN - cells);
}

function buildLoadingFrame(progress, tick, phases, icon) {
  const spin = LOADING_SPINNER[tick % LOADING_SPINNER.length];
  const pct  = String(progress).padStart(3, ' ');
  let phaseText = phases[phases.length - 1].text;
  for (const p of phases) {
    if (progress < p.max) { phaseText = p.text; break; }
  }
  return `${spin}  ${renderLoadingBar(progress)}  ${pct}%\n` +
         `${icon || '🎬'}  ${phaseText}…`;
}

// Chạy thanh loading dạng giống preview phim, nhưng nội dung do caller truyền vào.
// opts:
//   phases:   [{max:Number, text:String}, ...] — đoạn cuối nên có max=100
//   totalMs:  thời lượng (mặc định 2400)
//   tickMs:   chu kỳ cập nhật (mặc định 180)
//   icon:     emoji phía trước phase text (mặc định 🎬)
//   doneText: text hiển thị khi 100% (mặc định "✅  ▰...  100%\n<icon>  Sẵn sàng!")
//   onCancel: () => boolean — trả về true thì dừng sớm
// Trả về messageId của tin nhắn loading (caller tự xoá), hoặc null nếu gửi thất bại.
async function runLoadingAnimation(bot, chatId, opts = {}) {
  const phases = (opts.phases && opts.phases.length) ? opts.phases : [{ max: 100, text: 'Đang xử lý' }];
  const totalMs = opts.totalMs || 2400;
  const tickMs  = opts.tickMs  || 180;
  const icon    = opts.icon    || '🎬';
  const totalTicks = Math.max(1, Math.ceil(totalMs / tickMs));

  const initText = buildLoadingFrame(0, 0, phases, icon);
  const sent = await bot.sendMessage(chatId, initText).catch(() => null);
  if (!sent) return null;
  const messageId = sent.message_id;

  let progress = 0;
  let tick = 0;

  await new Promise((resolve) => {
    const timer = setInterval(async () => {
      try {
        if (typeof opts.onCancel === 'function' && opts.onCancel()) {
          clearInterval(timer);
          return resolve();
        }
        tick++;
        const ratio = Math.min(1, tick / totalTicks);
        const eased = 1 - Math.pow(1 - ratio, 2);
        const target = Math.floor(eased * 100);
        progress = Math.min(100, Math.max(progress + 1, target));

        if (progress >= 100 || tick >= totalTicks) {
          progress = 100;
          clearInterval(timer);
          const doneText = opts.doneText ||
            `✅  ${LOADING_FILLED.repeat(LOADING_BAR_LEN)}  100%\n${icon}  Sẵn sàng!`;
          await bot.editMessageText(doneText, { chat_id: chatId, message_id: messageId }).catch(() => {});
          await new Promise(r => setTimeout(r, 260));
          return resolve();
        }

        const text = buildLoadingFrame(progress, tick, phases, icon);
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId }).catch(() => {});
      } catch {
        clearInterval(timer);
        resolve();
      }
    }, tickMs);
  });

  return messageId;
}

// Chọn ngẫu nhiên 1 text từ danh sách key (bỏ qua key trống). Trả về { text, entities, key } hoặc null.
function pickRandomText(store, keys) {
  const candidates = [];
  for (const k of keys) {
    const t = (store.getText(k) || '').trim();
    if (t) candidates.push({ key: k, text: t, entities: store.getTextEntities(k) });
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// UTF-16 code-unit length (Telegram MessageEntity offsets are measured in
// UTF-16 units — surrogate-pair emojis count as 2).
function utf16Length(str) {
  let n = 0;
  for (const ch of String(str || '')) {
    n += ch.codePointAt(0) > 0xffff ? 2 : 1;
  }
  return n;
}

// Prepend `prefix` to `text` and shift every entity offset by the UTF-16
// length of the prefix. Returns { text, entities }.
function prefixWithEntities(prefix, text, entities) {
  const combined = String(prefix || '') + String(text || '');
  if (!entities || entities.length === 0) {
    return { text: combined, entities: null };
  }
  const shift = utf16Length(prefix);
  return {
    text: combined,
    entities: entities.map(e => ({ ...e, offset: e.offset + shift }))
  };
}

// Substitute {token} placeholders in `text` and adjust entity offsets so
// custom_emoji / formatting entities stay aligned after substitution.
// `vars` maps token name -> string (already formatted).
// Entities whose offset lands inside a substituted token are dropped.
function applyTemplate(text, entities, vars) {
  const src = String(text || '');
  if (!src) return { text: '', entities: null };

  const re = /\{(\w+)\}/g;
  const segs = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    if (Object.prototype.hasOwnProperty.call(vars, m[1])) {
      segs.push({ start: m.index, end: m.index + m[0].length, value: String(vars[m[1]] ?? '') });
    }
  }
  if (segs.length === 0) {
    return { text: src, entities: entities && entities.length ? entities.slice() : null };
  }

  let out = '';
  let cursor = 0;
  for (const s of segs) {
    out += src.slice(cursor, s.start) + s.value;
    cursor = s.end;
  }
  out += src.slice(cursor);

  if (!entities || entities.length === 0) {
    return { text: out, entities: null };
  }

  const segData = segs.map(s => ({
    startUtf16: utf16Length(src.slice(0, s.start)),
    endUtf16:   utf16Length(src.slice(0, s.end)),
    valueUtf16: utf16Length(s.value)
  }));

  const adjusted = [];
  for (const e of entities) {
    let drop = false;
    let shift = 0;
    for (const sd of segData) {
      if (e.offset >= sd.endUtf16) {
        shift += (sd.valueUtf16 - (sd.endUtf16 - sd.startUtf16));
      } else if (e.offset >= sd.startUtf16 && e.offset < sd.endUtf16) {
        drop = true;
        break;
      }
    }
    if (!drop) adjusted.push({ ...e, offset: e.offset + shift });
  }

  return { text: out, entities: adjusted.length ? adjusted : null };
}

module.exports = {
  generateOrderCode,
  generateMemo,
  generateQR,
  animatedText,
  formatTime,
  delay,
  utf16Length,
  prefixWithEntities,
  applyTemplate,
  runLoadingAnimation,
  pickRandomText
};
