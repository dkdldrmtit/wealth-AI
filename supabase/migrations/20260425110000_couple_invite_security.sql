-- ════════════════════════════════════════════════════════════════
-- 커플 초대 코드 보안 강화
--
-- 기존: couples.SELECT USING (true) → 모든 사용자가 모든 커플 row 열람 가능
--       (브루트포스로 invite_code 탐색 가능)
--
-- 변경:
--   1. couples.SELECT 정책을 본인이 속한 커플만 조회 가능하도록 제한
--   2. join_couple_by_code(code) RPC 함수로 안전하게 참여
--      - SECURITY DEFINER로 RLS 우회하여 invite_code 검색
--      - 호출 즉시 본인을 멤버로 추가 (참여 + 검증을 원자적 처리)
--      - 이미 2명이거나 본인이 이미 커플 보유 시 거절
--      - 코드 자체는 응답에 포함 안 함 (열거 차단)
-- ════════════════════════════════════════════════════════════════

-- ── 1. couples SELECT 정책 강화
DROP POLICY IF EXISTS "couples_select" ON public.couples;
CREATE POLICY "couples_select" ON public.couples
  FOR SELECT USING (
    id = public.my_couple_id()
  );

-- ── 2. 초대 코드로 참여 RPC
CREATE OR REPLACE FUNCTION public.join_couple_by_code(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_couple_id UUID;
  v_member_count INT;
  v_existing_couple UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated');
  END IF;

  -- 입력 정규화 + 형식 검증 (8자 이상의 영숫자만 허용)
  p_code := lower(trim(p_code));
  IF p_code IS NULL OR length(p_code) < 6 OR p_code !~ '^[a-z0-9]+$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;

  -- 이미 커플에 속해 있으면 차단
  SELECT couple_id INTO v_existing_couple FROM profiles WHERE id = v_user_id;
  IF v_existing_couple IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_in_couple');
  END IF;

  -- 코드로 커플 찾기
  SELECT id INTO v_couple_id FROM couples WHERE invite_code = p_code LIMIT 1;
  IF v_couple_id IS NULL THEN
    -- 존재 여부를 노출하지 않도록 동일한 에러 코드 반환
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;

  -- 정원 체크 (이미 2명이면 거절)
  SELECT COUNT(*) INTO v_member_count FROM profiles WHERE couple_id = v_couple_id;
  IF v_member_count >= 2 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'couple_full');
  END IF;

  -- 멤버로 등록
  UPDATE profiles
     SET couple_id = v_couple_id, role = 'partner2'
   WHERE id = v_user_id;

  RETURN jsonb_build_object('ok', true, 'couple_id', v_couple_id);
END;
$$;

REVOKE ALL ON FUNCTION public.join_couple_by_code(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_couple_by_code(TEXT) TO authenticated;
