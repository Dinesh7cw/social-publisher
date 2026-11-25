"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { segment: "", label: "Overview" },
  { segment: "compose", label: "Create post" },
  { segment: "calendar", label: "Calendar" },
  { segment: "accounts", label: "Accounts" },
  { segment: "history", label: "History" },
  { segment: "credentials", label: "Credentials" },
];

/**
 * Project tabs.
 *
 * The active tab is derived from the pathname rather than stored, so a shared
 * link and a browser back button both land on a correct tab.
 */
export function ProjectTabs({ clientId }: { clientId: string }) {
  const pathname = usePathname();
  const base = `/clients/${clientId}`;

  return (
    <nav className="project-tabs" aria-label="Client project">
      {TABS.map((tab) => {
        const href = tab.segment ? `${base}/${tab.segment}` : base;
        const active = pathname === href;

        return (
          <Link
            key={tab.segment || "overview"}
            href={href}
            className="project-tab"
            aria-current={active ? "page" : undefined}
            data-active={active ? "true" : "false"}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
