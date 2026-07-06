# Backend Plan — Unified Device/Notification Token Registry

Status: **§1–§4 implemented. §7 (marketing/CVE-alert send) — initial version implemented.**
Scope: how we add app-launch push registration and a future marketing-push
channel on top of the existing freemium model, without breaking any
existing endpoint or client already in the field.

---

## 1. Current state (as of this plan)

Two independent auth models exist today. Neither talks to the other.

### 1a. Entitlement / JWT model — `chat`, `subscription`, `agent tasks`
```
App → POST /api/auth/integrity-token → verify Play Integrity (+ purchase
      token if present) → sign 15-min JWT { sub, plan, expiryTime }
App → Authorization: Bearer <jwt> → /ping, /v1/chat/completions,
      /api/agent/task/start, /api/subscription/status  (requireJwt)
```
- `sub` = `sha256(purchase token)` for paying users, or the legacy
  client-supplied `deviceId` for free users (most users today — see §3).
- `sub` is an **entitlement identity**, not a device identity: it's shared
  across every device signed into the same Google account/subscription, and
  changes if the user cancels/resubscribes or switches IAP↔subscription.
- Rate limits, trial usage, blocklist, and task quotas are all pooled per
  `sub` **by design** — "one subscription = one bucket, regardless of
  device count" (see `subscription-api.md`).

### 1b. VPS-alert bearer model — `/integrations/token`, `/alert`
```
App → POST /integrations/token { integrityToken, fcmToken }
    → token = sha256(integrityToken + fcmToken)   (deterministic doc ID)
    → stored in integrationTokens/{token}, no expiry, revoke via DELETE
VPS agent → Authorization: Bearer <token> → POST /alert
    → looked up directly as integrationTokens/{token}
```
- Never verifies `integrityToken` against Google — the "auth" here is
  purely possession of the derived hash. Fine for a user-revocable,
  self-service VPS pairing secret; not fine as a general auth mechanism.
- `fcmToken` is frozen into the doc at creation time. If the FCM token
  rotates, calling `/integrations/token` again produces a **new** doc, not
  an update — the old doc stays "valid" but silently pushes to a dead
  token until the user notices and re-pairs the VPS agent manually.

### 1c. Admin shared-secret model — `/admin/*`
```
Caller → GET/POST /admin/... ?token=<ADMIN_TOKEN>
       → isAuthorized() compares query token to env ADMIN_TOKEN
```
- No JWT, no per-caller identity — a single shared secret gates every
  `/admin/*` route (dashboard, settings, quota reset, blocklist). Anyone
  holding `ADMIN_TOKEN` can call any admin action.
- Deliberately reused (see §7) as the auth for the new notification-send
  endpoint, since it's the simplest existing mechanism and — unlike the
  JWT model — isn't tied to any one app install, which matters for a
  future non-app caller (an automated CVE-alert service).

**Gap:** neither the JWT model nor the VPS-alert model has a per-device
push-token record that's (a) kept fresh on every launch, (b) available to
users who never set up a VPS, and (c) stable across plan/subscription
churn. That's what §2 adds.

---

## 2. Design

**Implemented:** `services/deviceTokens.js`, `routes/devices.js`.

### 2a. New collection: `deviceTokens`
Single source of truth for "what FCM token does this install currently
have." Keyed by **`installId`** — a client-generated UUID, persisted
locally on the device, sent explicitly by the client. Not derived from the
JWT, not derived from `sub`.

```
deviceTokens/{installId}: {
  fcmToken:   string,
  sub:        string | null,   // metadata only — for segmentation/fan-out
  plan:       string | null,   // metadata only
  packageName: string | null,
  updatedAt:  Timestamp
}
```

Why `installId` and not `sub`: `sub` can be identical across multiple
physical devices (same subscription, multiple phones) or change entirely
on resubscribe. Keying by `sub` would let one device's registration
silently clobber another's. Keying by `installId` makes this a natural
**one-to-many**: one `sub` → many `deviceTokens` docs → many independent
`fcmToken`s, which is also exactly what a future "push to all of this
subscriber's devices" marketing fan-out needs (`where sub == X`, no extra
Firestore index required for the simple equality case).

