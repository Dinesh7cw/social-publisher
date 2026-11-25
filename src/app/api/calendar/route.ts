import { NextResponse } from "next/server";

import { route, invalid } from "@/server/http";
import { requireUser } from "@/server/auth/guards";
import { prisma } from "@/server/db";

const MAX_RANGE_DAYS = 62;

/**
 * Calendar data, bucketed in the viewer's time zone.
 *
 * Bucketing happens on the server from the stored IANA zone so two team members
 * in different zones see the same post on the day it actually publishes for the
 * client, not the day it happens to fall on for them.
 */
export const GET = route(async (request: Request) => {
  await requireUser();

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const timeZone = url.searchParams.get("timeZone") ?? "Asia/Kolkata";
  const clientId = url.searchParams.get("clientId");
  const platform = url.searchParams.get("platform");
  const status = url.searchParams.get("status");

  if (!from || !to) throw invalid("A from and to date are required.");

  const start = new Date(from);
  const end = new Date(to);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw invalid("Those dates could not be read.");
  }
  if (end <= start) throw invalid("The end date must be after the start date.");

  const days = Math.ceil((end.getTime() - start.getTime()) / 86_400_000);
  if (days > MAX_RANGE_DAYS) {
    throw invalid(`Choose a range of ${MAX_RANGE_DAYS} days or fewer.`);
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw invalid("That time zone is not recognised.");
  }

  const posts = await prisma.post.findMany({
    where: {
      deletedAt: null,
      OR: [
        { scheduledAt: { gte: start, lt: end } },
        // Published posts are keyed off publishedAt so the calendar shows when
        // they actually went out, not when they were drafted.
        { publishedAt: { gte: start, lt: end } },
      ],
      ...(clientId ? { clientId } : {}),
      ...(status && status !== "ALL" ? { status: status as never } : {}),
      ...(platform && platform !== "ALL"
        ? { targets: { some: { socialAccount: { platform: platform as never } } } }
        : {}),
    },
    orderBy: [{ scheduledAt: "asc" }, { publishedAt: "asc" }],
    include: {
      client: { select: { id: true, name: true } },
      targets: {
        select: {
          status: true,
          socialAccount: { select: { platform: true, displayName: true } },
        },
      },
    },
  });

  // Bucket by local date.
  const buckets = new Map<string, unknown[]>();

  for (const post of posts) {
    const instant = post.scheduledAt ?? post.publishedAt ?? post.createdAt;
    const localDate = formatter.format(instant); // en-CA yields YYYY-MM-DD

    const entry = {
      id: post.id,
      clientId: post.clientId,
      clientName: post.client.name,
      status: post.status,
      baseCaption: post.baseCaption,
      scheduledAt: post.scheduledAt?.toISOString() ?? null,
      publishedAt: post.publishedAt?.toISOString() ?? null,
      timeZone,
      targets: post.targets.map((t) => ({
        status: t.status,
        platform: t.socialAccount.platform,
        accountName: t.socialAccount.displayName,
      })),
    };

    const list = buckets.get(localDate) ?? [];
    list.push(entry);
    buckets.set(localDate, list);
  }

  return NextResponse.json({
    timeZone,
    days: [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, items]) => ({ date, posts: items })),
  });
});
