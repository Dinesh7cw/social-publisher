"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

/**
 * The product mark.
 *
 * Drawn from CW's own world: two square "posts" with a connecting arrow, in the
 * brand red. Not a black square with a letter.
 */
export function CwMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="8" width="14" height="16" rx="2.5" fill="var(--primary-color)" />
      <rect
        x="17"
        y="8"
        width="14"
        height="16"
        rx="2.5"
        fill="none"
        stroke="var(--primary-color)"
        strokeWidth="2"
      />
      <path
        d="M8 16h16"
        stroke="var(--light-color)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M20.5 12.5 24 16l-3.5 3.5"
        stroke="var(--light-color)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface NavItem {
  href: string;
  label: string;
  /** Only set where a queue genuinely needs action. */
  badge?: number;
}

const NAV: Array<{ group: string; items: NavItem[] }> = [
  {
    group: "Workspace",
    items: [
      { href: "/", label: "Dashboard" },
      { href: "/clients", label: "Clients" },
      { href: "/accounts", label: "Social accounts" },
    ],
  },
  {
    group: "Publishing",
    items: [
      { href: "/compose", label: "Create post" },
      { href: "/calendar", label: "Content calendar" },
      { href: "/history", label: "Publishing history" },
    ],
  },
  {
    group: "Admin",
    items: [{ href: "/settings", label: "Team settings" }],
  },
];

export interface ShellUser {
  name: string;
  email: string;
  role: "ADMIN" | "MEMBER";
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  user,
  failedCount,
  children,
}: {
  user: ShellUser;
  failedCount: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  // Closing the sheet on navigation is derived state, not an effect: the sheet is
  // only open for the current pathname. Storing the pathname it was opened on
  // means a route change closes it without a second render pass.
  const [openedOnPath, setOpenedOnPath] = useState<string | null>(null);
  const sheetOpen = menuOpen && openedOnPath === pathname;

  const nav = NAV.map((group) => ({
    ...group,
    items: group.items.map((item) =>
      item.href === "/history" && failedCount > 0
        ? { ...item, badge: failedCount }
        : item.href === "/settings" && user.role !== "ADMIN"
          ? { ...item, hidden: true }
          : item,
    ),
  }));

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      {/* Phone top bar: the sidebar folds into this. */}
      <header className="shell-bar">
        <div className="brand">
          <CwMark size={22} />
          <span className="brand-name">CW Social Publisher</span>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          aria-expanded={sheetOpen}
          aria-controls="shell-nav"
          onClick={() => {
            // Opening records the current path; navigating then closes it
            // without an effect.
            if (sheetOpen) {
              setMenuOpen(false);
            } else {
              setOpenedOnPath(pathname);
              setMenuOpen(true);
            }
          }}
        >
          {sheetOpen ? "Close" : "Menu"}
        </button>
      </header>

      <aside
        id="shell-nav"
        className="shell-sidebar"
        data-open={sheetOpen ? "true" : "false"}
      >
        <div className="sidebar-top">
          <div className="brand">
            <CwMark size={26} />
            <div className="brand-text">
              <span className="brand-name">CW Social Publisher</span>
              <span className="brand-scope">ColorWhistle agency</span>
            </div>
          </div>
        </div>

        {/* The label belongs on the landmark, not on the wrapper, so a screen
            reader announces "Main navigation" when it reaches the links. */}
        <nav className="sidebar-nav" aria-label="Main navigation">
          {nav.map((group) => (
            <div key={group.group} className="nav-group">
              <div className="nav-group-label">{group.group}</div>
              {group.items
                .filter((item) => !("hidden" in item && item.hidden))
                .map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="nav-row"
                      aria-current={active ? "page" : undefined}
                      data-active={active ? "true" : "false"}
                    >
                      <span className="nav-label">{item.label}</span>
                      {item.badge ? (
                        <span className="nav-count" aria-label={`${item.badge} need attention`}>
                          {item.badge}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="user-row">
            <span className="user-avatar" aria-hidden="true">
              {user.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="user-meta">
              <span className="user-name">{user.name}</span>
              <span className="user-role">
                {user.role === "ADMIN" ? "Admin" : "Team member"}
              </span>
            </div>
          </div>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="btn btn-ghost btn-sm logout-btn">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {sheetOpen ? (
        <button
          type="button"
          className="shell-scrim"
          aria-label="Close menu"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}

      <main id="main" className="shell-main">
        {children}
      </main>
    </div>
  );
}

