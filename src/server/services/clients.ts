/**
 * Client service.
 *
 * Business rules live here rather than in route handlers so they can be unit
 * tested and reused (the worker also needs to validate client ownership).
 */

import { prisma } from "@/server/db";
import { ApiError, invalid, notFound } from "@/server/http";
import { recordAuditSafe } from "@/server/audit";
import type { ClientStatus } from "@/generated/prisma/enums";

export interface ClientSummary {
  id: string;
  name: string;
  slug: string;
  contactName: string | null;
  contactEmail: string | null;
  notes: string | null;
  status: ClientStatus;
  archivedAt: string | null;
  createdAt: string;
  counts: {
    accounts: number;
    drafts: number;
    scheduled: number;
    published: number;
    failed: number;
  };
}

/** Deterministic, collision-resistant slug. Appends a counter when needed. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return base.length > 0 ? base : "client";
}

async function uniqueSlug(desired: string, excludeId?: string): Promise<string> {
  let candidate = slugify(desired);
  let suffix = 1;

  // Bounded loop: 50 attempts is far beyond any realistic collision.
  for (let i = 0; i < 50; i += 1) {
    const existing = await prisma.client.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!existing || existing.id === excludeId) return candidate;
    suffix += 1;
    candidate = `${slugify(desired)}-${suffix}`;
  }

  // Fall back to a random suffix rather than looping forever.
  return `${slugify(desired)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function listClients(params: {
  query?: string | null;
  status?: ClientStatus | "ALL";
  cursor?: string | null;
  limit: number;
}): Promise<{ items: ClientSummary[]; nextCursor: string | null }> {
  const { query, status = "ACTIVE", cursor, limit } = params;

  const where = {
    ...(status === "ALL" ? {} : { status }),
    ...(query && query.trim().length > 0
      ? {
          OR: [
            { name: { contains: query.trim(), mode: "insensitive" as const } },
            { slug: { contains: query.trim(), mode: "insensitive" as const } },
            { contactName: { contains: query.trim(), mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const rows = await prisma.client.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: {
      _count: { select: { accounts: true } },
      posts: { where: { deletedAt: null }, select: { status: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const items = page.map((row) => {
    const counts = { accounts: row._count.accounts, drafts: 0, scheduled: 0, published: 0, failed: 0 };
    for (const post of row.posts) {
      switch (post.status) {
        case "DRAFT":
          counts.drafts += 1;
          break;
        case "SCHEDULED":
        case "PUBLISHING":
          counts.scheduled += 1;
          break;
        case "PUBLISHED":
          counts.published += 1;
          break;
        case "FAILED":
        case "PARTIAL":
          counts.failed += 1;
          break;
        default:
          break;
      }
    }

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      contactName: row.contactName,
      contactEmail: row.contactEmail,
      notes: row.notes,
      status: row.status,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      counts,
    };
  });

  return {
    items,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getClient(id: string): Promise<ClientSummary> {
  const row = await prisma.client.findUnique({
    where: { id },
    include: {
      _count: { select: { accounts: true } },
      posts: { where: { deletedAt: null }, select: { status: true, scheduledAt: true } },
    },
  });

  if (!row) throw notFound("Client not found.");

  const counts = { accounts: row._count.accounts, drafts: 0, scheduled: 0, published: 0, failed: 0 };
  for (const post of row.posts) {
    switch (post.status) {
      case "DRAFT":
        counts.drafts += 1;
        break;
      case "SCHEDULED":
      case "PUBLISHING":
        counts.scheduled += 1;
        break;
      case "PUBLISHED":
        counts.published += 1;
        break;
      case "FAILED":
      case "PARTIAL":
        counts.failed += 1;
        break;
      default:
        break;
    }
  }

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    notes: row.notes,
    status: row.status,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    counts,
  };
}

export async function createClient(params: {
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  notes?: string | null;
  actorId: string;
  ip?: string | null;
}): Promise<ClientSummary> {
  const name = params.name.trim();
  if (name.length < 2) throw invalid("Client name is too short.");
  if (name.length > 120) throw invalid("Client name is too long.");

  const slug = await uniqueSlug(name);

  const created = await prisma.client.create({
    data: {
      name,
      slug,
      contactName: params.contactName?.trim() || null,
      contactEmail: params.contactEmail?.trim().toLowerCase() || null,
      notes: params.notes?.trim() || null,
      createdById: params.actorId,
    },
  });

  await recordAuditSafe({
    actorId: params.actorId,
    action: "CLIENT_CREATED",
    entityType: "Client",
    entityId: created.id,
    clientId: created.id,
    metadata: { name: created.name, slug: created.slug },
    ip: params.ip,
  });

  return getClient(created.id);
}

export async function updateClient(params: {
  id: string;
  name?: string;
  contactName?: string | null;
  contactEmail?: string | null;
  notes?: string | null;
  actorId: string;
  ip?: string | null;
}): Promise<ClientSummary> {
  const existing = await prisma.client.findUnique({ where: { id: params.id } });
  if (!existing) throw notFound("Client not found.");

  const data: Record<string, unknown> = {};

  if (params.name !== undefined) {
    const name = params.name.trim();
    if (name.length < 2) throw invalid("Client name is too short.");
    if (name.length > 120) throw invalid("Client name is too long.");
    data.name = name;
    if (name !== existing.name) {
      data.slug = await uniqueSlug(name, existing.id);
    }
  }

  if (params.contactName !== undefined) data.contactName = params.contactName?.trim() || null;
  if (params.contactEmail !== undefined) {
    data.contactEmail = params.contactEmail?.trim().toLowerCase() || null;
  }
  if (params.notes !== undefined) data.notes = params.notes?.trim() || null;

  if (Object.keys(data).length === 0) return getClient(params.id);

  await prisma.client.update({ where: { id: params.id }, data });

  await recordAuditSafe({
    actorId: params.actorId,
    action: "CLIENT_UPDATED",
    entityType: "Client",
    entityId: params.id,
    clientId: params.id,
    metadata: {
      before: { name: existing.name, slug: existing.slug, status: existing.status },
      after: data,
    },
    ip: params.ip,
  });

  return getClient(params.id);
}

/**
 * Archive a client.
 *
 * Refused while the client has work in flight: archiving a client whose posts
 * are queued would let the worker publish for an archived client, or (if we
 * skipped them) silently drop a scheduled post the team believes is coming.
 */
