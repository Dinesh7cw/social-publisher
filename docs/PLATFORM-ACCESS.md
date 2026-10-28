# Platform access and approval checklist

Verified against vendor documentation on **2026-10-28**. Re-verify before go-live; these pages change.

> **Read this first.** Nothing in this document is an approval. It is the list of things a human must
> do, in order, before a platform can publish for real. Until each box is ticked, the corresponding
> adapter runs with its feature flag **off**.

---

## Status at a glance

| Platform | Adapter built | Credentials | App review | Enabled |
| --- | --- | --- | --- | --- |
| Facebook Pages | ✅ | ❌ none in this environment | ❌ | `FACEBOOK_ENABLED=false` |
| Instagram (professional) | ✅ | ❌ none in this environment | ❌ | `INSTAGRAM_ENABLED=false` |
| LinkedIn (organization) | ✅ | ❌ none in this environment | ❌ Community Management API approval required | `LINKEDIN_ENABLED=false` |
| LinkedIn (member) | ✅ | ❌ | partially self-serve | `LINKEDIN_ENABLED=false` |
| X | ✅ | ❌ none in this environment | account-level | `X_ENABLED=false` |

"No credentials" means exactly that: no Meta app, no LinkedIn app, no X developer account exists for
this build. Every adapter is exercised against recorded fixtures only. **No live post has been made
by this codebase.**

---

## 1. Meta — Facebook Pages

### What you need
- A Meta Business Portfolio that owns the client Pages.
- A Meta app (type: **Business**) at <https://developers.facebook.com/apps>.
- Your own Facebook account added to the app as Admin/Tester during development.

### Permissions to request
| Permission | Why | Review |
| --- | --- | --- |
| `pages_show_list` | list Pages the user manages | App Review |
| `pages_read_engagement` | read Page metadata | App Review |
| `pages_manage_posts` | create Page posts | App Review |
| `pages_manage_engagement` | per Meta's posts guide | App Review |
| `publish_video` | only if Page video posts are in scope | App Review |
| `business_management` | if you resolve Pages through a Business Portfolio | App Review |

The authenticated user must hold `CREATE_CONTENT`, `MANAGE`, `MODERATE` on each Page.

### Steps
1. Create the app, add the **Facebook Login for Business** product.
2. Add Valid OAuth Redirect URIs: `https://<your-host>/api/accounts/facebook/callback` and the
   `http://localhost:3010/...` dev equivalent.
3. Add the permissions above under App Review → Permissions and Features.
4. Record a screencast showing: login, selecting a Page, composing a post, the post appearing on the
   Page. Meta rejects vague submissions.
5. Submit for App Review. Until approved, only users with a role on the app can authorize it.
6. Put the App ID / App Secret in `.env` as `META_APP_ID` / `META_APP_SECRET`.
7. Exchange short-lived user tokens for long-lived ones (60-day) and store **Page** access tokens —
   Page tokens derived from a long-lived user token do not expire, which is what the scheduler needs.

### Constraints that shape the code
- Graph API **v26.0**.
- Photos require a **publicly fetchable URL**; Meta fetches the media itself.
- Native scheduling exists (10 min – 30 days) but this app does **not** use it — our queue owns
  scheduling so all platforms behave identically.

---

## 2. Instagram — professional accounts

### Choose the configuration once
| | Instagram API with Facebook Login | Instagram API with Instagram Login |
| --- | --- | --- |
| Host | `graph.facebook.com` | `graph.instagram.com` |
| Token | Facebook Page token | Instagram User token |
| Page required | Yes | No |
| Permissions | `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` | `instagram_business_basic`, `instagram_business_content_publish` |
| Product tagging / hashtag search | ✅ | ❌ |

**This build targets Facebook Login**, because the Meta app and OAuth round-trip are already required
for Pages, and one consent screen for both platforms is less friction for the team. If CW ever needs
Instagram accounts with no Facebook Page, switch to Instagram Login — the adapter is isolated for
exactly that reason.

### Requirements
- Instagram **Business or Creator** account (consumer accounts are unreachable by the API).
- The IG account must be linked to a Facebook Page the user administers.
- **Page Publishing Authorization (PPA)** may be required on the Page. The app cannot detect PPA, so
  the team must complete it proactively in Page Settings. If PPA is pending, publishing fails with an
  opaque error — this is documented in `docs/OPERATIONS.md` troubleshooting.
- **JPEG only** for images. PNG sources are transcoded server-side before upload.
- Carousels: up to 20 items; carousels count as one post against the rate limit.
- Rate limit: **100 API-published posts per rolling 24 h**, enforced at `media_publish`. The adapter
  calls `GET /{ig-id}/content_publishing_limit` before publishing and fails fast with a clear message
  instead of burning a retry.

