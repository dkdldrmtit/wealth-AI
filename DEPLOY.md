# OURs 배포 가이드

> **이 문서는 코드 작성자/운영자용입니다. 일반 사용자에게는 보이지 않습니다.**

---

## 1. 사전 준비

### 1-1. 외부 서비스 가입
| 서비스 | 용도 | 필수 |
|---|---|---|
| Supabase | DB·인증·서버리스 함수 | ✅ |
| Anthropic Console | Claude API 키 | ✅ |
| 토스페이먼츠 | 정기결제 가맹 | 💰 (수익화 시) |
| 국토교통부 공공데이터 | 실거래가 API | ✅ |
| Sentry (선택) | 에러 모니터링 | ⚪ |
| Cloudflare Pages 또는 Vercel | 정적 호스팅 | ✅ |

### 1-2. 사업자 등록
유료 결제를 받으려면 다음이 선행되어야 합니다.
- 사업자등록증 (간이 또는 일반)
- 통신판매업 신고
- 토스페이먼츠 가맹 심사 (도메인·약관·사업자등록증 필요)

---

## 2. Supabase 셋업

### 2-1. 프로젝트 생성 후 Secrets 설정
```bash
supabase login
supabase link --project-ref <PROJECT_REF>

supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set MOLIT_API_KEY=<국토부 인증키>
supabase secrets set TOSS_SECRET_KEY=test_sk_...   # 운영 시 live_sk_...
supabase secrets set CRON_SECRET=<openssl rand -hex 32>
supabase secrets set VAPID_PUBLIC_KEY=<신규 발급>
supabase secrets set VAPID_PRIVATE_KEY=<신규 발급>
supabase secrets set VAPID_SUBJECT=mailto:contact@<도메인>
```

### 2-2. DB 마이그레이션 실행
```bash
supabase db push
```

다음 마이그레이션이 적용됩니다:
- `20260425072027_ai_usage_and_subscriptions.sql` — AI 사용량·구독 테이블
- `20260425080000_rls_audit.sql` — 모든 데이터 테이블 RLS 정책
- `20260425090000_apt_trades_cache.sql` — 실거래가 캐시
- `20260425100000_billing_history.sql` — 결제 이력

### 2-3. Edge Functions 배포
```bash
supabase functions deploy ai-chat
supabase functions deploy apt-trades
supabase functions deploy billing-issue
supabase functions deploy billing-cancel
supabase functions deploy billing-renew
supabase functions deploy delete-account
supabase functions deploy send-push  # 기존
```

### 2-4. 정기결제 cron 등록
Supabase SQL Editor에서:
```sql
SELECT cron.schedule(
  'billing-renew-daily',
  '0 3 * * *',  -- 매일 새벽 3시 KST
  $$
    SELECT net.http_post(
      url := 'https://<PROJECT_REF>.supabase.co/functions/v1/billing-renew',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer <CRON_SECRET>'
      )
    )
  $$
);
```

---

## 3. 클라이언트 환경변수 교체

`index.html` 안의 placeholder를 실제 값으로 교체합니다:

| 변수 | 위치 | 교체 값 |
|---|---|---|
| `SUPABASE_URL` | 약 4090번 줄 | 본인 프로젝트 URL |
| `SUPABASE_ANON_KEY` | 4091번 줄 | anon public key |
| `TOSS_CLIENT_KEY` | `startPremiumCheckout` 근처 | `live_ck_...` |
| `__SENTRY_DSN__` | head script | `https://...@sentry.io/...` |
| `VAPID_PUBLIC_KEY` | `initPushNotifications` 근처 | 새로 발급한 공개키 |

> ⚠️ **개인 흔적 제거 잔존**: 코드의 `'민석'`, `'시윤'` 주석은 사용자 노출 X. 그대로 둬도 됩니다.

---

## 4. 정적 호스팅 (Cloudflare Pages 권장)

```bash
# Cloudflare Pages
wrangler pages deploy . --project-name=ours
```

또는 Vercel:
```bash
vercel --prod
```

도메인 연결: Cloudflare Pages → Custom domain 메뉴.

---

## 5. 운영 체크리스트

### 출시 전
- [ ] `TOSS_CLIENT_KEY`/`TOSS_SECRET_KEY`를 live 키로 교체
- [ ] `__SENTRY_DSN__`에 실제 DSN 입력
- [ ] VAPID 키 신규 발급 후 클라/서버 모두 갱신
- [ ] Supabase 프로젝트 프로 플랜으로 업그레이드 (백업 일 1회)
- [ ] 토스페이먼츠 라이브 키 발급 (가맹 심사 통과 후)
- [ ] 도메인 연결 후 Open Graph 테스트 (카카오 디버거)

### 출시 후 모니터링
- [ ] Sentry 에러 알림 채널 (Slack/Discord)
- [ ] Supabase 사용량 (DB 행 수, Edge Function 호출 수)
- [ ] Anthropic 청구 (월별 토큰 사용량)
- [ ] 토스페이먼츠 정산 내역
- [ ] cron `billing-renew` 실행 결과 (Supabase Functions 로그)

---

## 6. 무료/프리미엄 한도 조정

`supabase/functions/ai-chat/index.ts`:
```typescript
const FREE_MONTHLY_LIMIT = 50;  // AI 합산
```

`supabase/functions/apt-trades/index.ts`:
```typescript
const FREE_MONTHLY_LIMIT = 30;  // 실거래가 캐시 miss 기준
```

수정 후 `supabase functions deploy <name>`.

---

## 7. 가격 변경

| 위치 | 내용 |
|---|---|
| `index.html` 요금제 모달 | UI 표시 가격 (`4,900원`, `39,000원`) |
| `billing-issue` `SUBSCRIPTION_AMOUNT_KRW` | 첫 결제 금액 |
| `billing-renew` `SUBSCRIPTION_AMOUNT_KRW` | 갱신 결제 금액 |
| 이용약관 제6조 | 표기 가격 |

위 4곳을 모두 동시에 갱신 후 함수 재배포.
