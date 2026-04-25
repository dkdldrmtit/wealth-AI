/**
 * Supabase Edge Function: ai-chat
 *
 * 모든 Claude API 호출을 단일 엔드포인트로 통합한다.
 * - JWT 인증으로 사용자 식별
 * - 무료/프리미엄 등급 확인
 * - 월별 사용량 한도 체크 (무료: FREE_MONTHLY_LIMIT)
 * - Anthropic API 호출 (텍스트 + 이미지)
 * - 사용량 카운트 increment
 *
 * 배포:
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *   supabase functions deploy ai-chat
 *
 * 호출 예 (클라이언트):
 *   const { data, error } = await _supabase.functions.invoke('ai-chat', {
 *     body: { useCase: 'chat', model, max_tokens, system, messages, tools }
 *   });
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// 무료 사용자 월간 한도 (전체 use_case 합산)
const FREE_MONTHLY_LIMIT = 50;

// 화이트리스트 모델 (남용 방지)
const ALLOWED_MODELS = new Set([
  "claude-haiku-4-5-20251001",
]);

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

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

  if (!ANTHROPIC_API_KEY) {
    return jsonError(500, "anthropic_key_missing");
  }
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

  // ── 2. 요청 파싱
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonError(400, "invalid_json");
  }

  const {
    useCase = "general",
    model,
    max_tokens,
    system,
    messages,
    tools,
  } = payload ?? {};

  if (!model || !ALLOWED_MODELS.has(model)) {
    return jsonError(400, "model_not_allowed", { model });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonError(400, "messages_required");
  }
  if (typeof useCase !== "string" || useCase.length > 50) {
    return jsonError(400, "use_case_invalid");
  }

  // 메시지 크기 제한 (남용 방지)
  const MAX_MESSAGES = 40;
  const MAX_TOTAL_CHARS = 30_000;
  if (messages.length > MAX_MESSAGES) {
    return jsonError(400, "too_many_messages", { max: MAX_MESSAGES });
  }
  const totalChars = messages.reduce((sum: number, m: any) => {
    const content = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((c: any) => (typeof c.text === "string" ? c.text : "")).join("")
        : "";
    return sum + content.length;
  }, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    return jsonError(400, "message_too_long", { max: MAX_TOTAL_CHARS, actual: totalChars });
  }

  // max_tokens 상한 (무료 4,000 / 프리미엄은 나중에 체크 후 허용)
  const MAX_TOKENS_CAP = 4000;

  // ── 3. 구독 등급 + 사용량 체크
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
    const { data: usageRows } = await supabase
      .from("ai_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("period", period);

    const totalUsed = (usageRows ?? []).reduce(
      (sum, r: any) => sum + (r.count ?? 0),
      0,
    );

    if (totalUsed >= FREE_MONTHLY_LIMIT) {
      return jsonError(429, "monthly_limit_exceeded", {
        limit: FREE_MONTHLY_LIMIT,
        used: totalUsed,
      });
    }
  }

  // ── 4. Anthropic API 호출
  const anthBody: Record<string, unknown> = {
    model,
    max_tokens: typeof max_tokens === "number" ? Math.min(max_tokens, MAX_TOKENS_CAP) : 1000,
    messages,
  };
  if (system) anthBody.system = system;
  if (tools) anthBody.tools = tools;

  let anthRes: Response;
  try {
    anthRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(anthBody),
    });
  } catch (e) {
    return jsonError(502, "anthropic_fetch_failed", { message: String(e) });
  }

  const anthData = await anthRes.json().catch(() => ({}));

  if (!anthRes.ok) {
    return jsonResponse(anthRes.status, anthData);
  }

  // ── 5. 사용량 increment (응답 전 동기 처리 — 한도 우회 방지)
  const tokensIn = anthData?.usage?.input_tokens ?? 0;
  const tokensOut = anthData?.usage?.output_tokens ?? 0;

  const { error: incErr } = await supabase.rpc("increment_ai_usage", {
    p_user_id: userId,
    p_period: period,
    p_use_case: useCase,
    p_tokens_in: tokensIn,
    p_tokens_out: tokensOut,
  });
  if (incErr) {
    // 카운터 실패 자체는 사용자에게 영향 없도록 응답은 정상 진행
    // 단, 모니터링 로그에 남김
    console.error("usage increment failed", incErr);
  }

  return jsonResponse(200, anthData);
});
