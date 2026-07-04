/**
 * ============================================================
 * SRAY BOT V1 - Production-ready single-file Cloudflare Worker
 * Final fixed version (spread fixes, missing tables, unique constraints,
 * router/debug logs, safety checks).
 * ============================================================
 */

/* eslint-disable no-unused-vars */
/* global fetch, Response, crypto */

//
// CONFIG
//
const CONFIG = {
  BOT_NAME: "SRAY",
  BOT_USERNAME: "thesraybot",
  VERSION: "1.0.0",
  MEMORY_TTL: 86400, // 24h
  MESSAGE_TTL: 86400,
  DAILY_REWARD: 2000,
  WEEKLY_REWARD: 5000,
  STARTING_BALANCE: 200,
  TAXES: {
    GIVE: 0.07,
    ROB: 0.06,
    KILL: 0.05,
    CARD: 0.08
  },
  MIGRATION_VERSION: 1
};

//
// Simple logging
//
const Log = {
  info: (...args) => console.log("[INFO]", ...args),
  warn: (...args) => console.warn("[WARN]", ...args),
  error: (...args) => console.error("[ERROR]", ...args)
};

//
// Time helpers
//
const Time = {
  now() {
    return Math.floor(Date.now() / 1000);
  },
  future(seconds) {
    return this.now() + seconds;
  },
  format(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    let output = "";
    if (days > 0) output += `${days}d `;
    if (hours > 0) output += `${hours}h `;
    if (mins > 0) output += `${mins}m`;
    return output.trim();
  }
};

