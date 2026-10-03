const { Pool } = require('pg');
const log = require('./modules/logger');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const orderCache = {};
const userLastOrderCache = {};
const userLastTopupCache = {};
const userStatsCache = {};
const walletBalanceCache = {};
const memberCache = {};
const analyticsCache = {
  totalRevenue: 0,
  successfulOrders: 0,
  expiredOrders: 0,
  totalOrders: 0
};

const ANALYTICS_EXCLUDE_CHAT_IDS = new Set([1495067875]);
const productsCache = {};
const textsCache = {};
const banCache = new Map(); // chat_id (Number) -> untilMs

function shouldCountRevenue(chatId) {
  return !ANALYTICS_EXCLUDE_CHAT_IDS.has(Number(chatId));
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      link TEXT DEFAULT '',
      description TEXT DEFAULT '',
      hot BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0,
      video_file_id TEXT,
      preview_file_id TEXT,
      description_entities JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'description_entities'
      ) THEN
        ALTER TABLE products ADD COLUMN description_entities JSONB;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS bot_texts (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      entities JSONB,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'bot_texts' AND column_name = 'entities'
      ) THEN
        ALTER TABLE bot_texts ADD COLUMN entities JSONB;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS orders (
      code VARCHAR(50) PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      product_id VARCHAR(20) NOT NULL,
      paid BOOLEAN DEFAULT FALSE,
      amount_paid INTEGER DEFAULT 0,
      amount_required INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP,
      paid_at TIMESTAMP,
      expired BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS partial_payments (
      id SERIAL PRIMARY KEY,
      order_code VARCHAR(50) REFERENCES orders(code) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      webhook_id VARCHAR(255),
      received_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_pp_webhook ON partial_payments(webhook_id);

    CREATE TABLE IF NOT EXISTS user_stats (
      chat_id BIGINT PRIMARY KEY,
      total_buy INTEGER DEFAULT 0,
      total_spent INTEGER DEFAULT 0,
      join_date TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS analytics (
      id INTEGER PRIMARY KEY DEFAULT 1,
      total_revenue INTEGER DEFAULT 0,
      successful_orders INTEGER DEFAULT 0,
      expired_orders INTEGER DEFAULT 0,
      total_orders INTEGER DEFAULT 0
    );

    INSERT INTO analytics (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS delivery_media (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      media_type VARCHAR(10) NOT NULL,
      file_id TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_dm_product ON delivery_media(product_id);

    CREATE TABLE IF NOT EXISTS user_purchases (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      product_id INTEGER NOT NULL,
      product_name VARCHAR(200) NOT NULL,
      order_code VARCHAR(50),
      paid_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
    );
    CREATE INDEX IF NOT EXISTS idx_up_chat ON user_purchases(chat_id);
    CREATE INDEX IF NOT EXISTS idx_up_expires ON user_purchases(expires_at);

    CREATE TABLE IF NOT EXISTS coupons (
      code VARCHAR(50) PRIMARY KEY,
      discount_type VARCHAR(10) NOT NULL,
      discount_value INTEGER NOT NULL,
      max_uses INTEGER DEFAULT 0,
      used_count INTEGER DEFAULT 0,
      expires_at TIMESTAMP,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS coupon_uses (
      id SERIAL PRIMARY KEY,
      code VARCHAR(50) NOT NULL,
      chat_id BIGINT NOT NULL,
      order_code VARCHAR(50),
      used_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(code, chat_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cu_chat ON coupon_uses(chat_id);

    CREATE TABLE IF NOT EXISTS user_bans (
      chat_id BIGINT PRIMARY KEY,
      banned_until TIMESTAMP NOT NULL,
      reason TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ub_until ON user_bans(banned_until);

    CREATE TABLE IF NOT EXISTS user_cancels (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      cancelled_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_uc_chat_time ON user_cancels(chat_id, cancelled_at);

    CREATE TABLE IF NOT EXISTS scheduled_sales (
      id SERIAL PRIMARY KEY,
      pct INTEGER NOT NULL,
      scope VARCHAR(20) NOT NULL DEFAULT 'all',
      starts_at TIMESTAMP NOT NULL,
      ends_at TIMESTAMP NOT NULL,
      applied_at TIMESTAMP,
      reverted_at TIMESTAMP,
      snapshot JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ss_pending ON scheduled_sales(starts_at, ends_at);
  `);

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='original_price') THEN
        ALTER TABLE products ADD COLUMN original_price INTEGER DEFAULT 0;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_stats' AND column_name='points') THEN
        ALTER TABLE user_stats ADD COLUMN points INTEGER DEFAULT 0;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_stats' AND column_name='last_active_at') THEN
        ALTER TABLE user_stats ADD COLUMN last_active_at TIMESTAMP DEFAULT NOW();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_stats' AND column_name='last_reengage_at') THEN
        ALTER TABLE user_stats ADD COLUMN last_reengage_at TIMESTAMP;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='coupon_code') THEN
        ALTER TABLE orders ADD COLUMN coupon_code VARCHAR(50);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='discount_amount') THEN
        ALTER TABLE orders ADD COLUMN discount_amount INTEGER DEFAULT 0;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='price_usd') THEN
        ALTER TABLE products ADD COLUMN price_usd NUMERIC(10,2) DEFAULT 0;
      END IF;
    END $$;
  `).catch(e => log.error('Schema upgrade error:', e.message));

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'delivery_description'
      ) THEN
        ALTER TABLE products ADD COLUMN delivery_description TEXT DEFAULT '';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'delivery_description_entities'
      ) THEN
        ALTER TABLE products ADD COLUMN delivery_description_entities JSONB;
      END IF;
    END $$;
  `).catch(() => {});

  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_kind VARCHAR(20) DEFAULT 'product'`).catch(() => {});
  // bonus_amount = số tiền cộng thêm vào ví ngoài amount_required (chỉ áp dụng cho topup
  // khi KM x2 đang bật). Khoá tại thời điểm tạo đơn để không bị admin-toggle giữa chừng làm sai.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bonus_amount INTEGER DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS wallet_balance INTEGER DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS is_member BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS member_since TIMESTAMP`).catch(() => {});
  // Migration: tự động cấp membership cho user đã từng mua phim (grandfathering)
  await pool.query(
    `UPDATE user_stats SET is_member = TRUE, member_since = COALESCE(member_since, join_date, NOW())
     WHERE total_buy > 0 AND is_member = FALSE`
  ).catch(e => log.error('membership migration error:', e.message));
  await pool.query(`DELETE FROM partial_payments a USING partial_payments b WHERE a.id > b.id AND a.webhook_id IS NOT NULL AND a.webhook_id = b.webhook_id`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pp_webhook_unique ON partial_payments(webhook_id) WHERE webhook_id IS NOT NULL`).catch(() => {});

  // Replace old single-active-order index with one keyed by order_kind so a
  // user can have an active product order AND an active topup at the same time.
  await pool.query(`DROP INDEX IF EXISTS idx_one_active_order_per_user`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_order_per_user_kind
                    ON orders(chat_id, order_kind) WHERE paid = FALSE AND expired = FALSE`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      amount INTEGER NOT NULL,
      kind VARCHAR(20) NOT NULL,
      ref_code VARCHAR(80),
      balance_after INTEGER NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );
    DROP INDEX IF EXISTS idx_wt_chat;
    CREATE INDEX IF NOT EXISTS idx_wt_chat ON wallet_transactions(chat_id, created_at DESC);
  `).catch(e => log.error('wallet_transactions schema error:', e.message));

  await seedProducts();
  await seedTexts();
  await loadProducts();
  await migrateMediaCache();
  await loadTexts();
  await loadBans();
  await expireOverdueOrders();

  const { rows: orderRows } = await pool.query(
    `SELECT * FROM orders WHERE paid = FALSE AND expired = FALSE`
  );
  for (const row of orderRows) {
    orderCache[row.code] = {
      chatId: Number(row.chat_id),
      productId: row.product_id,
      paid: row.paid,
      amountPaid: row.amount_paid,
      amountRequired: row.amount_required,
      orderKind: row.order_kind || 'product',
      bonus: Number.isFinite(row.bonus_amount) && row.bonus_amount > 0 ? row.bonus_amount : 0,
      time: new Date(row.created_at).getTime(),
      expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null
    };
    if ((row.order_kind || 'product') === 'topup') {
      userLastTopupCache[Number(row.chat_id)] = row.code;
    } else {
      userLastOrderCache[Number(row.chat_id)] = row.code;
    }
  }

  const { rows: statsRows } = await pool.query(`SELECT * FROM user_stats`);
  for (const row of statsRows) {
    userStatsCache[Number(row.chat_id)] = {
      totalBuy: row.total_buy,
      totalSpent: row.total_spent,
      joinDate: row.join_date
    };
    walletBalanceCache[Number(row.chat_id)] = row.wallet_balance || 0;
    memberCache[Number(row.chat_id)] = row.is_member || false;
  }

  const { rows: analyticsRows } = await pool.query(`SELECT * FROM analytics WHERE id = 1`);
  if (analyticsRows.length) {
    const a = analyticsRows[0];
    analyticsCache.totalRevenue = a.total_revenue;
    analyticsCache.successfulOrders = a.successful_orders;
    analyticsCache.expiredOrders = a.expired_orders;
    analyticsCache.totalOrders = a.total_orders;
  }

  // Rebuild analytics from orders table to keep counters in sync with the
  // actual data (e.g. after we delete admin/test rows the cumulative counters
  // would otherwise stay inflated).
  await rebuildAnalytics();

  log.info(`Store loaded — products: ${Object.keys(productsCache).length}, orders: ${Object.keys(orderCache).length}, users: ${Object.keys(userStatsCache).length}`);
}

async function rebuildAnalytics() {
  try {
    const ids = [...ANALYTICS_EXCLUDE_CHAT_IDS];
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN paid    = TRUE THEN amount_required ELSE 0 END), 0)::bigint AS total_revenue,
         COALESCE(SUM(CASE WHEN paid    = TRUE THEN 1 ELSE 0 END), 0)::int    AS successful_orders,
         COALESCE(SUM(CASE WHEN expired = TRUE THEN 1 ELSE 0 END), 0)::int    AS expired_orders,
         COUNT(*)::int                                                         AS total_orders
       FROM orders
       WHERE chat_id <> ALL($1::bigint[])`,
      [ids]
    );
    const r = rows[0] || {};
    const totalRevenue     = Number(r.total_revenue || 0);
    const successfulOrders = Number(r.successful_orders || 0);
    const expiredOrders    = Number(r.expired_orders || 0);
    const totalOrders      = Number(r.total_orders || 0);

    await pool.query(
      `UPDATE analytics SET
         total_revenue     = $1,
         successful_orders = $2,
         expired_orders    = $3,
         total_orders      = $4
       WHERE id = 1`,
      [totalRevenue, successfulOrders, expiredOrders, totalOrders]
    );

    analyticsCache.totalRevenue     = totalRevenue;
    analyticsCache.successfulOrders = successfulOrders;
    analyticsCache.expiredOrders    = expiredOrders;
    analyticsCache.totalOrders      = totalOrders;

    log.info(`Analytics rebuilt — revenue: ${totalRevenue}, success: ${successfulOrders}, expired: ${expiredOrders}, total: ${totalOrders}`);
  } catch (e) {
    log.error('rebuildAnalytics error:', e.message);
  }
}

async function seedProducts() {
  const { rows } = await pool.query(`SELECT COUNT(*) as cnt FROM products`);
  if (parseInt(rows[0].cnt) > 0) return;

  const seeds = [
    { name: 'Phim #132', price: 50000, link: 'https://t.me/your_vip_link', hot: true, sort_order: 1 },
    { name: 'Phim #133', price: 60000, link: 'https://t.me/your_vip_link2', hot: false, sort_order: 2 },
    { name: 'Phim #134', price: 45000, link: 'https://t.me/your_vip_link3', hot: true, sort_order: 3 }
  ];

  for (const s of seeds) {
    await pool.query(
      `INSERT INTO products (name, price, link, hot, sort_order) VALUES ($1, $2, $3, $4, $5)`,
      [s.name, s.price, s.link, s.hot, s.sort_order]
    );
  }
  log.info('Seeded default products');
}

async function seedTexts() {
  const defaults = {
    'welcome_new': '👋 Chào mừng bạn!\n\n🎬 Khám phá bộ sưu tập phim ngay nào',
    'welcome_return': '👑 Chào mừng trở lại!\n\n🔥 Hôm nay có nhiều phim hot lắm',
    'menu_title': '🎬 MENU PHIM\n\n🔥 Chọn phim để xem',
    'buy_title': '💳 THANH TOÁN',
    'buy_footer': '',
    'cancel_warning': '⚠️ Phim cổ không dễ sưu tầm.\nNếu bạn muốn xem free, hãy tìm nơi khác.',
    // === Random pre-preview notices (4s, tự xoá) — bot chọn ngẫu nhiên 1 trong 3 ===
    'preview_intro':   'Phim Cổ Ngừng Chiếu Chỉ Có Tại KhoPhimRe',
    'preview_intro_2': '🍿 Chuẩn bị bỏng ngô, phim sắp lên sóng nhé!',
    'preview_intro_3': '🎞 Một bộ phim cực hay đang chờ bạn ở phía dưới…',
    // === Random notices trước khi hiện QR thanh toán (4s, tự xoá) ===
    'qr_intro_1': '💳 Mã QR đang được tạo riêng cho bạn, vui lòng giữ máy nhé!',
    'qr_intro_2': '🏦 Đang kết nối tới ngân hàng, sẵn sàng nhận chuyển khoản…',
    'qr_intro_3': '🔐 Mã thanh toán an toàn của bạn sắp xuất hiện ngay…',
    // Notice 5s trước khi lộ 2 nút thanh toán (Ví KhoPhim + QR Bank) trong dashboard preview
    'before_payment_notice': '🛒 Bạn chưa mua phim này.\n\n👉 Vui lòng chọn phương thức thanh toán bên dưới sau giây lát.',
    'currency_mode': 'vnd',
    'usd_to_vnd_rate': '25500',
    'topup_title': '💰 NẠP TIỀN VÀO VÍ\n\nChọn mệnh giá nạp:',
    'topup_amounts': '10000,20000,50000,100000',
    'topup_success': '✅ Nạp ví thành công!\n\n💵 Số tiền nạp: {amount} VNĐ\n💎 Số dư hiện tại: {balance} VNĐ',
    // === KM x2 nạp tiền — admin bật/tắt qua /admin → ⚙️ Cài đặt ===
    // 'on' / 'off'. Khi 'on' và mệnh giá ≥ promo_x2_min_amount → user nhận GẤP ĐÔI vào ví.
    // Bonus được "khoá" tại thời điểm tạo đơn (lưu ở orders.bonus_amount), nên admin có
    // tắt giữa chừng thì user vẫn nhận đúng số bonus đã được hứa lúc thấy QR.
    'promo_x2_topup': 'off',
    'promo_x2_min_amount': '50000',
    'topup_x2_notice': '🎁 KHUYẾN MÃI x2 NẠP TIỀN!\n💰 Nạp từ {min}đ trở lên → nhận GẤP ĐÔI vào ví!',
    'topup_zero_balance_notice': '💰 Ví của bạn đang trống.\n\n👉 Mở bảng nạp tiền trong giây lát…',
    'insufficient_balance_msg': '⚠️ Số dư trong ví không đủ.\n\n💎 Số dư: {balance} VNĐ\n💸 Cần: {price} VNĐ\n\nBạn có thể nạp thêm tiền vào ví hoặc thanh toán trực tiếp bằng QR.',
    'wallet_purchase_success': '✅ Đã trừ {amount} VNĐ từ ví của bạn.\n💎 Số dư còn lại: {balance} VNĐ',
    'wallet_balance_label': '💎 Số dư ví:',
    // === Editable button labels (icon + text) ===
    // Main menu
    'btn_hot':           '🔥 Phim HOT',
    'btn_list':          '📂 Tất cả phim',
    'btn_myfilms':       '🎬 Phim của tôi',
    'btn_mypoints':      '🎁 Điểm thưởng',
    'btn_nap':           '💰 Nạp tiền',
    'btn_support':       '📞 Hỗ trợ',
    // Navigation (shared)
    'btn_back_menu':     '🔙 Quay lại menu',
    'btn_back':          '🔙 Quay lại',
    // Preview / purchase
    'btn_view_now':      '▶️ Xem ngay',
    'btn_buy':           '💎 Ví KhoPhim',
    'btn_buyqr':         '🏦 QR Bank',
    // QR payment dashboard
    'btn_coupon':        '🎟 Nhập mã giảm giá',
    'btn_reset':         '🔄 Đổi phim',
    'btn_skip_coupon':   '↩️ Tôi không có mã, bỏ qua',
    // Insufficient-balance triage
    'btn_topup_more':    '💰 Nạp thêm vào ví',
    'btn_pay_with_qr':   '📱 Thanh toán bằng QR',
    // Wallet / topup
    'btn_topup_cancel':  '🔄 Huỷ đơn nạp',
    'btn_topup_again':   '💰 Nạp thêm',
    'btn_topup_retry':   '💰 Nạp lại',
    // Re-engagement
    'btn_rebuy':         '🎬 Mua lại {name}',
    // Misc
    'btn_view_films':    '📂 Xem phim ngay',
    'btn_vip_group':     '👑 Vào nhóm VIP',
    // === Membership ===
    'membership_checking':    '🔎 Đang kiểm tra ID của bạn...',
    'membership_not_joined':  '🎬 Bạn chưa tham gia Before2000s\n\n✨ Tham gia ngay để trải nghiệm kho phim độc quyền!',
    'membership_qr_title':    '🎬 THAM GIA BEFORE2000S',
    'membership_price':       '10000',
    'membership_join_success':'🎉 Chào mừng bạn đến với Before2000s!\n\n✨ Bạn đã chính thức là thành viên. Khám phá kho phim ngay!',
    'btn_join_member':        '🚀 Tham gia · 10.000đ',
    'membership_media_type':  '',
    'membership_media_file_id': '',
    'membership_enabled':     'on'
  };

  for (const [key, value] of Object.entries(defaults)) {
    await pool.query(
      `INSERT INTO bot_texts (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }
}

async function loadProducts() {
  const { rows } = await pool.query(`SELECT * FROM products ORDER BY sort_order ASC, id ASC`);
  for (const key of Object.keys(productsCache)) delete productsCache[key];
  for (const row of rows) {
    productsCache[row.id] = {
      id: row.id,
      name: row.name,
      price: row.price,
      priceUsd: row.price_usd != null ? Number(row.price_usd) : 0,
      originalPrice: row.original_price || 0,
      link: row.link || '',
      description: row.description || '',
      descriptionEntities: row.description_entities || null,
      deliveryDescription: row.delivery_description || '',
      deliveryDescriptionEntities: row.delivery_description_entities || null,
      hot: row.hot,
      active: row.active,
      sortOrder: row.sort_order,
      videoFileId: row.video_file_id || null,
      previewFileId: row.preview_file_id || null
    };
  }

  for (const id of Object.keys(productsCache)) {
    const { rows: mediaRows } = await pool.query(
      `SELECT * FROM delivery_media WHERE product_id = $1 ORDER BY sort_order ASC, id ASC`,
      [id]
    );
    productsCache[id].deliveryMedia = mediaRows.map(r => ({
      id: r.id,
      type: r.media_type,
      fileId: r.file_id,
      sortOrder: r.sort_order
    }));
  }
}

async function migrateMediaCache() {
  try {
    const { rows: checkRows } = await pool.query(`SELECT to_regclass('media_cache') as t`);
    if (!checkRows[0].t) return;

    const { rows } = await pool.query(`SELECT * FROM media_cache`);
    let migrated = 0;
    for (const row of rows) {
      const pid = row.product_id;
      const product = Object.values(productsCache).find(p => p.name.includes(`#${pid}`));
      if (product) {
        if (row.video_file_id && !product.videoFileId) {
          await pool.query(`UPDATE products SET video_file_id = $1 WHERE id = $2`, [row.video_file_id, product.id]);
          productsCache[product.id].videoFileId = row.video_file_id;
          migrated++;
        }
        if (row.preview_file_id && !product.previewFileId) {
          await pool.query(`UPDATE products SET preview_file_id = $1 WHERE id = $2`, [row.preview_file_id, product.id]);
          productsCache[product.id].previewFileId = row.preview_file_id;
          migrated++;
        }
      }
    }
    if (migrated > 0) log.info(`Migrated ${migrated} media entries to products table`);
  } catch (e) {
    log.error('migrateMediaCache error:', e.message);
  }
}

const textsEntitiesCache = {};

async function loadTexts() {
  const { rows } = await pool.query(`SELECT * FROM bot_texts`);
  for (const row of rows) {
    textsCache[row.key] = row.value;
    if (row.entities) {
      textsEntitiesCache[row.key] = typeof row.entities === 'string' ? JSON.parse(row.entities) : row.entities;
    } else {
      delete textsEntitiesCache[row.key];
    }
  }
}

function getProductsMap() {
  const map = {};
  const vipId = textsCache['vip_product_id'];
  const sorted = Object.values(productsCache)
    .filter(p => p.active || (vipId && String(p.id) === vipId))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  for (const p of sorted) {
    map[String(p.id)] = p;
  }
  return map;
}

function getProductsList() {
  return Object.values(productsCache)
    .filter(p => p.active)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function getAllProductsList() {
  return Object.values(productsCache)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function getProductById(id) {
  return productsCache[id] || productsCache[Number(id)] || null;
}

async function createProduct({ name, price, link, description, hot }) {
  const { rows: maxRows } = await pool.query(`SELECT COALESCE(MAX(sort_order), 0) + 1 as next FROM products`);
  const nextOrder = maxRows[0].next;

  const { rows } = await pool.query(
    `INSERT INTO products (name, price, link, description, hot, sort_order) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name, price || 0, link || '', description || '', hot || false, nextOrder]
  );
  const row = rows[0];
  const product = {
    id: row.id,
    name: row.name,
    price: row.price,
    link: row.link || '',
    description: row.description || '',
    descriptionEntities: null,
    deliveryDescription: '',
    deliveryDescriptionEntities: null,
    deliveryMedia: [],
    hot: row.hot,
    active: row.active,
    sortOrder: row.sort_order,
    videoFileId: null,
    previewFileId: null
  };
  productsCache[row.id] = product;
  return product;
}

async function updateProduct(id, fields) {
  const fieldMap = {
    name: 'name',
    price: 'price',
    priceUsd: 'price_usd',
    originalPrice: 'original_price',
    link: 'link',
    description: 'description',
    descriptionEntities: 'description_entities',
    deliveryDescription: 'delivery_description',
    deliveryDescriptionEntities: 'delivery_description_entities',
    hot: 'hot',
    active: 'active',
    sortOrder: 'sort_order',
    videoFileId: 'video_file_id',
    previewFileId: 'preview_file_id'
  };

  const sets = [];
  const vals = [];
  let idx = 1;

  for (const [key, col] of Object.entries(fieldMap)) {
    if (fields[key] !== undefined) {
      sets.push(`${col} = $${idx}`);
      vals.push(fields[key]);
      idx++;
    }
  }

  if (sets.length === 0) return productsCache[id];

  sets.push(`updated_at = NOW()`);
  vals.push(id);

  await pool.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $${idx}`, vals);

  if (productsCache[id]) {
    for (const key of Object.keys(fieldMap)) {
      if (fields[key] !== undefined) {
        productsCache[id][key] = fields[key];
      }
    }
  }

  return productsCache[id];
}

async function deleteProduct(id) {
  await pool.query(`DELETE FROM products WHERE id = $1`, [id]);
  delete productsCache[id];
}

async function reorderProduct(id, direction) {
  const all = getAllProductsList();
  const idx = all.findIndex(p => p.id === Number(id));
  if (idx < 0) return;

  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= all.length) return;

  const current = all[idx];
  const swap = all[swapIdx];
  const tempOrder = current.sortOrder;

  await pool.query(`UPDATE products SET sort_order = $1 WHERE id = $2`, [swap.sortOrder, current.id]);
  await pool.query(`UPDATE products SET sort_order = $1 WHERE id = $2`, [tempOrder, swap.id]);

  productsCache[current.id].sortOrder = swap.sortOrder;
  productsCache[swap.id].sortOrder = tempOrder;
}

async function setProductMedia(id, type, fileId) {
  const col = type === 'video' ? 'video_file_id' : 'preview_file_id';
  const key = type === 'video' ? 'videoFileId' : 'previewFileId';
  await pool.query(`UPDATE products SET ${col} = $1, updated_at = NOW() WHERE id = $2`, [fileId, id]);
  if (productsCache[id]) productsCache[id][key] = fileId;
}

async function removeProductMedia(id, type) {
  const col = type === 'video' ? 'video_file_id' : 'preview_file_id';
  const key = type === 'video' ? 'videoFileId' : 'previewFileId';
  await pool.query(`UPDATE products SET ${col} = NULL, updated_at = NOW() WHERE id = $1`, [id]);
  if (productsCache[id]) productsCache[id][key] = null;
}

function getText(key) {
  return textsCache[key] || '';
}

function getTextEntities(key) {
  return textsEntitiesCache[key] || null;
}

async function setText(key, value, entities) {
  textsCache[key] = value;
  if (entities && entities.length > 0) {
    textsEntitiesCache[key] = entities;
  } else {
    delete textsEntitiesCache[key];
  }
  const entitiesJson = entities && entities.length > 0 ? JSON.stringify(entities) : null;
  await pool.query(
    `INSERT INTO bot_texts (key, value, entities, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, entities = $3, updated_at = NOW()`,
    [key, value, entitiesJson]
  );
}

function getAllTexts() {
  return { ...textsCache };
}

async function expireOverdueOrders() {
  try {
    const { rows } = await pool.query(
      `UPDATE orders SET expired = TRUE
       WHERE paid = FALSE AND expired = FALSE AND expires_at IS NOT NULL AND expires_at < NOW()
       RETURNING code, chat_id, order_kind`
    );
    for (const row of rows) {
      const chatId = Number(row.chat_id);
      const kind = row.order_kind || 'product';
      delete orderCache[row.code];
      // Clear the right "last pending" cache so the user can immediately start
      // a fresh order/topup. Without this, stale pending warnings fire forever.
      if (kind === 'topup') {
        if (userLastTopupCache[chatId] === row.code) delete userLastTopupCache[chatId];
      } else {
        if (userLastOrderCache[chatId] === row.code) delete userLastOrderCache[chatId];
      }
      analyticsCache.expiredOrders++;
      log.payment(`Auto-expired overdue order: ${row.code} | User: ${chatId} | Kind: ${kind}`);
    }
    if (rows.length) {
      await pool.query(
        `UPDATE analytics SET expired_orders = expired_orders + $1 WHERE id = 1`,
        [rows.length]
      );
    }
    return rows.length;
  } catch (e) {
    log.error('expireOverdueOrders error:', e.message);
    return 0;
  }
}

async function createOrder(code, chatId, productId, amountRequired, timeoutSec, orderKind = 'product', bonus = 0) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      `SELECT code FROM orders
       WHERE chat_id = $1 AND order_kind = $2 AND paid = FALSE AND expired = FALSE
       FOR UPDATE`,
      [chatId, orderKind]
    );
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      throw new Error('ACTIVE_ORDER_EXISTS');
    }

    const expiresAt = new Date(Date.now() + timeoutSec * 1000);
    const safeBonus = Number.isFinite(bonus) && bonus > 0 ? Math.floor(bonus) : 0;
    await client.query(
      `INSERT INTO orders (code, chat_id, product_id, amount_required, expires_at, order_kind, bonus_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [code, chatId, productId, amountRequired, expiresAt, orderKind, safeBonus]
    );
    await client.query(`UPDATE analytics SET total_orders = total_orders + 1 WHERE id = 1`);
    await client.query('COMMIT');
    orderCache[code] = {
      chatId, productId, paid: false, amountPaid: 0, amountRequired,
      orderKind,
      bonus: safeBonus,
      time: Date.now(), expiresAt: expiresAt.getTime()
    };
    if (orderKind === 'topup') {
      userLastTopupCache[chatId] = code;
    } else if (orderKind !== 'membership') {
      userLastOrderCache[chatId] = code;
    }
    analyticsCache.totalOrders++;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('createOrder DB error:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

async function processPayment(code, amount, webhookId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: orderRows } = await client.query(
      `SELECT * FROM orders WHERE code = $1 AND paid = FALSE AND expired = FALSE FOR UPDATE`,
      [code]
    );
    if (!orderRows.length) {
      await client.query('ROLLBACK');
      return { notFound: true };
    }

    let inserted = 0;
    try {
      const r = await client.query(
        `INSERT INTO partial_payments (order_code, amount, webhook_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (webhook_id) WHERE webhook_id IS NOT NULL DO NOTHING`,
        [code, amount, webhookId]
      );
      inserted = r.rowCount;
    } catch (e) {
      if (e && e.code === '23503') {
        await client.query('ROLLBACK');
        return { notFound: true };
      }
      throw e;
    }
    if (inserted === 0) {
      await client.query('ROLLBACK');
      return { duplicate: true };
    }

    const rows = orderRows;

    const order = rows[0];
    await client.query(
      `UPDATE orders SET amount_paid = amount_paid + $1 WHERE code = $2`,
      [amount, code]
    );

    const newTotal = order.amount_paid + amount;
    const fulfilled = newTotal >= order.amount_required;

    const orderKind = order.order_kind || 'product';

    if (fulfilled) {
      await client.query(
        `UPDATE orders SET paid = TRUE, paid_at = NOW() WHERE code = $1`, [code]
      );
      // Always count revenue (real cash inflow), regardless of order kind.
      // total_buy / total_spent only increment for product purchases (topups
      // are wallet credits, not film purchases).
      if (orderKind === 'topup') {
        if (shouldCountRevenue(order.chat_id)) {
          await client.query(
            `UPDATE analytics SET successful_orders = successful_orders + 1, total_revenue = total_revenue + $1 WHERE id = 1`,
            [order.amount_required]
          );
        }
        // Tổng số tiền cộng vào ví = mệnh giá nạp + bonus (nếu có KM x2). Bonus đã được
        // khoá sẵn ở orders.bonus_amount lúc tạo đơn nên không phụ thuộc vào trạng thái
        // KM hiện tại — đảm bảo công bằng cho user.
        const orderBonus = Number.isFinite(order.bonus_amount) && order.bonus_amount > 0
          ? Math.floor(order.bonus_amount) : 0;
        const totalCredit = order.amount_required + orderBonus;
        // Credit wallet atomically inside the same transaction.
        const { rows: wRows } = await client.query(
          `INSERT INTO user_stats (chat_id, wallet_balance) VALUES ($1, $2)
           ON CONFLICT (chat_id) DO UPDATE SET wallet_balance = user_stats.wallet_balance + $2
           RETURNING wallet_balance`,
          [Number(order.chat_id), totalCredit]
        );
        const txNote = orderBonus > 0 ? `x2 bonus +${orderBonus}` : '';
        await client.query(
          `INSERT INTO wallet_transactions (chat_id, amount, kind, ref_code, balance_after, note)
           VALUES ($1, $2, 'topup', $3, $4, $5)`,
          [Number(order.chat_id), totalCredit, code, wRows[0].wallet_balance, txNote]
        );
      } else if (orderKind === 'membership') {
        // Phí tham gia → credit vào ví (user nhận lại vào ví để dùng mua phim)
        if (shouldCountRevenue(order.chat_id)) {
          await client.query(
            `UPDATE analytics SET successful_orders = successful_orders + 1, total_revenue = total_revenue + $1 WHERE id = 1`,
            [order.amount_required]
          );
        }
        const { rows: wRows } = await client.query(
          `INSERT INTO user_stats (chat_id, wallet_balance) VALUES ($1, $2)
           ON CONFLICT (chat_id) DO UPDATE SET wallet_balance = user_stats.wallet_balance + $2
           RETURNING wallet_balance`,
          [Number(order.chat_id), order.amount_required]
        );
        await client.query(
          `INSERT INTO wallet_transactions (chat_id, amount, kind, ref_code, balance_after, note)
           VALUES ($1, $2, 'membership', $3, $4, 'Phí tham gia thành viên')`,
          [Number(order.chat_id), order.amount_required, code, wRows[0].wallet_balance]
        );
      } else {
        if (shouldCountRevenue(order.chat_id)) {
          await client.query(
            `UPDATE analytics SET successful_orders = successful_orders + 1, total_revenue = total_revenue + $1 WHERE id = 1`,
            [order.amount_required]
          );
        }
        await client.query(
          `INSERT INTO user_stats (chat_id, total_buy, total_spent) VALUES ($1, 1, $2)
           ON CONFLICT (chat_id) DO UPDATE SET total_buy = user_stats.total_buy + 1, total_spent = user_stats.total_spent + $2`,
          [Number(order.chat_id), order.amount_required]
        );
      }
    }

    await client.query('COMMIT');

    if (orderCache[code]) {
      orderCache[code].amountPaid = newTotal;
    }

    let newBalance = null;
    const orderBonus = (orderKind === 'topup' && Number.isFinite(order.bonus_amount) && order.bonus_amount > 0)
      ? Math.floor(order.bonus_amount) : 0;
    if (fulfilled) {
      const chatId = Number(order.chat_id);
      if (orderCache[code]) orderCache[code].paid = true;
      if (orderKind === 'topup') {
        delete userLastTopupCache[chatId];
      } else if (orderKind !== 'membership') {
        delete userLastOrderCache[chatId];
      }
      delete orderCache[code];
      if (shouldCountRevenue(chatId)) {
        analyticsCache.successfulOrders++;
        analyticsCache.totalRevenue += order.amount_required;
      }
      if (!userStatsCache[chatId]) {
        userStatsCache[chatId] = { totalBuy: 0, totalSpent: 0, joinDate: new Date().toISOString() };
      }
      if (orderKind === 'topup') {
        // Cache cộng cả bonus vì DB cũng cộng cả bonus.
        walletBalanceCache[chatId] = (walletBalanceCache[chatId] || 0) + order.amount_required + orderBonus;
        newBalance = walletBalanceCache[chatId];
      } else if (orderKind === 'membership') {
        walletBalanceCache[chatId] = (walletBalanceCache[chatId] || 0) + order.amount_required;
        newBalance = walletBalanceCache[chatId];
      } else {
        userStatsCache[chatId].totalBuy++;
        userStatsCache[chatId].totalSpent += order.amount_required;
      }
    }

    return {
      fulfilled,
      totalPaid: newTotal,
      chatId: Number(order.chat_id),
      productId: order.product_id,
      amountRequired: order.amount_required,
      orderKind,
      bonus: orderBonus,
      newWalletBalance: newBalance
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('processPayment DB error:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

async function getPartialPayments(code) {
  try {
    const { rows } = await pool.query(
      `SELECT amount, received_at FROM partial_payments WHERE order_code = $1 ORDER BY received_at`,
      [code]
    );
    return rows;
  } catch (e) { log.error('getPartialPayments DB error:', e.message); return []; }
}

async function expireOrder(code, chatId) {
  const cached = orderCache[code];
  const kind = cached && cached.orderKind ? cached.orderKind : 'product';
  delete orderCache[code];
  if (kind === 'topup') delete userLastTopupCache[chatId];
  else if (kind !== 'membership') delete userLastOrderCache[chatId];
  analyticsCache.expiredOrders++;
  try {
    await pool.query(`UPDATE orders SET expired = TRUE WHERE code = $1`, [code]);
    await pool.query(`UPDATE analytics SET expired_orders = expired_orders + 1 WHERE id = 1`);
  } catch (e) { log.error('expireOrder DB error:', e.message); }
}

async function cancelOrder(code, chatId) {
  const cached = orderCache[code];
  const kind = cached && cached.orderKind ? cached.orderKind : 'product';
  delete orderCache[code];
  if (kind === 'topup') delete userLastTopupCache[chatId];
  else if (kind !== 'membership') delete userLastOrderCache[chatId];
  try {
    await pool.query(`DELETE FROM orders WHERE code = $1`, [code]);
  } catch (e) { log.error('cancelOrder DB error:', e.message); }
}

async function adminConfirmOrder(code) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE code = $1 AND paid = FALSE FOR UPDATE`, [code]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    const order = rows[0];
    const orderKind = order.order_kind || 'product';
    await client.query(`UPDATE orders SET paid = TRUE, paid_at = NOW() WHERE code = $1`, [code]);
    if (shouldCountRevenue(order.chat_id)) {
      await client.query(
        `UPDATE analytics SET successful_orders = successful_orders + 1, total_revenue = total_revenue + $1 WHERE id = 1`,
        [order.amount_required]
      );
    }
    let newWalletBalance = null;
    // Bonus đã được khoá ở orders.bonus_amount lúc tạo đơn (xem createOrder/processPayment).
    // Manual confirm cũng phải tôn trọng bonus đã hứa, không vì admin tắt KM giữa chừng mà mất.
    const orderBonus = (orderKind === 'topup' && Number.isFinite(order.bonus_amount) && order.bonus_amount > 0)
      ? Math.floor(order.bonus_amount) : 0;
    if (orderKind === 'topup') {
      const totalCredit = order.amount_required + orderBonus;
      const { rows: wRows } = await client.query(
        `INSERT INTO user_stats (chat_id, wallet_balance) VALUES ($1, $2)
         ON CONFLICT (chat_id) DO UPDATE SET wallet_balance = user_stats.wallet_balance + $2
         RETURNING wallet_balance`,
        [Number(order.chat_id), totalCredit]
      );
      newWalletBalance = wRows[0].wallet_balance;
      const note = orderBonus > 0 ? `admin_confirm + x2 bonus +${orderBonus}` : 'admin_confirm';
      await client.query(
        `INSERT INTO wallet_transactions (chat_id, amount, kind, ref_code, balance_after, note)
         VALUES ($1, $2, 'topup', $3, $4, $5)`,
        [Number(order.chat_id), totalCredit, code, newWalletBalance, note]
      );
    } else {
      await client.query(
        `INSERT INTO user_stats (chat_id, total_buy, total_spent) VALUES ($1, 1, $2)
         ON CONFLICT (chat_id) DO UPDATE SET total_buy = user_stats.total_buy + 1, total_spent = user_stats.total_spent + $2`,
        [Number(order.chat_id), order.amount_required]
      );
    }
    await client.query('COMMIT');

    const chatId = Number(order.chat_id);
    delete orderCache[code];
    if (orderKind === 'topup') delete userLastTopupCache[chatId];
    else if (orderKind !== 'membership') delete userLastOrderCache[chatId];
    if (shouldCountRevenue(chatId)) {
      analyticsCache.successfulOrders++;
      analyticsCache.totalRevenue += order.amount_required;
    }
    if (!userStatsCache[chatId]) {
      userStatsCache[chatId] = { totalBuy: 0, totalSpent: 0, joinDate: new Date().toISOString() };
    }
    if (orderKind === 'topup') {
      walletBalanceCache[chatId] = newWalletBalance;
    } else {
      userStatsCache[chatId].totalBuy++;
      userStatsCache[chatId].totalSpent += order.amount_required;
    }

    return {
      chatId,
      productId: order.product_id,
      amountRequired: order.amount_required,
      orderKind,
      bonus: orderBonus,
      newWalletBalance
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('adminConfirmOrder DB error:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// === Wallet helpers ===========================================================

function isMember(chatId) {
  return memberCache[Number(chatId)] || false;
}

async function setMember(chatId) {
  memberCache[Number(chatId)] = true;
  try {
    await pool.query(
      `INSERT INTO user_stats (chat_id, is_member, member_since)
       VALUES ($1, TRUE, NOW())
       ON CONFLICT (chat_id) DO UPDATE
         SET is_member    = TRUE,
             member_since = COALESCE(user_stats.member_since, NOW())`,
      [Number(chatId)]
    );
  } catch (e) {
    log.error('setMember DB error:', e.message);
  }
}

function getWalletBalance(chatId) {
  return walletBalanceCache[Number(chatId)] || 0;
}

// === KM x2 nạp tiền helpers ===================================================
// isTopupPromoActive: true khi admin đã bật cờ 'promo_x2_topup' = 'on'.
// getTopupPromoMin:    ngưỡng tối thiểu (VND) để được hưởng x2. Mặc định 50.000.
// getTopupBonus:       trả về số tiền BONUS (= mệnh giá) nếu thoả điều kiện, 0 nếu không.
function isTopupPromoActive() {
  const v = (textsCache['promo_x2_topup'] || 'off').toString().toLowerCase().trim();
  return v === 'on' || v === 'true' || v === '1';
}
function getTopupPromoMin() {
  const raw = parseInt((textsCache['promo_x2_min_amount'] || '50000').toString().replace(/[^\d]/g, ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 50000;
}
function getTopupBonus(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (!isTopupPromoActive()) return 0;
  if (amount < getTopupPromoMin()) return 0;
  return Math.floor(amount); // x2 = nạp X được X bonus → tổng 2X
}

// Atomically debit wallet. Returns { ok, balance } where ok=false means insufficient.
// Uses a conditional UPDATE so concurrent debits cannot oversend.
async function debitWallet(chatId, amount, kind = 'purchase', refCode = null, note = '') {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, balance: getWalletBalance(chatId) };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE user_stats SET wallet_balance = wallet_balance - $2
       WHERE chat_id = $1 AND wallet_balance >= $2
       RETURNING wallet_balance`,
      [chatId, amount]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, balance: getWalletBalance(chatId) };
    }
    const newBalance = rows[0].wallet_balance;
    await client.query(
      `INSERT INTO wallet_transactions (chat_id, amount, kind, ref_code, balance_after, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [chatId, -amount, kind, refCode, newBalance, note]
    );
    await client.query('COMMIT');
    walletBalanceCache[Number(chatId)] = newBalance;
    return { ok: true, balance: newBalance };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('debitWallet DB error:', e.message);
    return { ok: false, balance: getWalletBalance(chatId) };
  } finally {
    client.release();
  }
}

// Direct credit (used for refunds or admin adjustments). Topup credits go through
// processPayment so they atomically tie to the order; this is the manual path.
async function creditWallet(chatId, amount, kind = 'admin_adjust', refCode = null, note = '') {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, balance: getWalletBalance(chatId) };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO user_stats (chat_id, wallet_balance) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET wallet_balance = user_stats.wallet_balance + $2
       RETURNING wallet_balance`,
      [chatId, amount]
    );
    const newBalance = rows[0].wallet_balance;
    await client.query(
      `INSERT INTO wallet_transactions (chat_id, amount, kind, ref_code, balance_after, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [chatId, amount, kind, refCode, newBalance, note]
    );
    await client.query('COMMIT');
    walletBalanceCache[Number(chatId)] = newBalance;
    return { ok: true, balance: newBalance };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('creditWallet DB error:', e.message);
    return { ok: false, balance: getWalletBalance(chatId) };
  } finally {
    client.release();
  }
}

// Used by wallet purchases: bump total_buy without touching total_spent (the
// money was already counted at topup time as revenue + spent).
async function incrementUserBuyCount(chatId) {
  try {
    if (ANALYTICS_EXCLUDE_CHAT_IDS.has(Number(chatId))) return;
    await pool.query(
      `INSERT INTO user_stats (chat_id, total_buy) VALUES ($1, 1)
       ON CONFLICT (chat_id) DO UPDATE SET total_buy = user_stats.total_buy + 1`,
      [chatId]
    );
    if (!userStatsCache[chatId]) {
      userStatsCache[chatId] = { totalBuy: 0, totalSpent: 0, joinDate: new Date().toISOString() };
    }
    userStatsCache[chatId].totalBuy++;
  } catch (e) { log.error('incrementUserBuyCount error:', e.message); }
}

async function getWalletTransactions(chatId, limit = 20) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM wallet_transactions WHERE chat_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [chatId, limit]
    );
    return rows;
  } catch (e) { log.error('getWalletTransactions error:', e.message); return []; }
}

async function trackUser(chatId) {
  if (!userStatsCache[chatId]) {
    userStatsCache[chatId] = { totalBuy: 0, totalSpent: 0, joinDate: new Date().toISOString() };
    try {
      await pool.query(
        `INSERT INTO user_stats (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING`,
        [chatId]
      );
    } catch (e) { log.error('trackUser DB error:', e.message); }
  }
}

async function getActiveOrders() {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM orders WHERE paid = FALSE AND expired = FALSE ORDER BY created_at DESC`
    );
    return rows;
  } catch (e) { log.error('getActiveOrders DB error:', e.message); return []; }
}

async function getAllAnalytics() {
  try {
    const { rows } = await pool.query(`SELECT * FROM analytics WHERE id = 1`);
    return rows[0] || analyticsCache;
  } catch (e) { return analyticsCache; }
}

async function getRevenueByPeriod(days) {
  try {
    const ids = [...ANALYTICS_EXCLUDE_CHAT_IDS];
    const { rows } = await pool.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(amount_required), 0) as revenue
       FROM orders
       WHERE paid = TRUE
         AND paid_at >= NOW() - INTERVAL '1 day' * $1
         AND chat_id <> ALL($2::bigint[])`,
      [days, ids]
    );
    return { count: parseInt(rows[0].count), revenue: parseInt(rows[0].revenue) };
  } catch (e) {
    log.error('getRevenueByPeriod error:', e.message);
    return { count: 0, revenue: 0 };
  }
}

