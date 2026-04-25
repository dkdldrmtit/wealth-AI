-- ════════════════════════════════════════════════════════════════
-- AI 사용량 추적 + 구독 등급 테이블
-- ════════════════════════════════════════════════════════════════

-- ── 사용자 구독 정보
CREATE TABLE IF NOT EXISTS public.user_subscriptions (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'premium')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'past_due', 'paused')),
  current_period_start TIMESTAMPTZ DEFAULT NOW(),
  current_period_end TIMESTAMPTZ,
  billing_provider TEXT,
  billing_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── AI 사용량 (월간 use_case 별 집계)
CREATE TABLE IF NOT EXISTS public.ai_usage (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period TEXT NOT NULL,            -- 'YYYY-MM'
  use_case TEXT NOT NULL,          -- 'chat' | 'daily-comment' | 'sms-parse' | ...
  count INT NOT NULL DEFAULT 0,
  tokens_in INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, period, use_case)
);

CREATE INDEX IF NOT EXISTS ai_usage_user_period_idx
  ON public.ai_usage (user_id, period);

-- ── RLS
ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

-- 본인 구독만 read 가능 (write는 service_role 전용)
DROP POLICY IF EXISTS "subs_select_own" ON public.user_subscriptions;
CREATE POLICY "subs_select_own" ON public.user_subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- 본인 사용량만 read 가능 (write는 service_role 전용)
DROP POLICY IF EXISTS "usage_select_own" ON public.ai_usage;
CREATE POLICY "usage_select_own" ON public.ai_usage
  FOR SELECT USING (auth.uid() = user_id);

-- ── 사용량 increment 함수 (Edge Function에서 RPC로 호출)
CREATE OR REPLACE FUNCTION public.increment_ai_usage(
  p_user_id UUID,
  p_period TEXT,
  p_use_case TEXT,
  p_tokens_in INT,
  p_tokens_out INT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.ai_usage (user_id, period, use_case, count, tokens_in, tokens_out, updated_at)
  VALUES (p_user_id, p_period, p_use_case, 1, p_tokens_in, p_tokens_out, NOW())
  ON CONFLICT (user_id, period, use_case)
  DO UPDATE SET
    count       = public.ai_usage.count + 1,
    tokens_in   = public.ai_usage.tokens_in + EXCLUDED.tokens_in,
    tokens_out  = public.ai_usage.tokens_out + EXCLUDED.tokens_out,
    updated_at  = NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.increment_ai_usage(UUID, TEXT, TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_ai_usage(UUID, TEXT, TEXT, INT, INT) TO service_role;

-- ── 신규 가입 시 free 플랜 자동 생성 트리거
CREATE OR REPLACE FUNCTION public.handle_new_user_subscription()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_subscriptions (user_id, plan, status)
  VALUES (NEW.id, 'free', 'active')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_subscription ON auth.users;
CREATE TRIGGER on_auth_user_created_subscription
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_subscription();

-- ── 기존 사용자 백필 (이미 가입된 사용자에게 free 플랜 부여)
INSERT INTO public.user_subscriptions (user_id, plan, status)
SELECT id, 'free', 'active' FROM auth.users
ON CONFLICT (user_id) DO NOTHING;
