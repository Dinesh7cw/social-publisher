import { notFound } from "next/navigation";
import Link from "next/link";

import { requirePageUser } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { ProjectTabs } from "./project-tabs";
import "./project.css";

/**
 * Layout for everything inside one client's project.
 *
 * This is the answer to "when I am in the CW project, only CW can be posted":
 * the client is a fact of the route, not a dropdown the writer has to get
 * right. Every screen beneath this layout is already scoped to the client.
 */
export default async function ClientProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clientId: string }>;
}) {
  await requirePageUser();
  const { clientId } = await params;

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, status: true, contactName: true },
  });

  if (!client) notFound();

  return (
    <div className="project">
      <div className="project-bar">
        <div className="project-identity">
          <span className="project-kicker">
            Client project
            {client.status === "ARCHIVED" ? (
              <span className="pill pill-neutral project-pill">Archived</span>
            ) : null}
          </span>
          <span className="project-name">{client.name}</span>
          {client.contactName ? (
            <span className="small faint">{client.contactName}</span>
          ) : null}
        </div>

        <div className="project-bar-actions">
          <Link href="/clients" className="btn btn-ghost btn-sm">
            All clients
          </Link>
        </div>
      </div>

      <ProjectTabs clientId={client.id} />

      {client.status === "ARCHIVED" ? (
        <div className="form-banner form-banner-error" role="status">
          This client is archived. Restore it from the clients screen before creating or scheduling
          anything new.
        </div>
      ) : null}

      {children}
    </div>
  );
}