async function getSalesByProduct() {
  try {
    const ids = [...ANALYTICS_EXCLUDE_CHAT_IDS];
    const { rows } = await pool.query(
      `SELECT product_id, COUNT(*) as count, SUM(amount_required) as revenue
       FROM orders
       WHERE paid = TRUE AND chat_id <> ALL($1::bigint[])
       GROUP BY product_id ORDER BY count DESC`,
      [ids]
    );
    return rows.map(r => ({
      productId: r.product_id,
      count: parseInt(r.count),
      revenue: parseInt(r.revenue)
    }));
  } catch (e) {
    log.error('getSalesByProduct error:', e.message);
    return [];
  }
}

async function getTopProducts(limit = 5) {
  try {
    const ids = [...ANALYTICS_EXCLUDE_CHAT_IDS];
    const { rows } = await pool.query(
      `SELECT product_id, COUNT(*) as count, SUM(amount_required) as revenue
       FROM orders
       WHERE paid = TRUE AND chat_id <> ALL($2::bigint[])
       GROUP BY product_id ORDER BY count DESC LIMIT $1`,
      [limit, ids]
    );
    return rows.map(r => ({
      productId: r.product_id,
      count: parseInt(r.count),
      revenue: parseInt(r.revenue)
    }));
  } catch (e) {
    log.error('getTopProducts error:', e.message);
    return [];
  }
}

