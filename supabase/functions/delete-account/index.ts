/**
 * Supabase Edge Function: delete-account
 *
 * 사용자 계정과 모든 개인정보를 영구 삭제한다 (개인정보보호법 파기 의무).
 *
 *   1. profiles 조회 → couple_id 확인
 *   2. couple_id 가 있으면:
 *      - 같은 커플의 다른 멤버가 있는지 확인
 *      - 다른 멤버 없음(본인이 마지막) → couple_id 데이터 + couples row 삭제
 *      - 다른 멤버 있음 → couple 데이터는 보존 (배우자가 계속 사용)
 *   3. auth.admin.deleteUser → cascade 로 user_id 기반 모든 데이터 삭제
 *
 * 배포:
 *   supabase functions deploy delete-account
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

const COUPLE_TABLES = [
  "asset_history",
  "ledger_txs",
  "stocks",
  "goals",
  "schedules",
  "app_data",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonError(405, "method_not_allowed");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonError(500, "supabase_env_missing");
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return jsonError(401, "missing_bearer");
  const token = authHeader.slice("Bearer ".length).trim();

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return jsonError(401, "invalid_token");
  const userId = userData.user.id;

  // 1. 본인 프로필 조회 (couple_id 확인)
  const { data: prof } = await admin
    .from("profiles")
    .select("couple_id")
    .eq("id", userId)
    .maybeSingle();

  const coupleId = prof?.couple_id ?? null;

  // 2. 커플 데이터 처리
  if (coupleId) {
    // 같은 커플의 다른 멤버가 있는지 확인
    const { data: otherMembers } = await admin
      .from("profiles")
      .select("id")
      .eq("couple_id", coupleId)
      .neq("id", userId);

    const isLastMember = !otherMembers || otherMembers.length === 0;

    if (isLastMember) {
      // 본인이 마지막 → couple_id 기반 데이터 모두 삭제
      for (const t of COUPLE_TABLES) {
        await admin.from(t).delete().eq("couple_id", coupleId);
      }
      await admin.from("couples").delete().eq("id", coupleId);
    }
    // 배우자가 남아있으면 couple 데이터는 보존
  }

  // 3. auth.users 삭제 → cascade 로 profiles, user_subscriptions, ai_usage,
  //    billing_history, push_subscriptions 등 user_id 기반 row 모두 삭제
  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) {
    return jsonError(500, "auth_delete_failed", { message: delErr.message });
  }

  return jsonResponse(200, { ok: true });
});
