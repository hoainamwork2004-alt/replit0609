// Tắt deprecation warning của node-telegram-bot-api: dùng hành vi mới (filename mặc định = "filename"
// thay vì "data") + tắt cả các throw legacy khi không detect được file-type. PHẢI set TRƯỚC khi require bot.
process.env.NTBA_FIX_350 = process.env.NTBA_FIX_350 || '1';
process.env.NTBA_FIX_252 = process.env.NTBA_FIX_252 || '1';

const express = require('express');
const path    = require('path');
const log     = require('./modules/logger');
const store   = require('./store');
const { PORT } = require('./config');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err && err.message ? err.message : err);
  setTimeout(() => process.exit(1), 100).unref();
});

store.init().then(() => {
  require('./modules/handlers');

  const { setupTelegramWebhook } = require('./modules/telegram');
  const { setupSepayWebhook }    = require('./modules/sepay');
  const { startExpiryWatcher }   = require('./modules/payment');
  const { startLoyaltyCron }     = require('./modules/loyalty');
  const { startSepayPollCron }   = require('./modules/sepayPoll');
  const { startSaleCron }        = require('./modules/saleCron');

  setupTelegramWebhook(app);
  setupSepayWebhook(app);
  startExpiryWatcher();
  startLoyaltyCron();
  startSepayPollCron();
  startSaleCron();

  app.get('/', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  app.use((err, req, res, _next) => {
    log.error('Express error:', err && err.message ? err.message : err);
    res.status(500).json({ status: 'error' });
  });

  const server = app.listen(PORT, () => {
    log.info(`🚀 BOT RUNNING on port ${PORT}`);
  });

  const shutdown = (signal) => {
    log.info(`Received ${signal}, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}).catch(err => {
  log.error('Failed to initialize store:', err.message);
  process.exit(1);
});
