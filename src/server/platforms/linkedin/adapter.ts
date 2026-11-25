/**
 * LinkedIn adapter.
 *
 * Verified 2026-10-28 against the Posts API documentation.
 *
 * The two details most implementations get wrong, both handled here:
 *   1. Success is HTTP 201 and the post id is in the **`x-restli-id` response
 *      header**, not the JSON body. Reading `body.id` silently yields undefined.
 *   2. Two required headers: `Linkedin-Version: YYYYMM` and
 *      `X-Restli-Protocol-Version: 2.0.0`. Omitting either returns a 400 that
 *      looks like a malformed request.
 *
 * Access reality: organization posting needs `w_organization_social`, which
 * requires the Community Management API product to be manually approved by
 * LinkedIn. Member posting (`w_member_social`) is far easier. This adapter
 * supports both and lets the account's type decide the author URN — it does not
 * pretend an unapproved app can post to an organization.
 */

import { env } from "@/lib/env";
import {
  PlatformError,
  type AppCredentials,
  type CommentRequest,
  type DeletePublishedRequest,
  type DeleteResult,
  type PlatformAdapter,
  type PublishRequest,
  type PublishResult,
  type TokenSet,
  type DiscoveredAccount,
  type ValidationInput,
  type ValidationResult,
  type RefreshResult,
} from "../types";
import { CAPABILITIES } from "../capabilities";
import { platformRequest, withQuery } from "../http";
import { resultFromIssues, validateCommon } from "../validation";

const OAUTH_AUTHORIZE = "https://www.linkedin.com/oauth/v2/authorization";
const OAUTH_TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";
const API_BASE = "https://api.linkedin.com/rest";

function headers(): Record<string, string> {
  return {
    // Both are mandatory on every /rest call.
    "Linkedin-Version": env().LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };
}

export class LinkedInAdapter implements PlatformAdapter {
  readonly platform = "LINKEDIN" as const;
  readonly capabilities = CAPABILITIES.LINKEDIN!;

  validate(input: ValidationInput): ValidationResult {
    return resultFromIssues("LINKEDIN", validateCommon("LINKEDIN", input), input.caption);
  }