### 2b. New endpoint: `POST /devices/token`
- Gated by the existing `requireJwt` middleware — no new auth scheme.
- Body: `{ installId, fcmToken, packageName? }`.
- Upserts `deviceTokens/{installId}`, stamping `sub`/`plan` from
  `request.jwtPayload` as metadata.
- Called on every app launch, **piggybacked** on the JWT the app already
  mints via `/api/auth/integrity-token` for chat/subscription gating — not
  a second Play-Integrity round trip. Fire-and-forget; does not block
  startup UI.
- Covers every user by construction, since every install already goes
  through the integrity/JWT exchange on launch regardless of whether they
  use the monitor-agent feature.

Note: `plan` is now also stored alongside `sub` on each `deviceTokens` doc
(not in the original sketch) — needed so §7's future segmented sends can
filter by plan without a second lookup.

### 2c. `/integrations/token` — additive change only (not yet implemented)
Add one optional field to the stored doc: `installId`, if the client sends
it. Old clients that omit it are completely unaffected — same request
shape, same response shape, same doc-ID derivation.

### 2d. `/alert` — additive internal read-path only (not yet implemented)
Before sending the push, if the integration doc has `installId`, look up
`deviceTokens/{installId}` and prefer its `fcmToken` (the live one) over
the doc's own stored `fcmToken`. Falls back to the old behavior if
unlinked. **No change to `/alert`'s request or response shape** — this is
purely an internal lookup enhancement, so it self-heals the token-rotation
bug for any device that has also called `/devices/token`, without
requiring the user to re-pair their VPS agent.

### 2e. What is explicitly NOT changing
- `/api/auth/integrity-token` — untouched.
- `/integrations/token` — request/response contract untouched (one new
  optional input field only).
- `/alert` — request/response contract untouched.
- No `v2` of any existing route. No versioning needed at all, because
  nothing existing changes shape or semantics — see §4.

---

## 3. Freemium-model correctness notes

- Most installs are free-tier with no purchase token, so `sub == deviceId`
  today — coincidentally already device-stable. This does **not** hold for
  paying users, where `sub == sha256(purchase token)` and is shared across
  every device on that subscription. Any future feature that needs a
  per-device key must use `installId`, never `sub`, regardless of how
  convenient `sub` looks for the free-tier majority.
- Pooled rate limits/quota/blocklist per `sub` are intentional existing
  behavior (one entitlement, shared across devices) — do not "fix" this
  as part of push-token work; it's a separate product decision if it ever
  changes.
- FCM tokens are rotating credentials, never identifiers. Anything that
  stores one must treat it as replaceable and keep the real identity in a
  separate, stable key (`installId`).

---

## 4. Backward-compatibility guarantees

| Endpoint | Change | Existing callers affected? |
|---|---|---|
| `POST /api/auth/integrity-token` | none | no |
| `POST /integrations/token` | +1 optional field (`installId`) | no |
| `DELETE /integrations/token` | none | no |
| `POST /alert` | internal read-path fallback only | no |
| `POST /devices/token` | **new** | n/a (new) |

No backfill/migration required: existing `integrationTokens` docs without
`installId` keep working exactly as they do today until the same device
also calls `/devices/token` at least once (which happens naturally on next
app launch), at which point alert delivery for that device silently
upgrades to the fresher token.

---

## 5. Principles for future API design (apply beyond this feature)

1. **Never key a device-scoped record by `sub`.** `sub` is an entitlement
   identity (purchase-token- or legacy-deviceId-derived), not a device
   identity. Use a client-generated, locally-persisted `installId` for
   anything that must stay distinct per physical install.
2. **Treat push/registration tokens (FCM, APNs, etc.) as rotating
   credentials, not identifiers.** Always store them behind a stable key,
   refreshed on every launch, never as the key itself.
3. **Reuse the existing JWT mint as the one universal per-launch auth
   event.** New features needing device-level auth should hang off
   `requireJwt`, not invent a parallel token scheme — avoids duplicate
   Play Integrity round-trips and duplicate bearer-secret sprawl.
4. **Entitlement (`sub`, `plan`) is metadata for segmentation, never a
   primary key** for anything that must remain distinct per device.
