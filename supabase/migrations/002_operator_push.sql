CREATE TABLE IF NOT EXISTS public.operator_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  subscription JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operator_push_subscriptions_user_id
  ON public.operator_push_subscriptions(user_id);

ALTER TABLE public.operator_push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.operator_push_subscriptions FROM anon, authenticated;
GRANT ALL ON TABLE public.operator_push_subscriptions TO service_role;
