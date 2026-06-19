# ServerKit Relay — Auth Model, API Shapes & Rate Limiting

---

## 1. Auth Model Overview (no login)

Two tokens. No user account. Rate limits tied to subscription only.

```
App                          Relay Backend                 Google APIs
 │                                │                              │
 │  1. Request Play Integrity     │                              │
 │     token (nonce = timestamp)  │                              │
 │                                │                              │
 │  2. POST /api/auth/integrity-token ──────────────────────────►│
 │     { integrityToken,          │  verify integrity token      │
 │       subscriptionPurchaseToken│  verify subscription status  │
 │       iapPurchaseToken? }      │◄─────────────────────────────│
 │                                │                              │
 │◄── { jwt, plan, offerToken } ──│                              │
 │    JWT payload:                │                              │
 │    { sub: ptHash,              │                              │
 │      plan, exp: now+15min }    │                              │
 │                                │                              │
 │  3. POST /v1/chat/completions  │                              │
 │     Authorization: Bearer jwt  │                              │
 │  ─────────────────────────────►│                              │
 │     guard: verify jwt,         │                              │
 │     plan check, rate limit     │                              │
 │     (all limits per ptHash)    │                              │
 │◄─── streamed Gemini response ──│─────────────────────────────►│
```

**Why no login works:**
- Play Integrity proves: real device + unmodified app + correct package
- Purchase token proves: active subscription on a Google account
- JWT is a short-lived cache of the above — backend never stores a user account
- **One subscription = one rate limit bucket**, regardless of how many devices

---

## 2. About Purchase Tokens

Purchase token is unique per subscription transaction. Same user on 3 phones → all 3 get the **same** token via `restorePurchases()`. Different users → different tokens.

Rate limits are keyed by `ptHash = sha256(purchaseToken)`. This naturally means one subscription shares limits across all devices — no device tracking needed.

---

## 3. Environment Variables

```env
# existing
GOOGLE_PLAY_PACKAGE_NAME=com.iishanto.servermanager
GOOGLE_SERVICE_ACCOUNT_PATH=./play_service_account.json
PLAY_IAP_PRODUCT_ID=ad_free_forever
PLAY_SUBSCRIPTION_PRODUCT_ID=serverkit_ai_pro
PLAY_OFFER_TOKEN_FULL=<offer token>
PLAY_OFFER_TOKEN_DISCOUNTED=<offer token>

# new
JWT_SECRET=<random 256-bit hex>
GEMINI_API_KEY=<relay's own Gemini key>
GEMINI_MODEL=gemini-2.0-flash
RATE_LIMIT_REQUESTS_PER_MIN=10        # per subscription per minute (burst cap)
RATE_LIMIT_REQUESTS_PER_DAY=200       # per subscription per day
RATE_LIMIT_TOKENS_PER_DAY=500000      # Gemini output tokens per subscription per day
RATE_LIMIT_TASKS_PER_MONTH=50         # agent tasks per subscription per month
```

---

## 4. API Reference

### 4.1 `POST /api/auth/integrity-token` (modified)

**Request:**
```json
{
  "packageName": "com.iishanto.servermanager",
  "integrityToken": "<play integrity token>",
  "iapPurchaseToken": "<ad_free_forever token or null>",
  "subscriptionPurchaseToken": "<serverkit_ai_pro token or null>"
}
```

**Response 200:**
```json
{
  "token": "<jwt>",
  "plan": "free | iap | subscriber | subscriber_discounted",
  "offerToken": "<play offer token — only present for free/iap plans>"
}
```

**Response 400 — integrity failure:**
```json
{
  "error": "integrity_failed",
  "verdict": "FAILS_BASIC_INTEGRITY"
}
```

**Backend logic:**