//
// ENV validation
//
function validateEnvironment(env) {
  const required = ["BOT_TOKEN", "DB", "OWNER_ID", "SECRET_HOOK"];
  const missing = required.filter((r) => !env[r]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

//
// DB wrapper (Cloudflare D1)
//
const DB = {};

DB.query = async function (env, query, binds = []) {
  try {
    return await env.DB.prepare(query).bind(...binds).all();
  } catch (e) {
    Log.error("DB QUERY ERROR", e, query, binds);
    throw e;
  }
};

DB.first = async function (env, query, binds = []) {
  try {
    return await env.DB.prepare(query).bind(...binds).first();
  } catch (e) {
    Log.error("DB FIRST ERROR", e, query, binds);
    throw e;
  }
};

DB.run = async function (env, query, binds = []) {
  try {
    return await env.DB.prepare(query).bind(...binds).run();
  } catch (e) {
    Log.error("DB RUN ERROR", e, query, binds);
    throw e;
  }
};

/**
 * Atomic balance update helper (uses batch if available)
 */
DB.updateBalanceAtomic = async function (env, userId, delta) {
  try {
    if (typeof env.DB.batch === "function") {
      const stmts = [
        {
          sql: `
            UPDATE users
            SET balance = balance + ?,
                total_earned = total_earned + CASE WHEN ? > 0 THEN ? ELSE 0 END,
                total_spent = total_spent + CASE WHEN ? < 0 THEN ABS(?) ELSE 0 END,
                updated_at = ?
            WHERE user_id = ?
          `,
          params: [delta, delta, delta, delta, delta, Time.now(), userId]
        },
        {
          sql: `SELECT balance FROM users WHERE user_id = ?`,
          params: [userId]
        }
      ];
      const res = await env.DB.batch(stmts);
      const rows = res[1]?.results || [];
      return rows[0]?.balance ?? null;
    } else {
      await DB.run(
        env,
        `
          UPDATE users
          SET balance = balance + ?,
              total_earned = total_earned + CASE WHEN ? > 0 THEN ? ELSE 0 END,
              total_spent = total_spent + CASE WHEN ? < 0 THEN ABS(?) ELSE 0 END,
              updated_at = ?
          WHERE user_id = ?
        `,
        [delta, delta, delta, delta, delta, Time.now(), userId]
      );
      const row = await DB.first(env, `SELECT balance FROM users WHERE user_id = ?`, [userId]);
      return row ? row.balance : null;
    }
  } catch (e) {
    Log.error("updateBalanceAtomic failed", e, userId, delta);
    throw e;
  }
};

//
// Migration / schema init
//
DB.initSchema = async function (env) {
  try {
    await DB.run(
      env,
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL,
        applied_at INTEGER NOT NULL
      )`
    );

    const cur = await DB.first(env, `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`);
    const currentVersion = cur ? cur.version : 0;

    if (currentVersion >= CONFIG.MIGRATION_VERSION) {
      Log.info("DB schema up-to-date", currentVersion);
      return;
    }

    Log.info("Applying migrations up to version", CONFIG.MIGRATION_VERSION);

    const statements = [
      `CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        title TEXT DEFAULT '',
        intro TEXT DEFAULT '',
        balance INTEGER DEFAULT ${CONFIG.STARTING_BALANCE},
        total_earned INTEGER DEFAULT 0,
        total_spent INTEGER DEFAULT 0,
        kills INTEGER DEFAULT 0,
        robs INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        highest_points INTEGER DEFAULT 0,
        streak INTEGER DEFAULT 0,
        reputation INTEGER DEFAULT 0,
        status TEXT DEFAULT 'alive',
        protected_until INTEGER DEFAULT 0,
        dead_until INTEGER DEFAULT 0,
        is_bot INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS groups (
        chat_id INTEGER PRIMARY KEY,
        title TEXT,
        username TEXT,
        type TEXT,
        save_mode INTEGER DEFAULT 0,
        web_enabled INTEGER DEFAULT 0,
        economy_enabled INTEGER DEFAULT 1,
        rules TEXT DEFAULT '',
        welcome_message TEXT DEFAULT '',
        goodbye_message TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS profiles (
        user_id INTEGER PRIMARY KEY,
        intro TEXT,
        title TEXT,
        reputation INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS treasury (
        id INTEGER PRIMARY KEY,
        balance INTEGER DEFAULT 0
      )`,

      `CREATE TABLE IF NOT EXISTS treasury_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT,
        amount INTEGER,
        reference_id TEXT,
        created_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER,
        receiver_id INTEGER,
        amount INTEGER,
        tax INTEGER,
        type TEXT,
        created_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS inventory (
        user_id INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        quantity INTEGER DEFAULT 0,
        PRIMARY KEY(user_id, item_id)
      )`,

      `CREATE TABLE IF NOT EXISTS shop_items (
        item_id TEXT PRIMARY KEY,
        name TEXT,
        emoji TEXT,
        price INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS ai_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER,
        user_id INTEGER,
        role TEXT,
        content TEXT,
        created_at INTEGER,
        expires_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS message_store (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER,
        chat_id INTEGER,
        user_id INTEGER,
        username TEXT,
        text TEXT,
        created_at INTEGER,
        expires_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS save_settings (
        chat_id INTEGER PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        enabled_by INTEGER,
        updated_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        admin_id INTEGER,
        chat_id INTEGER,
        reason TEXT,
        created_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS group_rules (
        chat_id INTEGER PRIMARY KEY,
        rules TEXT,
        updated_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS global_bans (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        reason TEXT,
        banned_by INTEGER,
        created_at INTEGER
      )`,

      // locks needs unique constraint to support ON CONFLICT(chat_id, lock_type)
      `CREATE TABLE IF NOT EXISTS locks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        lock_type TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        updated_by INTEGER,
        updated_at INTEGER,
        UNIQUE(chat_id, lock_type)
      )`,

      `CREATE TABLE IF NOT EXISTS protections (
        chat_id INTEGER,
        type TEXT,
        enabled INTEGER DEFAULT 0,
        PRIMARY KEY (chat_id, type)
      )`,

      `CREATE TABLE IF NOT EXISTS antispam_users (
        chat_id INTEGER,
        user_id INTEGER,
        enabled INTEGER DEFAULT 1,
        PRIMARY KEY(chat_id, user_id)
      )`,

      `CREATE TABLE IF NOT EXISTS message_tracker (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER,
        user_id INTEGER,
        created_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS join_tracker (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER,
        user_id INTEGER,
        joined_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS card_matches (
        match_id TEXT PRIMARY KEY,
        chat_id INTEGER,
        creator_id INTEGER,
        bet_amount INTEGER,
        status TEXT,
        created_at INTEGER,
        expires_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS card_players (
        match_id TEXT,
        user_id INTEGER,
        joined_at INTEGER,
        PRIMARY KEY(match_id, user_id)
      )`,

      `CREATE TABLE IF NOT EXISTS card_hands (
        match_id TEXT,
        user_id INTEGER,
        card_a TEXT,
        card_b TEXT,
        card_c TEXT,
        card_d TEXT,
        score INTEGER,
        strikes INTEGER,
        PRIMARY KEY(match_id, user_id)
      )`,

      `CREATE TABLE IF NOT EXISTS card_moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT,
        round INTEGER,
        user_id INTEGER,
        selected_card TEXT,
        created_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS card_state (
        match_id TEXT PRIMARY KEY,
        current_round INTEGER DEFAULT 1
      )`,

      `CREATE TABLE IF NOT EXISTS card_predictions (
        match_id TEXT,
        user_id INTEGER,
        prediction INTEGER,
        PRIMARY KEY(match_id, user_id)
      )`,

      `CREATE TABLE IF NOT EXISTS card_disqualified (
        match_id TEXT,
        user_id INTEGER,
        PRIMARY KEY(match_id, user_id)
      )`,

      `CREATE TABLE IF NOT EXISTS combat_status (
        user_id INTEGER PRIMARY KEY,
        status TEXT DEFAULT 'alive',
        protected_until INTEGER,
        dead_until INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS scheduled_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER,
        content TEXT,
        media_url TEXT,
        send_at INTEGER,
        created_at INTEGER,
        created_by INTEGER,
        sent INTEGER DEFAULT 0
      )`,

      `CREATE TABLE IF NOT EXISTS search_cache (
        cache_key TEXT PRIMARY KEY,
        value TEXT,
        expires_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS rate_limits (
        user_id INTEGER,
        action TEXT,
        requests INTEGER DEFAULT 0,
        expires_at INTEGER,
        PRIMARY KEY(user_id, action)
      )`,

      `CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_type TEXT,
        user_id INTEGER,
        chat_id INTEGER,
        metadata TEXT,
        created_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS error_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location TEXT,
        error TEXT,
        created_at INTEGER
      )`,

      `CREATE TABLE IF NOT EXISTS settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS scheduled_cleanup (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT,
        row_id INTEGER,
        delete_at INTEGER
      )`,

      // cooldowns missing in previous schemas - add it
      `CREATE TABLE IF NOT EXISTS cooldowns (
        user_id INTEGER,
        command TEXT,
        expires_at INTEGER,
        PRIMARY KEY(user_id, command)
      )`
    ];

    for (const sql of statements) {
      await DB.run(env, sql);
    }

    // Ensure treasury row exists
    await DB.run(env, `INSERT OR IGNORE INTO treasury (id, balance) VALUES (1, 0)`);

    // indexes
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_message_store_chat on message_store(chat_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_memory_chat on ai_memory(chat_id)`,
      `CREATE INDEX IF NOT EXISTS idx_card_matches_chat on card_matches(chat_id)`,
      `CREATE INDEX IF NOT EXISTS idx_card_players_match on card_players(match_id)`,
      `CREATE INDEX IF NOT EXISTS idx_users_balance on users(balance)`,
      `CREATE INDEX IF NOT EXISTS idx_global_bans_user on global_bans(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_protections_chat_type on protections(chat_id, type)`
    ];
    for (const idx of indexes) await DB.run(env, idx);

    await DB.run(env, `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, [
      CONFIG.MIGRATION_VERSION,
      Time.now()
    ]);

    Log.info("Migrations applied");
  } catch (e) {
    Log.error("DB.initSchema failed", e);
    throw e;
  }
};

//
// Telegram wrapper with retry logic
//
const TG = {
  api(env, method) {
    return `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  },

  async call(env, method, payload = {}) {
    try {
      const res = await fetch(this.api(env, method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (parseErr) {
        Log.error(`Telegram parse error (${method})`, parseErr, text);
        return null;
      }
      if (json && json.ok === false) {
        Log.error(`Telegram API returned error (${method})`, json);
      }
      return json;
    } catch (err) {
      Log.error(`Telegram API Error (${method})`, err);
      return null;
    }
  },

  async sendMessage(env, chatId, text, replyTo = null) {
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    };
    if (replyTo) payload.reply_to_message_id = replyTo;
    return await this.call(env, "sendMessage", payload);
  },

  async editMessage(env, chatId, messageId, text) {
    return await this.call(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML"
    });
  },

  async deleteMessage(env, chatId, messageId) {
    return await this.call(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
  },

  async sendPhoto(env, chatId, photo, caption = "") {
    return await this.call(env, "sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML" });
  },

  async sendAnimation(env, chatId, animation, caption = "") {
    return await this.call(env, "sendAnimation", { chat_id: chatId, animation, caption, parse_mode: "HTML" });
  },

  async sendDice(env, chatId, emoji = "🎲") {
    return await this.call(env, "sendDice", { chat_id: chatId, emoji });
  },

  async getMember(env, chatId, userId) {
    return await this.call(env, "getChatMember", { chat_id: chatId, user_id: userId });
  }
};

//
// Security, retry, audit, cleanup
//
const Security = {};

Security.RATE_LIMIT_WINDOW = 10;
Security.RATE_LIMIT_MAX = 15;

Security.retry = async function (fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
};

Security.logError = async function (env, error, source) {
  try {
    Log.error(source, error);
    await DB.run(env, `INSERT INTO error_logs (location, error, created_at) VALUES (?,?,?)`, [
      source,
      String(error),
      Time.now()
    ]);
  } catch (e) {
    console.error("Failed to log error to DB", e);
  }
};

Security.audit = async function (env, type, userId, chatId, meta = {}) {
  try {
    await DB.run(env, `INSERT INTO audit_logs (log_type, user_id, chat_id, metadata, created_at) VALUES (?,?,?,?,?)`, [
      type,
      userId,
      chatId,
      JSON.stringify(meta),
      Time.now()
    ]);
  } catch (e) {
    Log.error("audit failed", e);
  }
};

Security.health = async function (env) {
  try {
    await env.DB.prepare("SELECT 1").first();
    return { ok: true, database: true, timestamp: Date.now() };
  } catch {
    return { ok: false, database: false, timestamp: Date.now() };
  }
};

Security.cleanup = async function (env) {
  try {
    await DB.run(env, `DELETE FROM rate_limits WHERE expires_at <= ?`, [Time.now()]);
  } catch (e) {
    Log.error("Security.cleanup failed", e);
  }
};

//
// Permissions & Roles
//
const Permissions = {};
Permissions.getOwnerId = (env) => String(env.OWNER_ID);
Permissions.getDeveloperId = (env) => String(env.OWNER_ID);
Permissions.getRootAdminId = (env) => String(env.OWNER_ID);

Permissions.isOwner = (env, userId) => String(userId) === Permissions.getOwnerId(env);
Permissions.isDeveloper = (env, userId) => String(userId) === Permissions.getDeveloperId(env);
Permissions.isRootAdmin = (env, userId) => String(userId) === Permissions.getRootAdminId(env);

Permissions.isGroupAdmin = async function (env, chatId, userId) {
  if (Permissions.isOwner(env, userId)) return true;
  try {
    const member = await TG.getMember(env, chatId, userId);
    if (!member || !member.ok) return false;
    const st = member.result.status;
    return st === "creator" || st === "administrator";
  } catch {
    return false;
  }
};

// alias used by some old code
Permissions.isAdmin = Permissions.isGroupAdmin;

Permissions.requireOwner = async function (env, message) {
  if (Permissions.isOwner(env, message.from.id)) return true;
  await TG.sendMessage(env, message.chat.id, "❌ Owner only command.", message.message_id);
  return false;
};

Permissions.requireDeveloper = async function (env, message) {
  if (Permissions.isDeveloper(env, message.from.id)) return true;
  await TG.sendMessage(env, message.chat.id, "❌ Developer only command.", message.message_id);
  return false;
};

Permissions.requireAdmin = async function (env, message) {
  const allowed = await Permissions.isGroupAdmin(env, message.chat.id, message.from.id);
  if (allowed) return true;
  await TG.sendMessage(env, message.chat.id, "❌ Admin permissions required.", message.message_id);
  return false;
};

Permissions.getRole = async function (env, chatId, userId) {
  if (Permissions.isOwner(env, userId)) return "OWNER";
  if (Permissions.isDeveloper(env, userId)) return "DEVELOPER";
  if (Permissions.isRootAdmin(env, userId)) return "ROOT ADMIN";
  const admin = await Permissions.isGroupAdmin(env, chatId, userId);
  if (admin) return "ADMIN";
  return "MEMBER";
};

//
// Placeholders for modules
//
const Router = {};
const AI = {};
const Economy = {};
const Moderation = {};
const Protection = {};
const Card = {};
const Combat = {};
const Profiles = {};
const GlobalMod = {};
const Greetings = {};
const Channel = {};
const Search = {};
const Fun = {};
const MiniGames = {};
const Recovery = {};
const Shop = {}; // ensure Shop exists

//
// Basic response helpers
//
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function success(message, extra = {}) {
  return { success: true, message, ...extra };
}
function failure(message, extra = {}) {
  return { success: false, message, ...extra };
}

//
// Router: parseCommand & basic handlers
//
Router.parseCommand = function (message) {
  if (!message || !message.text) return null;
  const text = message.text.trim();
  if (!text.startsWith("/") && !text.startsWith(".")) return null;
  const prefix = text[0];
  const parts = text.slice(1).trim().split(/\s+/);
  if (parts.length === 0) return null;
  let command = parts.shift().toLowerCase();
  command = command.replace(`@${CONFIG.BOT_USERNAME}`, "").replace(`@${CONFIG.BOT_USERNAME.toLowerCase()}`, "");
  return {
    prefix,
    command,
    args: parts,
    raw: text,
    isPublic: prefix === "/",
    isDeveloper: prefix === "."
  };
};

Router.handleStart = async function (env, message) {
  const text = `🩷 <b>SRAY ONLINE</b>

Hello ${message.from.first_name}!

I am SRAY —
your complete Telegram Group Operating System.

Version:
${CONFIG.VERSION}

Use:
/help
/bal
/profile
/status`;
  return await TG.sendMessage(env, message.chat.id, text, message.message_id);
};

Router.handlePing = async function (env, message) {
  const text = `🏓 Pong!

SRAY Status:
🟢 Online

Version:
${CONFIG.VERSION}

Timestamp:
${Time.now()}`;
  return await TG.sendMessage(env, message.chat.id, text, message.message_id);
};

Router.handleHelp = async function (env, message) {
  const text = `🩷 <b>SRAY HELP</b>

General:
/start
/help
/ping

Economy:
/bal
/daily
/weekly

Profile:
/profile
/status

Moderation:
/ban
/warn
/purge

AI:
.web on
.nweb
.aienabled`;
  return await TG.sendMessage(env, message.chat.id, text, message.message_id);
};

Router.unknown = async function (env, message, command) {
  return await TG.sendMessage(env, message.chat.id, `❓ Unknown command: <code>${command}</code>`, message.message_id);
};

// Router developer handlers requested
Router.handleRole = async function (env, message) {
  const role = await Permissions.getRole(env, message.chat.id, message.from.id);
  const text = `👤 SRAY ROLE SYSTEM

Name:
${message.from.first_name}

Role:
${role}

User ID:
<code>${message.from.id}</code>`;
  return await TG.sendMessage(env, message.chat.id, text, message.message_id);
};

Router.handleStt10Dev = async function (env, message) {
  if (!(await Permissions.requireDeveloper(env, message))) return;
  return await TG.sendMessage(env, message.chat.id, `🩷 STT10 Developer Event Enabled

Reward:
€4000

Duration:
10 Days`, message.message_id);
};

// -------------------- INSERT: Router.handle --------------------
// -------------------- REPLACE: Router.handle (complete routing) --------------------
Router.handle = async function (env, message, ctx) {
  try {
    // keep DB sync minimal and non-blocking memory store
    await DB.syncContext(env, message);
    if (ctx) ctx.waitUntil(AI.storeMessage(env, message));
    // parse command (safe)
    const parsed = Router.parseCommand(message);
    if (!parsed) return;
    const { command, args, isDeveloper } = parsed;

    // developer-only commands must be invoked with the dev prefix (.)
    const developerOnly = new Set([
      "open", "close", "broadcast", "schedule", "gban", "gunban", "stt10dev"
    ]);
    if (developerOnly.has(command) && !isDeveloper) {
      return TG.sendMessage(env, message.chat.id, `❌ Developer-only command. Use .${command}`, message.message_id);
    }

    // audit command (non-blocking)
    ctx && ctx.waitUntil(Security.audit(env, "command", message.from.id, message.chat ? message.chat.id : null, { command, args }));

    // Route commands to implemented functions. If function missing, leave TODO comment.
    // CORE
    if (command === "start") return Router.handleStart(env, message);
    if (command === "help") return Router.handleHelp(env, message);
    if (command === "ping") return Router.handlePing(env, message);
    if (command === "whoami") {
      // TODO: implementation missing (whoami behavior existed in earlier versions)
      return TG.sendMessage(env, message.chat.id, "❌ whoami not implemented on this build.", message.message_id);
    }

    // PROFILE
    if (["profile", "info"].includes(command)) return Profiles.show(env, message);
    if (["setintro", "intro"].includes(command)) return Profiles.setIntro(env, message, args); // using same backend
    if (["settitle", "title"].includes(command)) return Profiles.setTitle(env, message, args); // using same backend
    if (command === "pfp") {
      // TODO: implementation missing
      return TG.sendMessage(env, message.chat.id, "❌ pfp not implemented.", message.message_id);
    }
    if (command === "rep") return Profiles.rep(env, message);
    if (command === "status") return Combat.status(env, message);

    // ECONOMY
    if (["bal", "wallet"].includes(command)) return Economy.balance(env, message);
    if (command === "daily") return Economy.daily(env, message);
    if (command === "weekly") return Economy.weekly(env, message);
    if (command === "claim") return Economy.claim(env, message);
    if (command === "give") return Economy.give(env, message, args);
    if (command === "top") return Economy.top(env, message);
    if (command === "transactions") return Economy.transactions(env, message);
    if (command === "stats") {
      // TODO: implementation missing (Economy.stats not present)
      return TG.sendMessage(env, message.chat.id, "❌ Economy stats not implemented.", message.message_id);
    }
    if (command === "open") return Economy.open(env, message); // dev-only enforced above
    if (command === "close") return Economy.close(env, message); // dev-only enforced above
    if (command === "inventory") return Shop.inventory(env, message); // inventory implemented in Shop

    // SHOP
    if (command === "shop") return Shop.show(env, message);
    if (command === "buy") return Shop.buy(env, message, args);
    if (command === "gift") return Shop.gift(env, message, args);
    if (command === "sell") return Shop.sell(env, message, args);

    // COMBAT
    if (command === "rob") return Combat.rob(env, message);
    if (command === "kill") return Combat.kill(env, message);
    if (command === "protect") return Combat.protect(env, message);
    // status already mapped above to Combat.status

    // MODERATION
    if (command === "ban") return Moderation.ban(env, message);
    if (command === "unban") return Moderation.unban(env, message, args);
    if (command === "kick") return Moderation.kick(env, message);
    if (command === "mute") return Moderation.mute(env, message);
    if (command === "unmute") return Moderation.unmute(env, message);
    if (command === "tmute") return Moderation.tmute(env, message, args);
    if (command === "tban") return Moderation.tban(env, message, args);
    if (command === "warn") return Moderation.warn(env, message, args);
    if (command === "clearwarns") return Moderation.clearWarns(env, message);
    if (command === "purge" || command === "del") return Moderation.purge(env, message, args);
    if (command === "filter") {
      // TODO: implementation missing
      return TG.sendMessage(env, message.chat.id, "❌ filter not implemented.", message.message_id);
    }
    if (command === "pin") {
      // TODO: implementation missing
      return TG.sendMessage(env, message.chat.id, "❌ pin not implemented.", message.message_id);
    }
    if (command === "unpin") {
      // TODO: implementation missing
      return TG.sendMessage(env, message.chat.id, "❌ unpin not implemented.", message.message_id);
    }
    if (command === "promote") {
      // TODO: implementation missing
      return TG.sendMessage(env, message.chat.id, "❌ promote not implemented.", message.message_id);
    }
    if (command === "demote") {
      // TODO: implementation missing
      return TG.sendMessage(env, message.chat.id, "❌ demote not implemented.", message.message_id);
    }
    if (command === "admins") return Moderation.admins(env, message);
    if (command === "report") return Moderation.report(env, message);
    if (command === "rules") return Moderation.rules(env, message);
    if (command === "setrules") return Moderation.setRules(env, message, args);
    if (command === "welcome") return Greetings.setWelcome(env, message, args);
    if (command === "goodbye") return Greetings.setGoodbye(env, message, args);

    // PROTECTION
    if (command === "lock") return Protection.lock(env, message, args);
    if (command === "unlock") return Protection.unlock(env, message, args);
    if (command === "antispam") return Protection.antiSpam(env, message);
    if (command === "antilink") return Protection.toggleAntiLink(env, message);
    if (command === "antiflood") return Protection.toggleAntiFlood(env, message);
    if (command === "antiraid") return Protection.toggleAntiRaid(env, message);

    // GLOBAL MODERATION
    if (command === "gban") return GlobalMod.gban(env, message, args); // dev-only enforced
    if (command === "gunban") return GlobalMod.gunban(env, message, args); // dev-only enforced
    if (command === "gbans") return GlobalMod.list(env, message);

    // CARD SYSTEM
    if (command === "card") return Card.createMatch(env, message, args);
    if (command === "bet") return Card.joinMatch(env, message);
    if (command === "predict") return Card.predict(env, message, args);
    if (command === "flip") return Card.flip(env, message, args);

    // FUN
    if (command === "love") return Fun.love(env, message);
    if (command === "crush") {
      // TODO: implementation missing (alias/endpoint not present)
      return TG.sendMessage(env, message.chat.id, "❌ crush not implemented.", message.message_id);
    }
    if (command === "ship") return Fun.ship(env, message);
    if (command === "couples") return Fun.couples(env, message);
    if (command === "gay") return Fun.gay(env, message);
    if (command === "lesbo") return Fun.lesbo(env, message);
    if (command === "dick") return Fun.dick(env, message);
    if (command === "looks") return Fun.looks(env, message);
    if (command === "brain") return Fun.brain(env, message);
    if (command === "stupidity") return Fun.stupidity(env, message);
    if (command === "hot") return Fun.hot(env, message);
    if (command === "cute") return Fun.cute(env, message);
    if (command === "power") return Fun.power(env, message);
    if (command === "sigma") return Fun.sigma(env, message);
    if (command === "chad") return Fun.chad(env, message);
    if (command === "luck") return Fun.luck(env, message);
    if (command === "rich") return Fun.rich(env, message);
    if (command === "danger") return Fun.danger(env, message);
    if (command === "simp") return Fun.simp(env, message);
    if (command === "toss") return Fun.toss(env, message);

    // GIF (no implementations present in this codebase)
    const gifCommands = ["slap","hug","kiss","bite","cuddle","fck","pat","punch","tickle","stare","wave","angry","murder","lol"];
    if (gifCommands.includes(command)) {
      // TODO: GIF commands not implemented
      return TG.sendMessage(env, message.chat.id, `❌ ${command} (GIF) not implemented.`, message.message_id);
    }

    // MINI GAMES
    if (command === "truth") return MiniGames.truth(env, message);
    if (command === "dare") return MiniGames.dare(env, message);
    if (command === "wouldyourather") return MiniGames.wyr(env, message);
    if (command === "neverhaveiever") return MiniGames.never(env, message);
    if (command === "quiz") return MiniGames.quiz(env, message);
    if (command === "riddle") return MiniGames.riddle(env, message);
    if (command === "coin") return MiniGames.coin(env, message);
    if (command === "dice") return MiniGames.dice(env, message);
    if (command === "spin") return MiniGames.spin(env, message);
    if (command === "dance") return MiniGames.dance(env, message);

    // SEARCH
    if (command === "wiki") return Search.wiki(env, message, args);
    if (["translate","tr"].includes(command)) return Search.translate(env, message, args);

    // AI controls
    if (command === "ai") return AI.showStatus(env, message);
    if (command === "aienabled") {
      // TODO: AI.toggleProvider missing - implement function before wiring
      return TG.sendMessage(env, message.chat.id, "❌ aienabled toggle not implemented.", message.message_id);
    }
    if (command === "aidedisabled") {
      // TODO: decide behavior; toggleProvider is missing
      return TG.sendMessage(env, message.chat.id, "❌ aidedisabled not implemented.", message.message_id);
    }
    if (command === "web") {
      // TODO: web on/nweb handling not implemented
      return TG.sendMessage(env, message.chat.id, "❌ web/nweb not implemented.", message.message_id);
    }
    if (command === "nweb") {
      // TODO: web/nweb handling not implemented
      return TG.sendMessage(env, message.chat.id, "❌ web/nweb not implemented.", message.message_id);
    }
    if (command === "save") return AI.toggleSave(env, message);

    // RECOVERY
    if (command === "rcvr") return Recovery.handle(env, message, args);

    // CHANNEL
    if (command === "broadcast") return Channel.broadcast(env, message, args); // dev-only enforced
    if (command === "analytics") return Channel.analytics(env, message);
    if (command === "schedule") return Channel.schedulePost(env, message, args); // dev-only enforced

    // DEVELOPER
    if (command === "stt10dev") return Router.handleStt10Dev(env, message);

    // Fallback: unknown
    return Router.unknown(env, message, command);
  } catch (error) {
    Log.error("ROUTER HANDLE ERROR", error);
    try {
      await DB.run(env, `INSERT INTO error_logs (location, error, created_at) VALUES (?,?,?)`, ["router_handle", String(error), Time.now()]);
    } catch (e) {}
    try {
      return TG.sendMessage(env, message.chat.id, `❌ Router Error:\n<code>${String(error)}</code>`, message.message_id);
    } catch (e) {
      // nothing more we can do
    }
  }
};
// -------------------- END Router.handle --------------------
// -------------------- END Router.handle --------------------
//
// DB helpers: sync, get, cooldowns, audit, error
//
DB.syncUser = async function (env, user) {
  if (!user) return;
  const now = Time.now();
  await DB.run(
    env,
    `
    INSERT INTO users (
      user_id, username, first_name, is_bot, balance, status, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      updated_at = excluded.updated_at
    `,
    [user.id, user.username || "", user.first_name || "", user.is_bot ? 1 : 0, CONFIG.STARTING_BALANCE, "alive", now, now]
  );
};

DB.syncGroup = async function (env, chat) {
  if (!chat) return;
  if (chat.type === "private") return;
  const now = Time.now();
  await DB.run(
    env,
    `
    INSERT INTO groups (
      chat_id, title, username, type, created_at, updated_at
    ) VALUES (?,?,?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET
      title = excluded.title,
      username = excluded.username,
      updated_at = excluded.updated_at
    `,
    [chat.id, chat.title || "", chat.username || "", chat.type || "", now, now]
  );
};

DB.getUser = async function (env, userId) {
  return await DB.first(env, `SELECT * FROM users WHERE user_id = ?`, [userId]);
};

DB.getGroup = async function (env, chatId) {
  return await DB.first(env, `SELECT * FROM groups WHERE chat_id = ?`, [chatId]);
};

DB.userExists = async function (env, userId) {
  const row = await DB.first(env, `SELECT user_id FROM users WHERE user_id = ?`, [userId]);
  return !!row;
};

DB.getBalance = async function (env, userId) {
  const user = await DB.getUser(env, userId);
  return user ? user.balance : CONFIG.STARTING_BALANCE;
};

DB.setBalance = async function (env, userId, amount) {
  return await DB.run(env, `UPDATE users SET balance = ?, updated_at = ? WHERE user_id = ?`, [amount, Time.now(), userId]);
};

DB.audit = async function (env, type, userId = null, chatId = null, metadata = {}) {
  try {
    await DB.run(env, `INSERT INTO audit_logs (log_type, user_id, chat_id, metadata, created_at) VALUES (?,?,?,?,?)`, [
      type,
      userId,
      chatId,
      JSON.stringify(metadata),
      Time.now()
    ]);
  } catch (e) {
    Log.error("DB.audit failed", e);
  }
};

DB.error = async function (env, location, error) {
  try {
    await DB.run(env, `INSERT INTO error_logs (location, error, created_at) VALUES (?,?,?)`, [location, String(error), Time.now()]);
  } catch (_) {}
};

DB.syncContext = async function (env, message) {
  if (!message) return;
  if (message.from) await DB.syncUser(env, message.from);
  if (message.chat) await DB.syncGroup(env, message.chat);
};

DB.getCooldown = async function (env, userId, command) {
  const row = await DB.first(env, `SELECT expires_at FROM cooldowns WHERE user_id = ? AND command = ?`, [userId, command]);
  if (!row) return 0;
  if (row.expires_at <= Time.now()) return 0;
  return row.expires_at - Time.now();
};

DB.setCooldown = async function (env, userId, command, seconds) {
  const expiry = Time.future(seconds);
  await DB.run(env, `INSERT INTO cooldowns (user_id, command, expires_at) VALUES (?,?,?) ON CONFLICT(user_id, command) DO UPDATE SET expires_at = excluded.expires_at`, [userId, command, expiry]);
};

DB.addTreasury = async function (env, amount, source) {
  await DB.run(env, `UPDATE treasury SET balance = balance + ? WHERE id = 1`, [amount]);
  await DB.run(env, `INSERT INTO treasury_logs (amount, source_type, reference_id, created_at) VALUES (?,?,?,?)`, [amount, source, null, Time.now()]);
};

//
// Moderation (ban/unban/kick/warn/clearWarns/purge/...)
//
Moderation.ban = async function (env, message) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "❌ Reply to a user to ban them.", message.message_id);
  const target = message.reply_to_message.from;
  if (target.id === message.from.id) return TG.sendMessage(env, message.chat.id, "❌ You cannot ban yourself.");
  const result = await TG.call(env, "banChatMember", { chat_id: message.chat.id, user_id: target.id });
  if (result?.ok) {
    await DB.audit(env, "ban", target.id, message.chat.id, { admin: message.from.id });
    return TG.sendMessage(env, message.chat.id, `🔨 ${target.first_name} has been banned.`);
  }
  return TG.sendMessage(env, message.chat.id, "❌ Failed to ban user.");
};

Moderation.unban = async function (env, message, args) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  const userId = args[0];
  if (!userId) return TG.sendMessage(env, message.chat.id, "❌ Usage: /unban USER_ID");
  const result = await TG.call(env, "unbanChatMember", { chat_id: message.chat.id, user_id: userId });
  if (result?.ok) return TG.sendMessage(env, message.chat.id, "✅ User unbanned.");
  return TG.sendMessage(env, message.chat.id, "❌ Failed to unban user.");
};

Moderation.kick = async function (env, message) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "❌ Reply to a user to kick them.");
  const target = message.reply_to_message.from;
  await TG.call(env, "banChatMember", { chat_id: message.chat.id, user_id: target.id, until_date: Time.now() + 30 });
  await TG.call(env, "unbanChatMember", { chat_id: message.chat.id, user_id: target.id });
  return TG.sendMessage(env, message.chat.id, `👢 ${target.first_name} has been kicked.`);
};

Moderation.warn = async function (env, message, args) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "❌ Reply to a user to warn.");
  const target = message.reply_to_message.from;
  const reason = args.join(" ") || "No reason provided";
  await DB.run(env, `INSERT INTO warnings (user_id, chat_id, admin_id, reason, created_at) VALUES (?,?,?,?,?)`, [target.id, message.chat.id, message.from.id, reason, Time.now()]);
  const count = await DB.first(env, `SELECT COUNT(*) as total FROM warnings WHERE user_id = ? AND chat_id = ?`, [target.id, message.chat.id]);
  if (count && count.total >= 3) {
    await TG.call(env, "banChatMember", { chat_id: message.chat.id, user_id: target.id });
    return TG.sendMessage(env, message.chat.id, `🔨 ${target.first_name} reached 3 warnings and was automatically banned.`);
  }
  return TG.sendMessage(env, message.chat.id, `⚠️ ${target.first_name} warned.\nReason: ${reason}\nWarnings: ${count ? count.total : 0}/3`);
};

Moderation.clearWarns = async function (env, message) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "❌ Reply to a user.");
  const target = message.reply_to_message.from;
  await DB.run(env, `DELETE FROM warnings WHERE user_id = ? AND chat_id = ?`, [target.id, message.chat.id]);
  return TG.sendMessage(env, message.chat.id, `✅ Cleared all warnings for ${target.first_name}.`);
};

Moderation.purge = async function (env, message, args) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  let amount = parseInt(args[0]) || 10;
  if (amount > 100) amount = 100;
  for (let i = 0; i <= amount; i++) {
    const msgId = message.message_id - i;
    try {
      await TG.deleteMessage(env, message.chat.id, msgId);
      await new Promise((r) => setTimeout(r, 120));
    } catch (err) {
      Log.warn("Failed to delete message", message.chat.id, msgId, err);
    }
  }
  return;
};

