require('dotenv').config();
const { pool } = require('./db');

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Extensions ──────────────────────────────────────────────────────────
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // ── users ────────────────────────────────────────────────────────────────
    // Central auth table. Both customers and vendors have a row here.
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        email         TEXT        UNIQUE NOT NULL,
        phone         TEXT        UNIQUE,
        password_hash TEXT        NOT NULL,
        role          TEXT        NOT NULL CHECK (role IN ('customer', 'vendor', 'admin')),
        is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
        fcm_token     TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── customers ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        user_id             UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        first_name          TEXT,
        last_name           TEXT,
        home_address        JSONB,
        stripe_customer_id  TEXT,
        subscription_tier   TEXT        NOT NULL DEFAULT 'basic'
                              CHECK (subscription_tier IN ('basic', 'plus', 'premium')),
        subscription_status TEXT        NOT NULL DEFAULT 'inactive',
        subscription_end    TIMESTAMPTZ,
        maintenance_score   INTEGER     NOT NULL DEFAULT 0
      )
    `);

    // ── vendors ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS vendors (
        user_id           UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        business_name     TEXT        NOT NULL,
        first_name        TEXT,
        last_name         TEXT,
        trades            TEXT[]      NOT NULL DEFAULT '{}',
        service_zip_codes TEXT[]      NOT NULL DEFAULT '{}',
        working_hours     JSONB,
        is_available      BOOLEAN     NOT NULL DEFAULT TRUE,
        is_approved       BOOLEAN     NOT NULL DEFAULT FALSE,
        stripe_account_id TEXT,
        reliability_score NUMERIC(5,2) NOT NULL DEFAULT 80.00,
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    // ── addresses ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS addresses (
        id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label      TEXT,
        line1      TEXT        NOT NULL,
        line2      TEXT,
        city       TEXT        NOT NULL,
        state      TEXT        NOT NULL,
        zip        TEXT        NOT NULL,
        lat        NUMERIC(10,7),
        lng        NUMERIC(10,7),
        is_default BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── jobs ─────────────────────────────────────────────────────────────────
    // service_fee_cents / hourly_rate_cents are stored per-job so pricing
    // changes don't retroactively affect historical records.
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id                    UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
        customer_id           UUID         NOT NULL REFERENCES users(id),
        vendor_id             UUID         REFERENCES users(id),
        address_id            UUID         REFERENCES addresses(id),
        trade                 TEXT         NOT NULL,
        urgency               TEXT         NOT NULL DEFAULT 'standard'
                                CHECK (urgency IN ('standard', 'priority', 'emergency')),
        description           TEXT,
        photos                JSONB        NOT NULL DEFAULT '[]',
        status                TEXT         NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'accepted', 'in_progress', 'completed', 'cancelled')),
        estimated_price_cents INTEGER      NOT NULL DEFAULT 0,
        final_price_cents     INTEGER,
        service_fee_cents     INTEGER      NOT NULL DEFAULT 8900,
        hourly_rate_cents     INTEGER      NOT NULL DEFAULT 6500,
        urgency_fee_cents     INTEGER      NOT NULL DEFAULT 0,
        labor_minutes         INTEGER,
        parts_cost_cents      INTEGER      NOT NULL DEFAULT 0,
        tip_cents             INTEGER      NOT NULL DEFAULT 0,
        ai_trade_detected     TEXT,
        ai_confidence         NUMERIC(5,2),
        scheduled_start       TIMESTAMPTZ,
        accepted_at           TIMESTAMPTZ,
        started_at            TIMESTAMPTZ,
        completed_at          TIMESTAMPTZ,
        cancelled_at          TIMESTAMPTZ,
        cancel_reason         TEXT,
        customer_rated        BOOLEAN      NOT NULL DEFAULT FALSE,
        payment_status        TEXT         NOT NULL DEFAULT 'pending'
                                CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
        created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    // ── messages ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id        UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        job_id    UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        sender_id UUID        NOT NULL REFERENCES users(id),
        content   TEXT,
        media_url TEXT,
        msg_type  TEXT        NOT NULL DEFAULT 'text'
                    CHECK (msg_type IN ('text', 'image', 'system')),
        sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        read_at   TIMESTAMPTZ
      )
    `);

    // ── ratings ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ratings (
        id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        job_id     UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        rater_id   UUID        NOT NULL REFERENCES users(id),
        ratee_id   UUID        NOT NULL REFERENCES users(id),
        score      INTEGER     NOT NULL CHECK (score BETWEEN 1 AND 5),
        comment    TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (job_id, rater_id)
      )
    `);

    // ── disputes ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS disputes (
        id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        job_id      UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        filed_by    UUID        REFERENCES users(id),
        reason      TEXT,
        status      TEXT        NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'resolved', 'closed')),
        resolution  TEXT,
        resolved_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── vendor_locations ──────────────────────────────────────────────────────
    // One row per vendor; upserted on every location:update socket event.
    await client.query(`
      CREATE TABLE IF NOT EXISTS vendor_locations (
        vendor_id  UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        lat        NUMERIC(10,7) NOT NULL,
        lng        NUMERIC(10,7) NOT NULL,
        updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    // ── job_parts ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS job_parts (
        id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        job_id           UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        name             TEXT        NOT NULL,
        sku              TEXT,
        quantity         INTEGER     NOT NULL DEFAULT 1,
        unit_price_cents INTEGER     NOT NULL DEFAULT 0,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── otp_codes ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS otp_codes (
        id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        identifier TEXT        NOT NULL,
        code       TEXT        NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used       BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Indexes ──────────────────────────────────────────────────────────────
    // jobs — most-queried filters
    await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_customer_id     ON jobs(customer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_vendor_id       ON jobs(vendor_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_status          ON jobs(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_trade           ON jobs(trade)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_created_at      ON jobs(created_at DESC)`);

    // messages
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_job_id      ON messages(job_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_sent_at     ON messages(sent_at ASC)`);

    // ratings
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ratings_ratee_id     ON ratings(ratee_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ratings_job_id       ON ratings(job_id)`);

    // addresses
    await client.query(`CREATE INDEX IF NOT EXISTS idx_addresses_user_id    ON addresses(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_addresses_zip        ON addresses(zip)`);

    // otp_codes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_otp_identifier       ON otp_codes(identifier)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_otp_expires_at       ON otp_codes(expires_at)`);

    // disputes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_disputes_job_id      ON disputes(job_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_disputes_status      ON disputes(status)`);

    // job_parts
    await client.query(`CREATE INDEX IF NOT EXISTS idx_job_parts_job_id     ON job_parts(job_id)`);

    await client.query('COMMIT');
    console.log('Migration complete — all tables and indexes created.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

migrate();