```
1. Verify integrityToken via Play Integrity API:
   - requestDetails.packageName == GOOGLE_PLAY_PACKAGE_NAME
   - appIntegrity.appRecognitionVerdict == "PLAY_RECOGNIZED"
   - deviceIntegrity includes "MEETS_BASIC_INTEGRITY"
   - Return 400 if any check fails

2. Verify subscriptionPurchaseToken (if provided):
   - Call androidpublisher.purchases.subscriptionsv2.get(
       packageName, PLAY_SUBSCRIPTION_PRODUCT_ID, subscriptionPurchaseToken
     )
   - subValid = subscriptionState IN ("SUBSCRIPTION_STATE_ACTIVE",
                                      "SUBSCRIPTION_STATE_IN_GRACE_PERIOD")

3. Verify iapPurchaseToken (if provided):
   - Call androidpublisher.purchases.products.get(...)
   - iapValid = purchaseState == 0

4. Derive plan:
   if subValid && iapValid  → "subscriber_discounted"
   if subValid && !iapValid → "subscriber"
   if !subValid && iapValid → "iap"
   else                     → "free"

5. Derive offerToken:
   "iap"  → PLAY_OFFER_TOKEN_DISCOUNTED
   "free" → PLAY_OFFER_TOKEN_FULL
   subscriber* → null

6. Build JWT:
   {
     sub: sha256(subscriptionPurchaseToken),   // ptHash — stable subscription identity
     plan: <plan>,
     exp: now + 900   // 15 minutes
   }
   // For free/iap plans: sub = sha256(iapPurchaseToken) or a random stable nonce
   Sign with HS256, JWT_SECRET

7. Return { token, plan, offerToken }
```

---

### 4.2 `POST /api/agent/task/start` (new)

App calls **once** when user triggers an agent task, before the first LLM call. Returns a `taskId`. All LLM calls within that task carry this `taskId` — counted as **one task** regardless of how many steps the agent takes.

**Request:**
```
POST /api/agent/task/start
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "description": "Install nginx and configure SSL"   // optional, for logging
}
```

**Response 200:**
```json
{
  "taskId": "tsk_a1b2c3d4e5f6",
  "tasksUsedThisMonth": 12,
  "tasksLimit": 50,
  "resetsAt": "2026-07-01T00:00:00Z"
}
```

**Response 403 — not a subscriber:**
```json
{ "error": "subscription_required" }
```

**Response 429 — task limit reached:**
```json
{
  "error": "task_limit_reached",
  "tasksUsedThisMonth": 50,
  "tasksLimit": 50,
  "resetsAt": "2026-07-01T00:00:00Z"
}
```

**Backend logic:**

```
1. Verify JWT → 401 if invalid/expired
2. Plan check → 403 if plan NOT IN (subscriber, subscriber_discounted)
3. monthKey = YYYY-MM derived from server UTC time
   bucketKey = "rl:sub:tasks:" + jwt.sub + ":" + monthKey
4. current = GET bucketKey (0 if missing)
   if current >= RATE_LIMIT_TASKS_PER_MONTH:
     return 429 task_limit_reached with resetsAt = first day of next month 00:00 UTC
5. Generate taskId = "tsk_" + crypto.randomBytes(6).toString('hex')
6. Store in DB: agent_tasks (task_id, pt_hash=jwt.sub, started_at, first_llm_call=NULL)
   NOTE: do NOT increment counter yet — increment on first LLM call
         (prevents counting tasks user cancels before sending anything)
7. Return { taskId, tasksUsedThisMonth: current, tasksLimit: 50, resetsAt }
```

---

### 4.3 `POST /v1/chat/completions` (relay guard, modified)

Forwards to Gemini. Only subscribers pass.

**Request:**
```
POST /v1/chat/completions
Authorization: Bearer <jwt>
X-Task-Id: tsk_a1b2c3d4e5f6        // include for agent calls; omit for manual/step AI Assistant
Content-Type: application/json

{
  "model": "gemini-2.0-flash",      // ignored — relay uses GEMINI_MODEL env var
  "messages": [ ... ],
  "stream": true,
  "max_tokens": 4096
}
```

> `X-Task-Id` absent = non-agent call (manual/step modes). Task counter not touched. Daily limits still apply.

**Response 200 — streaming:**
```
data: {"id":"...","choices":[{"delta":{"content":"chunk"},...}]}
data: [DONE]
```

**Response 403:**
```json
{ "error": "subscription_required", "plan": "free" }
```

**Response 429:**
```json
{
  "error": "rate_limited",
  "scope": "minute | day_requests | day_tokens",
  "retry_after": 47
}
```

**Guard logic:**