Moderation.mute = async function (env, message) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "❌ Reply to a user to mute them.");
  const target = message.reply_to_message.from;
  const result = await TG.call(env, "restrictChatMember", { chat_id: message.chat.id, user_id: target.id, permissions: { can_send_messages: false } });
  if (result?.ok) return TG.sendMessage(env, message.chat.id, `🔇 ${target.first_name} has been muted.`);
  return TG.sendMessage(env, message.chat.id, "❌ Failed to mute user.");
};

Moderation.unmute = async function (env, message) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "❌ Reply to a user to unmute them.");
  const target = message.reply_to_message.from;
  const result = await TG.call(env, "restrictChatMember", {
    chat_id: message.chat.id,
    user_id: target.id,
    permissions: {
      can_send_messages: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_documents: true,
      can_send_voice_notes: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true
    }
  });
  if (result?.ok) return TG.sendMessage(env, message.chat.id, `🔊 ${target.first_name} has been unmuted.`);
  return TG.sendMessage(env, message.chat.id, "❌ Failed to unmute user.");
};

Moderation.tmute = async function (env, message, args) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "❌ Reply to a user to temporarily mute them.");
  const minutes = parseInt(args[0]);
  if (!minutes || minutes <= 0) return TG.sendMessage(env, message.chat.id, "❌ Usage: /tmute 30");
  const target = message.reply_to_message.from;
  const until = Time.now() + minutes * 60;
  const result = await TG.call(env, "restrictChatMember", { chat_id: message.chat.id, user_id: target.id, until_date: until, permissions: { can_send_messages: false } });
  if (result?.ok) return TG.sendMessage(env, message.chat.id, `⏳ ${target.first_name} muted for ${minutes} minutes.`);
};

Moderation.tban = async function (env, message, args) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "❌ Reply to a user to temporarily ban them.");
  const hours = parseInt(args[0]);
  if (!hours || hours <= 0) return TG.sendMessage(env, message.chat.id, "❌ Usage: /tban 24");
  const target = message.reply_to_message.from;
  const until = Time.now() + hours * 3600;
  const result = await TG.call(env, "banChatMember", { chat_id: message.chat.id, user_id: target.id, until_date: until });
  if (result?.ok) return TG.sendMessage(env, message.chat.id, `⛔ ${target.first_name} banned for ${hours} hours.`);
};

Moderation.admins = async function (env, message) {
  const result = await TG.call(env, "getChatAdministrators", { chat_id: message.chat.id });
  if (!result?.ok) return TG.sendMessage(env, message.chat.id, "❌ Failed to fetch admin list.");
  let text = "👮 <b>Group Admins</b>\n\n";
  for (const admin of result.result) text += `• ${admin.user.first_name}\n`;
  return TG.sendMessage(env, message.chat.id, text);
};

Moderation.report = async function (env, message) {
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "❌ Reply to a message to report it.");
  const admins = await TG.call(env, "getChatAdministrators", { chat_id: message.chat.id });
  let mentions = "";
  if (admins?.ok) for (const admin of admins.result) if (admin.user.username) mentions += `@${admin.user.username} `;
  return TG.sendMessage(env, message.chat.id, `🚨 Report submitted by ${message.from.first_name}\n\n${mentions}`);
};

Moderation.setRules = async function (env, message, args) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  const rules = args.join(" ");
  if (!rules) return TG.sendMessage(env, message.chat.id, "❌ Usage: /setrules your rules here");
  await DB.run(env, `INSERT INTO group_rules (chat_id, rules, updated_at) VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET rules=excluded.rules, updated_at=excluded.updated_at`, [message.chat.id, rules, Time.now()]);
  return TG.sendMessage(env, message.chat.id, "✅ Group rules updated.");
};

Moderation.rules = async function (env, message) {
  const rules = await DB.first(env, `SELECT rules FROM group_rules WHERE chat_id = ?`, [message.chat.id]);
  if (!rules) return TG.sendMessage(env, message.chat.id, "📜 No rules configured.");
  return TG.sendMessage(env, message.chat.id, `📜 <b>Group Rules</b>\n\n${rules.rules}`);
};

//
// Protection (locks, antilink, antiflood, antiraid, message processing)
//
Protection.lock = async function (env, message, args) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  const type = (args[0] || "").toLowerCase();
  const allowed = ["all", "media", "links", "stickers", "photos", "videos", "documents", "voice"];
  if (!allowed.includes(type)) return TG.sendMessage(env, message.chat.id, `❌ Valid locks:\n${allowed.join(", ")}`);
  await DB.run(env, `INSERT INTO locks (chat_id, lock_type, enabled, updated_at) VALUES (?,?,1,?) ON CONFLICT(chat_id, lock_type) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at`, [message.chat.id, type, Time.now()]);
  return TG.sendMessage(env, message.chat.id, `🔒 ${type.toUpperCase()} locked.`);
};

Protection.unlock = async function (env, message, args) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  const type = (args[0] || "").toLowerCase();
  await DB.run(env, `DELETE FROM locks WHERE chat_id = ? AND lock_type = ?`, [message.chat.id, type]);
  return TG.sendMessage(env, message.chat.id, `🔓 ${type.toUpperCase()} unlocked.`);
};

