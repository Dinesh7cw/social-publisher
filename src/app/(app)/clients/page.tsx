import type { Metadata } from "next";

import { requirePageUser } from "@/server/auth/guards";
import { listClients } from "@/server/services/clients";
import { ClientsManager } from "./clients-manager";

export const metadata: Metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const session = await requirePageUser();

  // Server-rendered first page so the screen is useful before any JS runs; the
  // client component takes over for search and mutations.
  const initial = await listClients({ status: "ACTIVE", limit: 100 });

  return (
    <ClientsManager
      initialClients={initial.items}
      canManage={session.user.role === "ADMIN"}
    />
  );
}
