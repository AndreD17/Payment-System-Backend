CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  stripe_customer_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Plans in your app map to Stripe Price IDs
CREATE TABLE IF NOT EXISTS plans (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  stripe_price_id TEXT UNIQUE NOT NULL,
  interval TEXT NOT NULL, -- 'month' | 'year'
  amount_cents INT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TYPE sub_status AS ENUM ('INCOMPLETE', 'ACTIVE', 'PAST_DUE', 'CANCELED');

CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id BIGINT NOT NULL REFERENCES plans(id),
  status sub_status NOT NULL DEFAULT 'INCOMPLETE',

  stripe_subscription_id TEXT UNIQUE,
  stripe_checkout_session_id TEXT UNIQUE,

  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Store invoices/payment events for audit + fulfillment triggers
CREATE TABLE IF NOT EXISTS billing_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id),
  stripe_event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  stripe_invoice_id TEXT,
  stripe_payment_intent_id TEXT,
  amount_paid INT,
  currency TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedupe Stripe events (webhooks can be retried)
CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGSERIAL PRIMARY KEY,
  stripe_event_id TEXT UNIQUE NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outbox for async email + fulfillment (reliable background processing)
CREATE TYPE outbox_type AS ENUM ('EMAIL_RECEIPT', 'FULFILL_SUBSCRIPTION');

CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  type outbox_type NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|PROCESSING|DONE|FAILED
  attempts INT NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency keys to prevent double-fulfillment
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  scope TEXT NOT NULL, -- e.g. 'FULFILLMENT'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
