# Database schema

PostgreSQL 16 via Prisma. Source of truth is `prisma/schema.prisma`; this document explains the
decisions.

## 1. Entity map

```
User ──< Session
  │
  └──< AuditLog (actor)

Client ──< SocialAccount ──1 SocialAccountSecret
   │            │
   │            └──< PostTarget >── Post ──< MediaAsset (via PostMedia)
   │                     │
   │                     ├──< PublishingAttempt
   │                     └──< ScheduledJob
   └──< Post
```

## 2. Design decisions

### 2.1 `SocialAccountSecret` is a separate table

Tokens are the highest-value data in the system. Keeping them in a dedicated table means:

- they are absent from every ordinary query and every `include` the UI performs;
- they cannot leak through a generic serialiser that spreads a model;
- they can be encrypted with a different lifecycle (rotation, re-encryption) than business data;
- deleting an account can hard-delete the secret while keeping the account row for audit history.

The table has **no relation back to any model the UI reads**. Access is via `getAccessToken()` only.

### 2.2 `PostTarget` carries the state, `Post` derives it

Per-account status is a hard requirement. If `Post` held the status, "3 succeeded, 1 failed" would be
unrepresentable. `Post.status` is a cached rollup recomputed after any target change, so list queries
stay cheap without becoming the source of truth.

### 2.3 Attempts are append-only

`PublishingAttempt` is never updated in place after it is closed. Retrying creates a new attempt row
with `attemptNo + 1`. This makes the history truthful and the audit trail complete.

### 2.4 `ScheduledJob` mirrors BullMQ

BullMQ lives in Redis, which is not durable enough to be the system of record. `ScheduledJob` records
the intended schedule and the last known queue state so that:

- the calendar and history pages can render without touching Redis;
- a job lost from Redis can be re-enqueued by the reconciler;
- the team can see what *should* be running.

`jobId` is `@@unique` and equals the BullMQ job id, which is the join key between the two systems.

### 2.5 Enums, not strings

Every status is a Postgres enum. This makes illegal states unrepresentable and lets the database
reject a typo that a string column would silently accept.

## 3. Entities

### User

| Column | Type | Notes |
| --- | --- | --- |
| id | text (cuid) | PK |
| email | text | **unique**, lowercased on write |
| name | text | display name |
| passwordHash | text | argon2id |
| role | `Role` | `ADMIN` \| `MEMBER` |
| isActive | boolean | default true; deactivation keeps history |
| timeZone | text | IANA zone, default `Asia/Kolkata` |
| createdAt / updatedAt | timestamptz | |

Indexes: `unique(email)`.

### Session

| Column | Type | Notes |
| --- | --- | --- |
| id | text | PK; the value in the cookie is an HMAC of this, not the id itself |
| userId | text | FK → User, `onDelete: Cascade` |
| expiresAt | timestamptz | absolute expiry |
| createdAt | timestamptz | |
| userAgent / ipHash | text? | ipHash is a salted hash, never the raw IP |

Indexes: `index(userId)`, `index(expiresAt)` for the sweeper.

### Client

| Column | Type | Notes |
| --- | --- | --- |
| id | text | PK |
| name | text | |
| slug | text | unique, for stable URLs |
| contactName / contactEmail | text? | |
| notes | text? | |
| status | `ClientStatus` | `ACTIVE` \| `ARCHIVED` |
| archivedAt | timestamptz? | |
| createdById | text | FK → User |
| createdAt / updatedAt | timestamptz | |

Indexes: `unique(slug)`, `index(status)`, `index(name)` for search.
Archiving never deletes: posts and history must survive.

### SocialAccount

| Column | Type | Notes |
| --- | --- | --- |
| id | text | PK |
| clientId | text | FK → Client, `onDelete: Restrict` |
| platform | `Platform` | `FACEBOOK` \| `INSTAGRAM` \| `LINKEDIN` \| `X` |
| externalId | text | page id / ig user id / member or org urn / x user id |
| displayName | text | account name shown to the team |
| accountType | `AccountType` | `PAGE` \| `IG_PROFESSIONAL` \| `MEMBER` \| `ORGANIZATION` \| `X_ACCOUNT` |
| status | `AccountStatus` | `CONNECTED` \| `EXPIRED` \| `REVOKED` \| `ERROR` |
| scopes | text[] | granted scopes, as reported by the platform |
| tokenExpiresAt | timestamptz? | null when the platform does not expire it |
| lastVerifiedAt | timestamptz? | last successful token check |
| connectedById | text | FK → User |
| createdAt / updatedAt | timestamptz | |

Indexes: `unique(platform, externalId)`, `index(clientId)`, `index(status)`.
The unique constraint prevents connecting the same page twice under two clients — a real source of
double-posting bugs.

### SocialAccountSecret

| Column | Type | Notes |
| --- | --- | --- |
| id | text | PK |
| socialAccountId | text | **unique** FK → SocialAccount, `onDelete: Cascade` |
| accessTokenCipher | text | AES-256-GCM envelope |
| refreshTokenCipher | text? | |
| tokenType | text? | `Bearer` etc. |
| keyId | text | which encryption key version |
| rotatedAt | timestamptz? | |
| updatedAt | timestamptz | |

No index beyond the unique FK. Never selected by list queries.

### Post

| Column | Type | Notes |
| --- | --- | --- |
| id | text | PK |
| clientId | text | FK → Client, `onDelete: Restrict` |
| authorId | text | FK → User |
| baseCaption | text | the master caption |
| status | `PostStatus` | `DRAFT` \| `SCHEDULED` \| `PUBLISHING` \| `PUBLISHED` \| `PARTIAL` \| `FAILED` \| `CANCELLED` |
| scheduledAt | timestamptz? | UTC instant |
| scheduledTimeZone | text | IANA zone the user scheduled in |
| publishedAt | timestamptz? | set only when a target confirms |
| duplicatedFromId | text? | self-relation for duplicate lineage |
| createdAt / updatedAt | timestamptz | |

