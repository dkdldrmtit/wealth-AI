/**
 * Supabase Edge Function: billing-issue
 *
 * 토스페이먼츠 빌링 인증 완료 콜백을 받아 처리한다.
 *   1. authKey + customerKey → 토스 API로 빌링키 발급
 *   2. 발급된 빌링키로 즉시 첫 결제 실행 (월 4,900원)
 *   3. user_subscriptions 를 premium 으로 업데이트 (current_period_end = +30d)
 *   4. billing_history 에 결제 이력 기록
 *
 * 배포:
 *   supabase secrets set TOSS_SECRET_KEY=test_sk_... (또는 live_sk_...)
 *   supabase functions deploy billing-issue
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TOSS_SECRET_KEY = Deno.env.get("TOSS_SECRET_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const SUBSCRIPTION_AMOUNT_KRW = 4900;
const SUBSCRIPTION_NAME = "OURs 프리미엄 (월간)";
const TOSS_BASE = "https://api.tosspayments.com/v1";

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

function tossAuthHeader() {
  return "Basic " + btoa(TOSS_SECRET_KEY + ":");
}

function addDays(d: Date, days: number) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return jsonError(405, "method_not_allowed");

  if (!TOSS_SECRET_KEY) return jsonError(500, "toss_key_missing");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonError(500, "supabase_env_missing");
  }

  // JWT 인증
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return jsonError(401, "missing_bearer");
  const token = authHeader.slice("Bearer ".length).trim();

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return jsonError(401, "invalid_token");
  const userId = userData.user.id;
  const userEmail = userData.user.email ?? "";

  // 입력 검증
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonError(400, "invalid_json");
  }
  const { authKey, customerKey } = payload ?? {};
  if (!authKey || !customerKey) return jsonError(400, "missing_params");
  if (customerKey !== userId) return jsonError(403, "customer_key_mismatch");

  // ── 1. 빌링키 발급
  let billingKey = "";
  try {
    const issueRes = await fetch(`${TOSS_BASE}/billing/authorizations/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": tossAuthHeader(),
      },
      body: JSON.stringify({ authKey, customerKey }),
    });
    const issueData = await issueRes.json();
    if (!issueRes.ok || !issueData.billingKey) {
      return jsonError(issueRes.status || 502, "issue_failed", issueData);
    }
    billingKey = issueData.billingKey;
  } catch (e) {
    return jsonError(502, "issue_fetch_failed", { message: String(e) });
  }

  // ── 2. 첫 결제 실행
  const orderId = `ours-${userId}-${Date.now()}`;
  let paymentData: any = null;
  try {
    const payRes = await fetch(`${TOSS_BASE}/billing/${billingKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": tossAuthHeader(),
      },
      body: JSON.stringify({
        customerKey,
        amount: SUBSCRIPTION_AMOUNT_KRW,
        orderId,
        orderName: SUBSCRIPTION_NAME,
        customerEmail: userEmail || undefined,
      }),
    });
    paymentData = await payRes.json();
    if (!payRes.ok || paymentData.status !== "DONE") {
      return jsonError(payRes.status || 502, "payment_failed", paymentData);
    }
  } catch (e) {
    return jsonError(502, "payment_fetch_failed", { message: String(e) });
  }

  // ── 3. 구독 업데이트
  const periodStart = new Date();
  const periodEnd = addDays(periodStart, 30);

  await supabase
    .from("user_subscriptions")
    .upsert(
      {
        user_id: userId,
        plan: "premium",
        status: "active",
        current_period_start: periodStart.toISOString(),
        current_period_end: periodEnd.toISOString(),
        billing_provider: "toss",
        billing_key: billingKey,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

  // ── 4. 결제 이력
  await supabase.from("billing_history").insert({
    user_id: userId,
    payment_key: paymentData.paymentKey ?? null,
    order_id: orderId,
    amount: SUBSCRIPTION_AMOUNT_KRW,
    status: "paid",
    approved_at: paymentData.approvedAt ?? new Date().toISOString(),
    raw_response: paymentData,
  });

  return jsonResponse(200, {
    ok: true,
    plan: "premium",
    current_period_end: periodEnd.toISOString(),
  });
});
