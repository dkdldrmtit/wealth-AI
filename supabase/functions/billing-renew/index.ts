/**
 * Supabase Edge Function: billing-renew
 *
 * 매일 1회 cron 호출되어, current_period_end 가 24시간 이내인 active 구독자의
 * 빌링키로 자동 결제를 실행하고 구독 기간을 30일 연장한다.
 *
 *   - status='canceled' 사용자는 자동 갱신 스킵 (현재 기간 종료 후 free 전환)
 *   - 결제 실패 시 status='past_due' 로 변경 + 다음 날 재시도
 *
 * 호출 방법: Supabase Cron (pg_cron)에서 매일 새벽 3시 호출
 *   SELECT cron.schedule(
 *     'billing-renew-daily',
 *     '0 3 * * *',
 *     $$ SELECT net.http_post(
 *          url := 'https://<project>.supabase.co/functions/v1/billing-renew',
 *          headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')
 *        ) $$
 *   );
 *
 * 인증: 외부 호출 차단을 위해 X-Cron-Secret 헤더 검증
 *
 * 배포:
 *   supabase secrets set CRON_SECRET=<랜덤 문자열>
 *   supabase functions deploy billing-renew
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TOSS_SECRET_KEY = Deno.env.get("TOSS_SECRET_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const SUBSCRIPTION_AMOUNT_KRW = 4900;
const SUBSCRIPTION_NAME = "OURs 프리미엄 (월간 자동갱신)";
const TOSS_BASE = "https://api.tosspayments.com/v1";

function tossAuthHeader() {
  return "Basic " + btoa(TOSS_SECRET_KEY + ":");
}
function addDays(d: Date, days: number) {
  const c = new Date(d);
  c.setDate(c.getDate() + days);
  return c;
}

Deno.serve(async (req) => {
  // 외부 호출 차단 (cron 비밀키 검증)
  const provided =
    req.headers.get("X-Cron-Secret") ??
    (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!CRON_SECRET || provided !== CRON_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!TOSS_SECRET_KEY) {
    return new Response(JSON.stringify({ error: "toss_key_missing" }), { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 24시간 이내 만료 + active 구독 조회
  const within = new Date();
  within.setHours(within.getHours() + 24);

  const { data: dueSubs } = await supabase
    .from("user_subscriptions")
    .select("user_id, billing_key, current_period_end")
    .eq("status", "active")
    .eq("plan", "premium")
    .eq("billing_provider", "toss")
    .lte("current_period_end", within.toISOString());

  const results: any[] = [];

  for (const sub of dueSubs ?? []) {
    if (!sub.billing_key) continue;

    const orderId = `ours-renew-${sub.user_id}-${Date.now()}`;
    let paymentData: any = null;
    let success = false;

    try {
      // 사용자 이메일 조회 (toss customerEmail 용)
      const { data: u } = await supabase.auth.admin.getUserById(sub.user_id);
      const email = u?.user?.email ?? undefined;

      const payRes = await fetch(`${TOSS_BASE}/billing/${sub.billing_key}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": tossAuthHeader(),
        },
        body: JSON.stringify({
          customerKey: sub.user_id,
          amount: SUBSCRIPTION_AMOUNT_KRW,
          orderId,
          orderName: SUBSCRIPTION_NAME,
          customerEmail: email,
        }),
      });
      paymentData = await payRes.json();
      success = payRes.ok && paymentData.status === "DONE";
    } catch (e) {
      paymentData = { error: String(e) };
    }

    if (success) {
      const periodStart = new Date(sub.current_period_end);
      const periodEnd = addDays(periodStart, 30);
      await supabase
        .from("user_subscriptions")
        .update({
          status: "active",
          current_period_start: periodStart.toISOString(),
          current_period_end: periodEnd.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", sub.user_id);

      await supabase.from("billing_history").insert({
        user_id: sub.user_id,
        payment_key: paymentData.paymentKey,
        order_id: orderId,
        amount: SUBSCRIPTION_AMOUNT_KRW,
        status: "paid",
        approved_at: paymentData.approvedAt ?? new Date().toISOString(),
        raw_response: paymentData,
      });
      results.push({ user_id: sub.user_id, ok: true });
    } else {
      // 결제 실패 → past_due 로 표시 (다음 cron에서 재시도)
      await supabase
        .from("user_subscriptions")
        .update({ status: "past_due", updated_at: new Date().toISOString() })
        .eq("user_id", sub.user_id);

      await supabase.from("billing_history").insert({
        user_id: sub.user_id,
        payment_key: null,
        order_id: orderId,
        amount: SUBSCRIPTION_AMOUNT_KRW,
        status: "failed",
        approved_at: null,
        raw_response: paymentData,
      });
      results.push({ user_id: sub.user_id, ok: false, error: paymentData });
    }
  }

  // 만료된(current_period_end 지난) canceled / past_due → free 로 전환
  const now = new Date().toISOString();
  await supabase
    .from("user_subscriptions")
    .update({
      plan: "free",
      status: "active",
      billing_key: null,
      billing_provider: null,
      current_period_end: null,
      updated_at: now,
    })
    .in("status", ["canceled", "past_due"])
    .lt("current_period_end", now);

  return new Response(
    JSON.stringify({ ok: true, processed: (dueSubs ?? []).length, results }),
    { headers: { "Content-Type": "application/json" } },
  );
});
