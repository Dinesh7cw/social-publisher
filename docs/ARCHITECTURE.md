# Architecture

## 1. System shape

```
                    ┌──────────────────────────────────────────┐
   Team browser ───▶│  Next.js 16 (App Router)                 │
   (HTTPS)          │  · RSC pages  · Route handlers (/api/*)   │
                    │  · session cookie auth · RBAC             │
                    └───────┬───────────────┬──────────────────┘
                            │               │
                ┌───────────▼──────┐  ┌─────▼──────────────┐
                │ Postgres 16      │  │ Redis 7            │
                │ Prisma           │  │ BullMQ queues      │
                │ system of record │  │ rate-limit windows │
                └───────────┬──────┘  └─────┬──────────────┘
                            │               │
                            │        ┌──────▼───────────────┐
                            │        │ Worker process       │
                            │        │ (separate container) │
                            │        └──────┬───────────────┘
                            │               │
                            │        ┌──────▼───────────────────────────────┐
                            │        │ Adapter registry                     │
                            │        │ meta · instagram · linkedin · x       │
                            │        └──────┬───────────────────────────────┘
                            │               │ HTTPS
                ┌───────────▼──────┐  ┌─────▼──────────────────────┐
                │ S3 / MinIO       │  │ Facebook Graph v26.0       │
                │ private originals│  │ graph.instagram.com        │
                │ public projection│  │ api.linkedin.com/rest      │
                └──────────────────┘  │ api.x.com/2                │
                                      └────────────────────────────┘
```

Two processes, one image. `web` serves HTTP; `worker` consumes the queue. They share code
(`src/server/**`) and the database. The worker is separate because BullMQ consumers must not run
inside a horizontally-scaled request process, and because a publishing stall must never take the UI
down with it.

## 2. Why this shape

**One deployable, two processes.** An internal tool with a handful of users does not justify
microservices. Splitting the worker out is the one split that earns its keep: it gives independent
restart, independent resource limits, and a clean "jobs survive app restart" story that the brief
explicitly requires.

**Our queue owns scheduling.** Meta can schedule natively (10 min – 30 days), LinkedIn and X cannot.
If scheduling lived in the platforms, the product would have four different behaviours, four sets of
limits, and two platforms that cannot schedule at all. One queue gives one retry policy, one audit
trail, one cancellation path — and identical semantics for every adapter.

**PostTarget is the unit of work.** "Three platforms succeed and one fails" is a stated requirement,
so the atomic unit is a (post, social account) pair, not a post. Each target gets its own job, its own
state, its own attempts, and its own error. The post's status is derived from its targets.

## 3. Publishing state machines

### PostTarget (the real work)

```
                     ┌──────────► SKIPPED (user cancelled / platform disabled)
                     │
  PENDING ──► QUEUED ──► PUBLISHING ──► PUBLISHED
     │            │           │
     │            │           ├──────► FAILED_RETRYABLE ──► QUEUED (backoff)
     │            │           ├──────► FAILED_PERMANENT  (no auto retry)
     │            │           └──────► UNKNOWN  (ambiguous: platform may or may not have posted)
     │            │
     └────────────┴──────────────────► CANCELLED
```

`UNKNOWN` exists because a network timeout after the platform accepted the payload is
indistinguishable from a failure at the HTTP layer. Blindly retrying that case is how duplicate posts
happen. The worker marks `UNKNOWN`, records the attempt, and surfaces "Check the platform before
retrying" in the UI. This is the honest behaviour and it is deliberate.

### Post (derived, never set by hand)

| Condition over targets | Post status |
| --- | --- |
| no targets | `DRAFT` |
| any target `PENDING`/`QUEUED`/`PUBLISHING` and none published | `SCHEDULED` (or `PUBLISHING` when started) |
| all targets `PUBLISHED` | `PUBLISHED` |
| some `PUBLISHED`, some failed | `PARTIAL` |
| all targets failed/cancelled, none published | `FAILED` |
| user-created, never scheduled | `DRAFT` |

A post is **never** marked `PUBLISHED` until the platform API has confirmed success and the platform
post id has been stored.

## 4. Idempotency and duplicate prevention

Four layers, because this is the failure that damages a client relationship most:

1. **Deterministic job id.** BullMQ job id = `publish:{postTargetId}:{attemptNo}`. Re-enqueueing the
   same work cannot create a second job.
2. **Transactional claim.** The worker claims a target with
   `UPDATE post_target SET status='PUBLISHING' WHERE id=$1 AND status IN ('QUEUED','FAILED_RETRYABLE')`.
   Zero rows updated ⇒ another worker already has it ⇒ exit without publishing.
3. **Unique attempt number.** `@@unique([postTargetId, attemptNo])` makes a duplicate attempt row
   impossible at the database level.
4. **Per-adapter idempotency key** where the platform supports one, passed through the adapter
   context and recorded on the attempt.

Composer double-submit is prevented separately by a client-side submit lock plus a server-side
`Idempotency-Key` header required on `POST /api/posts/:id/publish`.

## 5. Token handling

- Tokens live in `SocialAccountSecret`, a table with **no inbound relations to anything the UI reads**
  and which is never included in a normal `include`.