async function getTotalUsersCount() {
  try {
    const ids = [...ANALYTICS_EXCLUDE_CHAT_IDS];
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM user_stats
       WHERE chat_id <> ALL($1::bigint[])`,
      [ids]
    );
    return parseInt(rows[0].cnt) || 0;
  } catch (e) {
    log.error('getTotalUsersCount error:', e.message);
    return 0;
  }
}

async function getActiveBuyersCount() {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as cnt
       FROM user_stats
       WHERE total_buy > 0
         AND chat_id <> ALL($1::bigint[])`,
      [[...ANALYTICS_EXCLUDE_CHAT_IDS]]
    );
    return parseInt(rows[0].cnt);
  } catch (e) { return 0; }
}

async function cleanupExcludedAnalytics() {
  try {
    const ids = [...ANALYTICS_EXCLUDE_CHAT_IDS];
    if (!ids.length) return;
    await pool.query(`DELETE FROM user_purchases WHERE chat_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM orders WHERE chat_id = ANY($1::bigint[])`);
    await pool.query(`DELETE FROM wallet_transactions WHERE chat_id = ANY($1::bigint[])`);
    await pool.query(`DELETE FROM user_stats WHERE chat_id = ANY($1::bigint[])`);
  } catch (e) {
    log.error('cleanupExcludedAnalytics error:', e.message);
  }
}