```
1. Verify JWT signature + expiry → 401 if invalid/expired

2. Plan check:
   if jwt.plan NOT IN ("subscriber", "subscriber_discounted"):
     return 403 subscription_required

3. Blocklist check (revoked subscriptions):
   if Redis GET "blocklist:" + jwt.sub exists:
     return 403 { error: "subscription_revoked" }

4. Per-minute burst limit (per subscription):
   bucketKey = "rl:min:" + jwt.sub
   count = INCR bucketKey
   if count == 1: EXPIRE bucketKey 60
   if count > RATE_LIMIT_REQUESTS_PER_MIN:
     return 429 { scope: "minute", retry_after: TTL(bucketKey) }

5. Daily request limit (per subscription):
   bucketKey = "rl:day:req:" + jwt.sub
   count = INCR bucketKey
   if count == 1: EXPIREAT bucketKey next_utc_midnight
   if count > RATE_LIMIT_REQUESTS_PER_DAY:
     return 429 { scope: "day_requests", retry_after: seconds_until_midnight_utc }

6. Daily token budget (per subscription):
   bucketKey = "rl:day:tok:" + jwt.sub
   current = GET bucketKey (0 if missing)
   if current >= RATE_LIMIT_TOKENS_PER_DAY:
     return 429 { scope: "day_tokens", retry_after: seconds_until_midnight_utc }

7. Task tracking (only if X-Task-Id header present):
   taskId = request.headers["X-Task-Id"]
   - Verify taskId exists in DB AND pt_hash == jwt.sub → 403 if mismatch
   - If agent_tasks.first_llm_call IS NULL for this taskId:
       this is first LLM call → increment monthly task counter
       monthKey = "rl:tasks:" + jwt.sub + ":" + YYYY-MM
       newCount = INCR monthKey
       if newCount == 1: EXPIREAT monthKey first_day_of_next_month_utc
       if newCount > RATE_LIMIT_TASKS_PER_MONTH:
         // rolled over limit — decrement and reject
         DECR monthKey
         return 429 { error: "task_limit_reached" }
       UPDATE agent_tasks SET first_llm_call = NOW() WHERE task_id = taskId
   - If first_llm_call IS NOT NULL: subsequent step, skip counter

8. Forward to Gemini:
   - Translate OpenAI messages format → Gemini contents format
   - Stream response back to client
   - On stream complete:
       INCRBY "rl:day:tok:" + jwt.sub  usage.totalTokenCount
       if key was new: EXPIREAT to next_utc_midnight
```

---

### 4.4 `GET /api/subscription/status` (new)

App polls to show usage in UI (subscription page, paywall).

**Request:**
```
GET /api/subscription/status
Authorization: Bearer <jwt>
```

**Response 200:**
```json
{
  "plan": "subscriber",
  "expiryTime": 1721400000000,
  "usage": {
    "requestsToday": 47,
    "requestsLimit": 200,
    "tokensToday": 124000,
    "tokensLimit": 500000,
    "tasksThisMonth": 12,
    "tasksLimit": 50,
    "dailyResetsAt": "2026-06-20T00:00:00Z",
    "monthlyResetsAt": "2026-07-01T00:00:00Z"
  }
}
```

Free/iap plan users get `plan: "free"` with no usage fields (no relay usage to show).

---

### 4.5 `POST /api/play/notifications` (existing, one addition)

No change to webhook interface. Add:

- On `notificationType 13 = REVOKED`: set `Redis SET "blocklist:" + ptHash 1` (no expiry). This blocks relay access within seconds even before JWT expires.

---

## 5. Rate Limit Summary

All limits keyed by `jwt.sub` = `sha256(purchaseToken)`. One subscription = one bucket, shared across all devices automatically.

| Limit | Bucket key | Value | Resets |
|-------|-----------|-------|--------|
| Burst | `rl:min:{ptHash}` | 10 req/min | 60s rolling |
| Daily requests | `rl:day:req:{ptHash}` | 200/day | UTC midnight |
| Daily tokens | `rl:day:tok:{ptHash}` | 500k tokens/day | UTC midnight |
| Monthly tasks | `rl:tasks:{ptHash}:YYYY-MM` | 50 tasks/month | 1st of month UTC |

### Redis keys

```
rl:min:{ptHash}              → INCR, EXPIRE 60
rl:day:req:{ptHash}          → INCR, EXPIREAT next_utc_midnight
rl:day:tok:{ptHash}          → INCRBY <tokens>, EXPIREAT next_utc_midnight
rl:tasks:{ptHash}:YYYY-MM    → INCR, EXPIREAT first_day_next_month_utc
blocklist:{ptHash}           → SET 1 (no expiry, permanent until restored)
```

