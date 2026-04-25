/**
 * Supabase Edge Function: send-push
 *
 * 파트너에게 Web Push 알림을 전송합니다.
 *
 * 배포 방법:
 *   1. supabase CLI 설치: npm install -g supabase
 *   2. 프로젝트 링크: supabase link --project-ref pjxdfhozjuteckbtavmw
 *   3. 환경변수 설정:
 *        supabase secrets set VAPID_PUBLIC_KEY=BBI1p4ve4Wu3ak0S2cRcSqxBxnkr9nc3Z8N9vP9TcaJGiWGbbr7JWDY2visCcLgT6M-xH3qbGGjgisfQrLT1xeg
 *        supabase secrets set VAPID_PRIVATE_KEY=TbTZdlZUJYtPFhLw3l_kBPjLyXOc9qEllFiDOwmIzxI
 *        supabase secrets set VAPID_SUBJECT=mailto:contact@mswealth.app
 *   4. 배포: supabase functions deploy send-push
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── VAPID 서명 구현 (web-push 라이브러리 없이 WebCrypto 사용) ──

function b64urlToUint8Array(b64url: string): Uint8Array {
  const padding = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + padding;
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function uint8ArrayToB64url(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function buildVapidHeaders(
  endpoint: string,
  publicKeyB64url: string,
  privateKeyB64url: string,
  subject: string
): Promise<Record<string, string>> {
  const url = new URL(endpoint);
  const audience = url.origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;

  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud: audience, exp, sub: subject };

  const encode = (obj: object) =>
    uint8ArrayToB64url(new TextEncoder().encode(JSON.stringify(obj)));

  const signingInput = encode(header) + "." + encode(payload);

  // Import private key
  const privKeyBytes = b64urlToUint8Array(privateKeyB64url);
  const privKey = await crypto.subtle.importKey(
    "raw",
    privKeyBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  ).catch(async () => {
    // Fallback: try as ECDSA
    return await crypto.subtle.importKey(
      "pkcs8",
      privKeyBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
  });

  // Sign
  const sigBuffer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privKey,
    new TextEncoder().encode(signingInput)
  );

  const jwt =
    signingInput + "." + uint8ArrayToB64url(new Uint8Array(sigBuffer));

  return {
    Authorization: `vapid t=${jwt}, k=${publicKeyB64url}`,
  };
}

// ── 메인 핸들러 ──

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ── 1. JWT 인증
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ ok: false, message: "missing_bearer" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const token = authHeader.slice("Bearer ".length).trim();

    const { notification } = await req.json();
    if (!notification) {
      return new Response(
        JSON.stringify({ ok: false, message: "필수 파라미터 누락" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
    const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
    const VAPID_SUBJECT =
      Deno.env.get("VAPID_SUBJECT") || "mailto:contact@mswealth.app";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get(
      "SUPABASE_SERVICE_ROLE_KEY"
    )!;

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // JWT 검증 → 발신자 user_id 도출 (클라이언트 입력 신뢰 X)
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(
        JSON.stringify({ ok: false, message: "invalid_token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const senderUserId = userData.user.id;

    // 발신자의 couple_id는 서버에서 직접 조회 (위조 방지)
    const { data: senderProfile } = await supabase
      .from("profiles")
      .select("couple_id")
      .eq("id", senderUserId)
      .maybeSingle();

    const coupleId = senderProfile?.couple_id;
    if (!coupleId) {
      return new Response(
        JSON.stringify({ ok: false, message: "no_couple" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 파트너 유저 ID 조회
    const { data: partnerProfile } = await supabase
      .from("profiles")
      .select("id")
      .eq("couple_id", coupleId)
      .neq("id", senderUserId)
      .single();

    if (!partnerProfile) {
      return new Response(
        JSON.stringify({ ok: false, message: "파트너 없음" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 파트너의 푸시 구독 정보 조회
    const { data: subData } = await supabase
      .from("app_data")
      .select("data")
      .eq("user_id", partnerProfile.id)
      .eq("key", "push-subscription")
      .single();

    if (!subData?.data) {
      return new Response(
        JSON.stringify({ ok: false, message: "파트너 구독 정보 없음" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const subscription = subData.data as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };

    // VAPID 헤더 빌드
    const vapidHeaders = await buildVapidHeaders(
      subscription.endpoint,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY,
      VAPID_SUBJECT
    );

    // Web Push 페이로드 암호화 (AESGCM)
    const payloadStr = JSON.stringify(notification);
    const payloadBytes = new TextEncoder().encode(payloadStr);

    // p256dh 공개키로 암호화
    const recipientPublicKey = await crypto.subtle.importKey(
      "raw",
      b64urlToUint8Array(subscription.keys.p256dh),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );

    // 임시 ECDH 키쌍 생성
    const ephemeralKeyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );

    // 공유 비밀 도출
    const sharedSecret = await crypto.subtle.deriveBits(
      { name: "ECDH", public: recipientPublicKey },
      ephemeralKeyPair.privateKey,
      256
    );

    // auth salt
    const authBytes = b64urlToUint8Array(subscription.keys.auth);
    const salt = crypto.getRandomValues(new Uint8Array(16));

    // PRK 도출 (HKDF)
    const authInfo = new TextEncoder().encode("Content-Encoding: auth\0");
    const prk = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(sharedSecret),
      { name: "HKDF" },
      false,
      ["deriveBits"]
    );

    // HKDF expand
    async function hkdfExpand(
      prk: CryptoKey,
      info: Uint8Array,
      salt: Uint8Array,
      length: number
    ): Promise<Uint8Array> {
      const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info },
        prk,
        length * 8
      );
      return new Uint8Array(bits);
    }

    // 암호화 키 및 nonce 도출
    const ephPubKeyRaw = await crypto.subtle.exportKey(
      "raw",
      ephemeralKeyPair.publicKey
    );
    const ephPubKeyBytes = new Uint8Array(ephPubKeyRaw);

    const keyInfo = new Uint8Array([
      ...new TextEncoder().encode("Content-Encoding: aesgcm\0"),
      0x41, // "A" for P-256
      ...new Uint8Array(4), // key_length placeholder
      ...ephPubKeyBytes,
      ...b64urlToUint8Array(subscription.keys.p256dh),
    ]);

    const contentKey = await hkdfExpand(prk, keyInfo, salt, 16);
    const nonceInfo = new Uint8Array([
      ...new TextEncoder().encode("Content-Encoding: nonce\0"),
      0x41,
      ...new Uint8Array(4),
      ...ephPubKeyBytes,
      ...b64urlToUint8Array(subscription.keys.p256dh),
    ]);
    const nonce = await hkdfExpand(prk, nonceInfo, salt, 12);

    // AES-GCM 암호화
    const encKey = await crypto.subtle.importKey(
      "raw",
      contentKey,
      "AES-GCM",
      false,
      ["encrypt"]
    );

    // 패딩 추가 (최소 2바이트)
    const paddedPayload = new Uint8Array(payloadBytes.length + 2);
    paddedPayload[0] = 0;
    paddedPayload[1] = 0;
    paddedPayload.set(payloadBytes, 2);

    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      encKey,
      paddedPayload
    );

    // 푸시 전송
    const pushRes = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        ...vapidHeaders,
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aesgcm",
        Encryption: `salt=${uint8ArrayToB64url(salt)}`,
        "Crypto-Key": `dh=${uint8ArrayToB64url(ephPubKeyBytes)}`,
        TTL: "86400",
      },
      body: encrypted,
    });

    if (!pushRes.ok && pushRes.status !== 201) {
      const errText = await pushRes.text();
      console.error("Push 전송 실패:", pushRes.status, errText);
      return new Response(
        JSON.stringify({
          ok: false,
          message: "Push 전송 실패",
          status: pushRes.status,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Edge Function 오류:", err);
    return new Response(
      JSON.stringify({ ok: false, message: String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
