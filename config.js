const requiredSecrets = ['BOT_TOKEN', 'SEPAY_SECRET'];
for (const key of requiredSecrets) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing required secret: ${key}`);
    process.exit(1);
  }
}

module.exports = {
  BOT_TOKEN:        process.env.BOT_TOKEN,
  DOMAIN:           process.env.DOMAIN           || "",
  WEBHOOK_SECRET:   process.env.WEBHOOK_SECRET   || "",
  SEPAY_SECRET:     process.env.SEPAY_SECRET,
  // Optional: enables SePay polling fallback (catches payments when webhooks are delayed/missed)
  SEPAY_API_TOKEN:  process.env.SEPAY_API_TOKEN  || "",
  BANK:             process.env.BANK             || "ICB",
  ACCOUNT:          process.env.ACCOUNT          || "105886833489",
  ACCOUNT_NAME:     process.env.ACCOUNT_NAME     || "PHAM HOAI NAM",
  PORT:             process.env.PORT             || 3000,
  ADMIN_CHAT_ID:    process.env.ADMIN_CHAT_ID    || "",
  SUPPORT_USERNAME: process.env.SUPPORT_USERNAME || "",
  SPAM_DELAY:       700,
  ORDER_TIMEOUT_SEC: 600
};
