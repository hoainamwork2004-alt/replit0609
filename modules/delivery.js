const bot = require('../bot');
const store = require('../store');
const { animatedText } = require('./utils');

async function sendDeliveryDashboard(chatId, product) {
  const vipProductId = store.getText('vip_product_id');
  if (vipProductId && String(product.id) === String(vipProductId)) {
    return sendVipDelivery(chatId, product);
  }

  const media = product.deliveryMedia || [];
  const photos = media.filter(m => m.type === 'photo');
  const videos = media.filter(m => m.type === 'video');

  const hasDeliveryContent = photos.length > 0 || videos.length > 0 || product.deliveryDescription;

  if (!hasDeliveryContent) {
    await bot.sendMessage(chatId, `✅ Thanh toán thành công`, {
      reply_markup: { inline_keyboard: [[{ text: store.getText('btn_back_menu') || '🔙 Quay lại menu', callback_data: 'menu' }]] }
    }).catch(() => {});
    return;
  }

  let captionText = `✅ Thanh toán thành công\n\n🎬 ${animatedText(product.name)}`;
  let captionEntities = null;

  if (product.deliveryDescription) {
    const prefix = captionText + '\n\n';
    const prefixOffset = prefix.length;
    captionText = prefix + product.deliveryDescription;

    if (product.deliveryDescriptionEntities) {
      try {
        const rawEntities = typeof product.deliveryDescriptionEntities === 'string'
          ? JSON.parse(product.deliveryDescriptionEntities)
          : product.deliveryDescriptionEntities;
        if (Array.isArray(rawEntities) && rawEntities.length > 0) {
          captionEntities = rawEntities.map(e => ({
            ...e,
            offset: e.offset + prefixOffset
          }));
        }
      } catch {}
    }
  }

  const mediaItems = [];

  for (const photo of photos) {
    mediaItems.push({ type: 'photo', media: photo.fileId });
  }
  for (const video of videos) {
    mediaItems.push({ type: 'video', media: video.fileId, supports_streaming: true });
  }

  if (mediaItems.length > 1) {
    mediaItems[0].caption = captionText;
    if (captionEntities) {
      mediaItems[0].caption_entities = captionEntities;
    }

    try {
      await bot.sendMediaGroup(chatId, mediaItems);
    } catch (e) {
      for (const item of mediaItems) {
        try {
          if (item.type === 'photo') {
            await bot.sendPhoto(chatId, item.media);
          } else {
            await bot.sendVideo(chatId, item.media, { supports_streaming: true });
          }
        } catch {}
      }
      const opts = {};
      if (captionEntities) opts.entities = captionEntities;
      await bot.sendMessage(chatId, captionText, opts).catch(() => {});
    }
  } else if (mediaItems.length === 1) {
    const item = mediaItems[0];
    const opts = { caption: captionText };
    if (captionEntities) opts.caption_entities = captionEntities;

    try {
      if (item.type === 'photo') {
        await bot.sendPhoto(chatId, item.media, opts);
      } else {
        opts.supports_streaming = true;
        await bot.sendVideo(chatId, item.media, opts);
      }
    } catch (e) {
      if (captionEntities) opts.entities = captionEntities;
      delete opts.caption;
      delete opts.caption_entities;
      await bot.sendMessage(chatId, captionText, opts).catch(() => {});
    }
  } else {
    const opts = {};
    if (captionEntities) opts.entities = captionEntities;
    await bot.sendMessage(chatId, captionText, opts).catch(() => {});
  }

  await bot.sendMessage(chatId, '👆 Nội dung sản phẩm ở trên', {
    reply_markup: { inline_keyboard: [[{ text: store.getText('btn_back_menu') || '🔙 Quay lại menu', callback_data: 'menu' }]] }
  }).catch(() => {});
}

async function sendVipDelivery(chatId, product) {
  const vipLink = store.getText('vip_invite_link');

  let msg = `✅ Thanh toán thành công!\n\n👑 ${animatedText(product.name)}\n\n`;
  msg += `Chúc mừng bạn đã trở thành hội viên VIP!\n`;

  if (vipLink) {
    msg += `\n🔗 Nhấn nút bên dưới để vào nhóm VIP:`;
    const keyboard = {
      inline_keyboard: [
        [{ text: store.getText('btn_vip_group') || '👑 Vào nhóm VIP', url: vipLink }],
        [{ text: store.getText('btn_back_menu') || '🔙 Quay lại menu', callback_data: 'menu' }]
      ]
    };
    await bot.sendMessage(chatId, msg, { reply_markup: keyboard }).catch(() => {});
  } else {
    msg += `\n⚠️ Link nhóm VIP đang được cập nhật.\nVui lòng liên hệ admin để được hỗ trợ.`;
    await bot.sendMessage(chatId, msg, {
      reply_markup: { inline_keyboard: [[{ text: store.getText('btn_back_menu') || '🔙 Quay lại menu', callback_data: 'menu' }]] }
    }).catch(() => {});
  }
}

module.exports = { sendDeliveryDashboard };
