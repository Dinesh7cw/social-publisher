import { requirePageUser } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { AppShell } from "@/components/shell/app-shell";

/**
 * Layout for every authenticated screen.
 *
 * The guard runs server-side before any child renders, so an unauthenticated
 * request never reaches a page component or its data queries.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requirePageUser();

  // Count only targets that genuinely need a human: a failed publish that is
  // already being retried is not a task for the team.
  const needsAttention = await prisma.postTarget.count({
    where: { status: { in: ["FAILED_PERMANENT", "UNKNOWN"] } },
  });

  return (
    <AppShell
      user={{
        name: session.user.name,
        email: session.user.email,
        role: session.user.role,
      }}
      failedCount={needsAttention}
    >
      {children}
    </AppShell>
  );
}