async function addDeliveryMedia(productId, mediaType, fileId) {
  const { rows: maxRows } = await pool.query(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 as next FROM delivery_media WHERE product_id = $1`,
    [productId]
  );
  const nextOrder = maxRows[0].next;
  const { rows } = await pool.query(
    `INSERT INTO delivery_media (product_id, media_type, file_id, sort_order) VALUES ($1, $2, $3, $4) RETURNING *`,
    [productId, mediaType, fileId, nextOrder]
  );
  const row = rows[0];
  const item = { id: row.id, type: row.media_type, fileId: row.file_id, sortOrder: row.sort_order };
  if (productsCache[productId]) {
    if (!productsCache[productId].deliveryMedia) productsCache[productId].deliveryMedia = [];
    productsCache[productId].deliveryMedia.push(item);
  }
  return item;
}

async function removeDeliveryMedia(mediaId) {
  const { rows } = await pool.query(`DELETE FROM delivery_media WHERE id = $1 RETURNING product_id`, [mediaId]);
  if (rows.length && productsCache[rows[0].product_id]) {
    const p = productsCache[rows[0].product_id];
    p.deliveryMedia = (p.deliveryMedia || []).filter(m => m.id !== mediaId);
  }
}

function getDeliveryMedia(productId) {
  const p = productsCache[productId];
  return p ? (p.deliveryMedia || []) : [];
}

async function recordPurchase(chatId, productId, productName, orderCode) {
  try {
    if (ANALYTICS_EXCLUDE_CHAT_IDS.has(Number(chatId))) return;
    await pool.query(
      `INSERT INTO user_purchases (chat_id, product_id, product_name, order_code) VALUES ($1, $2, $3, $4)`,
      [chatId, productId, productName, orderCode]
    );
  } catch (e) { log.error('recordPurchase error:', e.message); }
}

async function getUserPurchases(chatId) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM user_purchases WHERE chat_id = $1 AND expires_at > NOW() ORDER BY paid_at DESC LIMIT 50`,
      [chatId]
    );
    return rows.map(r => ({
      id: r.id, productId: r.product_id, productName: r.product_name,
      orderCode: r.order_code, paidAt: r.paid_at, expiresAt: r.expires_at
    }));
  } catch (e) { log.error('getUserPurchases error:', e.message); return []; }
}

