# Operations runbook

Day-to-day operation of CW Social Publisher. Written for the team who runs it, not for the person who
built it.

---

## 1. Connecting a social account

1. Go to **Social accounts**.
2. If the platform reads **Needs credentials from an admin**, its app credentials are not configured on
   this deployment. See `docs/PLATFORM-ACCESS.md`; nothing can be connected until they are.
3. Otherwise, choose the platform, sign in at the platform, and pick which of the discovered accounts
   belong to which client.

**One account belongs to exactly one client.** The database enforces this. If you see "already
connected to a different client", disconnect it there first. This is deliberate: the same page being
attached to two clients is how the wrong brand gets posted to.

**Why the account picker exists.** Meta returns every Page you administer, and LinkedIn returns your
profile plus every organisation you administer. The picker is where the team decides which of those
belong to CW's clients, rather than connecting everything and sorting it out later.

---

## 2. Publishing a post

1. **Create post** → choose the client.
2. Write the caption. As you select accounts, each platform's remaining characters appear above the
   caption box.
3. Optionally override the caption per platform. A blank override uses the main caption.
4. Choose **Save draft**, **Schedule**, or **Publish now**.

Before anything is queued, the server validates every target. If one platform cannot publish, the post
is **not** enqueued for any of them, and the draft is kept. This is deliberate: a half-published batch
is worse than a blocked one.

### Platform limits worth knowing

| Platform | Characters | Media | Notes |
| --- | --- | --- | --- |
| Facebook Page | 63,206 | optional | Links get a preview card |
| Instagram | 2,200 | **required** | JPEG only; 100 posts per 24 h |
| LinkedIn | 3,000 | optional | Org posting needs approved API access |
| X | 280 | optional | **Links count as 23 characters**; a post with a URL costs more |

---

## 3. When something fails

Open **Publishing history**. Each account has its own row, so you can see exactly which platform failed
and why.

### Reading the status

| Status | Meaning | What to do |
| --- | --- | --- |
| **Published** | The platform confirmed it and returned an id | Nothing |
| **Failed — retrying** | A temporary problem; a retry is scheduled with backoff | Wait |
| **Failed** | A permanent problem: content, permission, or account | Fix the cause, then Retry |
| **Needs checking** | **Ambiguous.** The connection dropped after sending; the post may exist | **Look at the account before retrying** |
| **Needs reconnecting** | The token expired or was revoked | Reconnect the account |

### The "Needs checking" case

This is the one to be careful with. The request was sent, but we never found out whether the platform
accepted it. If you retry without checking, the audience may see the post twice.

1. Open the account in the platform's own app or website.
2. If the post is there, do not retry. The history row is accurate enough.
3. If it is not there, click **Retry** and confirm you checked.

The system deliberately does not retry this case automatically.

### Common failures

| Message | Cause | Fix |
| --- | --- | --- |
| "The platform refused this post for this account" | Missing permission on the connected account | Check the account still has the right role (page admin, org admin), then reconnect |
| "The account's authorisation has expired" | Token expired or was revoked | Reconnect the account |
| "This Instagram account has hit its 24-hour publishing limit" | 100 posts in 24 h | Wait; the limit rolls |
| "Instagram cannot publish a text-only post" | No media attached | Attach an image |
| "This caption is N characters" | Over the platform limit | Shorten, or set a shorter per-platform caption |
| "The platform is rate limiting us" | Too many calls | Retries automatically with backoff |

---

## 4. Scheduling and time zones

- All times are stored in UTC and displayed in the viewer's time zone.
- A scheduled post keeps the time zone it was scheduled in, so a daylight-saving change does not move
  it by an hour.
- Jobs live in Redis with AOF persistence, so they survive a restart of the app, the worker, or the
  whole server.
- A **reconciler** runs when the worker starts and every 5 minutes. If a post should have gone out but
  has no live job (for example because Redis was flushed), it is re-queued. You do not need to fix this
  by hand.

### Cancelling or rescheduling

Open **Content calendar**, find the post, and cancel it. Cancelling removes the queued job and settles
the targets. Anything already published stays live; the post becomes **Partly published** if some
targets went out and others did not.

---

