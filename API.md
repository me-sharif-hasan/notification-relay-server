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
  "timestamp": "2026-06-11T10:00:00Z"
}
```

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

## Error Reference

| Code | Meaning | Action |
|------|---------|--------|
| `200` | Success | — |
| `400` | Bad request, missing fields | Check request body |
| `401` | Token invalid or revoked | Token was revoked or never existed |
| `404` | Resource not found | Token doesn't exist |
| `429` | Rate limited (agent only) | Agent backs off and retries |
| `500` | Server error | Retry with backoff |