Protection.toggleAntiLink = async function (env, message) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  const existing = await DB.first(env, `SELECT enabled FROM protections WHERE chat_id = ? AND type = 'antilink'`, [message.chat.id]);
  const enabled = existing ? 0 : 1;
  await DB.run(env, `INSERT INTO protections (chat_id, type, enabled) VALUES (?,?,?) ON CONFLICT(chat_id, type) DO UPDATE SET enabled = excluded.enabled`, [message.chat.id, "antilink", enabled]);
  return TG.sendMessage(env, message.chat.id, enabled ? "🔗 AntiLink enabled." : "🔓 AntiLink disabled.");
};

Protection.toggleAntiFlood = async function (env, message) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  const existing = await DB.first(env, `SELECT enabled FROM protections WHERE chat_id = ? AND type = 'antiflood'`, [message.chat.id]);
  const enabled = existing ? 0 : 1;
  await DB.run(env, `INSERT INTO protections (chat_id, type, enabled) VALUES (?,?,?) ON CONFLICT(chat_id, type) DO UPDATE SET enabled = excluded.enabled`, [message.chat.id, "antiflood", enabled]);
  return TG.sendMessage(env, message.chat.id, enabled ? "🌊 AntiFlood enabled." : "🔓 AntiFlood disabled.");
};

Protection.toggleAntiRaid = async function (env, message) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  const existing = await DB.first(env, `SELECT enabled FROM protections WHERE chat_id = ? AND type = 'antiraid'`, [message.chat.id]);
  const enabled = existing ? 0 : 1;
  await DB.run(env, `INSERT INTO protections (chat_id, type, enabled) VALUES (?,?,?) ON CONFLICT(chat_id, type) DO UPDATE SET enabled = excluded.enabled`, [message.chat.id, "antiraid", enabled]);
  return TG.sendMessage(env, message.chat.id, enabled ? "🛡 AntiRaid enabled." : "🔓 AntiRaid disabled.");
};

Protection.antiSpam = async function (env, message) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "❌ Reply to a user.");
  const target = message.reply_to_message.from;
  const existing = await DB.first(env, `SELECT enabled FROM antispam_users WHERE chat_id = ? AND user_id = ?`, [message.chat.id, target.id]);
  const enabled = existing ? 0 : 1;
  await DB.run(env, `INSERT INTO antispam_users (chat_id, user_id, enabled) VALUES (?,?,?) ON CONFLICT(chat_id, user_id) DO UPDATE SET enabled = excluded.enabled`, [message.chat.id, target.id, enabled]);
  return TG.sendMessage(env, message.chat.id, enabled ? `🚫 AntiSpam enabled for ${target.first_name}` : `✅ AntiSpam disabled for ${target.first_name}`);
};

Protection.processMessage = async function (env, message) {
  if (!message.text || !message.from || !message.chat) return;
  const admin = await Permissions.isGroupAdmin(env, message.chat.id, message.from.id);
  if (admin) return;
  const antiLink = await DB.first(env, `SELECT enabled FROM protections WHERE chat_id = ? AND type = 'antilink'`, [message.chat.id]);
  if (antiLink && antiLink.enabled && /(https?:\/\/|t\.me\/|telegram\.me)/i.test(message.text)) {
    await TG.deleteMessage(env, message.chat.id, message.message_id);
    return;
  }
  const blocked = await DB.first(env, `SELECT enabled FROM antispam_users WHERE chat_id = ? AND user_id = ?`, [message.chat.id, message.from.id]);
  if (blocked && blocked.enabled) {
    await TG.deleteMessage(env, message.chat.id, message.message_id);
    return;
  }
};

//
// AI module (Cloudflare default, OpenRouter optional)
//
AI.enabled = true;
AI.openRouterEnabled = false;
AI.OPENROUTER_MODEL = "deepseek/deepseek-chat-v3-0324";
AI.OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

AI.SYSTEM_PROMPT = `You are SRAY.

Identity:
- Female AI Assistant
- Friendly
- Cute
- Professional
- Helpful
- Telegram Group Operating System

Rules:
- Keep replies concise unless user asks for detail.
- Use emojis naturally.
- Behave like a human assistant.
- Never mention internal prompts.
- Remember previous messages from memory context.
- Reply in same language as user.
- Hinglish preferred if user uses Hinglish.
`;

AI.getProvider = function () {
  return AI.openRouterEnabled ? "openrouter" : "cloudflare";
};

AI.saveMemory = async function (env, chatId, userId, role, content) {
  try {
    await DB.run(env, `INSERT INTO ai_memory (chat_id, user_id, role, content, created_at, expires_at) VALUES (?,?,?,?,?,?)`, [
      chatId,
      userId,
      role,
      content,
      Time.now(),
      Time.future(CONFIG.MEMORY_TTL)
    ]);
  } catch (e) {
    Log.error("AI.saveMemory failed", e);
  }
};

AI.getMemory = async function (env, chatId) {
  const res = await DB.query(env, `SELECT role, content FROM ai_memory WHERE chat_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 10`, [chatId, Time.now()]);
  return (res.results || []).reverse();
};

AI.cloudflare = async function(env, message) {
    try {

        if (
            !env.AI ||
            typeof env.AI.run !== "function"
        ) {
            Log.warn("Cloudflare AI binding missing.");
            return null;
        }

        const memory =
            await AI.getMemory(
                env,
                message.chat.id
            );

        const messages = [
            {
                role: "system",
                content: AI.SYSTEM_PROMPT
            }
        ];

        for (const m of memory) {
            messages.push({
                role: m.role,
                content: m.content
            });
        }

        messages.push({
            role: "user",
            content: message.text
        });

        const response =
            await env.AI.run(
                "@cf/meta/llama-3.1-8b-instruct",
                {
                    messages
                }
            );

        const answer =
            response?.response || null;

        if (answer) {
            try {
                await AI.saveMemory(
                    env,
                    message.chat.id,
                    message.from.id,
                    "user",
                    message.text
                );

                await AI.saveMemory(
                    env,
                    message.chat.id,
                    0,
                    "assistant",
                    answer
                );
            } catch(e) {
                Log.warn(
                    "Memory save failed",
                    e
                );
            }
        }

        return answer;

    } catch(err) {
        Log.error(
            "Cloudflare AI error",
            err
        );

        return null;
    }
};

AI.openrouter = async function(env, message) {

    try {

        if (
            !env.OPENROUTER_API_KEY
        ) {
            return AI.cloudflare(
                env,
                message
            );
        }

        const memory =
            await AI.getMemory(
                env,
                message.chat.id
            );

        const messages = [
            {
                role: "system",
                content: AI.SYSTEM_PROMPT
            }
        ];

        for (const m of memory) {
            messages.push({
                role: m.role,
                content: m.content
            });
        }

        messages.push({
            role: "user",
            content: message.text
        });

        const r = await fetch(
            AI.OPENROUTER_URL,
            {
                method: "POST",
                headers: {
                    Authorization:
                        `Bearer ${env.OPENROUTER_API_KEY}`,
                    "Content-Type":
                        "application/json"
                },
                body: JSON.stringify({
                    model:
                        AI.OPENROUTER_MODEL ||
                        "deepseek/deepseek-chat-v3-0324",
                    messages,
                    temperature: 0.8,
                    max_tokens: 700
                })
            }
        );

        if (!r.ok) {
            throw new Error(
                `OpenRouter HTTP ${r.status}`
            );
        }

        const data =
            await r.json();

        const answer =
            data?.choices?.[0]
            ?.message?.content || null;

        return answer;

    } catch(err) {

        Log.error(
            "OpenRouter error",
            err
        );

        return AI.cloudflare(
            env,
            message
        );
    }
};

AI.getProviderStatus = function () {
  return {
    provider: AI.getProvider(),
    openrouter: AI.openRouterEnabled,
    cloudflare: !AI.openRouterEnabled,
    model: AI.openRouterEnabled ? AI.OPENROUTER_MODEL : "@cf/meta/llama-3.1-8b-instruct"
  };
};

AI.SAVE_DEFAULT = false;
AI.isSaveEnabled = async function (env, chatId) {
  const row = await DB.first(env, `SELECT enabled FROM save_settings WHERE chat_id = ?`, [chatId]);
  if (!row) return AI.SAVE_DEFAULT;
  return row.enabled === 1;
};

AI.toggleSave = async function (env, message) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  const current = await AI.isSaveEnabled(env, message.chat.id);
  const next = current ? 0 : 1;
  await DB.run(env, `INSERT INTO save_settings (chat_id, enabled, updated_at) VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`, [message.chat.id, next, Time.now()]);
  return TG.sendMessage(env, message.chat.id, next ? "💾 Save Mode enabled.\nEntire group history will be stored for 24 hours." : "🗑 Save Mode disabled.\nOnly AI and bot interactions will be stored.");
};

AI.storeMessage = async function (env, message, force = false) {
  if (!message || !message.text) return;
  const saveEnabled = await AI.isSaveEnabled(env, message.chat.id);
  if (!saveEnabled && !force) return;
  await DB.run(env, `INSERT INTO message_store (message_id, chat_id, user_id, username, text, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`, [
    message.message_id,
    message.chat.id,
    message.from.id,
    message.from.username || "",
    message.text,
    Time.now(),
    Time.future(CONFIG.MESSAGE_TTL)
  ]);
};

AI.getMemory = AI.getMemory; // already defined

AI.getConversationContext = async function (env, chatId) {
  const res = await DB.query(env, `SELECT username, text FROM message_store WHERE chat_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT ?`, [chatId, Time.now(), 50]);
  const rows = res.results || [];
  return rows.reverse().map((x) => `${x.username || "user"}: ${x.text}`).join("\n");
};

AI.buildPrompt = async function (env, message) {
  const memory = await AI.getMemory(env, message.chat.id);
  const conversation = await AI.getConversationContext(env, message.chat.id);
  const messages = [{ role: "system", content: `${AI.SYSTEM_PROMPT}\n\nRecent Group Context:\n\n${conversation}` }];
  for (const m of memory) messages.push({ role: m.role, content: m.content });
  messages.push({ role: "user", content: message.text });
  return messages;
};

AI.process = async function(
    env,
    message
) {

    try {

        if (!AI.enabled) {
            return;
        }

        if (
            !AI.shouldRespond(
                message
            )
        ) {
            return;
        }

        let answer = null;

        const provider =
            AI.getProvider();

        if (
            provider ===
            "openrouter"
        ) {

            answer =
                await AI.openrouter(
                    env,
                    message
                );

        } else {

            answer =
                await AI.cloudflare(
                    env,
                    message
                );

        }

        if (
            answer &&
            message &&
            message.chat
        ) {

            await TG.sendMessage(
                env,
                message.chat.id,
                answer,
                message.message_id
            );

        }

    } catch(err) {

        Log.error(
            "AI process failed",
            err
        );

        // NO fallback message here
        // This prevents:
        // "Sorry, my brain stopped working..."
    }
};

AI.shouldRespond = function(message) {
    if (!message || !message.text) return false;

    // Ignore bot commands
    if (
        message.text.startsWith("/") ||
        message.text.startsWith(".")
    ) {
        return false;
    }

    const text = message.text.toLowerCase();

    // Always respond in private chats
    if (
        message.chat &&
        message.chat.type === "private"
    ) {
        return true;
    }

    // Reply if bot mentioned or replied to
    if (
        text.includes("sray") ||
        text.includes(`@${CONFIG.BOT_USERNAME}`)
    ) {
        return true;
    }

    if (
        message.reply_to_message &&
        message.reply_to_message.from &&
        message.reply_to_message.from.username &&
        message.reply_to_message.from.username.toLowerCase() ===
        CONFIG.BOT_USERNAME.toLowerCase()
    ) {
        return true;
    }

    return false;
};

AI.cleanupMemory = async function (env) {
  await DB.run(env, `DELETE FROM ai_memory WHERE expires_at <= ?`, [Time.now()]);
};

AI.cleanupStorage = async function (env) {
  await DB.run(env, `DELETE FROM message_store WHERE expires_at <= ?`, [Time.now()]);
};

AI.showStatus = async function (env, message) {
  const status = AI.getProviderStatus();
  return await TG.sendMessage(env, message.chat.id, `🩷 <b>SRAY AI STATUS</b>

Provider:
<b>${status.provider.toUpperCase()}</b>

Model:
<code>${status.model}</code>

Memory:
24 Hours

OpenRouter:
${status.openrouter ? "Enabled" : "Disabled"}

Cloudflare AI:
${status.cloudflare ? "Enabled" : "Disabled"}

Female Personality:
Enabled

Group Memory:
Enabled`);
};

//
// Recovery (uses message_store); implements .rcvr commands
//
Recovery.allowed = async function (env, message) {
  if (Permissions.isOwner(env, message.from.id)) return true;
  return await Permissions.isGroupAdmin(env, message.chat.id, message.from.id);
};

Recovery.byUser = async function (env, chatId, username) {
  username = username.replace("@", "").toLowerCase();
  return await DB.query(env, `SELECT username, text, created_at FROM message_store WHERE LOWER(username) = ? AND chat_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 25`, [username, chatId, Time.now()]);
};

Recovery.byKeyword = async function (env, chatId, keyword) {
  return await DB.query(env, `SELECT username, text, created_at FROM message_store WHERE chat_id = ? AND text LIKE ? AND expires_at > ? ORDER BY created_at DESC LIMIT 25`, [chatId, `%${keyword}%`, Time.now()]);
};

Recovery.similar = async function (env, chatId, text) {
  const words = text.toLowerCase().split(/\s+/).slice(0, 5);
  if (!words.length) return { results: [] };
  const conditions = words.map(() => "text LIKE ?").join(" OR ");
  const binds = [chatId, ...words.map((w) => `%${w}%`), Time.now()];
  return await DB.query(env, `SELECT username, text, created_at FROM message_store WHERE chat_id = ? AND (${conditions}) AND expires_at > ? ORDER BY created_at DESC LIMIT 20`, binds);
};

Recovery.thread = async function (env, chatId) {
  return await DB.query(env, `SELECT username, text, created_at FROM message_store WHERE chat_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 50`, [chatId, Time.now()]);
};