export async function archiveClient(params: {
  id: string;
  actorId: string;
  ip?: string | null;
}): Promise<ClientSummary> {
  const client = await prisma.client.findUnique({ where: { id: params.id } });
  if (!client) throw notFound("Client not found.");

  if (client.status === "ARCHIVED") return getClient(params.id);

  const inFlight = await prisma.postTarget.count({
    where: {
      post: { clientId: params.id },
      status: { in: ["PENDING", "QUEUED", "PUBLISHING"] },
    },
  });

  if (inFlight > 0) {
    throw new ApiError(
      "CONFLICT",
      `This client has ${inFlight} post${inFlight === 1 ? "" : "s"} still scheduled or publishing. Cancel or wait for them before archiving.`,
    );
  }

  await prisma.client.update({
    where: { id: params.id },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });

  await recordAuditSafe({
    actorId: params.actorId,
    action: "CLIENT_ARCHIVED",
    entityType: "Client",
    entityId: params.id,
    clientId: params.id,
    metadata: { name: client.name },
    ip: params.ip,
  });

  return getClient(params.id);
}

/** Restore an archived client. Idempotent. */
export async function unarchiveClient(params: {
  id: string;
  actorId: string;
  ip?: string | null;
}): Promise<ClientSummary> {
  const client = await prisma.client.findUnique({ where: { id: params.id } });
  if (!client) throw notFound("Client not found.");

  if (client.status === "ACTIVE") return getClient(params.id);

  await prisma.client.update({
    where: { id: params.id },
    data: { status: "ACTIVE", archivedAt: null },
  });

  await recordAuditSafe({
    actorId: params.actorId,
    action: "CLIENT_UPDATED",
    entityType: "Client",
    entityId: params.id,
    clientId: params.id,
    metadata: { restored: true },
    ip: params.ip,
  });

  return getClient(params.id);
}