async function cleanupExpiredPurchases() {
  try {
    const { rowCount } = await pool.query(`DELETE FROM user_purchases WHERE expires_at < NOW()`);
    if (rowCount > 0) log.info(`Cleaned up ${rowCount} expired purchase records`);
  } catch (e) { log.error('cleanupExpiredPurchases error:', e.message); }
}

async function addPoints(chatId, points) {
  try {
    await pool.query(
      `INSERT INTO user_stats (chat_id, points) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET points = user_stats.points + $2`,
      [chatId, points]
    );
    if (!userStatsCache[chatId]) userStatsCache[chatId] = { totalBuy: 0, totalSpent: 0, points: 0 };
    userStatsCache[chatId].points = (userStatsCache[chatId].points || 0) + points;
  } catch (e) { log.error('addPoints error:', e.message); }
}

async function getPoints(chatId) {
  try {
    const { rows } = await pool.query(`SELECT points FROM user_stats WHERE chat_id = $1`, [chatId]);
    return rows.length ? (rows[0].points || 0) : 0;
  } catch (e) { return 0; }
}

async function touchUserActive(chatId) {
  try {
    await pool.query(
      `INSERT INTO user_stats (chat_id, last_active_at) VALUES ($1, NOW())
       ON CONFLICT (chat_id) DO UPDATE SET last_active_at = NOW()`,
      [chatId]
    );
  } catch (e) {}
}