5. **Prefer additive, optional-field evolution over versioning.** Version
   an endpoint only when you must change existing request/response
   semantics that current callers depend on — not when you're adding a new
   optional input or an internal read-path enhancement.
6. **One source of truth per resource.** Any future "send push to X"
   feature (marketing, alerts, or whatever comes next) reads from
   `deviceTokens` rather than keeping its own copy of push tokens, to
   avoid re-introducing the staleness bug this plan fixes.
7. **Clean up stale device records reactively, not on a timer.** Prefer
   acting on FCM's "unregistered" error response over guessing an
   expiry window — keeps the SSOT accurate without a cron job.

---

## 7. Notification distribution endpoint (initial version)

**Implemented:** `POST /admin/notifications/send` in `routes/admin.js`.

```
Caller (admin dashboard, or in future an external CVE-alert service)
  → POST /admin/notifications/send?token=<ADMIN_TOKEN>
    { title, body, data?, installId? }

  installId present  → unicast: getDeviceFcmToken(installId) → admin.messaging().send()
  installId omitted  → broadcast: every deviceTokens doc (§2a) →
                        admin.messaging().sendEachForMulticast(), batched
                        500 tokens at a time

  → any stale-token response
      (messaging/registration-token-not-registered,
       messaging/invalid-registration-token)
    triggers deleteDeviceToken(installId)   — reactive cleanup, per §5.7
  → { success, total, sent, failed, cleaned }
```

Unicast is meant for targeted use (e.g. "notify this one subscriber," or a
future per-device CVE alert scoped to affected installs only) without
having to broadcast to everyone.

**Why gated by `ADMIN_TOKEN` and not JWT:** this endpoint isn't tied to any
one app install — it's a distribution API meant to be called by whatever
decides *that* a notification should go out. Today that's a human via the
admin dashboard. The planned automated CVE-alert integration is a
**separate service** that watches for new CVEs and decides content/timing;
it has no Play Integrity token, no app JWT, and shouldn't need one — it
just needs to call this relay's send endpoint with the shared admin
secret. This keeps a clean separation of concerns: other services own
"what and when to alert," this relay stays the single point of FCM
distribution and the single owner of `deviceTokens`.

**Admin panel:** `views/adminDashboard.js` now shows a "Registered Push
Devices" count and a "Send Notification" panel (title/body → broadcast to
all devices), for manual/ad-hoc sends and as a smoke test for the pipeline
ahead of the automated integration.

**Current limitations (intentional, for the initial version):**
- Targeting is single-device (`installId`) or everyone — no filtering by
  `plan`/`sub`/list-of-installIds yet. `plan` is already stored on each
  `deviceTokens` doc (§2a) specifically so plan-based segmentation (e.g.
  "subscribers only") can be added later without a schema change.
- No delivery log/history is persisted — only an aggregate
  `{ sent, failed, cleaned }` count is returned per call. Add a
  `notificationSends` collection if audit history becomes necessary before
  the CVE integration ships.
- No rate limiting or dedup on this endpoint. Acceptable while it's
  human-triggered only; revisit before wiring up an automated caller that
  could fire repeatedly on a flaky CVE feed.

## 8. Open follow-ups (not yet decided)

- Segmentation for the send endpoint (by `plan`, `sub`, or explicit
  `installId` list) — not needed until the CVE-alert integration or a
  real marketing campaign requires targeting less than "everyone."
- Should the future CVE-alert service call `/admin/notifications/send`
  directly with `ADMIN_TOKEN`, or should it get its own scoped credential
  once it exists, so it can't accidentally exercise the other `/admin/*`
  actions (settings, blocklist, quota reset)? Leaning toward a separate
  token/route by the time that integration is real — reusing
  `ADMIN_TOKEN` for the initial version is a deliberate "make it simple"
  shortcut, not a permanent decision.
- Whether `/devices/token` should also accept an unauthenticated
  "best-effort" mode for the rare case a launch has no JWT yet (current
  recommendation: no — always piggyback on the JWT mint; see prior
  discussion on why an unauthenticated path reintroduces the same
  weak-verification problem as the integration-token scheme).
