-- ════════════════════════════════════════════════════════════════
-- RLS(Row Level Security) 전면 감사 및 정책 정비
--
-- 각 테이블 접근 규칙:
--   데이터 테이블(asset_history, ledger_txs, stocks, goals, schedules, app_data):
--     → 내 user_id인 행 OR 내가 속한 couple_id인 행만 허용
--   profiles: 본인 row만 수정, 같은 커플 파트너는 읽기만
--   couples:  본인이 속한 커플만 읽기, 생성은 인증된 사용자 모두
--   beta_codes: 인증된 사용자 읽기만 (초대코드 검증용)
-- ════════════════════════════════════════════════════════════════

-- ── 헬퍼: 현재 사용자의 couple_id 반환 (NULL이면 커플 없음)
CREATE OR REPLACE FUNCTION public.my_couple_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT couple_id FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$;

-- ══════════════════════════════════════
-- 1. profiles
-- ══════════════════════════════════════
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
DROP POLICY IF EXISTS "profiles_delete" ON public.profiles;

-- 본인 또는 같은 커플 파트너는 읽을 수 있음 (파트너 이름 표시 등)
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT USING (
    id = auth.uid()
    OR (
      couple_id IS NOT NULL
      AND couple_id = public.my_couple_id()
    )
  );

-- 신규 가입 시 본인 프로필만 생성 가능
CREATE POLICY "profiles_insert" ON public.profiles
  FOR INSERT WITH CHECK (id = auth.uid());

-- 본인 프로필만 수정 가능
CREATE POLICY "profiles_update" ON public.profiles
  FOR UPDATE USING (id = auth.uid());

-- 탈퇴 시 본인 프로필만 삭제 가능
CREATE POLICY "profiles_delete" ON public.profiles
  FOR DELETE USING (id = auth.uid());


-- ══════════════════════════════════════
-- 2. couples
-- ══════════════════════════════════════
ALTER TABLE public.couples ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "couples_select" ON public.couples;
DROP POLICY IF EXISTS "couples_insert" ON public.couples;
DROP POLICY IF EXISTS "couples_update" ON public.couples;

-- 초대코드 참여를 위해 모든 커플 row를 읽을 수 있음 (invite_code로 조회)
-- (더 엄격하게 하려면 invite_code 조회만 허용하도록 별도 Edge Function 사용)
CREATE POLICY "couples_select" ON public.couples
  FOR SELECT USING (true);

-- 인증된 사용자는 커플 생성 가능
CREATE POLICY "couples_insert" ON public.couples
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- 본인이 속한 커플만 수정 가능
CREATE POLICY "couples_update" ON public.couples
  FOR UPDATE USING (id = public.my_couple_id());


-- ══════════════════════════════════════
-- 3. 데이터 테이블 공통 헬퍼 매크로
--    (asset_history, ledger_txs, stocks, goals, schedules)
--    컬럼: user_id UUID, couple_id UUID
-- ══════════════════════════════════════

-- asset_history
ALTER TABLE public.asset_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "asset_history_all"    ON public.asset_history;
DROP POLICY IF EXISTS "asset_history_select" ON public.asset_history;
DROP POLICY IF EXISTS "asset_history_insert" ON public.asset_history;
DROP POLICY IF EXISTS "asset_history_update" ON public.asset_history;
DROP POLICY IF EXISTS "asset_history_delete" ON public.asset_history;

CREATE POLICY "asset_history_all" ON public.asset_history
  USING (
    user_id = auth.uid()
    OR (couple_id IS NOT NULL AND couple_id = public.my_couple_id())
  )
  WITH CHECK (
    user_id = auth.uid()
    OR (couple_id IS NOT NULL AND couple_id = public.my_couple_id())
  );

-- ledger_txs
ALTER TABLE public.ledger_txs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ledger_txs_all"    ON public.ledger_txs;
DROP POLICY IF EXISTS "ledger_txs_select" ON public.ledger_txs;
DROP POLICY IF EXISTS "ledger_txs_insert" ON public.ledger_txs;
DROP POLICY IF EXISTS "ledger_txs_update" ON public.ledger_txs;
DROP POLICY IF EXISTS "ledger_txs_delete" ON public.ledger_txs;