Recovery.format = function (results, title) {
  const rows = results.results || [];
  if (!rows.length) return `⚠️ No recovery data found.`;
  let output = `🔎 <b>${title}</b>\n\n`;
  rows.reverse().forEach((row) => {
    output += `<b>${row.username || "user"}</b>\n${row.text}\n\n`;
  });
  if (output.length > 3900) output = output.slice(0, 3900) + "\n...";
  return output;
};

Recovery.handle = async function (env, message, args) {
  if (!(await Recovery.allowed(env, message))) return;
  if (!args || args.length === 0) {
    return TG.sendMessage(env, message.chat.id, `Usage:\n\n.rcvr @user\n.rcvr keyword scam\n.rcvr thread\n.rcvr similar hello world`);
  }
  const mode = args[0].toLowerCase();
  if (mode.startsWith("@")) {
    const result = await Recovery.byUser(env, message.chat.id, mode);
    return TG.sendMessage(env, message.chat.id, Recovery.format(result, `RECOVERY USER ${mode}`));
  }
  if (mode === "keyword") {
    const keyword = args.slice(1).join(" ");
    const result = await Recovery.byKeyword(env, message.chat.id, keyword);
    return TG.sendMessage(env, message.chat.id, Recovery.format(result, `KEYWORD: ${keyword}`));
  }
  if (mode === "thread") {
    const result = await Recovery.thread(env, message.chat.id);
    return TG.sendMessage(env, message.chat.id, Recovery.format(result, "THREAD RECOVERY"));
  }
  if (mode === "similar") {
    const query = args.slice(1).join(" ");
    const result = await Recovery.similar(env, message.chat.id, query);
    return TG.sendMessage(env, message.chat.id, Recovery.format(result, `SIMILAR TO: ${query}`));
  }
  return TG.sendMessage(env, message.chat.id, "❌ Invalid recovery mode.");
};

//
// Profiles
//
Profiles.ensureProfile = async function (env, user) {
  await DB.run(env, `INSERT OR IGNORE INTO profiles (user_id, intro, title, reputation, created_at, updated_at) VALUES (?,?,?,?,?,?)`, [user.id, "", "", 0, Time.now(), Time.now()]);
};

Profiles.get = async function (env, userId) {
  return await DB.first(env, `SELECT * FROM profiles WHERE user_id = ?`, [userId]);
};

Profiles.setIntro = async function (env, message, args) {
  const intro = args.join(" ");
  if (!intro) return TG.sendMessage(env, message.chat.id, "Usage:\n/setintro your intro");
  await Profiles.ensureProfile(env, message.from);
  await DB.run(env, `UPDATE profiles SET intro = ?, updated_at = ? WHERE user_id = ?`, [intro, Time.now(), message.from.id]);
  return TG.sendMessage(env, message.chat.id, "✅ Intro updated.");
};

Profiles.setTitle = async function (env, message, args) {
  const title = args.join(" ");
  if (!title) return TG.sendMessage(env, message.chat.id, "Usage:\n/settitle Your Title");
  await Profiles.ensureProfile(env, message.from);
  await DB.run(env, `UPDATE profiles SET title = ?, updated_at = ? WHERE user_id = ?`, [title, Time.now(), message.from.id]);
  return TG.sendMessage(env, message.chat.id, "👑 Title updated.");
};

Profiles.addRep = async function (env, giverId, targetId) {
  if (giverId === targetId) return false;
  await DB.run(env, `UPDATE profiles SET reputation = reputation + 1 WHERE user_id = ?`, [targetId]);
  return true;
};

Profiles.getStatus = async function (env, userId) {
  const user = await DB.getUser(env, userId);
  if (!user) return "ALIVE";
  return (user.status || "ALIVE").toUpperCase();
};

Profiles.show = async function (env, message) {
  const target = message.reply_to_message ? message.reply_to_message.from : message.from;
  await Profiles.ensureProfile(env, target);
  const profile = await Profiles.get(env, target.id);
  const economy = await DB.getUser(env, target.id);
  const balance = economy ? economy.balance : CONFIG.STARTING_BALANCE;
  const text = `👤 <b>SRAY PROFILE</b>

Name:
${target.first_name}

ID:
<code>${target.id}</code>

Username:
@${target.username || "none"}

👑 Title:
${profile.title || "None"}

📝 Intro:
${profile.intro || "No intro set."}

⭐ Reputation:
${profile.reputation}

💶 Balance:
€${balance}

❤️ Status:
${await Profiles.getStatus(env, target.id)}

Joined:
${new Date().toLocaleDateString()}`;
  return TG.sendMessage(env, message.chat.id, text, message.message_id);
};

Profiles.rep = async function (env, message) {
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "Reply to a user.");
  const target = message.reply_to_message.from;
  await Profiles.ensureProfile(env, target);
  const ok = await Profiles.addRep(env, message.from.id, target.id);
  if (!ok) return TG.sendMessage(env, message.chat.id, "❌ You cannot rep yourself.");
  return TG.sendMessage(env, message.chat.id, `⭐ Reputation given to ${target.first_name}`);
};

//
// Economy
//
Economy.getUserData = async function (env, userId) {
  let user = await DB.getUser(env, userId);
  if (!user) {
    await DB.syncUser(env, { id: userId, first_name: "Unknown", is_bot: false });
    user = await DB.getUser(env, userId);
  }
  return user;
};

Economy.balance = async function (env, message) {
  const target = message.reply_to_message ? message.reply_to_message.from : message.from;
  const user = await Economy.getUserData(env, target.id);
  return TG.sendMessage(env, message.chat.id, `💶 <b>SRAY WALLET</b>

User:
${target.first_name}

Balance:
€${user.balance}

Status:
${(user.status || "alive").toUpperCase()}`);
};

Economy.getDailyReward = async function (env) {
  const event = await DB.first(env, `SELECT setting_value FROM settings WHERE setting_key = ?`, ["stt10dev"]);
  if (event && event.setting_value === "enabled") return 4000;
  return CONFIG.DAILY_REWARD;
};

Economy.daily = async function (env, message) {
  const cooldown = await DB.getCooldown(env, message.from.id, "daily");
  if (cooldown > 0) return TG.sendMessage(env, message.chat.id, `⏳ Daily already claimed.

Remaining:
${Time.format(cooldown)}`);
  const reward = await Economy.getDailyReward(env);
  await DB.updateBalanceAtomic(env, message.from.id, reward);
  await DB.setCooldown(env, message.from.id, "daily", 86400);
  await DB.audit(env, "daily_claim", message.from.id, message.chat.id, { reward });
  return TG.sendMessage(env, message.chat.id, `🎁 Daily Reward Claimed

Reward:
€${reward}`);
};

Economy.weekly = async function (env, message) {
  const cooldown = await DB.getCooldown(env, message.from.id, "weekly");
  if (cooldown > 0) return TG.sendMessage(env, message.chat.id, `⏳ Weekly already claimed.

Remaining:
${Time.format(cooldown)}`);
  await DB.updateBalanceAtomic(env, message.from.id, CONFIG.WEEKLY_REWARD);
  await DB.setCooldown(env, message.from.id, "weekly", 604800);
  await DB.audit(env, "weekly_claim", message.from.id, message.chat.id, { reward: CONFIG.WEEKLY_REWARD });
  return TG.sendMessage(env, message.chat.id, `🎉 Weekly Reward Claimed

Reward:
€${CONFIG.WEEKLY_REWARD}`);
};

Economy.claim = async function (env, message) {
  const reward = 500;
  await DB.updateBalanceAtomic(env, message.from.id, reward);
  return TG.sendMessage(env, message.chat.id, `💰 Claim Successful

Received:
€${reward}`);
};

Economy.give = async function (env, message, args) {
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "Reply to a user.");
  const amount = parseInt(args[0]);
  if (!amount || amount <= 0) return TG.sendMessage(env, message.chat.id, "Invalid amount.");
  const sender = await Economy.getUserData(env, message.from.id);
  if (sender.balance < amount) return TG.sendMessage(env, message.chat.id, "Insufficient balance.");
  const target = message.reply_to_message.from;
  const tax = Math.floor(amount * CONFIG.TAXES.GIVE);
  const finalAmount = amount - tax;
  await DB.updateBalanceAtomic(env, message.from.id, -amount);
  await DB.updateBalanceAtomic(env, target.id, finalAmount);
  await DB.addTreasury(env, tax, "give_tax");
  await DB.run(env, `INSERT INTO transactions (sender_id, receiver_id, amount, tax, type, created_at) VALUES (?,?,?,?,?,?)`, [message.from.id, target.id, amount, tax, "give", Time.now()]);
  return TG.sendMessage(env, message.chat.id, `💸 Transfer Successful

Amount:
€${amount}

Tax:
€${tax}

Received:
€${finalAmount}`);
};

Economy.treasury = async function (env, message) {
  const t = await DB.first(env, `SELECT balance FROM treasury WHERE id = 1`);
  return TG.sendMessage(env, message.chat.id, `🏦 SRAY TREASURY

Balance:
€${t ? t.balance : 0}`);
};

Economy.top = async function (env, message) {
  const result = await DB.query(env, `SELECT first_name, balance FROM users ORDER BY balance DESC LIMIT 10`);
  const rows = result.results || [];
  let text = `🏆 <b>RICHEST USERS</b>\n\n`;
  rows.forEach((user, idx) => {
    text += `${idx + 1}. ${user.first_name}\n€${user.balance}\n\n`;
  });
  return TG.sendMessage(env, message.chat.id, text);
};

Economy.transactions = async function (env, message) {
  const result = await DB.query(env, `SELECT * FROM transactions WHERE sender_id = ? OR receiver_id = ? ORDER BY created_at DESC LIMIT 20`, [message.from.id, message.from.id]);
  const rows = result.results || [];
  if (!rows.length) return TG.sendMessage(env, message.chat.id, "No transactions found.");
  let text = `💳 <b>Recent Transactions</b>\n\n`;
  for (const tx of rows) {
    text += `${tx.type.toUpperCase()}\n€${tx.amount}\n${new Date(tx.created_at * 1000).toLocaleDateString()}\n\n`;
  }
  return TG.sendMessage(env, message.chat.id, text);
};

Economy.supportIncome = async function (env) {
  const users = await DB.query(env, `SELECT user_id, balance FROM users`);
  const rows = users.results || [];
  for (const user of rows) {
    let reward = 0;
    if (user.balance === 0) reward = 200;
    else if (user.balance > 0 && user.balance < 100) reward = 100;
    else if (user.balance >= 100 && user.balance <= 300) reward = 50;
    if (reward > 0) {
      await DB.updateBalanceAtomic(env, user.user_id, reward);
      await DB.audit(env, "support_income", user.user_id, null, { reward });
    }
  }
};

Economy.setState = async function (env, enabled) {
  await DB.run(env, `INSERT INTO settings (setting_key, setting_value) VALUES (?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`, ["economy_enabled", enabled ? "1" : "0"]);
};

Economy.open = async function (env, message) {
  if (!(await Permissions.requireDeveloper(env, message))) return;
  await Economy.setState(env, true);
  return TG.sendMessage(env, message.chat.id, "🟢 Economy Enabled");
};

Economy.close = async function (env, message) {
  if (!(await Permissions.requireDeveloper(env, message))) return;
  await Economy.setState(env, false);
  return TG.sendMessage(env, message.chat.id, "🔴 Economy Disabled");
};

//
// Shop
//
Shop.ITEMS = {
  rose: { emoji: "🌹", name: "Rose", price: 500 },
  chocolate: { emoji: "🍫", name: "Chocolate", price: 800 },
  ring: { emoji: "💍", name: "Ring", price: 5000 },
  teddy: { emoji: "🧸", name: "Teddy Bear", price: 3000 },
  pizza: { emoji: "🍕", name: "Pizza", price: 1500 },
  surprise: { emoji: "🎁", name: "Surprise Box", price: 2500 },
  puppy: { emoji: "🐶", name: "Puppy", price: 12000 },
  cake: { emoji: "🎂", name: "Cake", price: 2000 },
  letter: { emoji: "💌", name: "Love Letter", price: 1000 },
  cat: { emoji: "🐱", name: "Cat", price: 10000 },
  dildo: { emoji: "🍆", name: "Dildo", price: 250 }
};

Shop.show = async function (env, message) {
  let text = `🛒 <b>SRAY SHOP</b>\n\n`;
  for (const key in Shop.ITEMS) {
    const item = Shop.ITEMS[key];
    text += `${item.emoji} ${item.name}\nID: <code>${key}</code>\nPrice: €${item.price}\n\n`;
  }
  return TG.sendMessage(env, message.chat.id, text);
};

Shop.buy = async function (env, message, args) {
  const itemId = (args[0] || "").toLowerCase();
  const item = Shop.ITEMS[itemId];
  if (!item) return TG.sendMessage(env, message.chat.id, "❌ Item not found.");
  const user = await DB.getUser(env, message.from.id);
  if (!user || user.balance < item.price) return TG.sendMessage(env, message.chat.id, "❌ Insufficient balance.");
  await DB.updateBalanceAtomic(env, message.from.id, -item.price);
  await DB.run(env, `INSERT INTO inventory (user_id, item_id, quantity) VALUES (?,?,1) ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + 1`, [message.from.id, itemId]);
  return TG.sendMessage(env, message.chat.id, `${item.emoji} Purchased successfully!\n\nItem:\n${item.name}\n\nPrice:\n€${item.price}`);
};

Shop.inventory = async function (env, message) {
  const items = await DB.query(env, `SELECT item_id, quantity FROM inventory WHERE user_id = ?`, [message.from.id]);
  const rows = items.results || [];
  if (!rows.length) return TG.sendMessage(env, message.chat.id, "🎒 Inventory is empty.");
  let text = `🎒 <b>Inventory</b>\n\n`;
  for (const row of rows) {
    const item = Shop.ITEMS[row.item_id];
    if (!item) continue;
    text += `${item.emoji} ${item.name}\nx${row.quantity}\n\n`;
  }
  return TG.sendMessage(env, message.chat.id, text);
};

