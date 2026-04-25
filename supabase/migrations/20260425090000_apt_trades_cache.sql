-- ════════════════════════════════════════════════════════════════
-- 국토부 실거래가 응답 캐시 테이블
-- (lawdCd-dealYmd) 단위로 24시간 캐싱하여 MOLIT API 호출량 절감
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.apt_trades_cache (
  cache_key TEXT PRIMARY KEY,         -- 'LAWDCD-DEALYMD' (예: '11680-202504')
  xml TEXT NOT NULL,                  -- MOLIT 원본 XML 응답
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS apt_trades_cache_fetched_idx
  ON public.apt_trades_cache (fetched_at);

-- RLS: 모든 사용자가 캐시를 공유 (실거래가는 공개 데이터)
-- 단, 클라이언트는 직접 접근 못 하게 막고, Edge Function(service_role)만 접근.
ALTER TABLE public.apt_trades_cache ENABLE ROW LEVEL SECURITY;

-- 일반 사용자(authenticated/anon) 접근 차단 (정책 없음 = 모두 거부)
DROP POLICY IF EXISTS "apt_cache_no_client_access" ON public.apt_trades_cache;
-- 명시적으로 정책 생성하지 않음 → service_role만 접근 가능 (RLS는 service_role 무시)

-- 24시간 지난 캐시 정리 함수 (수동 또는 cron 호출)
CREATE OR REPLACE FUNCTION public.purge_apt_trades_cache()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count INT;
BEGIN
  DELETE FROM public.apt_trades_cache
  WHERE fetched_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_apt_trades_cache() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_apt_trades_cache() TO service_role;
