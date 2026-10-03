# Telegram Phim Bot

## Overview
A Telegram bot for selling Vietnamese films with automated payment processing via SePay bank transfer webhooks (MB Bank). Features a full dynamic admin panel with inline keyboard navigation for managing products, pricing, content, and analytics — no code changes needed.

## Architecture
- **Runtime**: Node.js + Express
- **Bot**: node-telegram-bot-api (webhook mode, no polling)
- **Database**: PostgreSQL (Replit built-in)
- **Payment**: SePay webhook → MB Bank QR via VietQR
- **Admin**: Inline keyboard panel with state machine for text/media input

## File Structure
```
index.js              — Entry point, initializes store → handlers → webhooks → server
config.js             — Env vars, bank details, constants (NO hardcoded products)
bot.js                — Single TelegramBot instance (webhook mode)
store.js              — PostgreSQL-backed storage: products CRUD, bot_texts, orders, analytics, media
modules/
  logger.js           — Timestamped console logging
  utils.js            — QR generation, order codes, helpers
  admin.js            — Full admin panel: dashboard, movies CRUD, texts, orders, analytics
  menu.js             — Buyer menu, film list with prices, hot films (smooth transitions)
  preview.js          — Animated VIDEO PLAYER preview, video/photo dashboard
  payment.js          — Buy flow, QR display, countdown timer, expiry watcher
  handlers.js         — Message/callback routing, admin state routing
  telegram.js         — Telegram webhook setup & auth
  sepay.js            — SePay webhook, payment processing, receipts
  delivery.js         — Post-payment delivery dashboard (photo + videos + description)
```

## Database Tables
- `products` — Dynamic product catalog (name, price, link, description, description_entities, delivery_description, delivery_description_entities, hot, active, sort_order, video_file_id, preview_file_id)
- `delivery_media` — Delivery media items per product (product_id, media_type [photo/video], file_id, sort_order). 1 photo + up to 3 videos per product.
- `bot_texts` — Editable bot text content (welcome messages, menu title, buy screen text). Has `entities` JSONB column for preserving Telegram rich formatting (custom emoji, bold, italic, links, etc.)
- `orders` — Active and historical orders with partial payment tracking, `expires_at` for durable expiry
- `partial_payments` — Individual payment records per order with unique webhook_id constraint
- `user_stats` — Per-user purchase history
- `analytics` — Global revenue, order counts

### DB Constraints
- `idx_pp_webhook_unique` — Unique index on `partial_payments.webhook_id` (prevents double-processing)
- `idx_one_active_order_per_user` — Unique index on `orders.chat_id` WHERE unpaid/unexpired (one active order per user)

## Admin Panel (/admin)
Full inline keyboard admin interface accessible only by ADMIN_CHAT_ID:

### Dashboard
- Total revenue, orders, users, conversion rate
- Period stats: today / 7 days / 30 days
- Top selling products, per-product sales breakdown

### Movie Management
- Add new movies (name + price multi-step flow)
- Edit: name, price, link, description
- Toggle: hot flag, active/inactive status
- Media: assign/remove video and preview images via Telegram file_id
- Delivery content: manage post-payment delivery dashboard (1 photo + up to 3 videos + description with custom emoji support)
- Reorder: move products up/down
- Delete with confirmation (blocked when unpaid orders exist)
- Pagination for large catalogs (8 per page)

### Text Content Management
- Edit all buyer-facing text without code changes:
  - Welcome messages (new/returning users)
  - Menu title
  - Payment screen title
  - Payment footer note

### Order Management
- View active orders with details
- One-click order confirmation buttons
- Also supports `/confirm <code>` text command

## Key Features
- Dynamic product catalog from PostgreSQL (no hardcoded products)
- Admin panel with inline keyboard navigation + state machine
- Persistent PostgreSQL storage (survives restarts/deployments)
- Atomic payment processing with DB transactions + row-level locking
- Partial payment accumulation (multiple transfers sum up)
- Webhook deduplication via unique constraint + INSERT ON CONFLICT
- Durable order expiry via `expires_at` column + periodic cleanup (every 30s)
- Fail-fast on missing BOT_TOKEN or SEPAY_SECRET
- Exact order code matching via regex (`NAP <code>`)
- One active order per user enforced at DB level
- QR send failure cancels order automatically
- Payment timer throttled to 5s edits (avoids Telegram rate limits)
- Single-message navigation: all menu screens edit same message
- Video dashboard: static caption (no editMessageCaption) to prevent playback interruption
- Photo/text dashboard: live caption updates every 2 seconds
- Telegram file_id stored in products table for instant media delivery
- Race condition protection: session cancelled flag + session ID + processing lock
- Constant-time secret comparison for webhook auth
- Auto-seed: default products created on first run, migrates media_cache data
- Admin access strictly enforced by ADMIN_CHAT_ID on both UI and backend

## Environment Variables (Secrets)
- `BOT_TOKEN` — Telegram bot token (REQUIRED)
- `SEPAY_SECRET` — SePay webhook authorization key (REQUIRED)
- `WEBHOOK_SECRET` — Telegram webhook secret token
- `DATABASE_URL` — PostgreSQL connection (auto-set by Replit)
- `DOMAIN` — Production domain URL
- `BANK`, `ACCOUNT`, `ACCOUNT_NAME` — Bank details
- `ADMIN_CHAT_ID` — Telegram chat ID for admin panel access
- `SUPPORT_USERNAME` — (Optional) Telegram username for customer support
- `SEPAY_API_TOKEN` — SePay API bearer token for polling fallback (optional but recommended)

## Workflow
- Command: `PORT=5000 node index.js`
- Production URL: `https://esteemed-gruesome-information--letnamtrade.replit.app`
- Telegram webhook: `<DOMAIN>/bot<token>`
- SePay webhook: `<DOMAIN>/webhook`

## Important Notes
- Must **Republish** after code changes for production to update
- Products are now dynamic — manage via /admin panel, not config.js
- Default products seeded on first run with placeholder links — update via admin panel
- Admin features require ADMIN_CHAT_ID env var to be set
- Support button requires SUPPORT_USERNAME env var to be set
- Bot will refuse to start without BOT_TOKEN and SEPAY_SECRET
- Video dashboard does NOT do live caption edits (prevents video playback from stopping)
