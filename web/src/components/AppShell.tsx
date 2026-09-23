import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Icon, type IconName } from "../components/Icon";
import { checkHealth } from "../lib/api";
import { useIsCompact, useStored, RAIL_KEY } from "../lib/storage";

/**
 * The application shell: sidebar, ambient background, and the routed pane.
 * ---------------------------------------------------------------------------
 * Three pages, in the order they are actually used: Home, Library, Add. The
 * reader is not in this list on purpose — it is about one specific book and
 * takes the whole viewport when open, so it routes outside the shell.
 */

interface NavEntry {
  to: string;
  label: string;
  icon: IconName;
  /** Matched with `endsWith`-style logic so a sub-route keeps the parent lit. */
  match: (path: string) => boolean;
}

const NAV: NavEntry[] = [
  { to: "/", label: "Home", icon: "home", match: (p) => p === "/" },
  { to: "/library", label: "Library", icon: "books", match: (p) => p.startsWith("/library") },
  { to: "/add", label: "Add a book", icon: "plus", match: (p) => p.startsWith("/add") },
];

export function AppShell({ children }: { children: ReactNode }) {
  const compact = useIsCompact();
  const location = useLocation();
  const [collapsed, setCollapsed] = useStored(RAIL_KEY, false);
  /** On a narrow viewport the rail becomes an overlay that starts closed. */
  const [mobileOpen, setMobileOpen] = useState(false);

  // Collapsing on a wide screen is a preference; on a narrow one the rail is
  // an overlay, so any navigation closes it.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const isCollapsed = !compact && collapsed;
  const railOpen = compact ? mobileOpen : true;

  return (
    <>
      <div className="ambient" aria-hidden="true">
        <span className="ambient__blob" />
      </div>
      <div className="grain" aria-hidden="true" />

      <div
        className={[
          "shell",
          isCollapsed ? "shell--rail-min" : "",
          compact ? "shell--compact" : "",
          compact && mobileOpen ? "shell--overlay-open" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <Sidebar
          collapsed={isCollapsed}
          compact={compact}
          open={railOpen}
          onToggle={() => (compact ? setMobileOpen((v) => !v) : setCollapsed((v) => !v))}
          onNavigate={() => setMobileOpen(false)}
        />

        {compact && mobileOpen && (
          <div
            className="shell__scrim"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}

        {/*
         * The rail's own toggle sits inside the rail, which on a compact
         * viewport starts off-canvas — so the button that brings the rail back
         * was itself off-screen and navigation was unreachable. This opener
         * lives outside the rail for exactly that reason. It is only rendered
         * while the rail is closed, so it never fights the drawer for taps.
         */}
        {compact && !mobileOpen && (
          <button
            type="button"
            className="rail-fab"
            onClick={() => setMobileOpen(true)}
            aria-label="Show navigation"
            aria-expanded={false}
          >
            <Icon name="sidebar" size={19} />
          </button>
        )}

        <main className="main" id="main">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location.pathname}
              className="main__pane"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </>
  );
}

function Sidebar({
  collapsed,
  compact,
  open,
  onToggle,
  onNavigate,
}: {
  collapsed: boolean;
  compact: boolean;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const online = useBackendStatus();

  // On a compact viewport the rail is an off-canvas overlay; `collapsed` (the
  // desktop preference) must not also shrink it, or it would open as a rail of
  // icons with nothing to tap.
  const isMin = collapsed && !compact;

  return (
    <aside
      className={["rail", isMin ? "rail--min" : "", open ? "rail--open" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-label="Main"
    >
      <div className="rail__top">
        <NavLink to="/" className="brand" onClick={onNavigate} aria-label="BookTube home">
          <span className="brand__mark" aria-hidden="true">
            <span className="brand__pivot">B</span>
            <span>ookTube</span>
          </span>
        </NavLink>
        <button
          type="button"
          className="rail__toggle"
          onClick={onToggle}
          aria-label={
            compact
              ? open
                ? "Hide navigation"
                : "Show navigation"
              : isMin
                ? "Expand sidebar"
                : "Collapse sidebar"
          }
          aria-expanded={open}
        >
          <Icon name={compact ? "close" : isMin ? "chevronRight" : "chevronLeft"} size={17} />
        </button>
      </div>

      <nav className="rail__nav">
        {NAV.map((entry) => (
          <NavLink
            key={entry.to}
            to={entry.to}
            end={entry.to === "/"}
            onClick={onNavigate}
            className={({ isActive }) =>
              ["navitem", entry.match(location.pathname) || isActive ? "is-active" : ""]
                .filter(Boolean)
                .join(" ")
            }
            title={isMin ? entry.label : undefined}
          >
            <span className="navitem__icon">
              <Icon name={entry.icon} size={19} />
            </span>
            <span className="navitem__label">{entry.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="rail__foot">
        <span
          className={`statusdot ${online ? "is-on" : "is-off"}`}
          title={online ? "Server reachable" : "Server unreachable"}
        >
          <span className="statusdot__dot" />
          <span className="statusdot__label">{online ? "Backend online" : "Backend offline"}</span>
        </span>
      </div>
    </aside>
  );
}

/**
 * Whether the Flask API is answering.
 *
 * Polled slowly — this is an indicator, not a heartbeat, and a local app's
 * server does not appear and disappear on a timescale where thirty seconds
 * would matter. The first probe runs immediately so the dot is honest on
 * first paint rather than optimistically green.
 */
function useBackendStatus(): boolean {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const probe = async () => {
      const ok = await checkHealth();
      if (cancelled) return;
      setOnline(ok);
      timer = window.setTimeout(probe, 30_000);
    };

    void probe();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return online;
}