Shop.gift = async function (env, message, args) {
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "Reply to a user.");
  const itemId = (args[0] || "").toLowerCase();
  const item = Shop.ITEMS[itemId];
  if (!item) return TG.sendMessage(env, message.chat.id, "Invalid item.");
  const inv = await DB.first(env, `SELECT quantity FROM inventory WHERE user_id = ? AND item_id = ?`, [message.from.id, itemId]);
  if (!inv || inv.quantity <= 0) return TG.sendMessage(env, message.chat.id, "You don't own this item.");
  const target = message.reply_to_message.from;
  await DB.run(env, `UPDATE inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_id = ?`, [message.from.id, itemId]);
  await DB.run(env, `INSERT INTO inventory (user_id, item_id, quantity) VALUES (?,?,1) ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + 1`, [target.id, itemId]);
  return TG.sendMessage(env, message.chat.id, `${message.from.first_name}\ngifted\n\n${item.emoji} ${item.name}\n\nto\n\n${target.first_name}`);
};

Shop.sell = async function (env, message, args) {
  const itemId = (args[0] || "").toLowerCase();
  const item = Shop.ITEMS[itemId];
  if (!item) return TG.sendMessage(env, message.chat.id, "Invalid item.");
  const inv = await DB.first(env, `SELECT quantity FROM inventory WHERE user_id = ? AND item_id = ?`, [message.from.id, itemId]);
  if (!inv || inv.quantity <= 0) return TG.sendMessage(env, message.chat.id, "Item not owned.");
  const value = Math.floor(item.price * 0.5);
  await DB.run(env, `UPDATE inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_id = ?`, [message.from.id, itemId]);
  await DB.updateBalanceAtomic(env, message.from.id, value);
  return TG.sendMessage(env, message.chat.id, `💰 Sold successfully\n\nItem:\n${item.name}\n\nReceived:\n€${value}`);
};

//
// Combat (rob/kill/protect/status)
//
Combat.DEATH_DURATION = 172800; // 48h

Combat.getStatus = async function (env, userId) {
  const row = await DB.first(env, `SELECT status, protected_until, dead_until FROM combat_status WHERE user_id = ?`, [userId]);
  if (!row) return { status: "alive", protected: false, dead: false };
  return {
    status: row.status,
    protected: row.protected_until && row.protected_until > Time.now(),
    dead: row.dead_until && row.dead_until > Time.now(),
    protected_until: row.protected_until,
    dead_until: row.dead_until
  };
};

Combat.setDead = async function (env, userId) {
  await DB.run(env, `INSERT INTO combat_status (user_id, status, dead_until) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET status='dead', dead_until=excluded.dead_until`, [userId, "dead", Time.future(Combat.DEATH_DURATION)]);
};

Combat.reviveExpired = async function (env) {
  await DB.run(env, `UPDATE combat_status SET status='alive', dead_until=NULL WHERE dead_until <= ?`, [Time.now()]);
};

Combat.protect = async function (env, message) {
  const cost = 1000;
  const user = await DB.getUser(env, message.from.id);
  if (user.balance < cost) return TG.sendMessage(env, message.chat.id, `❌ Protection costs €${cost}`);
  await DB.updateBalanceAtomic(env, message.from.id, -cost);
  await DB.run(env, `INSERT INTO combat_status (user_id, status, protected_until) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET protected_until = excluded.protected_until`, [message.from.id, "alive", Time.future(86400)]);
  return TG.sendMessage(env, message.chat.id, "🛡 Protection enabled for 24 hours.");
};

Combat.rob = async function (env, message) {
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "Reply to a user.");
  const target = message.reply_to_message.from;
  if (target.id === message.from.id) return TG.sendMessage(env, message.chat.id, "❌ Cannot rob yourself.");
  const targetStatus = await Combat.getStatus(env, target.id);
  if (targetStatus.protected) return TG.sendMessage(env, message.chat.id, "🛡 User is protected.");
  const victim = await DB.getUser(env, target.id);
  const amount = Math.min(Math.floor(Math.random() * 500) + 100, victim.balance);
  if (amount <= 0) return TG.sendMessage(env, message.chat.id, "💸 Nothing to steal.");
  const tax = Math.floor(amount * CONFIG.TAXES.ROB);
  const reward = amount - tax;
  await DB.updateBalanceAtomic(env, target.id, -amount);
  await DB.updateBalanceAtomic(env, message.from.id, reward);
  await DB.addTreasury(env, tax, "rob_tax");
  return TG.sendMessage(env, message.chat.id, `💰 Rob Successful

Victim:
${target.first_name}

Stolen:
€${reward}

Tax:
€${tax}`);
};

Combat.kill = async function (env, message) {
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "Reply to a user.");
  const target = message.reply_to_message.from;
  if (target.is_bot) return TG.sendMessage(env, message.chat.id, "❌ Bots cannot be killed.");
  const status = await Combat.getStatus(env, target.id);
  if (status.dead) return TG.sendMessage(env, message.chat.id, "☠️ User is already dead.");
  const success = Math.random() < 0.6;
  if (!success) return TG.sendMessage(env, message.chat.id, `🔪 Attempt failed against ${target.first_name}`);
  await Combat.setDead(env, target.id);
  return TG.sendMessage(env, message.chat.id, `☠️ ${target.first_name} has been killed.

Revive Time:
48 Hours`);
};

Combat.status = async function (env, message) {
  const state = await Combat.getStatus(env, message.from.id);
  let text = `❤️ STATUS

Current:
${state.status.toUpperCase()}`;
  if (state.protected) text += `

🛡 Protected for:
${Time.format(state.protected_until - Time.now())}`;
  if (state.dead) text += `

☠️ Revives in:
${Time.format(state.dead_until - Time.now())}`;
  return TG.sendMessage(env, message.chat.id, text);
};

//
// Card game
//
Card.MIN_BET = 200;
Card.LOBBY_TIME = 60;
Card.CARDS = ["A", "B", "C", "D"];
Card.MAX_STRIKES = 3;
Card.TURN_TIME = 60;
Card.WARNING_TIME = 30;

Card.shuffle = function (cards) {
  const arr = [...cards];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

Card.createMatch = async function (env, message, args) {
  const bet = parseInt(args[0]);
  if (!bet || bet < Card.MIN_BET) return TG.sendMessage(env, message.chat.id, `Minimum bet is €${Card.MIN_BET}`);
  const creator = await DB.getUser(env, message.from.id);
  if (creator.balance < bet) return TG.sendMessage(env, message.chat.id, "Insufficient balance.");
  const existing = await DB.first(env, `SELECT match_id FROM card_matches WHERE chat_id = ? AND status = 'lobby'`, [message.chat.id]);
  if (existing) return TG.sendMessage(env, message.chat.id, "A card lobby already exists.");
  const matchId = crypto.randomUUID();
  await DB.run(env, `INSERT INTO card_matches (match_id, chat_id, creator_id, bet_amount, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`, [matchId, message.chat.id, message.from.id, bet, "lobby", Time.now(), Time.future(Card.LOBBY_TIME)]);
  await DB.run(env, `INSERT INTO card_players (match_id, user_id, joined_at) VALUES (?,?,?)`, [matchId, message.from.id, Time.now()]);
  return TG.sendMessage(env, message.chat.id, `🃏 CARD MATCH CREATED

Creator:
${message.from.first_name}

Bet:
€${bet}

Lobby:
${Card.LOBBY_TIME} seconds

Join using:
/bet`);
};

Card.joinMatch = async function (env, message) {
  const lobby = await DB.first(env, `SELECT * FROM card_matches WHERE chat_id = ? AND status = 'lobby'`, [message.chat.id]);
  if (!lobby) return TG.sendMessage(env, message.chat.id, "No active lobby found.");
  const already = await DB.first(env, `SELECT * FROM card_players WHERE match_id = ? AND user_id = ?`, [lobby.match_id, message.from.id]);
  if (already) return TG.sendMessage(env, message.chat.id, "You already joined this match.");
  const player = await DB.getUser(env, message.from.id);
  if (player.balance < lobby.bet_amount) return TG.sendMessage(env, message.chat.id, `You need €${lobby.bet_amount} to join.`);
  await DB.run(env, `INSERT INTO card_players (match_id, user_id, joined_at) VALUES (?,?,?)`, [lobby.match_id, message.from.id, Time.now()]);
  const count = await DB.first(env, `SELECT COUNT(*) total FROM card_players WHERE match_id = ?`, [lobby.match_id]);
  return TG.sendMessage(env, message.chat.id, `✅ Joined Card Match

Players:
${count.total}

Bet:
€${lobby.bet_amount}`);
};

Card.startMatch = async function (env, matchId) {
  const players = await DB.query(env, `SELECT * FROM card_players WHERE match_id = ?`, [matchId]);
  const rows = players.results || [];
  if (rows.length < 2) {
    await DB.run(env, `UPDATE card_matches SET status = 'cancelled' WHERE match_id = ?`, [matchId]);
    return;
  }
  const match = await DB.first(env, `SELECT * FROM card_matches WHERE match_id = ?`, [matchId]);
  const tax = Math.floor(match.bet_amount * CONFIG.TAXES.CARD);
  for (const p of rows) {
    await DB.updateBalanceAtomic(env, p.user_id, -match.bet_amount);
  }
  await DB.addTreasury(env, tax * rows.length, "card_tax");
  await DB.run(env, `UPDATE card_matches SET status='active' WHERE match_id = ?`, [matchId]);

  for (const p of rows) {
    const deck = Card.shuffle(Card.CARDS);
    await DB.run(env, `INSERT OR REPLACE INTO card_hands (match_id, user_id, card_a, card_b, card_c, card_d, score, strikes) VALUES (?,?,?,?,?,?,?,?)`, [
      matchId,
      p.user_id,
      deck[0],
      deck[1],
      deck[2],
      deck[3],
      0,
      0
    ]);
    try {
      await TG.sendMessage(env, p.user_id, `🃏 Your Cards

A → ${deck[0]}
B → ${deck[1]}
C → ${deck[2]}
D → ${deck[3]}

Keep them secret.
Use:

/flip a
/flip b
/flip c
/flip d`);
    } catch (e) {
      Log.warn("Failed to DM card to user", p.user_id, e);
    }
  }
};

Card.processLobbies = async function (env) {
  const matches = await DB.query(env, `SELECT * FROM card_matches WHERE status = 'lobby' AND expires_at <= ?`, [Time.now()]);
  const rows = matches.results || [];
  for (const match of rows) await Card.startMatch(env, match.match_id);
};

Card.predict = async function (env, message, args) {
  const round = parseInt(args[0]);
  if (!round || round < 1 || round > 4) return TG.sendMessage(env, message.chat.id, "Usage:\n/predict 1");
  const active = await DB.first(env, `SELECT match_id FROM card_matches WHERE chat_id = ? AND status = 'active'`, [message.chat.id]);
  if (!active) return;
  await DB.run(env, `INSERT INTO card_predictions (match_id, user_id, prediction) VALUES (?,?,?) ON CONFLICT(match_id, user_id) DO UPDATE SET prediction = excluded.prediction`, [active.match_id, message.from.id, round]);
  return TG.sendMessage(env, message.chat.id, `🎯 Prediction saved for Round ${round}`);
};

Card.flip = async function (env, message, args) {
  const slot = (args[0] || "").toUpperCase();
  if (!["A", "B", "C", "D"].includes(slot)) return TG.sendMessage(env, message.chat.id, "Usage:\n/flip a");
  const active = await DB.first(env, `SELECT match_id FROM card_matches WHERE chat_id = ? AND status = 'active'`, [message.chat.id]);
  if (!active) return;
  const state = await DB.first(env, `SELECT current_round FROM card_state WHERE match_id = ?`, [active.match_id]);
  const round = state ? state.current_round : 1;
  const existing = await DB.first(env, `SELECT * FROM card_moves WHERE match_id = ? AND user_id = ? AND round = ?`, [active.match_id, message.from.id, round]);
  if (existing) return TG.sendMessage(env, message.chat.id, "You already played this round.");
  await DB.run(env, `INSERT INTO card_moves (match_id, round, user_id, selected_card, created_at) VALUES (?,?,?,?,?)`, [active.match_id, round, message.from.id, slot, Time.now()]);
  return TG.sendMessage(env, message.chat.id, `✅ Card ${slot} locked for Round ${round}`);
};

Card.revealRound = async function (env, matchId, round) {
  const moves = await DB.query(env, `SELECT * FROM card_moves WHERE match_id = ? AND round = ?`, [matchId, round]);
  const rows = moves.results || [];
  let output = `🃏 ROUND ${round} RESULTS\n\n`;
  for (const move of rows) {
    const hand = await DB.first(env, `SELECT * FROM card_hands WHERE match_id = ? AND user_id = ?`, [matchId, move.user_id]);
    const card = hand ? hand[`card_${move.selected_card.toLowerCase()}`] : "Unknown";
    output += `User ${move.user_id}\nPlayed:\n${move.selected_card}\nValue:\n${card}\n\n`;
    await DB.run(env, `UPDATE card_hands SET score = score + 1 WHERE match_id = ? AND user_id = ?`, [matchId, move.user_id]);
  }
  return output;
};

Card.sendWarning = async function (env, userId, round) {
  try {
    await TG.sendMessage(env, userId, `⏰ Round ${round}

30 seconds remaining.

Choose your card using:

/flip a
/flip b
/flip c
/flip d`);
  } catch (e) {}
};

Card.addStrike = async function (env, matchId, userId) {
  await DB.run(env, `UPDATE card_hands SET strikes = strikes + 1 WHERE match_id = ? AND user_id = ?`, [matchId, userId]);
  const hand = await DB.first(env, `SELECT strikes FROM card_hands WHERE match_id = ? AND user_id = ?`, [matchId, userId]);
  if (hand && hand.strikes >= Card.MAX_STRIKES) {
    await DB.run(env, `INSERT OR IGNORE INTO card_disqualified (match_id, user_id) VALUES (?,?)`, [matchId, userId]);
    return true;
  }
  return false;
};

Card.autoFlip = async function (env, matchId, userId, round) {
  const used = await DB.query(env, `SELECT selected_card FROM card_moves WHERE match_id = ? AND user_id = ?`, [matchId, userId]);
  const played = (used.results || []).map((x) => x.selected_card);
  const available = ["A", "B", "C", "D"].filter((x) => !played.includes(x));
  if (!available.length) return;
  const selected = available[0];
  await DB.run(env, `INSERT INTO card_moves (match_id, round, user_id, selected_card, created_at) VALUES (?,?,?,?,?)`, [matchId, round, userId, selected, Time.now()]);
  const kicked = await Card.addStrike(env, matchId, userId);
  try {
    await TG.sendMessage(env, userId, kicked ? `❌ Disqualified after 3 strikes.` : `⚠️ Auto Flip Used

Card:
${selected}

Strike Added.`);
  } catch (e) {}
};

Card.checkRoundFinished = async function (env, matchId, round) {
  const players = await DB.first(env, `SELECT COUNT(*) total FROM card_players WHERE match_id = ?`, [matchId]);
  const moves = await DB.first(env, `SELECT COUNT(*) total FROM card_moves WHERE match_id = ? AND round = ?`, [matchId, round]);
  return players.total === moves.total;
};

Card.finishGame = async function (env, matchId) {
  const scores = await DB.query(env, `SELECT user_id, score FROM card_hands WHERE match_id = ? ORDER BY score DESC`, [matchId]);
  const rows = scores.results || [];
  const match = await DB.first(env, `SELECT * FROM card_matches WHERE match_id = ?`, [matchId]);
  if (!match) return;
  const playerCount = rows.length;
  const totalPot = match.bet_amount * playerCount;
  const prizes = [Math.floor(totalPot * 0.5), Math.floor(totalPot * 0.3), Math.floor(totalPot * 0.2)];
  if (rows[0]) await DB.updateBalanceAtomic(env, rows[0].user_id, prizes[0]);
  if (rows[1]) await DB.updateBalanceAtomic(env, rows[1].user_id, prizes[1]);
  if (rows[2]) await DB.updateBalanceAtomic(env, rows[2].user_id, prizes[2]);
  await DB.run(env, `UPDATE card_matches SET status = 'finished' WHERE match_id = ?`, [matchId]);
};

//
// Fun and MiniGames
//
Fun.randomPercent = function (min = 0, max = 100) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};
Fun.replyTarget = function (message) {
  if (message.reply_to_message) return message.reply_to_message.from.first_name;
  return message.from.first_name;
};
Fun.sendPercent = async function (env, message, title, emoji) {
  const target = Fun.replyTarget(message);
  const percent = Fun.randomPercent();
  return TG.sendMessage(env, message.chat.id, `${emoji} ${title}

${target}

${percent}%`);
};
Fun.love = async function (env, message) {
  const percent = Fun.randomPercent();
  return TG.sendMessage(env, message.chat.id, `❤️ LOVE METER

${message.from.first_name}

Love Level:

${percent}%`);
};
Fun.ship = async function (env, message) {
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "Reply to someone.");
  const percent = Fun.randomPercent();
  return TG.sendMessage(env, message.chat.id, `💞 SHIP RESULT

${message.from.first_name}
❤️
${message.reply_to_message.from.first_name}

Compatibility:

${percent}%`);
};
Fun.gay = (env, m) => Fun.sendPercent(env, m, "GAY METER", "🏳️‍🌈");
Fun.lesbo = (env, m) => Fun.sendPercent(env, m, "LESBO METER", "💜");
Fun.brain = (env, m) => Fun.sendPercent(env, m, "BRAIN POWER", "🧠");
Fun.hot = (env, m) => Fun.sendPercent(env, m, "HOTNESS", "🔥");
Fun.cute = (env, m) => Fun.sendPercent(env, m, "CUTENESS", "🥰");
Fun.luck = (env, m) => Fun.sendPercent(env, m, "LUCK", "🍀");
Fun.rich = (env, m) => Fun.sendPercent(env, m, "RICH LEVEL", "💰");
Fun.sigma = (env, m) => Fun.sendPercent(env, m, "SIGMA ENERGY", "😎");
Fun.danger = (env, m) => Fun.sendPercent(env, m, "DANGER LEVEL", "☠️");
Fun.simp = (env, m) => Fun.sendPercent(env, m, "SIMP LEVEL", "🌹");
Fun.power = (env, m) => Fun.sendPercent(env, m, "POWER LEVEL", "⚡");
Fun.chad = (env, m) => Fun.sendPercent(env, m, "CHAD LEVEL", "🗿");
Fun.stupidity = (env, m) => Fun.sendPercent(env, m, "STUPIDITY", "🤡");
Fun.looks = (env, m) => Fun.sendPercent(env, m, "LOOKS", "✨");
Fun.dick = (env, m) => Fun.sendPercent(env, m, "SIZE DETECTOR", "📏");
Fun.couples = async function (env, message) {
  const result = await DB.query(env, `SELECT first_name FROM users ORDER BY RANDOM() LIMIT 2`);
  const rows = result.results || [];
  if (rows.length < 2) return;
  return TG.sendMessage(env, message.chat.id, `💞 SRAY COUPLES OF THE DAY

❤️ ${rows[0].first_name}
❤️ ${rows[1].first_name}`);
};
Fun.toss = async function (env, message) {
  const side = Math.random() > 0.5 ? "HEADS" : "TAILS";
  return TG.sendMessage(env, message.chat.id, `🪙 ${side}`);
};