## 5. Team management

Admins can add members, change roles, and deactivate accounts in **Team settings**.

- **Changing a role or deactivating someone ends their sessions immediately.** They must sign in again
  for the change to take effect, and a deactivated person cannot sign in at all.
- **You cannot remove your own admin access**, and the system refuses to leave the team with zero
  active admins.
- Passwords are hashed with argon2id. Nobody, including an admin, can read an existing password. If
  someone forgets theirs, reset it via the script in §8.

### Roles

| Action | Team member | Admin |
| --- | --- | --- |
| Create, schedule, publish posts | ✅ | ✅ |
| Retry failed posts | ✅ | ✅ |
| Connect a social account | ✅ | ✅ |
| Disconnect an account | ❌ | ✅ |
| Create or archive clients | ❌ | ✅ |
| Manage the team | ❌ | ✅ |
| View the audit log | ❌ | ✅ |

---

## 6. Tokens and reconnecting

- OAuth tokens are encrypted at rest (AES-256-GCM) and are **never** sent to a browser or written to a
  log.
- Expiry is shown on the **Social accounts** screen. A token close to expiry is marked as a warning.
- Some tokens never expire (Facebook Page tokens derived from a long-lived user token) and show
  "Does not expire".
- X tokens last about 2 hours but are refreshed automatically before publishing, provided the
  connection was made with `offline.access`.

### If every account suddenly needs reconnecting

This almost always means `TOKEN_ENCRYPTION_KEY` changed. Restoring the previous key recovers every
account without reconnecting. See `docs/DEPLOYMENT.md` §10.

---

## 7. Audit log

Every sign-in attempt, client change, account connection, publish, retry and cancellation is recorded
with actor, action, entity, timestamp and a redacted before/after pair.

Query it directly when investigating:

```sql
-- What happened to one client in the last week
SELECT "createdAt", action, "entityType", "entityId", metadata
FROM "AuditLog"
WHERE "clientId" = '<client-id>'
  AND "createdAt" > now() - interval '7 days'
ORDER BY "createdAt" DESC;

-- Every publish attempt for one target
SELECT "attemptNo", outcome, "httpStatus", "platformErrorMessage", "requestId", "durationMs"
FROM "PublishingAttempt"
WHERE "postTargetId" = '<target-id>'
ORDER BY "attemptNo";
```

Audit metadata is redacted at write time, so it can be shared when investigating without leaking
credentials.

---

## 8. Administrative scripts

Run these from the project root. They refuse to run against production where that would be dangerous.

```bash
# Create/reset the seeded admin and ensure the two seed clients (dev only)
pnpm tsx scripts/reset-dev-admin.ts

# Verify the seeded admin's password actually works
pnpm tsx scripts/verify-admin.ts

# Remove artefacts left by the end-to-end suite (dev only)
pnpm tsx scripts/clean-e2e-data.ts

# Which database is this shell pointed at?
pnpm tsx scripts/which-db.ts
```

**Always run `which-db.ts` first** if something looks wrong. A leaked `DATABASE_URL` in a shell once
pointed a dev server at the test database, which produced a "wrong password" that was really a
truncated table. The app now warns at startup when this happens, but the script gives a definitive
answer.

---

## 9. Routine checks

| Frequency | Check |
| --- | --- |
| Daily | `/api/health` returns `ok`; no posts stuck in **Failed** |
| Weekly | Any account marked **Needs reconnecting**; X credit balance |
| Monthly | Postgres backup restores cleanly; disk usage; review the audit log for unexpected admin changes |
| Per platform change | Re-read `docs/PLATFORM-ACCESS.md` — vendor APIs and limits change |

---

## 10. Escalation

If publishing fails for a client and the cause is not in the table in §3:

1. Find the `requestId` on the failing attempt (`GET /api/targets/<id>/attempts`).
2. Grep the worker logs for it: `docker compose logs worker | grep <requestId>`.
3. The log line carries the platform, HTTP status and normalised error code. That is the platform's own
   answer, and it is the most reliable evidence available.

If the platform is rejecting requests that used to work, check the vendor's changelog first. All four
APIs version their endpoints and retire old versions on a schedule.
