CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS anonymous_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES anonymous_devices(id) ON DELETE CASCADE,
  order_reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'Request received',
  shop_name TEXT NOT NULL,
  shop_location TEXT NOT NULL,
  food_instructions TEXT,
  delivery_destination TEXT NOT NULL,
  delivery_detail TEXT,
  whatsapp TEXT,
  requested_delivery_date DATE NOT NULL,
  requested_delivery_time TIME NOT NULL,
  food_subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  delivery_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'Not started',
  refund_status TEXT NOT NULL DEFAULT 'Not applicable',
  payment_deadline_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  payment_confirmed_at TIMESTAMPTZ,
  purchased_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  item_notes TEXT,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_holder_name TEXT NOT NULL,
  transfer_instructions TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_payment_details (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  bank_account_id UUID REFERENCES bank_accounts(id),
  bank_name TEXT,
  account_number TEXT,
  account_holder_name TEXT,
  transfer_instructions TEXT,
  amount_payable NUMERIC(12,2) NOT NULL DEFAULT 0,
  confirmation_status TEXT NOT NULL DEFAULT 'Awaiting confirmation',
  confirmation_deadline_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  refund_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  refund_method TEXT NOT NULL DEFAULT 'Bank transfer',
  status TEXT NOT NULL DEFAULT 'Pending manual review',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS substitute_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  original_item_name TEXT NOT NULL,
  proposed_item_name TEXT,
  proposed_item_price NUMERIC(12,2) DEFAULT 0,
  price_difference NUMERIC(12,2) DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending customer response',
  response_deadline_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID REFERENCES anonymous_devices(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_device_id ON orders(device_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_requested_delivery ON orders(requested_delivery_date, requested_delivery_time);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_status_history_order_id ON order_status_history(order_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_device_id ON push_subscriptions(device_id);

ALTER TABLE anonymous_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_payment_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE substitute_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anonymous customers can read only their own orders"
ON orders FOR SELECT
USING (device_id = auth.uid());

CREATE POLICY "Anonymous customers can insert only their own orders"
ON orders FOR INSERT
WITH CHECK (device_id = auth.uid());

CREATE POLICY "Anonymous customers cannot modify payment or approval state"
ON orders FOR UPDATE
USING (device_id = auth.uid())
WITH CHECK (
  status = OLD.status
  AND payment_status = OLD.payment_status
  AND refund_status = OLD.refund_status
);

CREATE POLICY "Services can manage payment state"
ON orders FOR UPDATE
USING (auth.role() = 'service_role');

CREATE POLICY "Users can read only their own order items"
ON order_items FOR SELECT
USING (order_id IN (
  SELECT id FROM orders WHERE device_id = auth.uid()
));

CREATE POLICY "Users can read only their own payment details"
ON order_payment_details FOR SELECT
USING (order_id IN (
  SELECT id FROM orders WHERE device_id = auth.uid()
));

CREATE POLICY "Users can manage their own push subscriptions"
ON push_subscriptions FOR ALL
USING (device_id = auth.uid())
WITH CHECK (device_id = auth.uid());