Indexes: `index(clientId, status)`, `index(scheduledAt)`, `index(status)`.

### PostTarget

| Column | Type | Notes |
| --- | --- | --- |
| id | text | PK |
| postId | text | FK → Post, `onDelete: Cascade` |
| socialAccountId | text | FK → SocialAccount, `onDelete: Restrict` |
| caption | text | platform-specific override; falls back to base on write |
| status | `TargetStatus` | `PENDING` \| `QUEUED` \| `PUBLISHING` \| `PUBLISHED` \| `FAILED_RETRYABLE` \| `FAILED_PERMANENT` \| `UNKNOWN` \| `SKIPPED` \| `CANCELLED` |
| attemptCount | int | default 0 |
| platformPostId | text? | id returned by the platform |
| platformPostUrl | text? | permalink when derivable |
| lastErrorCode | text? | normalised |
| lastErrorMessage | text? | human-readable, no secrets |
| publishedAt | timestamptz? | |
| createdAt / updatedAt | timestamptz | |

Indexes: `unique(postId, socialAccountId)` (one target per account per post),
`index(status)`, `index(socialAccountId)`.

### PostMedia

Join table so media order is explicit and one asset can be reused across posts.

| Column | Type | Notes |
| --- | --- | --- |
| postId | text | FK → Post, Cascade |
| mediaAssetId | text | FK → MediaAsset, Restrict |
| position | int | carousel order |

PK: `(postId, mediaAssetId)`. Index: `index(postId, position)`.

### MediaAsset

| Column | Type | Notes |
| --- | --- | --- |
| id | text | PK |
| clientId | text | FK → Client, Restrict — prevents cross-client reuse |
| uploadedById | text | FK → User |
| kind | `MediaKind` | `IMAGE` \| `VIDEO` |
| mimeType | text | sniffed, not trusted from client |
| byteSize | int | |
| width / height | int? | |
| durationSeconds | float? | video |
| storageKey | text | private object key |
| publicUrl | text? | public projection for Meta/IG, null until published |
| contentHash | text | sha256, for dedupe and immutable public naming |
| createdAt | timestamptz | |

Indexes: `index(clientId)`, `index(contentHash)`.

### ScheduledJob

| Column | Type | Notes |
| --- | --- | --- |
| id | text | PK |
| postTargetId | text | FK → PostTarget, Cascade |
| jobId | text | **unique** — the BullMQ job id |
| runAt | timestamptz | intended fire time |
| state | `JobState` | `PENDING` \| `ACTIVE` \| `COMPLETED` \| `FAILED` \| `DELAYED` \| `CANCELLED` |
| attempts | int | |
| createdAt / updatedAt | timestamptz | |

Indexes: `unique(jobId)`, `index(runAt, state)` for the reconciler.

### PublishingAttempt

| Column | Type | Notes |
| --- | --- | --- |
| id | text | PK |
| postTargetId | text | FK → PostTarget, Cascade |
| attemptNo | int | **unique with postTargetId** |
| startedAt | timestamptz | |
| finishedAt | timestamptz? | |
| outcome | `AttemptOutcome` | `SUCCESS` \| `RETRYABLE_FAILURE` \| `PERMANENT_FAILURE` \| `UNKNOWN` \| `IN_PROGRESS` |
| httpStatus | int? | |
| platformErrorCode | text? | |
| platformErrorMessage | text? | |
| requestId | text | correlates with logs |
| durationMs | int? | |

Indexes: `unique(postTargetId, attemptNo)`, `index(startedAt)`.

### AuditLog

| Column | Type | Notes |
| --- | --- | --- |
| id | text | PK |
| actorId | text? | FK → User, `onDelete: SetNull` (keep the log if a user is deleted) |
| action | `AuditAction` | `CLIENT_CREATED`, `ACCOUNT_CONNECTED`, `ACCOUNT_DISCONNECTED`, `POST_CREATED`, `POST_SCHEDULED`, `POST_PUBLISHED`, `POST_RETRY`, `POST_CANCELLED`, `USER_CREATED`, `ROLE_CHANGED`, … |
| entityType | text | `Client` \| `Post` \| `SocialAccount` \| `User` |
| entityId | text | |
| clientId | text? | denormalised for fast per-client filtering |
| metadata | jsonb | before/after, **redacted** — never tokens |
| ipHash | text? | |
| createdAt | timestamptz | |

Indexes: `index(clientId, createdAt)`, `index(entityType, entityId)`, `index(createdAt)`.

## 4. Constraints that prevent real bugs

| Constraint | Bug it prevents |
| --- | --- |
| `unique(platform, externalId)` on SocialAccount | Same page connected twice → double posting |
| `unique(postId, socialAccountId)` on PostTarget | Same post queued twice to one account |
| `unique(postTargetId, attemptNo)` | Two workers writing the same attempt |
| `unique(jobId)` on ScheduledJob | Orphaned/mismatched queue entries |
| `onDelete: Restrict` on Client→Post, Client→SocialAccount | Accidental cascade deleting a client's history |
| `onDelete: Cascade` on PostTarget→Attempt | Orphan attempt rows |
| `MediaAsset.clientId` FK | Media leaking between clients |

## 5. Migrations

```bash
pnpm prisma migrate dev --name init
pnpm prisma migrate deploy     # production
```

`prisma migrate reset` must remain idempotent and is used by tests. No destructive migration ships
without a backup step documented in `docs/DEPLOYMENT.md`.
