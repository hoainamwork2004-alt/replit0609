function fmtVN(n) {
  return Number(n || 0).toLocaleString('vi-VN');
}

function strike(s) {
  return [...String(s)].map(c => c + '\u0336').join('');
}

function priceDisplay(price, originalPrice) {
  if (originalPrice && originalPrice > price) {
    return `${strike(fmtVN(originalPrice))} ${fmtVN(price)} VNĐ`;
  }
  return `${fmtVN(price)} VNĐ`;
}

function discountPct(price, originalPrice) {
  if (!originalPrice || originalPrice <= price) return 0;
  return Math.round((originalPrice - price) * 100 / originalPrice);
}

// === Currency mode ===
// Lazy-required to avoid circular dependency with store.js
function getCurrencySettings() {
  try {
    const store = require('../store');
    const mode = (store.getText('currency_mode') || 'vnd').toLowerCase();
    const rate = parseFloat(store.getText('usd_to_vnd_rate') || '25500') || 25500;
    return { mode, rate };
  } catch {
    return { mode: 'vnd', rate: 25500 };
  }
}

function fmtUsd(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

// USD hiển thị: dùng priceUsd nếu admin đã đặt thủ công, ngược lại tự quy đổi từ VND theo tỷ giá.
function getDisplayUsd(product) {
  if (!product) return 0;
  const { rate } = getCurrencySettings();
  const usdSet = Number(product.priceUsd || 0);
  if (usdSet > 0) return usdSet;
  const vnd = Number(product.price || 0);
  if (!vnd || !rate) return 0;
  return Math.round((vnd / rate) * 100) / 100;
}

// USD của "giá gốc" (originalPrice) — luôn quy đổi từ VND theo tỷ giá hiện tại,
// để gạch ngang giá gốc đồng nhất tỷ lệ với giá bán.
function getDisplayUsdOriginal(product) {
  if (!product) return 0;
  const { rate } = getCurrencySettings();
  const orig = Number(product.originalPrice || 0);
  if (!orig || !rate) return 0;
  return Math.round((orig / rate) * 100) / 100;
}

// Convert effective product price to VND for QR / SePay (always VND).
// Nếu admin đặt priceUsd thủ công ⇒ VND = priceUsd × rate.
// Ngược lại dùng giá VND gốc của sản phẩm.
function getEffectivePriceVnd(product) {
  if (!product) return 0;
  const { mode, rate } = getCurrencySettings();
  const usdSet = Number(product.priceUsd || 0);
  if ((mode === 'usd' || mode === 'both') && usdSet > 0) return Math.round(usdSet * rate);
  return Number(product.price || 0);
}

// Long display used on preview/payment cards.
// Modes:
//  - 'vnd'  : chỉ VND (có strikethrough giá gốc nếu có)
//  - 'usd'  : chỉ USD — gạch ngang giá gốc nếu có (vd: ~~$9.99~~ $1.79)
//  - 'both' : USD (~VNĐ) — gạch ngang giá gốc cũng hiển thị nếu có
function displayProductPrice(product) {
  if (!product) return '';
  const { mode } = getCurrencySettings();
  if (mode === 'usd' || mode === 'both') {
    const usd = getDisplayUsd(product);
    if (usd > 0) {
      const usdOrig = getDisplayUsdOriginal(product);
      const hasDiscount = usdOrig > usd;
      const usdPart = hasDiscount
        ? `${strike(fmtUsd(usdOrig))} ${fmtUsd(usd)}`
        : fmtUsd(usd);
      if (mode === 'usd') return usdPart;
      const vnd = getEffectivePriceVnd(product);
      return `${usdPart} (~${fmtVN(vnd)} VNĐ)`;
    }
  }
  return priceDisplay(product.price, product.originalPrice);
}

// Short display for buttons / lists.
function displayProductPriceShort(product) {
  if (!product) return '';
  const { mode } = getCurrencySettings();
  if (mode === 'usd' || mode === 'both') {
    const usd = getDisplayUsd(product);
    if (usd > 0) return fmtUsd(usd);
  }
  return `${fmtVN(product.price)}đ`;
}

// === Entity-aware variants ===
// Trả về { text, entities } trong đó entities dùng MessageEntity 'strikethrough' của Telegram
// (gạch ngang sạch, đồng nhất mọi font), thay cho ký tự combining \u0336 dễ bị render sai
// thành gạch chân trên một số font Android.
//
// baseOffset: vị trí (UTF-16 code unit) mà đoạn text này được nhúng vào caption cha,
// dùng để dịch offset của entity cho đúng tuyệt đối trong caption.

function priceDisplayWithEntities(price, originalPrice, baseOffset = 0) {
  if (originalPrice && originalPrice > price) {
    const origStr = fmtVN(originalPrice);
    const text = `${origStr} ${fmtVN(price)} VNĐ`;
    return {
      text,
      entities: [{ type: 'strikethrough', offset: baseOffset, length: origStr.length }]
    };
  }
  return { text: `${fmtVN(price)} VNĐ`, entities: [] };
}

function displayProductPriceWithEntities(product, baseOffset = 0) {
  if (!product) return { text: '', entities: [] };
  const { mode } = getCurrencySettings();
  if (mode === 'usd' || mode === 'both') {
    const usd = getDisplayUsd(product);
    if (usd > 0) {
      const usdOrig = getDisplayUsdOriginal(product);
      const hasDiscount = usdOrig > usd;
      if (hasDiscount) {
        const origStr = fmtUsd(usdOrig);
        const usdPart = `${origStr} ${fmtUsd(usd)}`;
        const entities = [{ type: 'strikethrough', offset: baseOffset, length: origStr.length }];
        if (mode === 'usd') return { text: usdPart, entities };
        const vnd = getEffectivePriceVnd(product);
        return { text: `${usdPart} (~${fmtVN(vnd)} VNĐ)`, entities };
      }
      if (mode === 'usd') return { text: fmtUsd(usd), entities: [] };
      const vnd = getEffectivePriceVnd(product);
      return { text: `${fmtUsd(usd)} (~${fmtVN(vnd)} VNĐ)`, entities: [] };
    }
  }
  return priceDisplayWithEntities(product.price, product.originalPrice, baseOffset);
}

module.exports = {
  fmtVN, strike, priceDisplay, discountPct,
  fmtUsd, getCurrencySettings, getEffectivePriceVnd, getDisplayUsd,
  displayProductPrice, displayProductPriceShort,
  priceDisplayWithEntities, displayProductPriceWithEntities
};