- Encrypted with AES-256-GCM. Envelope: `v1.<keyId>.<iv-b64>.<tag-b64>.<ciphertext-b64>`. The version
  and key id allow rotation without a data migration.
- The key comes from `TOKEN_ENCRYPTION_KEY` (32 bytes, base64) — env in dev, secrets manager in prod.
  Never committed; `.env.example` carries a placeholder and a generation command.
- Decryption happens in exactly one place: `getAccessToken(accountId)`, called by the worker just
  before an API call. The web process never decrypts for display.
- **No token ever reaches the browser.** `SERIALISABLE_SOCIAL_ACCOUNT` selects explicit fields; the
  secret column is not in the model the UI queries.
- Log redaction drops keys matching `/(token|secret|password|authorization|cookie)/i` at any depth.

## 6. Media pipeline

The awkward constraint: **Meta and Instagram fetch media themselves from a public URL.** A private
bucket returns 403 to Meta's servers and Instagram publishing fails with an opaque error.

Design:

```
upload (presigned PUT) ──► s3://private/{clientId}/{assetId}/original.{ext}
                                    │
                          sharp: validate, strip EXIF, re-encode
                                    │
                          s3://public/{assetId}/{sha256}.{ext}   ← unguessable, immutable, public-read
                                    │
                          MediaAsset.publicUrl = https://media.cw.example/{id}/{hash}.{ext}
```

- The public object's name contains a 32-char hash, so it cannot be enumerated.
- Public objects are immutable; replacing media creates a new asset.
- Public copies are referenced by count and garbage-collected only when no non-archived post
  references them, mirroring the retention rule in `docs/PLATFORM-ACCESS.md`.
- Original filenames are never used in URLs (prevents both enumeration and PII leaks).
- MIME is decided by **magic-byte sniffing** (`file-type`), not by the client-supplied extension.
  Instagram additionally requires JPEG, so PNG sources are transcoded at validation time rather than
  failing at publish.

## 7. Timezones

- Every instant stored as `timestamptz` in UTC.
- The composer sends `scheduledAt` as an ISO-8601 string **with offset** plus the IANA zone name.
- Calendar bucketing is done in the viewer's zone, resolved on the server from the stored zone so the
  grouping is correct for a team spread across zones.
- BullMQ `delay` is computed from `scheduledAt - now`, never from a local-time string.
- DST: a naive "add 1 day" would break twice a year. Tests cover spring-forward (a non-existent local
  time) and fall-back (an ambiguous local time) and assert a single, defined publish instant.

## 8. Authorisation model

Two roles.

| Action | MEMBER | ADMIN |
| --- | --- | --- |
| View clients/accounts/posts/history | ✅ | ✅ |
| Create/edit/duplicate posts, publish, retry | ✅ | ✅ |
| Connect a social account | ✅ | ✅ |
| Disconnect a social account | ❌ | ✅ |
| Create/archive clients | ❌ | ✅ |
| Invite/deactivate team members, change roles | ❌ | ✅ |
| View audit log | ❌ | ✅ |

Rules enforced **server-side only**:

1. Every private route resolves the session first; unauthenticated → `401`.
2. Every mutation re-loads the target row and checks `clientId` ownership before acting. A
   mismatch returns **`404`**, not `403`, so the API does not confirm the existence of another
   client's data.
3. Cross-client requests are impossible to express in the composer because the target picker only
   ever returns accounts for clients the user can see.
4. Admin-only routes are guarded by `requireAdmin`, and the UI merely hides the button — the guard is
   the control.

## 9. Failure handling summary

| Failure | Classification | Behaviour |
| --- | --- | --- |
| Network timeout before response | Ambiguous | `UNKNOWN`, human check prompt, no auto retry |
| 429 / rate limit | Transient | Retry with `Retry-After` (or platform reset header), max 5 |
| 5xx from platform | Transient | Exponential backoff with jitter, max 5 |
| 401 / token expired | Recoverable | Refresh token, retry once, then `NEEDS_RECONNECT` |
| 403 / missing permission | Permanent | `FAILED_PERMANENT` with the exact missing scope named |
| 400 / validation | Permanent | `FAILED_PERMANENT` with platform message surfaced verbatim |
| Media too large / wrong type | Pre-flight | Blocked in composer; never reaches the queue |
| Worker crash mid-job | Recovered | BullMQ re-delivers; the claim in §4 step 2 makes it safe |
| Redis unavailable | Degraded | Web still serves; enqueue fails loudly; scheduled jobs wait in Postgres as `QUEUED` and a reconciler re-enqueues |

## 10. Observability

- Structured JSON logs (`pino`) with `requestId`, `postId`, `targetId`, `attemptNo`, `platform`.
- Every attempt row stores `requestId` so a log line and a database row are joinable.
- Health endpoints: `/api/health` (process), `/api/health/ready` (DB + Redis reachable).
- A reconciler job runs on worker boot and every 5 minutes: any target stuck in `QUEUED` with a
  past `scheduledAt` for more than 2 minutes is re-enqueued (covers the Redis-loss case).

## 11. Deliberately deferred

- Engagement/impression ingestion (brief defers it; needs extra permissions per platform).
- Multi-tenancy beyond clients (this is one agency, not a SaaS).
- Real-time UI updates (polling on the history page is sufficient for the team's cadence).