### Steps
1. Complete the Meta app setup from §1.
2. Add `instagram_basic` and `instagram_content_publish`.
3. Ensure each client's IG account is professional and Page-linked.
4. Have the client confirm PPA is complete.
5. Submit the same App Review package, with an Instagram publishing screencast.

---

## 3. LinkedIn

### Two capabilities, two levels of difficulty

| | Member posts | Organization posts |
| --- | --- | --- |
| Permission | `w_member_social` | `w_organization_social` |
| API product | Sign In with LinkedIn / Share on LinkedIn | **Community Management API** |
| Access | largely self-serve | **manual approval required** |
| Author URN | `urn:li:person:{id}` | `urn:li:organization:{id}` |

### Why organization posting is a real blocker
The Community Management API is **not self-serve**. CW must:
1. Create a LinkedIn app at <https://developer.linkedin.com>.
2. Add the Community Management API product and complete the access form.
3. Supply: business email, legal name, registered address, website, privacy policy, exact use case,
   test credentials, and a screencast demonstrating each use case.
4. Wait for manual review — third-party reports put this at **1–4 weeks**, sometimes months.

**Until that is approved, organization publishing cannot legally or technically work.** The feature
flag stays off and the UI says so. This is documented rather than worked around.

### Technical requirements
- `POST https://api.linkedin.com/rest/posts`
- Headers: `Linkedin-Version: YYYYMM`, `X-Restli-Protocol-Version: 2.0.0`, `Authorization: Bearer …`
- Success is **HTTP 201** with the post id in the **`x-restli-id` response header**.
- Images must first be registered via the Images API to get `urn:li:image:{id}`.
- For organization posting, the authorizing member needs a page role — `ADMINISTRATOR` or one of the
  content-posting roles — on that organization.

### Steps
1. Create the app, add **Sign In with LinkedIn using OpenID Connect** (for member identity).
2. Request **Community Management API** and wait for approval.
3. Add redirect URL `https://<host>/api/accounts/linkedin/callback`.
4. Set `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`.
5. After approval, set `LINKEDIN_ENABLED=true` and connect each client's organization page.
6. Pin `LINKEDIN_VERSION` to a version no older than ~12 months; LinkedIn sunsets versions on a
   rolling schedule.

---

## 4. X (Twitter)

### Requirements
- An X developer account at <https://developer.x.com> with a project and an app.
- **OAuth 2.0 Authorization Code with PKCE**, app type "Web App / Automated App or Bot".
- Scopes: `tweet.read tweet.write users.read media.write offline.access`.

### Why `offline.access` is mandatory
X access tokens last about **2 hours**. A scheduler that stores a token at connect time and publishes
six hours later will fail every time. `offline.access` is the only way to receive a refresh token, so
the adapter requests it unconditionally and stores the refresh token encrypted.

### Cost
X moved to **pay-per-use credits** (no Free/Basic/Pro tiers as of 2026):

| Operation | Price |
| --- | --- |
| Create post | ~$0.015 |
| **Create post containing a URL** | **~$0.20** |
| Delete post | ~$0.010 |

A post with a link costs ~13× a plain post. The composer warns when a URL is present. Reconcile spend
monthly against the developer portal; every X publish is recorded in `PublishingAttempt` so the
numbers are auditable.

### Steps
1. Create the project and app; note Client ID and Client Secret.
2. Set the callback to `https://<host>/api/accounts/x/callback`.
3. Confirm the app has write access and that credits are funded.
4. Set `X_CLIENT_ID` / `X_CLIENT_SECRET`, then `X_ENABLED=true`.

### Limitations to accept
- 280 characters on the standard endpoint (URLs count as a fixed 23 characters).
- Media upload is a separate v2 endpoint; up to 4 images per post.
- Some accounts are subject to additional anti-spam review before write access is granted.

---

## 5. Credentials checklist (copy into your secrets manager)

```
META_APP_ID=
META_APP_SECRET=
META_GRAPH_VERSION=v26.0
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_VERSION=202601
X_CLIENT_ID=
X_CLIENT_SECRET=
TOKEN_ENCRYPTION_KEY=        # openssl rand -base64 32
SESSION_SECRET=              # openssl rand -base64 32
```

**Never commit these.** `.env` is gitignored; `.env.example` holds placeholders only.

---

## 6. What "verified" will mean

A platform integration is declared verified only when, with real credentials:

1. OAuth completes and the account row shows `CONNECTED` with a real `tokenExpiresAt`.
2. A text post publishes and the platform post id in `PostTarget.platformPostId` resolves to a real,
   publicly visible post.
3. A post with media publishes the same way.
4. A deliberately invalid post (over-length caption / disallowed media) is rejected **before**
   enqueueing.
5. A revoked token produces `NEEDS_RECONNECT` and a clear message, not a crash.
6. The result is recorded in `docs/TEST-REPORT.md` with the platform post URL.

Until all six hold for a platform, the UI marks it "Not verified" and the flag stays off.