  buildAuthorizeUrl(params: {
    state: string;
    redirectUri: string;
    codeChallenge?: string;
    credentials: AppCredentials;
  }): string {
    // openid+profile gives us the member id needed to build urn:li:person:{id}.
    // w_member_social covers personal posts; w_organization_social is requested
    // too and simply ignored by LinkedIn if the app has not been approved for it.
    const scopes = ["openid", "profile", "w_member_social", "w_organization_social"];

    return withQuery(OAUTH_AUTHORIZE, {
      response_type: "code",
      client_id: params.credentials.appId,
      redirect_uri: params.redirectUri,
      state: params.state,
      scope: scopes.join(" "),
    });
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
    credentials: AppCredentials;
  }): Promise<{ ok: true; tokens: TokenSet } | { ok: false; error: PlatformError }> {
    try {
      const response = await platformRequest({
        platform: "LINKEDIN",
        url: OAUTH_TOKEN,
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: params.code,
          redirect_uri: params.redirectUri,
          client_id: params.credentials.appId,
          client_secret: params.credentials.appSecret,
        }),
        requestId: "oauth-exchange-li",
      });

      const body = response.json as {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
        refresh_token_expires_in?: number;
        scope?: string;
      };

      if (!body?.access_token) {
        return {
          ok: false,
          error: new PlatformError({
            platform: "LINKEDIN",
            errorClass: "permanent",
            code: "NO_TOKEN",
            message: "LinkedIn did not return an access token.",
            userMessage: "LinkedIn did not return an access token. Try connecting again.",
          }),
        };
      }

      return {
        ok: true,
        tokens: {
          accessToken: body.access_token,
          refreshToken: body.refresh_token ?? null,
          expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
          scopes: body.scope ? body.scope.split(/[ ,]/).filter(Boolean) : undefined,
          tokenType: "Bearer",
        },
      };
    } catch (error) {
      return { ok: false, error: asLinkedInError(error) };
    }
  }

  async refresh(refreshToken: string, credentials: AppCredentials): Promise<RefreshResult> {
    try {
      const response = await platformRequest({
        platform: "LINKEDIN",
        url: OAUTH_TOKEN,
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: credentials.appId,
          client_secret: credentials.appSecret,
        }),
        requestId: "oauth-refresh-li",
      });

      const body = response.json as {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
        scope?: string;
      };

      if (!body?.access_token) {
        return {
          ok: false,
          requiresReconnect: true,
          error: new PlatformError({
            platform: "LINKEDIN",
            errorClass: "auth",
            code: "REFRESH_FAILED",
            message: "LinkedIn did not return a refreshed token.",
            userMessage: "LinkedIn needs to be reconnected.",
          }),
        };
      }

      return {
        ok: true,
        tokens: {
          accessToken: body.access_token,
          refreshToken: body.refresh_token ?? refreshToken,
          expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
          scopes: body.scope ? body.scope.split(/[ ,]/).filter(Boolean) : undefined,
        },
      };
    } catch (error) {
      const platformError = asLinkedInError(error);
      return {
        ok: false,
        requiresReconnect: platformError.errorClass === "auth" || platformError.httpStatus === 400,
        error: platformError,
      };
    }
  }

  /**
   * Discover the member and any organizations they administer.
   *
   * Organization discovery needs `r_organization_admin`-class access, which is
   * part of the Community Management API. When that is not approved the call
   * fails; we degrade to returning just the member rather than failing the whole
   * connect, because member posting still works.
   */
  async listAccounts(
    tokens: TokenSet,
  ): Promise<{ ok: true; accounts: DiscoveredAccount[] } | { ok: false; error: PlatformError }> {
    const accounts: DiscoveredAccount[] = [];

    // --- The member -------------------------------------------------------
    try {
      const me = await platformRequest({
        platform: "LINKEDIN",
        url: "https://api.linkedin.com/v2/userinfo",
        accessToken: tokens.accessToken,
        requestId: "li-userinfo",
      });

      const body = me.json as { sub?: string; name?: string; given_name?: string; family_name?: string; email?: string };
      if (body.sub) {
        const display =
          body.name ??
          [body.given_name, body.family_name].filter(Boolean).join(" ") ??
          body.email ??
          "LinkedIn member";

        accounts.push({
          externalId: body.sub,
          displayName: display,
          accountType: "MEMBER",
          accessToken: tokens.accessToken,
          tokenExpiresAt: tokens.expiresAt ?? null,
          scopes: tokens.scopes,
        });
      }
    } catch (error) {
      return { ok: false, error: asLinkedInError(error) };
    }

    // --- Organizations ----------------------------------------------------
    // Failure here is expected until the Community Management API is approved,
    // so it must not abort the connect flow.
    try {
      const orgs = await platformRequest({
        platform: "LINKEDIN",
        url: withQuery("https://api.linkedin.com/v2/organizationAcls", {
          q: "roleAssignee",
          role: "ADMINISTRATOR",
          state: "APPROVED",
        }),
        accessToken: tokens.accessToken,
        headers: headers(),
        requestId: "li-orgs",
      });

      const body = orgs.json as {
        elements?: Array<{ organization?: string; "organization~"?: { localizedName?: string } }>;
      };

      for (const element of body.elements ?? []) {
        // `organization` is a URN: urn:li:organization:12345
        const urn = element.organization;
        if (!urn) continue;

        const id = urn.split(":").pop();
        if (!id) continue;

        accounts.push({
          externalId: id,
          displayName: element["organization~"]?.localizedName ?? `Organization ${id}`,
          accountType: "ORGANIZATION",
          accessToken: tokens.accessToken,
          tokenExpiresAt: tokens.expiresAt ?? null,
          scopes: tokens.scopes,
        });
      }
    } catch {
      // Not approved for organization access, or no admin roles. Member posting
      // is still available, so this is not a connect failure.
    }

    return { ok: true, accounts };
  }

  async verify(
    accessToken: string,
    _externalId: string,
  ): Promise<{ ok: boolean; scopes?: string[]; expiresAt?: Date | null; error?: PlatformError }> {
    try {
      await platformRequest({
        platform: "LINKEDIN",
        url: "https://api.linkedin.com/v2/userinfo",
        accessToken,
        requestId: "verify-li",
      });
      return { ok: true, expiresAt: null };
    } catch (error) {
      return { ok: false, error: asLinkedInError(error) };
    }
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    // The author URN depends on what kind of account was connected.
    const author =
      request.accountType === "ORGANIZATION"
        ? `urn:li:organization:${request.externalId}`
        : `urn:li:person:${request.externalId}`;

    try {
      const images = request.media.filter((m) => m.kind === "IMAGE");
      const videos = request.media.filter((m) => m.kind === "VIDEO");

      if (videos.length > 0) {
        throw new PlatformError({
          platform: "LINKEDIN",
          errorClass: "permanent",
          code: "VIDEO_NOT_ENABLED",
          message: "LinkedIn video publishing is not enabled in this build.",
          userMessage:
            "LinkedIn video posts are not enabled yet. Publish an image or text post instead.",
        });
      }

      // --- Upload images first, to get urn:li:image:{id} for each ----------
      const imageUrns: string[] = [];
      for (const image of images) {
        // LinkedIn does not fetch public URLs the way Meta does, so the bytes are
        // read from our public projection and PUT to LinkedIn's upload URL.
        const urn = await this.uploadImage(request, image.publicUrl);
        imageUrns.push(urn);
      }

      // --- Create the post -------------------------------------------------
      const body: Record<string, unknown> = {
        author,
        commentary: request.caption,
        visibility: request.options?.visibility ?? "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      };

      if (imageUrns.length === 1) {
        body.content = { media: { id: imageUrns[0] } };
      } else if (imageUrns.length > 1) {
        body.content = {
          multiImage: {
            images: imageUrns.map((urn) => ({ id: urn, altText: "" })),
          },
        };
      }

      const response = await platformRequest({
        platform: "LINKEDIN",
        url: `${API_BASE}/posts`,
        method: "POST",
        accessToken: request.accessToken,
        headers: headers(),
        body,
        requestId: request.requestId,
        isPublish: true,
        signal: request.signal,
      });

      // The id arrives in a response header, not the body. This is the detail
      // that silently breaks naive implementations.
      const postUrn =
        response.headers.get("x-restli-id") ??
        response.headers.get("X-Restli-Id") ??
        (response.json as { id?: string } | null)?.id;

      if (!postUrn) {
        throw new PlatformError({
          platform: "LINKEDIN",
          errorClass: "ambiguous",
          code: "NO_POST_URN",
          message: "LinkedIn returned 201 without an x-restli-id header.",
          userMessage:
            "LinkedIn did not confirm the post. Check the account before retrying.",
          httpStatus: response.status,
        });
      }

      // A share URN can be turned into a permalink; ugcPost URNs cannot be
      // resolved reliably without another call, so we only link when we can.
      const activityId = postUrn.split(":").pop();
      const url =
        postUrn.startsWith("urn:li:share:") && activityId
          ? `https://www.linkedin.com/feed/update/${postUrn}`
          : null;

      return {
        ok: true,
        platformPostId: postUrn,
        platformPostUrl: url,
      };
    } catch (error) {
      return { ok: false, error: asLinkedInError(error) };
    }
  }

  /**
   * Delete a published post.
   *
   * `DELETE /rest/posts/{urn}` returns 204 with no body. The URN must be
   * URL-encoded: an unencoded `urn:li:share:123` breaks path parsing.
   */
  async deletePublished(request: DeletePublishedRequest): Promise<DeleteResult> {
    try {
      await platformRequest({
        platform: "LINKEDIN",
        url: `${API_BASE}/posts/${encodeURIComponent(request.platformPostId)}`,
        method: "DELETE",
        accessToken: request.accessToken,
        headers: headers(),
        requestId: request.requestId,
        signal: request.signal,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: asLinkedInError(error) };
    }
  }

  /**
   * First comment on a post.
   *
   * Goes through the socialActions endpoint rather than the Posts API, and it
   * needs the actor URN as well as the post URN.
   */
  async commentOnPost(request: CommentRequest): Promise<{ ok: boolean; error?: PlatformError }> {
    const actor =
      request.accountType === "ORGANIZATION"
        ? `urn:li:organization:${request.externalId}`
        : `urn:li:person:${request.externalId}`;

    try {
      await platformRequest({
        platform: "LINKEDIN",
        url: `${API_BASE}/socialActions/${encodeURIComponent(request.platformPostId)}/comments`,
        method: "POST",
        accessToken: request.accessToken,
        headers: headers(),
        body: {
          actor,
          object: request.platformPostId,
          message: { text: request.body },
        },
        requestId: request.requestId,
        signal: request.signal,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: asLinkedInError(error) };
    }
  }

  /**
   * Register and upload an image, returning its urn.
   *
   * LinkedIn's Images API is a two-step handshake: initialise to get an upload
   * URL, then PUT the bytes. We stream from our private bucket because LinkedIn
   * does not fetch public URLs for images the way Meta does.
   */
  private async uploadImage(
    request: PublishRequest,
    publicUrl: string | null,
  ): Promise<string> {
    // Fetch the bytes. Prefer the public projection because it is already
    // reachable; fall back to reading from object storage.
    if (!publicUrl) {
      throw new PlatformError({
        platform: "LINKEDIN",
        errorClass: "permanent",
        code: "MEDIA_UNAVAILABLE",
        message: "Media has no readable location.",
        userMessage: "This image needs to be re-uploaded before it can go to LinkedIn.",
      });
    }

    const bytesResponse = await fetch(publicUrl);
    if (!bytesResponse.ok) {
      throw new PlatformError({
        platform: "LINKEDIN",
        errorClass: "transient",
        code: "MEDIA_FETCH_FAILED",
        message: `Could not read media from storage (${bytesResponse.status}).`,
        userMessage: "Could not read the attached image. It will be retried.",
      });
    }

    const bytes = Buffer.from(await bytesResponse.arrayBuffer());

    // Step 1: initialise the upload.
    const initResponse = await platformRequest({
      platform: "LINKEDIN",
      url: `${API_BASE}/images?action=initializeUpload`,
      method: "POST",
      accessToken: request.accessToken,
      headers: headers(),
      body: {
        initializeUploadRequest: {
          owner: request.accountType === "ORGANIZATION"
            ? `urn:li:organization:${request.externalId}`
            : `urn:li:person:${request.externalId}`,
        },
      },
      requestId: request.requestId,
      signal: request.signal,
    });

    const init = initResponse.json as {
      value?: { uploadUrl?: string; image?: string };
    };

    const uploadUrl = init.value?.uploadUrl;
    const imageUrn = init.value?.image;

    if (!uploadUrl || !imageUrn) {
      throw new PlatformError({
        platform: "LINKEDIN",
        errorClass: "transient",
        code: "UPLOAD_INIT_FAILED",
        message: "LinkedIn did not return an upload URL for the image.",
        userMessage: "LinkedIn did not accept the image. It will be retried.",
      });
    }

    // Step 2: PUT the bytes to the returned URL.
    const putResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${request.accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(bytes),
      signal: request.signal,
    });

    if (!putResponse.ok) {
      throw new PlatformError({
        platform: "LINKEDIN",
        errorClass: "transient",
        code: "UPLOAD_FAILED",
        message: `Image upload failed with status ${putResponse.status}.`,
        userMessage: "Uploading the image to LinkedIn failed. It will be retried.",
        httpStatus: putResponse.status,
      });
    }

    return imageUrn;
  }
}

function asLinkedInError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  return new PlatformError({
    platform: "LINKEDIN",
    errorClass: "permanent",
    code: "UNEXPECTED",
    message: error instanceof Error ? error.message : "Unknown error",
    userMessage: "Something unexpected happened while contacting LinkedIn.",
  });
}

export const linkedinAdapter = new LinkedInAdapter();
