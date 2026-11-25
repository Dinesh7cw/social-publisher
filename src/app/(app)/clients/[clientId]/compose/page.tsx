import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requirePageUser } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { capabilitiesFor } from "@/server/platforms/capabilities";
import { allPlatformStatuses } from "@/server/platforms/registry";
import { PLATFORMS, type PlatformId } from "@/lib/domain";
import {
  Composer,
  type ComposerAccount,
  type ComposerDraft,
  type PlatformRules,
} from "./composer";

export const metadata: Metadata = { title: "Create post" };
export const dynamic = "force-dynamic";

/**
 * Load a draft for the composer.
 *
 * Only drafts reopen here. A scheduled post already has queued jobs and a
 * published one is live, so editing either belongs to its own flow; returning
 * null makes the page 404 rather than silently starting a blank post.
 */
async function loadDraft(clientId: string, postId: string): Promise<ComposerDraft | null> {
  const post = await prisma.post.findFirst({
    where: { id: postId, clientId, deletedAt: null, status: "DRAFT" },
    select: {
      id: true,
      targets: {
        orderBy: { createdAt: "asc" },
        select: {
          socialAccountId: true,
          caption: true,
          platformOptions: true,
          socialAccount: { select: { platform: true } },
        },
      },
      media: {
        orderBy: { position: "asc" },
        select: {
          media: {
            select: {
              id: true,
              kind: true,
              mimeType: true,
              byteSize: true,
              width: true,
              height: true,
              publicUrl: true,
            },
          },
        },
      },
    },
  });

  if (!post) return null;

  const captions: ComposerDraft["captions"] = {};
  const options: ComposerDraft["options"] = {};

  // The composer holds one caption per platform; targets on the same platform
  // were written from that one box, so the first one speaks for all of them.
  for (const target of post.targets) {
    const platform = target.socialAccount.platform as PlatformId;
    if (captions[platform] === undefined) captions[platform] = target.caption;
    if (options[platform] === undefined && target.platformOptions) {
      const saved = target.platformOptions as Record<string, unknown>;
      options[platform] = Object.fromEntries(
        Object.entries(saved).filter(([, value]) => value !== null && value !== undefined),
      );
    }
  }

  return {
    id: post.id,
    selectedAccountIds: post.targets.map((target) => target.socialAccountId),
    captions,
    options,
    media: post.media.map(({ media }) => ({
      id: media.id,
      kind: media.kind as "IMAGE" | "VIDEO",
      mimeType: media.mimeType,
      byteSize: media.byteSize,
      width: media.width,
      height: media.height,
      publicUrl: media.publicUrl,
    })),
  };
}

export default async function ClientComposePage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ post?: string }>;
}) {
  const session = await requirePageUser();
  const { clientId } = await params;
  const { post: postId } = await searchParams;

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      status: true,
      accounts: {
        where: { status: { in: ["CONNECTED", "EXPIRED", "ERROR"] } },
        orderBy: { displayName: "asc" },
        select: {
          id: true,
          platform: true,
          displayName: true,
          accountType: true,
          status: true,
        },
      },
    },
  });

  if (!client) notFound();

  const draft = postId ? await loadDraft(client.id, postId) : undefined;
  if (draft === null) notFound();

  const availability = new Map((await allPlatformStatuses()).map((status) => [status.platform, status]));

  const rules: Record<string, PlatformRules> = Object.fromEntries(
    PLATFORMS.map((platform) => {
      const caps = capabilitiesFor(platform);
      const status = availability.get(platform);

      return [
        platform,
        {
          captionLimit: caps.captionLimit,
          requiresMedia: caps.requiresMedia,
          maxImages: caps.maxImages,
          maxVideos: caps.maxVideos,
          imageTypes: caps.supportedImageMimeTypes,
          videoTypes: caps.supportedVideoMimeTypes,
          linkAffectsCost: caps.linkAffectsCost,
          available: status?.available ?? false,
          unavailableMessage: status?.message ?? null,
        } satisfies PlatformRules,
      ];
    }),
  );

  const accounts: ComposerAccount[] = client.accounts.map((account) => ({
    id: account.id,
    platform: account.platform as PlatformId,
    displayName: account.displayName,
    accountType: account.accountType,
    status: account.status,
  }));

  return (
    <Composer
      // Remount when switching between drafts so state seeds from the new one.
      key={draft?.id ?? "new"}
      client={{ id: client.id, name: client.name }}
      accounts={accounts}
      rules={rules}
      defaultTimeZone={session.user.timeZone}
      draft={draft}
    />
  );
}
