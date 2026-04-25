/**
 * Supabase Edge Function: apt-trades
 *
 * 국토부(MOLIT) 아파트 실거래가 API를 프록시한다.
 * - JWT 인증으로 사용자 식별
 * - (lawdCd, dealYmd) 단위 24시간 캐싱
 * - 캐시 hit: 사용량 카운트 X
 * - 캐시 miss: 무료 월 30회 한도 체크 후 MOLIT 호출
 *
 * 배포:
 *   supabase secrets set MOLIT_API_KEY=...
 *   supabase functions deploy apt-trades
 *
 * 호출 예 (클라이언트):
 *   const { data, error } = await _supabase.functions.invoke('apt-trades', {
 *     body: { lawdCd: '11680', dealYmd: '202504' }
 *   });
 *   // 응답: { xml: string, cached: boolean }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MOLIT_API_KEY = Deno.env.get("MOLIT_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// 무료 사용자 월 한도 (캐시 miss 기준)
const FREE_MONTHLY_LIMIT = 30;
// 캐시 유효 시간(시간)
const CACHE_TTL_HOURS = 24;

const MOLIT_URL =
  "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonError(status: number, code: string, extra?: Record<string, unknown>) {
  return jsonResponse(status, { error: { code, ...(extra ?? {}) } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonError(405, "method_not_allowed");
  }

  if (!MOLIT_API_KEY) return jsonError(500, "molit_key_missing");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonError(500, "supabase_env_missing");
  }

  // ── 1. JWT 인증
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonError(401, "missing_bearer");
  }
  const token = authHeader.slice("Bearer ".length).trim();

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonError(401, "invalid_token");
  }
  const userId = userData.user.id;

  // ── 2. 입력 검증
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonError(400, "invalid_json");
  }

  const { lawdCd, dealYmd } = payload ?? {};
  if (!lawdCd || !/^\d{5}$/.test(String(lawdCd))) {
    return jsonError(400, "invalid_lawd_cd");
  }
  if (!dealYmd || !/^\d{6}$/.test(String(dealYmd))) {
    return jsonError(400, "invalid_deal_ymd");
  }

  const cacheKey = `${lawdCd}-${dealYmd}`;

  // ── 3. 캐시 조회
  const ttlIso = new Date(Date.now() - CACHE_TTL_HOURS * 3600 * 1000).toISOString();
  const { data: cached } = await supabase
    .from("apt_trades_cache")
    .select("xml, fetched_at")
    .eq("cache_key", cacheKey)
    .gte("fetched_at", ttlIso)
    .maybeSingle();

  if (cached?.xml) {
    return jsonResponse(200, { xml: cached.xml, cached: true });
  }

  // ── 4. 사용량 한도 체크 (캐시 miss 시에만)
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM

  const { data: subRow } = await supabase
    .from("user_subscriptions")
    .select("plan, status, current_period_end")
    .eq("user_id", userId)
    .maybeSingle();

  const now = new Date();
  const isPremium =
    subRow?.plan === "premium" &&
    subRow?.status === "active" &&
    (!subRow?.current_period_end || new Date(subRow.current_period_end) > now);

  if (!isPremium) {
    const { data: usageRow } = await supabase
      .from("ai_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("period", period)
      .eq("use_case", "apt-trades")
      .maybeSingle();

    const used = usageRow?.count ?? 0;
    if (used >= FREE_MONTHLY_LIMIT) {
      return jsonError(429, "monthly_limit_exceeded", {
        limit: FREE_MONTHLY_LIMIT,
        used,
        scope: "apt-trades",
      });
    }
  }

  // ── 5. MOLIT 호출
  const url = new URL(MOLIT_URL);
  url.searchParams.set("serviceKey", MOLIT_API_KEY);
  url.searchParams.set("LAWD_CD", String(lawdCd));
  url.searchParams.set("DEAL_YMD", String(dealYmd));
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "1000");

  let xml = "";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const molitRes = await fetch(url.toString(), { signal: ctrl.signal });
    clearTimeout(t);
    xml = await molitRes.text();
    if (!molitRes.ok) {
      return jsonError(502, "molit_error", { status: molitRes.status });
    }
  } catch (e) {
    return jsonError(502, "molit_fetch_failed", { message: String(e) });
  }

  // ── 6. 캐시 저장 (best-effort)
  supabase
    .from("apt_trades_cache")
    .upsert({ cache_key: cacheKey, xml, fetched_at: new Date().toISOString() })
    .then(({ error }: any) => {
      if (error) console.error("cache upsert failed", error);
    });

  // ── 7. 사용량 increment (캐시 miss 시에만, 응답 전 동기 처리)
  if (!isPremium) {
    const { error: incErr } = await supabase.rpc("increment_ai_usage", {
      p_user_id: userId,
      p_period: period,
      p_use_case: "apt-trades",
      p_tokens_in: 0,
      p_tokens_out: 0,
    });
    if (incErr) console.error("usage increment failed", incErr);
  }

  return jsonResponse(200, { xml, cached: false });
});
