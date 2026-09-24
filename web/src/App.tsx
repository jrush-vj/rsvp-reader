import { Suspense, lazy } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Spinner } from "./components/ui/Feedback";
import { LibraryProvider } from "./store/library";
import { ToastProvider } from "./store/toast";

/**
 * Routing.
 * ---------------------------------------------------------------------------
 * Hash routing works with Tauri's bundled assets without a web server providing
 * history fallbacks for nested routes.
 *
 * The reader sits *outside* `AppShell`. It takes the whole viewport, so giving
 * it the sidebar would mean either a layout that changes shape when you open a
 * book, or a sidebar that has to be hidden anyway.
 *
 * `/read/paste` is a static sibling of `/read/:bookId` and is declared first.
 * It is told which mode it is in by a **prop** rather than by inspecting the
 * URL, because a static route contributes no params at all: a reader that
 * decided on `bookId === "paste"` would see `undefined` here and try to open a
 * book whose id is the string "undefined". The route table is the single place
 * that knows the difference, so it is the route table that says so.
 */

/*
 * Every page is loaded on demand.
 * ---------------------------------------------------------------------------
 * These were static imports, which meant one bundle held the home page, the
 * library, the upload screen *and* the reader with framer-motion, and every
 * visitor downloaded all of it before the home page could paint. The reader
 * alone is the largest thing in the app and most sessions never open a book.
 *
 * Two things had to be true before this could work, and neither was:
 *
 *   - every page must be a *default* export, because `lazy` has no way to name
 *     a member of a module. These were named exports, so each one gained a
 *     default alias alongside its name.
 *   - nothing in the eagerly-loaded graph may import from the lazy one, or the
 *     split is immediately undone by the shared dependency. `WPM_DEFAULT` was
 *     imported by all three non-reader pages *from the reader engine*, which
 *     dragged the reader into the entry chunk no matter how the routes were
 *     declared. It now lives in `lib/speed.ts` — see the note there.
 *
 * Vite emits a chunk per dynamic import plus a shared chunk, and `<Suspense>`
 * below covers the gap while one is in flight. The fallback is deliberately
 * centred and quiet: on a warm cache the chunk arrives in a frame or two, so
 * anything more animated would flash.
 */

const HomePage = lazy(() => import("./pages/HomePage"));
const LibraryPage = lazy(() => import("./pages/LibraryPage"));
const AddPage = lazy(() => import("./pages/AddPage"));
const ReaderPage = lazy(() => import("./pages/ReaderPage"));

/** Shown while a route's chunk is in flight. */
function RouteFallback() {
  return (
    <div className="routefallback">
      <Spinner label="Loading…" />
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <ToastProvider>
        <LibraryProvider>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              {/* Full-screen: no shell. */}
              <Route path="/read/paste" element={<ReaderPage paste />} />
              <Route path="/read/:bookId" element={<ReaderPage />} />

              {/* Everything else sits inside the sidebar shell. */}
              <Route
                path="*"
                element={
                  <AppShell>
                    <Routes>
                      <Route path="/" element={<HomePage />} />
                      <Route path="/library" element={<LibraryPage />} />
                      <Route path="/add" element={<AddPage />} />
                      <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                  </AppShell>
                }
              />
            </Routes>
          </Suspense>
        </LibraryProvider>
      </ToastProvider>
    </HashRouter>
  );
}