//
// MiniGames
//
MiniGames.TRUTHS = ["What is your biggest fear?", "Who was your first crush?", "What is your most embarrassing moment?", "What is your biggest secret?", "Have you ever lied to your best friend?"];
MiniGames.DARES = ["Send your last emoji.", "Change your nickname for 10 minutes.", "Send a random meme.", "Type using only emojis for 5 messages.", "Compliment the person above you."];
MiniGames.WYR = ["Would you rather fly or become invisible?", "Would you rather have unlimited money or unlimited friends?", "Would you rather live in space or underwater?", "Would you rather never sleep or never eat?"];
MiniGames.NEVER = ["Never have I ever skipped school.", "Never have I ever broken a phone.", "Never have I ever lied to avoid trouble.", "Never have I ever forgotten someone's birthday."];
MiniGames.RIDDLES = [{ q: "What has keys but can't open locks?", a: "Keyboard" }, { q: "What gets wetter as it dries?", a: "Towel" }, { q: "What has hands but cannot clap?", a: "Clock" }];
MiniGames.QUIZ = [{ q: "Capital of India?", a: "New Delhi" }, { q: "2 + 2 × 2 = ?", a: "6" }, { q: "Largest planet?", a: "Jupiter" }];
MiniGames.pick = function (arr) {
  return arr[Math.floor(Math.random() * arr.length)];
};
MiniGames.truth = async function (env, message) {
  return TG.sendMessage(env, message.chat.id, `🎤 TRUTH\n\n${MiniGames.pick(MiniGames.TRUTHS)}`);
};
MiniGames.dare = async function (env, message) {
  return TG.sendMessage(env, message.chat.id, `🔥 DARE\n\n${MiniGames.pick(MiniGames.DARES)}`);
};
MiniGames.wyr = async function (env, message) {
  return TG.sendMessage(env, message.chat.id, `🤔 WOULD YOU RATHER\n\n${MiniGames.pick(MiniGames.WYR)}`);
};
MiniGames.never = async function (env, message) {
  return TG.sendMessage(env, message.chat.id, `🙈 NEVER HAVE I EVER\n\n${MiniGames.pick(MiniGames.NEVER)}`);
};
MiniGames.riddle = async function (env, message) {
  const item = MiniGames.pick(MiniGames.RIDDLES);
  return TG.sendMessage(env, message.chat.id, `🧩 RIDDLE

Question:
${item.q}

Answer:
||${item.a}||`);
};
MiniGames.quiz = async function (env, message) {
  const item = MiniGames.pick(MiniGames.QUIZ);
  return TG.sendMessage(env, message.chat.id, `📚 QUIZ

Question:
${item.q}

Answer:
||${item.a}||`);
};
MiniGames.coin = async function (env, message) {
  const result = Math.random() > 0.5 ? "HEADS" : "TAILS";
  return TG.sendMessage(env, message.chat.id, `🪙 Coin Result:\n${result}`);
};
MiniGames.dice = async function (env, message) {
  return TG.sendDice(env, message.chat.id, "🎲");
};
MiniGames.spin = async function (env, message) {
  const value = Math.floor(Math.random() * 100) + 1;
  return TG.sendMessage(env, message.chat.id, `🎡 Spin Result:\n${value}`);
};
MiniGames.dance = async function (env, message) {
  const dances = ["💃", "🕺", "💃🕺", "🎉💃🎉"];
  return TG.sendMessage(env, message.chat.id, MiniGames.pick(dances));
};

//
// Channel management
//
Channel.broadcast = async function (env, message, args) {
  if (!(await Permissions.requireDeveloper(env, message))) return;
  const text = args.join(" ");
  if (!text) return TG.sendMessage(env, message.chat.id, "Usage:\n.broadcast message");
  const chats = await DB.query(env, `SELECT chat_id FROM groups`);
  let success = 0;
  for (const group of chats.results || []) {
    try {
      await TG.sendMessage(env, group.chat_id, `📢 Broadcast

${text}`);
      success++;
      await new Promise((r) => setTimeout(r, 200));
    } catch (e) {
      Log.warn("Broadcast failed to group", group.chat_id, e);
    }
  }
  return TG.sendMessage(env, message.chat.id, `📡 Broadcast Complete

Delivered:
${success} chats`);
};

Channel.generateCaption = async function (env, text) {
  if (AI.getProvider() === "openrouter") {
    return `✨ ${text}

#SRAY
#Telegram
#Community`;
  }
  return `${text}

🩷 Powered by SRAY`;
};

Channel.autoReaction = function () {
  const reactions = ["❤️", "🔥", "👏", "💯", "⚡", "😍", "🎉"];
  return reactions[Math.floor(Math.random() * reactions.length)];
};

Channel.analytics = async function (env, message) {
  const users = await DB.first(env, `SELECT COUNT(*) total FROM users`);
  const groups = await DB.first(env, `SELECT COUNT(*) total FROM groups`);
  const transactions = await DB.first(env, `SELECT COUNT(*) total FROM transactions`);
  const memory = await DB.first(env, `SELECT COUNT(*) total FROM ai_memory`);
  return TG.sendMessage(env, message.chat.id, `📊 SRAY ANALYTICS

Users:
${users.total}

Groups:
${groups.total}

Transactions:
${transactions.total}

Memory Entries:
${memory.total}`);
};

Channel.schedulePost = async function (env, message, args) {
  if (!(await Permissions.requireDeveloper(env, message))) return;
  const minutes = parseInt(args[0]);
  const content = args.slice(1).join(" ");
  if (!minutes || !content) return TG.sendMessage(env, message.chat.id, `Usage:\n\n.schedule 30 Hello World`);
  await DB.run(env, `INSERT INTO scheduled_posts (chat_id, content, media_url, send_at, created_at, created_by) VALUES (?,?,?,?,?,?)`, [message.chat.id, content, null, Time.future(minutes * 60), Time.now(), message.from.id]);
  return TG.sendMessage(env, message.chat.id, `⏰ Post Scheduled

Time:
${minutes} minutes`);
};

Channel.processSchedules = async function (env) {
  const posts = await DB.query(env, `SELECT * FROM scheduled_posts WHERE send_at <= ? AND sent = 0`, [Time.now()]);
  for (const post of posts.results || []) {
    try {
      await TG.sendMessage(env, post.chat_id, post.content);
      await DB.run(env, `UPDATE scheduled_posts SET sent = 1 WHERE id = ?`, [post.id]);
    } catch (e) {
      Log.warn("Failed to send scheduled post", post.id, e);
    }
  }
};

//
// GlobalMod (gban)
//
GlobalMod.gban = async function (env, message, args) {
  if (!(await Permissions.requireDeveloper(env, message))) return;
  if (!message.reply_to_message) return TG.sendMessage(env, message.chat.id, "Reply to a user to globally ban them.");
  const target = message.reply_to_message.from;
  const reason = args.join(" ") || "No reason provided";
  await DB.run(env, `INSERT INTO global_bans (user_id, username, reason, banned_by, created_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET reason=excluded.reason, banned_by=excluded.banned_by, created_at=excluded.created_at`, [target.id, target.username || "", reason, message.from.id, Time.now()]);
  try {
    await TG.call(env, "banChatMember", { chat_id: message.chat.id, user_id: target.id });
  } catch (e) {}
  return TG.sendMessage(env, message.chat.id, `🌍 GLOBAL BAN APPLIED

User:
${target.first_name}

ID:
${target.id}

Reason:
${reason}`);
};

GlobalMod.gunban = async function (env, message, args) {
  if (!(await Permissions.requireDeveloper(env, message))) return;
  const userId = parseInt(args[0]);
  if (!userId) return TG.sendMessage(env, message.chat.id, `Usage:\n\n.gunban USER_ID`);
  await DB.run(env, `DELETE FROM global_bans WHERE user_id = ?`, [userId]);
  return TG.sendMessage(env, message.chat.id, `✅ Global ban removed

User ID:
${userId}`);
};

GlobalMod.list = async function (env, message) {
  const bans = await DB.query(env, `SELECT * FROM global_bans ORDER BY created_at DESC LIMIT 50`);
  const rows = bans.results || [];
  if (!rows.length) return TG.sendMessage(env, message.chat.id, "No global bans.");
  let text = `🌍 GLOBAL BANS\n\n`;
  for (const ban of rows) {
    text += `${ban.user_id}

@${ban.username || "none"}

Reason:
${ban.reason}

`;
  }
  return TG.sendMessage(env, message.chat.id, text);
};

GlobalMod.isGbanned = async function (env, userId) {
  const row = await DB.first(env, `SELECT user_id FROM global_bans WHERE user_id = ?`, [userId]);
  return !!row;
};

GlobalMod.enforce = async function (env, message) {
  if (!message.new_chat_members) return;
  for (const member of message.new_chat_members) {
    const banned = await GlobalMod.isGbanned(env, member.id);
    if (!banned) continue;
    try {
      await TG.call(env, "banChatMember", { chat_id: message.chat.id, user_id: member.id });
      await TG.sendMessage(env, message.chat.id, `🚫 Globally banned user removed

User:
${member.first_name}

Reason:
Global Ban List`);
    } catch (e) {
      Log.warn("Failed to enforce global ban", member.id, e);
    }
  }
};