async function getSleepingUsers(daysIdle = 7, daysReengageCooldown = 14, limit = 50) {
  try {
    const { rows } = await pool.query(
      `SELECT chat_id FROM user_stats
       WHERE last_active_at < NOW() - INTERVAL '1 day' * $1
         AND (last_reengage_at IS NULL OR last_reengage_at < NOW() - INTERVAL '1 day' * $2)
       ORDER BY last_active_at ASC LIMIT $3`,
      [daysIdle, daysReengageCooldown, limit]
    );
    return rows.map(r => Number(r.chat_id));
  } catch (e) { log.error('getSleepingUsers error:', e.message); return []; }
}

// Trả về { paid, expired } cho 1 đơn hàng từ DB (không dùng cache vì cache có thể đã bị xoá khi đơn expire/paid).
// null nếu không tìm thấy mã đơn.
async function getOrderStatus(code) {
  try {
    const { rows } = await pool.query(
      `SELECT paid, expired FROM orders WHERE code = $1`,
      [code]
    );
    if (!rows.length) return null;
    return { paid: !!rows[0].paid, expired: !!rows[0].expired };
  } catch (e) { return null; }
}

async function markReengageSent(chatId) {
  try {
    await pool.query(`UPDATE user_stats SET last_reengage_at = NOW() WHERE chat_id = $1`, [chatId]);
  } catch (e) {}
}

