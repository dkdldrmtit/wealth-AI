-- ════════════════════════════════════════════════════════════════
-- 결제 이력 테이블
-- 토스페이먼츠 결제 응답을 보존 (영수증·정산 추적용)
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.billing_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payment_key TEXT,
  order_id TEXT NOT NULL,
  amount INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('paid', 'failed', 'refunded', 'canceled')),
  approved_at TIMESTAMPTZ,
  raw_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS billing_history_user_idx
  ON public.billing_history (user_id, created_at DESC);

ALTER TABLE public.billing_history ENABLE ROW LEVEL SECURITY;

-- 본인 결제 이력만 조회 (수정/삭제는 service_role만)
DROP POLICY IF EXISTS "billing_history_select_own" ON public.billing_history;
CREATE POLICY "billing_history_select_own" ON public.billing_history
  FOR SELECT USING (auth.uid() = user_id);