---

## 6. DB Schema Additions

```sql
-- Add pt_hash to existing subscriptions table
ALTER TABLE subscriptions ADD COLUMN pt_hash TEXT UNIQUE;
CREATE INDEX idx_subscriptions_pt_hash ON subscriptions(pt_hash);

-- Agent task tracking (for 50 tasks/month dedup)
CREATE TABLE agent_tasks (
  task_id        TEXT PRIMARY KEY,
  pt_hash        TEXT NOT NULL,          -- subscription identity
  started_at     TIMESTAMP DEFAULT NOW(),
  first_llm_call TIMESTAMP,             -- NULL until first LLM call; when set = task counted
  description    TEXT                   -- optional, from request body
);
CREATE INDEX idx_agent_tasks_pt_hash ON agent_tasks(pt_hash);

-- JWT blocklist (alternative to Redis, use one or the other)
CREATE TABLE jwt_blocklist (
  pt_hash    TEXT PRIMARY KEY,
  blocked_at TIMESTAMP DEFAULT NOW()
);
```

---

## 7. App-Side Changes Required

### 7.1 Auth request

```dart
// POST /api/auth/integrity-token
final body = {
  "packageName": "com.iishanto.servermanager",
  "integrityToken": integrityToken,
  "iapPurchaseToken": await secureStorage.read(key: 'iap_token'),
  "subscriptionPurchaseToken": await secureStorage.read(key: 'sub_token'),
};

// Response: { token, plan, offerToken, expiresIn }
// - token: JWT for all subsequent relay calls
// - plan: "free" | "iap" | "subscriber" | "subscriber_discounted"
// - offerToken: offer ID string (see 7.2) — null for subscriber plans
```

### 7.2 Launching the subscription purchase UI

The `offerToken` field returned by the server is a **Google Play offer ID**, not a
Play Billing Library offer token. You must resolve it to a billing token at runtime:

```dart
// 1. Query Play for the subscription product details
final ProductDetailsResponse response = await InAppPurchase.instance
    .queryProductDetails({'serverkit_ai_pro'});

final ProductDetails product = response.productDetails.first;

// 2. Find the offer matching the server's offerId
//    (cast to GooglePlayProductDetails to access subscriptionOfferDetails)
final googleProduct = product as GooglePlayProductDetails;
final offer = googleProduct.productDetails.subscriptionOfferDetails!
    .firstWhere((o) => o.offerId == authResponse['offerToken']);

// 3. Use offer.offerToken (the real billing token) in the purchase params
final PurchaseParam purchaseParam = GooglePlayPurchaseParam(
  productDetails: product,
  changeSubscriptionParam: null,
  // Pass the resolved billing token here, not the offer ID from the server
  offerToken: offer.offerToken,
);
await InAppPurchase.instance.buyNonConsumable(purchaseParam: purchaseParam);
```

### 7.3 Agent task calls

```dart
// Before starting an agent task — call once per task session
final taskRes = await relay.post('/api/agent/task/start',
  body: { "description": userPrompt });
final taskId = taskRes['taskId'];

// Every LLM call within the agent task — include X-Task-Id header
await relay.post('/v1/chat/completions',
  headers: { 'X-Task-Id': taskId },
  body: { "messages": [...], "stream": true });

// Manual / step AI Assistant calls — no X-Task-Id header
await relay.post('/v1/chat/completions',
  body: { "messages": [...], "stream": true });
```

---

## 8. Security Notes

| Attack | Mitigation |
|--------|-----------|
| Modified APK | Play Integrity `MEETS_BASIC_INTEGRITY` + `PLAY_RECOGNIZED` required |
| Subscription token replay after cancellation | 15min JWT + RTDN webhook → Firestore blocklist → checked on every relay call |
| Burst abuse | 10 req/min per subscription bucket |
| Cost abuse via token-heavy prompts | `max_tokens` capped server-side + 500k token/day budget |
| Task counter bypass (calling relay without task/start) | X-Task-Id not required for non-agent calls; agent feature on app side won't work without valid taskId |
| Forged taskId | taskId verified against DB with pt_hash match before counting |
