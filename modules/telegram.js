const bot = require('../bot');
const log = require('./logger');
const { BOT_TOKEN, DOMAIN, WEBHOOK_SECRET } = require('../config');

function setupTelegramWebhook(app) {
  const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;
  const WEBHOOK_URL  = DOMAIN + WEBHOOK_PATH;

  bot.setWebhook(WEBHOOK_URL, {
    secret_token: WEBHOOK_SECRET || undefined
  }).then(() => {
    log.info(`Telegram webhook set: ${WEBHOOK_URL}`);
  }).catch(err => log.error('setWebHook error:', err.message));

  app.post(WEBHOOK_PATH, (req, res) => {
    if (WEBHOOK_SECRET) {
      const incoming = req.headers['x-telegram-bot-api-secret-token'];
      if (incoming !== WEBHOOK_SECRET) {
        log.warn('Invalid Telegram webhook secret — request rejected');
        return res.sendStatus(403);
      }
    }
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

module.exports = { setupTelegramWebhook };