//
// Greetings
//
Greetings.DEFAULT_WELCOME = `🩷 Welcome {name}!

Welcome to {group}

Please read the rules and enjoy your stay ✨`;
Greetings.DEFAULT_GOODBYE = `👋 Goodbye {name}

We'll miss you in {group} 🩷`;

Greetings.getWelcome = async function (env, chatId) {
  const custom = await DB.first(env, `SELECT value FROM group_settings WHERE chat_id = ? AND setting_key = 'welcome_message'`, [chatId]);
  return custom ? custom.value : Greetings.DEFAULT_WELCOME;
};

Greetings.getGoodbye = async function (env, chatId) {
  const custom = await DB.first(env, `SELECT value FROM group_settings WHERE chat_id = ? AND setting_key = 'goodbye_message'`, [chatId]);
  return custom ? custom.value : Greetings.DEFAULT_GOODBYE;
};

Greetings.setWelcome = async function (env, message, args) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  const text = args.join(" ");
  if (!text) return TG.sendMessage(env, message.chat.id, `Usage:\n\n/welcome Welcome {name} to {group}\n\nVariables:\n\n{name}\n{group}`);
  await DB.run(env, `INSERT INTO group_settings (chat_id, setting_key, value) VALUES (?,?,?) ON CONFLICT(chat_id, setting_key) DO UPDATE SET value = excluded.value`, [message.chat.id, "welcome_message", text]);
  return TG.sendMessage(env, message.chat.id, "✅ Welcome message updated.");
};

Greetings.setGoodbye = async function (env, message, args) {
  if (!(await Permissions.requireAdmin(env, message))) return;
  const text = args.join(" ");
  if (!text) return TG.sendMessage(env, message.chat.id, `Usage:\n\n/goodbye Bye {name}\n\nVariables:\n\n{name}\n{group}`);
  await DB.run(env, `INSERT INTO group_settings (chat_id, setting_key, value) VALUES (?,?,?) ON CONFLICT(chat_id, setting_key) DO UPDATE SET value = excluded.value`, [message.chat.id, "goodbye_message", text]);
  return TG.sendMessage(env, message.chat.id, "✅ Goodbye message updated.");
};

Greetings.handleJoin = async function (env, message) {
  if (!message.new_chat_members) return;
  const template = await Greetings.getWelcome(env, message.chat.id);
  for (const user of message.new_chat_members) {
    const text = template.replace("{name}", user.first_name).replace("{group}", message.chat.title || "");
    await TG.sendMessage(env, message.chat.id, text);
  }
};

Greetings.handleLeave = async function (env, message) {
  if (!message.left_chat_member) return;
  const template = await Greetings.getGoodbye(env, message.chat.id);
  const text = template.replace("{name}", message.left_chat_member.first_name).replace("{group}", message.chat.title || "");
  await TG.sendMessage(env, message.chat.id, text);
};

//
// Protection advanced
//
Protection.RAID_THRESHOLD = 8;
Protection.RAID_WINDOW = 60;
Protection.FLOOD_LIMIT = 7;
Protection.FLOOD_WINDOW = 12;
Protection.SPAM_MUTE_TIME = 1800;

Protection.trackMessage = async function (env, message) {
  if (!message.from) return;
  await DB.run(env, `INSERT INTO message_tracker (chat_id, user_id, created_at) VALUES (?,?,?)`, [message.chat.id, message.from.id, Time.now()]);
};

Protection.checkFlood = async function (env, message) {
  const enabled = await DB.first(env, `SELECT enabled FROM protections WHERE chat_id = ? AND type = 'antiflood'`, [message.chat.id]);
  if (!enabled || !enabled.enabled) return;
  const count = await DB.first(env, `SELECT COUNT(*) total FROM message_tracker WHERE chat_id = ? AND user_id = ? AND created_at > ?`, [message.chat.id, message.from.id, Time.now() - Protection.FLOOD_WINDOW]);
  if (!count || count.total < Protection.FLOOD_LIMIT) return;
  await TG.call(env, "restrictChatMember", {
    chat_id: message.chat.id,
    user_id: message.from.id,
    until_date: Time.future(Protection.SPAM_MUTE_TIME),
    permissions: { can_send_messages: false }
  });
  return TG.sendMessage(env, message.chat.id, `🚫 AntiFlood Triggered

User:
${message.from.first_name}

Muted:
30 Minutes`);
};

Protection.trackJoin = async function (env, message) {
  if (!message.new_chat_members) return;
  for (const member of message.new_chat_members) {
    await DB.run(env, `INSERT INTO join_tracker (chat_id, user_id, joined_at) VALUES (?,?,?)`, [message.chat.id, member.id, Time.now()]);
  }
};

Protection.checkRaid = async function (env, message) {
  const enabled = await DB.first(env, `SELECT enabled FROM protections WHERE chat_id = ? AND type = 'antiraid'`, [message.chat.id]);
  if (!enabled || !enabled.enabled) return;
  const joins = await DB.first(env, `SELECT COUNT(*) total FROM join_tracker WHERE chat_id = ? AND joined_at > ?`, [message.chat.id, Time.now() - Protection.RAID_WINDOW]);
  if (!joins || joins.total < Protection.RAID_THRESHOLD) return;
  await DB.run(env, `INSERT INTO protections (chat_id, type, enabled) VALUES (?,?,1) ON CONFLICT(chat_id, type) DO UPDATE SET enabled=1`, [message.chat.id, "raid_lockdown"]);
  await TG.sendMessage(env, message.chat.id, `🚨 RAID DETECTED

Protection Mode:
LOCKDOWN

New joins temporarily restricted.`);
};

Protection.enforceRaidLock = async function (env, message) {
  if (!message.new_chat_members) return;
  const lockdown = await DB.first(env, `SELECT enabled FROM protections WHERE chat_id = ? AND type = 'raid_lockdown'`, [message.chat.id]);
  if (!lockdown || !lockdown.enabled) return;
  for (const member of message.new_chat_members) {
    try {
      await TG.call(env, "restrictChatMember", { chat_id: message.chat.id, user_id: member.id, permissions: { can_send_messages: false }, until_date: Time.future(3600) });
    } catch (e) {}
  }
};

Protection.cleanup = async function (env) {
  await DB.run(env, `DELETE FROM message_tracker WHERE created_at < ?`, [Time.now() - 3600]);
  await DB.run(env, `DELETE FROM join_tracker WHERE joined_at < ?`, [Time.now() - 3600]);
};

//
// Search
//
Search.translate = async function (env, message, args) {
  const text = args.join(" ");
  if (!text) return TG.sendMessage(env, message.chat.id, `Usage:\n\n/tr hello in hindi\n/tr नमस्ते in english`);
  const prompt = `Translate this text:

${text}

Return only translated text.`;
  // Use AI functions for translation - fallbacks handled in AI functions
  const fakeMessage = { text: prompt, chat: message.chat, from: message.from };
  const result = AI.getProvider() === "openrouter" ? await AI.openrouter(env, fakeMessage) : await AI.cloudflare(env, fakeMessage);
  return TG.sendMessage(env, message.chat.id, `🌍 Translation:\n\n${result}`);
};

Search.wiki = async function (env, message, args) {
  const query = args.join(" ");
  if (!query) return TG.sendMessage(env, message.chat.id, `Usage:\n\n/wiki gravity\n/wiki telegram`);
  const prompt = `Explain this topic briefly:

${query}

Keep answer under 250 words.`;
  const fakeMessage = { text: prompt, chat: message.chat, from: message.from };
  const result = AI.getProvider() === "openrouter" ? await AI.openrouter(env, fakeMessage) : await AI.cloudflare(env, fakeMessage);
  return TG.sendMessage(env, message.chat.id, result);
};

Search.cacheGet = async function (env, key) {
  return await DB.first(env, `SELECT value FROM search_cache WHERE cache_key = ? AND expires_at > ?`, [key, Time.now()]);
};

Search.cacheSet = async function (env, key, value) {
  await DB.run(env, `INSERT INTO search_cache (cache_key, value, expires_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`, [key, value, Time.future(3600)]);
};

Search.processNatural = async function (env, message) {
  if (!message.text) return false;
  const text = message.text.toLowerCase();
  if (text.startsWith("play ")) {
    const song = text.replace("play ", "");
    return TG.sendMessage(env, message.chat.id, `🎵 Search Result

Song:
${song}

Open YouTube or Spotify to listen.`);
  }
  if (text.startsWith("find ")) {
    const query = text.replace("find ", "");
    const prompt = `Give short information about:

${query}`;
    const fakeMessage = { text: prompt, chat: message.chat, from: message.from };
    const result = AI.getProvider() === "openrouter" ? await AI.openrouter(env, fakeMessage) : await AI.cloudflare(env, fakeMessage);
    await TG.sendMessage(env, message.chat.id, result);
    return true;
  }
  return false;
};

Search.cleanup = async function (env) {
  await DB.run(env, `DELETE FROM search_cache WHERE expires_at <= ?`, [Time.now()]);
};

//
// Router.processUpdate - single entrypoint for updates
//
Router.processUpdate = async function (env, update, ctx) {
  try {
    Log.info("UPDATE RECEIVED", update && update.update_id ? update.update_id : "(no id)");
    const message = update.message || update.edited_message || update.channel_post;
    Log.info("MESSAGE (raw)", message && (message.text || "[no text]"));

    if (!message) return;

    // Ensure schema exists (safe, idempotent)
    try {
      await DB.initSchema(env);
    } catch (schemaErr) {
      Log.error("Schema init failed", schemaErr);
    }

    // keep DB sync minimal
    try {
      await DB.syncContext(env, message);
    } catch (syncErr) {
      Log.error("syncContext failed", syncErr);
    }

    // Non-command flows and enforcement
    await GlobalMod.enforce(env, message);
    await Greetings.handleJoin(env, message);
    await Greetings.handleLeave(env, message);

    // Protection hooks
    try {
      await Protection.trackMessage(env, message);
      await Protection.checkFlood(env, message);
      await Protection.trackJoin(env, message);
      await Protection.checkRaid(env, message);
      await Protection.enforceRaidLock(env, message);
    } catch (protErr) {
      Log.warn("Protection flow error", protErr);
    }

    // Immediate filters
    await Protection.processMessage(env, message);

    // Natural search detection
    try {
      const natural = await Search.processNatural(env, message);
      if (natural) {
        Log.info("Natural processor handled the message");
        return;
      }
    } catch (natErr) {
      Log.warn("Search.processNatural error", natErr);
    }

    // AI (non-blocking)
    try {
      ctx && ctx.waitUntil(AI.process(env, message));
    } catch (aiErr) {
      Log.warn("AI.process scheduling error", aiErr);
    }

    // Commands handling: only if starts with / or .
    if (!message.text) {
      Log.info("No message.text, skipping commands");
      return;
    }
    if (!message.text.startsWith("/") && !message.text.startsWith(".")) {
      Log.info("Not a command message");
      return;
    }

    const parsed = Router.parseCommand(message);
    Log.info("PARSED", parsed);
    if (!parsed) return;

    try {
      await Router.handle(env, message, ctx);
    } catch (handleErr) {
      Log.error("Router.handle error", handleErr);
    }
  } catch (err) {
    await Security.logError(env, err, "update_processor");
  }
};

//
// Export default (fetch & scheduled)
//
export default {
  async fetch(request, env, ctx) {
    try {
      try {
        validateEnvironment(env);
      } catch (vErr) {
        Log.error("ENV VALIDATION FAILED", vErr);
        return jsonResponse({ ok: false, error: String(vErr) }, 500);
      }

      const url = new URL(request.url);
      const path = url.pathname || "/";

      if (path === "/health" && request.method === "GET") {
        return Response.json(await Security.health(env));
      }

      if (path === "/") {
        if (request.method === "GET") {
          return Response.json({
            ok: true,
            bot: CONFIG.BOT_NAME,
            version: CONFIG.VERSION,
            runtime: "Cloudflare Workers",
            database: "Cloudflare D1"
          });
        }

        if (request.method === "POST") {
          // webhook secret header verification
          const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
          if (env.SECRET_HOOK) {
            if (!secretHeader) {
              Log.warn("Missing secret header on incoming webhook");
              return jsonResponse({ ok: false, error: "Missing secret header" }, 401);
            }
            if (String(secretHeader) !== String(env.SECRET_HOOK)) {
              Log.warn("Invalid secret header", secretHeader);
              return jsonResponse({ ok: false, error: "Invalid secret" }, 401);
            }
          }

          let update = null;
          try {
            update = await request.json();
          } catch (err) {
            Log.error("Webhook parse error", err);
            return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
          }

          Log.info("Telegram Update Received", update && update.update_id ? update.update_id : "(no id)");

          try {
            ctx.waitUntil(Router.processUpdate(env, update, ctx));
          } catch (procErr) {
            Log.error("Failed to enqueue update processing", procErr);
          }

          return jsonResponse({ ok: true }, 200);
        }

        return new Response("Method Not Allowed", { status: 405 });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      Log.error("FETCH ERROR", error);
      return jsonResponse({ ok: false, error: String(error) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    try {
      // ensure DB schema present (idempotent)
      try {
        await DB.initSchema(env);
      } catch (e) {
        Log.warn("scheduled: initSchema failed", e);
      }

      ctx.waitUntil(AI.cleanupMemory(env));
      ctx.waitUntil(AI.cleanupStorage(env));
      ctx.waitUntil(Search.cleanup(env));
      ctx.waitUntil(Security.cleanup(env));
      ctx.waitUntil(Protection.cleanup(env));
      ctx.waitUntil(Card.processLobbies(env));
      ctx.waitUntil(Channel.processSchedules(env));
      ctx.waitUntil(Combat.reviveExpired(env));

      const now = new Date();
      // 5:00 AM IST -> 23:30 UTC (preserved)
      if (now.getUTCHours() === 23 && now.getUTCMinutes() === 30) {
        ctx.waitUntil(Economy.supportIncome(env));
      }
    } catch (e) {
      Log.error("scheduled handler error", e);
    }
  }
};