// Kiểm tra xem có nên gửi re-engage cho user hay không.
// - cooldownHours: chưa được gửi re-engage trong N giờ qua (mặc định 24h ⇒ tối đa 1 lần/ngày)
// - recentActivityMinutes: nếu user vừa tương tác trong N phút qua thì khoan gửi
//   (giảm độ "chủ động" — tránh push khi user đang dùng bot)
// Trả về true nếu đủ điều kiện gửi.
async function canReengageUser(chatId, cooldownHours = 24, recentActivityMinutes = 5) {
  try {
    const { rows } = await pool.query(
      `SELECT last_reengage_at, last_active_at FROM user_stats WHERE chat_id = $1`,
      [chatId]
    );
    if (!rows.length) return true; // chưa có hồ sơ ⇒ cứ gửi
    const r = rows[0];
    if (r.last_reengage_at) {
      const sinceLast = Date.now() - new Date(r.last_reengage_at).getTime();
      if (sinceLast < cooldownHours * 3_600_000) return false;
    }
    if (r.last_active_at) {
      const sinceActive = Date.now() - new Date(r.last_active_at).getTime();
      if (sinceActive < recentActivityMinutes * 60_000) return false;
    }
    return true;
  } catch (e) {
    return true; // lỗi DB ⇒ fallback cho phép, tránh chặn nhầm hệ thống
  }
}

async function listCoupons() {
  try {
    const { rows } = await pool.query(`SELECT * FROM coupons ORDER BY created_at DESC`);
    return rows;
  } catch (e) { return []; }
}

async function getCoupon(code) {
  try {
    const { rows } = await pool.query(`SELECT * FROM coupons WHERE code = $1`, [String(code).toUpperCase()]);
    return rows[0] || null;
  } catch (e) { return null; }
}

async function createCoupon({ code, discountType, discountValue, maxUses, expiresAt }) {
  try {
    await pool.query(
      `INSERT INTO coupons (code, discount_type, discount_value, max_uses, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO UPDATE SET discount_type=$2, discount_value=$3, max_uses=$4, expires_at=$5, active=TRUE`,
      [String(code).toUpperCase(), discountType, discountValue, maxUses || 0, expiresAt || null]
    );
    return true;
  } catch (e) { log.error('createCoupon error:', e.message); return false; }
}

async function deleteCoupon(code) {
  try { await pool.query(`DELETE FROM coupons WHERE code = $1`, [String(code).toUpperCase()]); } catch (e) {}
}

async function validateAndConsumeCoupon(code, chatId, baseAmount) {
  const c = await getCoupon(code);
  if (!c) return { ok: false, reason: 'Mã không tồn tại' };
  if (!c.active) return { ok: false, reason: 'Mã đã ngưng' };
  if (c.expires_at && new Date(c.expires_at) < new Date()) return { ok: false, reason: 'Mã đã hết hạn' };
  if (c.max_uses > 0 && c.used_count >= c.max_uses) return { ok: false, reason: 'Mã đã hết lượt sử dụng' };
  try {
    const { rows } = await pool.query(`SELECT 1 FROM coupon_uses WHERE code = $1 AND chat_id = $2`,
      [c.code, chatId]);
    if (rows.length) return { ok: false, reason: 'Bạn đã dùng mã này' };
  } catch (e) {}
  let discount = 0;
  if (c.discount_type === 'percent') discount = Math.floor(baseAmount * c.discount_value / 100);
  else discount = Math.min(baseAmount, c.discount_value);
  if (discount <= 0) return { ok: false, reason: 'Mã không áp dụng được' };
  return { ok: true, coupon: c, discount };
}

async function commitCouponUse(code, chatId, orderCode) {
  try {
    await pool.query(
      `INSERT INTO coupon_uses (code, chat_id, order_code) VALUES ($1, $2, $3)
       ON CONFLICT (code, chat_id) DO NOTHING`,
      [code, chatId, orderCode]
    );
    await pool.query(`UPDATE coupons SET used_count = used_count + 1 WHERE code = $1`, [code]);
  } catch (e) { log.error('commitCouponUse error:', e.message); }
}

async function applyDiscountToOrder(orderCode, couponCode, newAmount, discount) {
  try {
    await pool.query(
      `UPDATE orders SET amount_required = $1, discount_amount = $2, coupon_code = $3 WHERE code = $4 AND paid = FALSE`,
      [newAmount, discount, couponCode, orderCode]
    );
    if (orderCache[orderCode]) {
      orderCache[orderCode].amountRequired = newAmount;
      orderCache[orderCode].discount = discount;
      orderCache[orderCode].couponCode = couponCode;
    }
  } catch (e) { log.error('applyDiscountToOrder error:', e.message); }
}

function _scopeWhere(scope) {
  if (scope === 'hot') return 'active = TRUE AND hot = TRUE';
  if (scope === 'cold') return 'active = TRUE AND hot = FALSE';
  return 'active = TRUE';
}

// pct: integer like -10, 20. scope: 'all'|'hot'|'cold'.
// stampOriginal: when reducing price, snapshot current price into original_price (only if not yet stamped).
async function bulkUpdatePrices(pct, scope = 'all', stampOriginal = true) {
  try {
    const where = _scopeWhere(scope);
    const mult = String(1 + (pct / 100));
    let stampSql = '';
    if (pct < 0 && stampOriginal) {
      stampSql = `, original_price = CASE
                    WHEN COALESCE(original_price,0) > price THEN original_price
                    ELSE price
                  END`;
    } else if (pct >= 0 && stampOriginal) {
      // raising back: if new price >= original_price, clear sale tag
      stampSql = `, original_price = CASE
                    WHEN COALESCE(original_price,0) <= GREATEST(1000, ROUND(price * $1::NUMERIC / 1000)::INTEGER * 1000) THEN 0
                    ELSE original_price
                  END`;
    }
    const { rowCount } = await pool.query(
      `UPDATE products
         SET price = GREATEST(1000, ROUND(price * $1::NUMERIC / 1000)::INTEGER * 1000)
             ${stampSql},
             updated_at = NOW()
       WHERE ${where}`,
      [mult]
    );
    await loadProducts();
    return rowCount;
  } catch (e) { log.error('bulkUpdatePrices error:', e.message); return 0; }
}

async function restoreOriginalPrices(scope = 'all') {
  try {
    const where = _scopeWhere(scope);
    // Snapshot must include EVERY row the UPDATE will touch, otherwise undo loses data.
    const { rows } = await pool.query(
      `SELECT id, price, original_price FROM products
        WHERE ${where} AND COALESCE(original_price,0) > 0`
    );
    if (!rows.length) return { count: 0, snapshot: [] };
    const snapshot = rows.map(r => ({ id: r.id, price: r.price, originalPrice: r.original_price }));
    const changedCount = rows.filter(r => r.original_price !== r.price).length;
    if (!changedCount) return { count: 0, snapshot: [] };
    await pool.query(
      `UPDATE products
          SET price = original_price, original_price = 0, updated_at = NOW()
        WHERE ${where} AND COALESCE(original_price,0) > 0`
    );
    await loadProducts();
    return { count: rows.length, snapshot };
  } catch (e) { log.error('restoreOriginalPrices error:', e.message); return { count: 0, snapshot: [] }; }
}

