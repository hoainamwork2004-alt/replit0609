const TelegramBotLib = require('node-telegram-bot-api');
const TelegramBot = TelegramBotLib.default || TelegramBotLib;
const { BOT_TOKEN } = require('./config');

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

module.exports = bot;
