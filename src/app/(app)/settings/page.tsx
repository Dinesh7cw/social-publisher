import type { Metadata } from "next";

import { requirePageUser } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { TeamSettings, type TeamMember } from "./team-settings";

export const metadata: Metadata = { title: "Team settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await requirePageUser();

  if (session.user.role !== "ADMIN") {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Team settings</h1>
            <p className="page-sub">Only an admin can manage the team.</p>
          </div>
        </div>
        <div className="empty-state">
          <p className="empty-title">Admin access required</p>
          <p className="small">Ask a CW admin if you need a change to your account.</p>
        </div>
      </>
    );
  }

  const users = await prisma.user.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      timeZone: true,
      createdAt: true,
      _count: { select: { posts: true } },
    },
  });

  const members: TeamMember[] = users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    timeZone: user.timeZone,
    createdAt: user.createdAt.toISOString(),
    postCount: user._count.posts,
    isSelf: user.id === session.user.id,
  }));

  return <TeamSettings members={members} />;
}
