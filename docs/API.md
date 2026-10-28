# API contract

All private endpoints require a valid session cookie. All mutations require `Content-Type:
application/json` (upload URLs excepted) and a same-origin `Origin` header.

**Conventions**

| Topic | Rule |
| --- | --- |
| Base | `/api` |
| Auth | httpOnly, `Secure`, `SameSite=Lax`, `__Host-` prefixed session cookie |
| Errors | `{ error: { code, message, details? } }` with a stable machine-readable `code` |
| Not found vs forbidden | Cross-tenant access returns **404**, never 403 (does not confirm existence) |
| Timestamps | ISO-8601 UTC in responses; requests carry offset + IANA zone |
| Pagination | `?cursor=<id>&limit=<1..100>`; response `{ items, nextCursor }` |
| Idempotency | `POST /posts/:id/publish` requires `Idempotency-Key` header |
| CSRF | Mutations reject requests whose `Origin` does not match `APP_ORIGIN` |
| Rate limit | Auth routes 10/min/IP; mutations 60/min/user; 429 + `Retry-After` |

**Error codes**

`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `RATE_LIMITED`,
`PLATFORM_DISABLED`, `PLATFORM_AUTH_EXPIRED`, `TARGET_NOT_PUBLISHABLE`, `IDEMPOTENCY_CONFLICT`,
`INTERNAL`

---

## Auth

### `POST /api/auth/login`

```json
{ "email": "team@colorwhistle.com", "password": "…" }
```
`200` → `{ "user": { id, name, email, role } }` and sets the session cookie.
`401 UNAUTHENTICATED` — same message for unknown email and wrong password (no user enumeration).
`429 RATE_LIMITED`.

### `POST /api/auth/logout`
`204`. Destroys the session row and clears the cookie.

### `GET /api/auth/me`
`200` → `{ user, capabilities: { canManageClients, canDisconnectAccounts, canManageTeam } }`.
`401` when unauthenticated. The client uses `capabilities` for affordances only; the server re-checks
every action.

---

## Clients

### `GET /api/clients?q=&status=&cursor=`
`200` → `{ items: Client[], nextCursor }`. `status` defaults to `ACTIVE`.
Search matches name and slug, case-insensitive.

### `POST /api/clients`  *(ADMIN)*
```json
{ "name": "Sri Krishna", "contactName": "…", "contactEmail": "…", "notes": "…" }
```
`201` → `Client`. `409` when the derived slug is taken. Writes `CLIENT_CREATED` audit entry.

### `GET /api/clients/:id`
`200` → `Client` with `counts: { accounts, drafts, scheduled, published, failed }`.

### `PATCH /api/clients/:id`  *(ADMIN)*
Partial update of `name`, `contactName`, `contactEmail`, `notes`. `200` → `Client`.

### `POST /api/clients/:id/archive`  *(ADMIN)*
`200` → `Client` with `status: "ARCHIVED"`. Idempotent. Refuses (409) while the client has targets
queued or publishing, to avoid orphaning in-flight work.

---

## Social accounts

### `GET /api/accounts?clientId=&platform=&status=`
`200` → `{ items: SocialAccountView[] }`.
`SocialAccountView` = `{ id, clientId, platform, displayName, accountType, status, scopes,
tokenExpiresAt, lastVerifiedAt }` — **never any token field.**

### `GET /api/accounts/:platform/connect`
Starts OAuth. `302` to the platform authorize URL with a signed, single-use `state` bound to the
session and a PKCE verifier where the platform supports it. `PLATFORM_DISABLED` (409) when the
platform flag is off.

### `GET /api/accounts/:platform/callback?code=&state=`
Validates `state` (signature, expiry ≤ 10 min, single use, session match). Exchanges the code, lists
selectable accounts, and returns `302` to
`/accounts/connect?session=<id>` for the **account picker** step, because Meta returns many pages and
LinkedIn returns a member plus organisations. The team chooses which to attach to which client.

`400 VALIDATION_FAILED` on state mismatch — never proceeds.

### `POST /api/accounts/connect/confirm`
```json
{
  "connectSessionId": "…",
  "clientId": "…",
  "accounts": [{ "externalId": "…", "displayName": "…", "accountType": "PAGE" }]
}
```
`201` → `{ items: SocialAccountView[] }`. Tokens are written encrypted in the same transaction.
Writes `ACCOUNT_CONNECTED` per account.

### `POST /api/accounts/:id/reconnect`
Re-runs OAuth for one existing account; refreshes the secret in place and sets `status: CONNECTED`.

### `POST /api/accounts/:id/disconnect`  *(ADMIN)*
`204`. Deletes the secret, sets `status: REVOKED`, keeps the row so history stays intact.
Refuses with `409` while any target on this account is `QUEUED` or `PUBLISHING`.
Writes `ACCOUNT_DISCONNECTED`.

### `POST /api/accounts/:id/verify`
Forces a token check against the platform. `200` → `{ status, tokenExpiresAt, scopes }`.
This is the only endpoint that reports expiry freshness on demand.

---

## Media

### `POST /api/media/presign`
```json
{ "clientId": "…", "filename": "launch.jpg", "mimeType": "image/jpeg", "byteSize": 482133 }
```
`200` → `{ uploadUrl, method: "PUT", headers, assetId, expiresIn }`.
Rejects oversized files and disallowed MIME types **before** an upload is attempted.

### `POST /api/media/:assetId/finalize`
Server downloads the object, sniffs the real MIME by magic bytes, validates dimensions, strips EXIF,
creates the public projection for image formats Meta/IG can fetch, and writes `MediaAsset`.
`201` → `MediaAssetView`. `422 VALIDATION_FAILED` when the sniffed type does not match the declared
type (a real attack vector, so it is rejected rather than corrected).

### `DELETE /api/media/:assetId`
`204` when unreferenced; `409` while attached to a non-draft post.

---

## Posts

### `GET /api/posts?clientId=&status=&platform=&from=&to=&cursor=`
`200` → `{ items: PostSummary[], nextCursor }`.
`PostSummary` carries the rollup status and per-status target counts so the calendar and list views
need one query.

### `POST /api/posts`
```json
{
  "clientId": "…",
  "baseCaption": "…",
  "mediaAssetIds": ["…"],
  "targets": [
    { "socialAccountId": "…", "caption": "Platform-specific override" }
  ]
}
```
`201` → `Post`. Creates `DRAFT`. Rejects duplicate `socialAccountId` in `targets` (`VALIDATION_FAILED`)
and accounts that do not belong to `clientId` (`NOT_FOUND`).

### `GET /api/posts/:id`
`200` → `Post` with `targets[]` (each with its own status, platform post id, url, last error) and
`media[]`.

### `PATCH /api/posts/:id`
Editable only in `DRAFT`, `SCHEDULED`, `FAILED`, `PARTIAL`. Editing a scheduled post re-validates and
reschedules its queued jobs inside the same transaction.
`409 TARGET_NOT_PUBLISHABLE` when the post has already gone live.

### `POST /api/posts/:id/validate`
Dry-run of every target's platform rules. `200` →
`{ ok: boolean, results: [{ socialAccountId, platform, ok, errors: [{ code, message }] }] }`.
The composer calls this before submit so a user sees all four verdicts at once rather than
discovering the fourth platform's objection after two posts already went out.

### `POST /api/posts/:id/schedule`
```json
{ "scheduledAt": "2026-11-02T09:30:00+05:30", "timeZone": "Asia/Kolkata" }
```
`200` → `Post` with `status: SCHEDULED`. Rejects a past instant (`VALIDATION_FAILED`) and schedules
every target. Writes `POST_SCHEDULED`.

### `POST /api/posts/:id/publish`
Header `Idempotency-Key: <uuid>`.
`202` → `{ post, targets }` where each target is `QUEUED` or `PUBLISHING`.
`409 IDEMPOTENCY_CONFLICT` when the same key was used with a different body.
`422` when validation fails — **nothing is enqueued**, so a partial batch cannot start.

### `POST /api/posts/:id/cancel`
`200`. Cancels every non-terminal target and removes its BullMQ job. Already-published targets are
left alone and the post becomes `CANCELLED` or `PARTIAL`.

### `POST /api/posts/:id/duplicate`
`201` → new `DRAFT` with copied targets and media, `duplicatedFromId` set. No publish state copied.

### `POST /api/posts/:id/targets/:targetId/retry`
`202`. Only for `FAILED_RETRYABLE`, `FAILED_PERMANENT` (explicit human override), or `UNKNOWN` with
`confirmUnknown: true`. Enqueues a new attempt. Writes `POST_RETRY`.

---

## Publishing history

### `GET /api/history?clientId=&platform=&status=&from=&to=&cursor=`
`200` → `{ items: HistoryRow[], nextCursor }` where each row is one target with its latest attempt:
platform post id, url, published timestamp, error class and message, attempt count.

### `GET /api/targets/:id/attempts`
`200` → `Attempt[]` (append-only, newest first). Used by the "why did this fail" drawer.

---

## Calendar

### `GET /api/calendar?from=&to=&timeZone=&clientId=&platform=&status=`
`200` → `{ days: [{ date: "2026-11-02", posts: PostSummary[] }] }`, bucketed in `timeZone`.
Range capped at 62 days to keep the payload honest.

---

## Dashboard

### `GET /api/dashboard`
```json
{
  "counts": { "clients": 0, "accounts": 0, "drafts": 0, "scheduled": 0, "published": 0, "failed": 0 },
  "accountsByPlatform": [{ "platform": "FACEBOOK", "connected": 0, "needsAttention": 0 }],
  "recentActivity": [{ "id": "…", "kind": "PUBLISHED", "clientName": "…", "platform": "…", "at": "…" }]
}
```
Counts come from SQL aggregation over the caller's visible clients, never from client-side filtering.

---

## Team  *(ADMIN)*

`GET /api/users` · `POST /api/users` (invite) · `PATCH /api/users/:id` (name, role, isActive) ·
`POST /api/users/:id/reset-password`. Role changes and deactivations write audit entries and
invalidate the target user's sessions.

---

## Audit  *(ADMIN)*

### `GET /api/audit?clientId=&action=&from=&to=&cursor=`
`200` → `{ items: AuditEntry[], nextCursor }`. Metadata is redacted before storage, so no response
can contain a token.

---

## Health

`GET /api/health` → `{ status: "ok", version }`
`GET /api/health/ready` → `{ database: "ok"|"down", redis: "ok"|"down" }`, `503` when either is down.
Both are unauthenticated by design and leak no configuration detail.