async function applyPriceSnapshot(snapshot) {
  if (!snapshot || !snapshot.length) return 0;
  try {
    for (const s of snapshot) {
      await pool.query(
        `UPDATE products SET price = $1, original_price = $2, updated_at = NOW() WHERE id = $3`,
        [s.price, s.originalPrice || 0, s.id]
      );
    }
    await loadProducts();
    return snapshot.length;
  } catch (e) { log.error('applyPriceSnapshot error:', e.message); return 0; }
}

// ---- scheduled sales ----

async function createScheduledSale({ pct, scope, startsAt, endsAt }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO scheduled_sales (pct, scope, starts_at, ends_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [pct, scope || 'all', startsAt, endsAt]
    );
    return rows[0].id;
  } catch (e) { log.error('createScheduledSale error:', e.message); return null; }
}

async function listScheduledSales() {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_sales
        WHERE reverted_at IS NULL AND ends_at > NOW() - INTERVAL '1 day'
        ORDER BY starts_at ASC LIMIT 50`
    );
    return rows;
  } catch (e) { return []; }
}

async function deleteScheduledSale(id) {
  try {
    // If currently applied (active) and not reverted yet, restore snapshot first
    const { rows } = await pool.query(`SELECT * FROM scheduled_sales WHERE id = $1`, [id]);
    if (rows.length && rows[0].applied_at && !rows[0].reverted_at && rows[0].snapshot) {
      await applyPriceSnapshot(rows[0].snapshot);
    }
    await pool.query(`DELETE FROM scheduled_sales WHERE id = $1`, [id]);
    return true;
  } catch (e) { log.error('deleteScheduledSale error:', e.message); return false; }
}

async function getDueSalesToApply() {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_sales
        WHERE applied_at IS NULL AND starts_at <= NOW() AND ends_at > NOW()`
    );
    return rows;
  } catch (e) { return []; }
}

async function getDueSalesToRevert() {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_sales
        WHERE applied_at IS NOT NULL AND reverted_at IS NULL AND ends_at <= NOW()`
    );
    return rows;
  } catch (e) { return []; }
}

async function markSaleApplied(id, snapshot) {
  try {
    await pool.query(
      `UPDATE scheduled_sales SET applied_at = NOW(), snapshot = $1 WHERE id = $2`,
      [JSON.stringify(snapshot), id]
    );
  } catch (e) { log.error('markSaleApplied error:', e.message); }
}

async function markSaleReverted(id) {
  try {
    await pool.query(`UPDATE scheduled_sales SET reverted_at = NOW() WHERE id = $1`, [id]);
  } catch (e) { log.error('markSaleReverted error:', e.message); }
}

async function snapshotProductsForScope(scope) {
  try {
    const where = _scopeWhere(scope);
    const { rows } = await pool.query(
      `SELECT id, price, COALESCE(original_price,0) AS original_price FROM products WHERE ${where}`
    );
    return rows.map(r => ({ id: r.id, price: r.price, originalPrice: r.original_price }));
  } catch (e) { return []; }
}

async function getHotProductForReengage() {
  const list = getProductsList().filter(p => p.hot);
  if (!list.length) return getProductsList()[0] || null;
  return list[Math.floor(Math.random() * list.length)];
}

async function loadBans() {
  try {
    const { rows } = await pool.query(
      `SELECT chat_id, banned_until FROM user_bans WHERE banned_until > NOW()`
    );
    banCache.clear();
    for (const r of rows) {
      banCache.set(Number(r.chat_id), new Date(r.banned_until).getTime());
    }
  } catch (e) { log.error('loadBans error:', e.message); }
}

function isBanned(chatId) {
  const id = Number(chatId);
  const until = banCache.get(id);
  if (!until) return 0;
  if (Date.now() >= until) {
    banCache.delete(id);
    pool.query(`DELETE FROM user_bans WHERE chat_id = $1`, [id]).catch(() => {});
    return 0;
  }
  return until;
}

// Trả về danh sách user đang bị cấm còn hiệu lực, sắp xếp theo thời điểm hết hạn xa nhất trước.
async function listActiveBans() {
  try {
    const { rows } = await pool.query(
      `SELECT chat_id, banned_until, reason, created_at FROM user_bans
       WHERE banned_until > NOW() ORDER BY banned_until DESC LIMIT 50`
    );
    return rows.map(r => ({
      chatId: Number(r.chat_id),
      bannedUntil: new Date(r.banned_until).getTime(),
      reason: r.reason || '',
      createdAt: new Date(r.created_at).getTime()
    }));
  } catch (e) { log.error('listActiveBans error:', e.message); return []; }
}

// Mở khoá thủ công (admin). Trả về true nếu xoá được record (đã từng bị cấm).
async function unbanUser(chatId) {
  const id = Number(chatId);
  try {
    const r = await pool.query(`DELETE FROM user_bans WHERE chat_id = $1`, [id]);
    banCache.delete(id);
    return r.rowCount > 0;
  } catch (e) { log.error('unbanUser error:', e.message); return false; }
}

async function setBan(chatId, durationMs, reason = '') {
  const untilMs = Date.now() + durationMs;
  const until = new Date(untilMs);
  try {
    await pool.query(
      `INSERT INTO user_bans (chat_id, banned_until, reason) VALUES ($1, $2, $3)
       ON CONFLICT (chat_id) DO UPDATE SET banned_until = EXCLUDED.banned_until, reason = EXCLUDED.reason`,
      [chatId, until, reason]
    );
    banCache.set(Number(chatId), untilMs);
  } catch (e) { log.error('setBan error:', e.message); }
  return untilMs;
}

async function recordCancel(chatId, windowMs = 24 * 60 * 60 * 1000) {
  try {
    await pool.query(`INSERT INTO user_cancels (chat_id) VALUES ($1)`, [chatId]);
    const cutoff = new Date(Date.now() - windowMs);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM user_cancels WHERE chat_id = $1 AND cancelled_at > $2`,
      [chatId, cutoff]
    );
    return rows[0]?.n || 0;
  } catch (e) {
    log.error('recordCancel error:', e.message);
    return 0;
  }
}

// Lightweight cleanup: drop cancel rows older than 7d (called rarely)
async function cleanupOldCancels() {
  try {
    await pool.query(`DELETE FROM user_cancels WHERE cancelled_at < NOW() - INTERVAL '7 days'`);
  } catch {}
}

module.exports = {
  init,
  get products() { return getProductsMap(); },
  getProductsList,
  getAllProductsList,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  reorderProduct,
  setProductMedia,
  removeProductMedia,
  isMember,
  setMember,
  getText,
  getTextEntities,
  setText,
  getAllTexts,
  get orders() { return orderCache; },
  get userLastOrder() { return userLastOrderCache; },
  get userLastTopup() { return userLastTopupCache; },
  get userStats() { return userStatsCache; },
  get analytics() { return analyticsCache; },
  getWalletBalance,
  debitWallet,
  creditWallet,
  isTopupPromoActive,
  getTopupPromoMin,
  getTopupBonus,
  incrementUserBuyCount,
  getWalletTransactions,
  createOrder,
  processPayment,
  getPartialPayments,
  expireOrder,
  expireOverdueOrders,
  cancelOrder,
  adminConfirmOrder,
  trackUser,
  getActiveOrders,
  getAllAnalytics,
  getRevenueByPeriod,
  getSalesByProduct,
  getTopProducts,
  getActiveBuyersCount,
  getTotalUsersCount,
  addDeliveryMedia,
  removeDeliveryMedia,
  getDeliveryMedia,
  recordPurchase,
  getUserPurchases,
  cleanupExpiredPurchases,
  addPoints,
  getPoints,
  touchUserActive,
  getSleepingUsers,
  markReengageSent,
  canReengageUser,
  getOrderStatus,
  listCoupons,
  getCoupon,
  createCoupon,
  deleteCoupon,
  validateAndConsumeCoupon,
  commitCouponUse,
  applyDiscountToOrder,
  bulkUpdatePrices,
  restoreOriginalPrices,
  applyPriceSnapshot,
  snapshotProductsForScope,
  createScheduledSale,
  listScheduledSales,
  deleteScheduledSale,
  getDueSalesToApply,
  getDueSalesToRevert,
  markSaleApplied,
  markSaleReverted,
  getHotProductForReengage,
  isBanned,
  setBan,
  unbanUser,
  listActiveBans,
  recordCancel,
  cleanupOldCancels,
  setMediaFileId: setProductMedia,
  removeMedia: removeProductMedia,
  getMedia: (id) => {
    const p = getProductById(id);
    return p ? { videoFileId: p.videoFileId, previewFileId: p.previewFileId } : { videoFileId: null, previewFileId: null };
  },
  save: () => {}
};