CREATE POLICY "ledger_txs_all" ON public.ledger_txs
  USING (
    user_id = auth.uid()
    OR (couple_id IS NOT NULL AND couple_id = public.my_couple_id())
  )
  WITH CHECK (
    user_id = auth.uid()
    OR (couple_id IS NOT NULL AND couple_id = public.my_couple_id())
  );

-- stocks
ALTER TABLE public.stocks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stocks_all"    ON public.stocks;
DROP POLICY IF EXISTS "stocks_select" ON public.stocks;
DROP POLICY IF EXISTS "stocks_insert" ON public.stocks;
DROP POLICY IF EXISTS "stocks_update" ON public.stocks;
DROP POLICY IF EXISTS "stocks_delete" ON public.stocks;

CREATE POLICY "stocks_all" ON public.stocks
  USING (
    user_id = auth.uid()
    OR (couple_id IS NOT NULL AND couple_id = public.my_couple_id())
  )
  WITH CHECK (
    user_id = auth.uid()
    OR (couple_id IS NOT NULL AND couple_id = public.my_couple_id())
  );

-- goals
ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "goals_all"    ON public.goals;
DROP POLICY IF EXISTS "goals_select" ON public.goals;
DROP POLICY IF EXISTS "goals_insert" ON public.goals;
DROP POLICY IF EXISTS "goals_update" ON public.goals;
DROP POLICY IF EXISTS "goals_delete" ON public.goals;

CREATE POLICY "goals_all" ON public.goals
  USING (
    user_id = auth.uid()
    OR (couple_id IS NOT NULL AND couple_id = public.my_couple_id())
  )
  WITH CHECK (
    user_id = auth.uid()
    OR (couple_id IS NOT NULL AND couple_id = public.my_couple_id())
  );

-- schedules
ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "schedules_all"    ON public.schedules;
DROP POLICY IF EXISTS "schedules_select" ON public.schedules;
DROP POLICY IF EXISTS "schedules_insert" ON public.schedules;
DROP POLICY IF EXISTS "schedules_update" ON public.schedules;
DROP POLICY IF EXISTS "schedules_delete" ON public.schedules;

CREATE POLICY "schedules_all" ON public.schedules
  USING (
    user_id = auth.uid()
    OR (couple_id IS NOT NULL AND couple_id = public.my_couple_id())
  )
  WITH CHECK (
    user_id = auth.uid()
    OR (couple_id IS NOT NULL AND couple_id = public.my_couple_id())
  );


-- ══════════════════════════════════════
-- 4. app_data  (key-value 형태)
--    컬럼: user_id, couple_id, key, data
-- ══════════════════════════════════════
ALTER TABLE public.app_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "app_data_all"    ON public.app_data;
DROP POLICY IF EXISTS "app_data_select" ON public.app_data;
DROP POLICY IF EXISTS "app_data_insert" ON public.app_data;
DROP POLICY IF EXISTS "app_data_update" ON public.app_data;
DROP POLICY IF EXISTS "app_data_delete" ON public.app_data;

CREATE POLICY "app_data_all" ON public.app_data
  USING (
    user_id = auth.uid()
    OR (couple_id IS NOT NULL AND couple_id = public.my_couple_id())
  )
  WITH CHECK (
    user_id = auth.uid()
    OR (couple_id IS NOT NULL AND couple_id = public.my_couple_id())
  );


-- ══════════════════════════════════════
-- 5. beta_codes  (초대코드 검증, 읽기 전용)
-- ══════════════════════════════════════
ALTER TABLE public.beta_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "beta_codes_select" ON public.beta_codes;

-- 인증된 사용자 누구나 읽기 가능 (코드 검증용)
CREATE POLICY "beta_codes_select" ON public.beta_codes
  FOR SELECT USING (auth.uid() IS NOT NULL);
