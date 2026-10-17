# Notification Relay — Mobile API Documentation

**Base URL:** `https://serverkitrelay.iishanto.com`

---

## Overview

The relay server bridges your VPS monitor agent and your mobile device via push notifications.

```
Mobile App → POST /integrations/token → gets a token
User pastes token into VPS agent
VPS Agent → POST /alert → relay → FCM → your device
```

---

## Endpoints

---

### 1. Create Integration Token

**`POST /integrations/token`**

Call this when the user wants to register a new VPS. The app provides a Play Integrity token (to prove it's a legitimate app install) and the device's FCM token (to receive notifications).

**Request**
```http
POST /integrations/token
Content-Type: application/json

{
  "integrityToken": "<Play Integrity token from Google>",
  "fcmToken": "<FCM registration token from Firebase>"
}
```

**Response `200`**
```json
{
  "token": "a3f9c2e1d5b8...64 char hex string",
  "createdAt": "2026-06-11T10:00:00.000Z"
}
```

**Important:** The token is returned **once only**. Display it to the user immediately and ask them to copy it. It cannot be retrieved again — but it is deterministic, so calling this endpoint again with the same `integrityToken` + `fcmToken` produces the same token.

**Errors**
| Code | Reason |
|------|--------|
| `400` | Missing `integrityToken` or `fcmToken` |

---

### 2. Revoke Integration Token

**`DELETE /integrations/token`**

Revoke a previously created token. The VPS agent using it will immediately start receiving `401` responses and stop sending alerts.

**Request**
```http
DELETE /integrations/token
Content-Type: application/json

{
  "token": "a3f9c2e1d5b8...the token to revoke"
}
```

**Response `200`**
```json
{
  "success": true
}
```

**Errors**
| Code | Reason |
|------|--------|
| `400` | Missing `token` field |
| `404` | Token not found |

---

### 2b. Mute, Unmute and Status

Silence alerts for one token (one phone) without revoking it. While muted, `POST /alert` still answers `200` but sends no push, so the VPS agent keeps running and needs no change. A timed mute ends by itself, with no call from the app.

**`POST /integrations/token/mute`**
```http
POST /integrations/token/mute
Content-Type: application/json

{ "token": "a3f9c2e1d5b8...", "minutes": 90 }
```
Send `"indefinite": true` instead of `minutes` to mute until unmuted. `minutes` is a whole number from 1 to 10080 (7 days).

**`DELETE /integrations/token/mute`** with body `{ "token": "..." }` resumes alerts.

**`POST /integrations/token/status`** with body `{ "token": "..." }` returns the current state.

All three return the state:
```json
{
  "muted": true,
  "indefinite": false,
  "until": "2026-06-11T11:30:00.000Z"
}
```
`until` is `null` when not muted or when muted indefinitely. An elapsed mute reads as `muted: false`.

**Errors**
| Code | Reason |
|------|--------|
| `400` | Missing `token`, or `minutes` out of range and `indefinite` not `true` |
| `401` | Token revoked |
| `404` | Token not found |
| `429` | Too many requests for this token |

---

### 3. Receive Alert (VPS Agent — for reference)

**`POST /alert`**

This endpoint is called by the VPS agent, not the mobile app. Documented here so the app can display incoming alert data correctly.

**Request (sent by agent)**
```http
POST /alert
Authorization: Bearer <integration token>
Content-Type: application/json

{
  "metric": "cpu",
  "level": "warn",
  "value": 87,
  "host": "my-vps-hostname",
  "timestamp": "2026-06-11T10:00:00Z"
}
```

| Field | Type | Values |
|-------|------|--------|
| `metric` | string | `cpu`, `mem`, `disk` |
| `level` | string | `warn`, `crit` |
| `value` | number | Percentage (0–100) |
| `host` | string | VPS hostname |
| `timestamp` | string | ISO 8601 |

---

## FCM Push Notification Payload

When an alert is received, the app gets an FCM notification with this structure:

**Notification (shown in system tray)**
| Alert | Title | Body |
|-------|-------|------|
| CPU warn | ⚠️ CPU Warning — {host} | CPU at {value}% |
| CPU crit | 🔴 CPU Critical — {host} | CPU at {value}% |
| Memory warn | ⚠️ Memory Warning — {host} | Memory at {value}% |
| Memory crit | 🔴 Memory Critical — {host} | Memory at {value}% |
| Disk warn | ⚠️ Disk Warning — {host} | Disk at {value}% |
| Disk crit | 🔴 Disk Critical — {host} | Disk at {value}% |

**Data payload (available in app when notification is tapped)**
```json
{
  "metric": "cpu",
  "level": "warn",
  "value": "87",
  "host": "my-vps-hostname",
  "server_name": "Production (ubuntu 24)",
  "token_id": "sha256 of the integration token",
  "timestamp": "2026-06-11T10:00:00Z"
}
```

`server_name` is the label the app gave the agent (empty if the agent did not send one). `token_id` lets the app work out which of its servers sent the alert, so a tap can open that server.

> Note: All data payload values are strings (FCM requirement).

**Android channel:** `monitor_alerts` — create this channel in your app with high importance so alerts are not silenced.

---

## Integration Flow (Step by Step)

```
1. User taps "Add VPS" in the app

2. App fetches Play Integrity token
   val integrityToken = IntegrityManagerFactory
       .create(context, googleCloudProjectNumber)
       .requestIntegrityToken(...)

3. App gets FCM registration token
   FirebaseMessaging.getInstance().token.await()

4. App calls POST /integrations/token
   → Server returns { token: "a3f9c..." }

5. App displays token to user with a copy button
   "Copy this token and paste it into your monitor agent.
    It will not be shown again."

6. User SSH into VPS and runs:
   ./monitor-agent.sh --token <token> --daemon

7. App receives FCM notifications when VPS metrics spike
```

---

## FCM Token Refresh

FCM tokens can rotate (app reinstall, device restore, etc.). When this happens:

1. Detect the new token via `FirebaseMessaging.onTokenRefresh`
2. Re-call `POST /integrations/token` with the new FCM token and the same `integrityToken`
3. Because the token is deterministic (`sha256(integrityToken + fcmToken)`), the new token will be different
4. The user must update the VPS agent with the new token

> Consider warning users in the app that reinstalling will invalidate their VPS tokens.

---

## Support chat

All routes need `Authorization: Bearer <jwt>` from `POST /api/auth/integrity-token`. `installId` is a random UUID the app creates once and keeps; it is the only identity of a thread. The relay stores the country from Cloudflare's `cf-ipcountry` header and never the IP.

### POST /support/messages

```json
{ "installId": "<uuid>", "kind": "problem|question|idea", "text": "...",
  "context": { "appVersion": "2.5.8", "androidVersion": "14", "lastError": "..." },
  "images": [{ "mime": "image/png", "data": "<base64>" }] }
```

Up to 2000 characters and 3 images of 4 MB each. Secrets (private keys, `password=`, bearer tokens) are removed before anything is stored. Returns `{ success, message, delivered }`. The message is stored first and forwarded to Telegram in the background, so `delivered: true` means received.

Errors: 400 `invalid_install_id`, `empty_message`, `text_too_long`, `too_many_images`, `invalid_image`; 403 `blocked`; 413 `image_too_large`; 429 `rate_limited` (6 per minute and 60 per day per install).

### GET /support/messages?installId=&after=&markRead=1

Messages with an id greater than `after`, oldest first, plus `unread` (replies not yet read). `markRead=1` clears the unread count.

### GET /support/unread?installId=

`{ success, unread }`. Cheap enough to call at launch.

### Replies

The developer answers inside the user's topic in the Telegram support group, or by replying to a forwarded message in the owner chat when no group is set. The relay stores the reply and sends an FCM message with `data.type = support_reply` on the `support_replies` channel to the token registered through `POST /devices/token`.

Owner commands: `/setup` (in the group, once), `/inbox`, and inside a topic `/close`, `/block`, `/unblock`, `/info`.

---

## Error Reference

| Code | Meaning | Action |
|------|---------|--------|
| `200` | Success | — |
| `400` | Bad request, missing fields | Check request body |
| `401` | Token invalid or revoked | Token was revoked or never existed |
| `404` | Resource not found | Token doesn't exist |
| `429` | Rate limited (agent only) | Agent backs off and retries |
| `500` | Server error | Retry with backoff |
