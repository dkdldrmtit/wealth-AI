/**
 * Supabase Edge Function: billing-cancel
 *
 * 사용자가 프리미엄 구독을 해지한다.
 *   - 즉시 환불은 하지 않음 (current_period_end 까지 프리미엄 유지)
 *   - 다음 결제 cron 함수가 status='canceled' 인 사용자는 자동결제 스킵
 *
 * 배포:
 *   supabase functions deploy billing-cancel
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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
  if (req.method !== "POST") return jsonError(405, "method_not_allowed");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonError(500, "supabase_env_missing");
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return jsonError(401, "missing_bearer");
  const token = authHeader.slice("Bearer ".length).trim();

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return jsonError(401, "invalid_token");
  const userId = userData.user.id;

  const { error: updateErr } = await supabase
    .from("user_subscriptions")
    .update({
      status: "canceled",
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (updateErr) {
    return jsonError(500, "cancel_failed", { message: updateErr.message });
  }

  return jsonResponse(200, { ok: true });
});
