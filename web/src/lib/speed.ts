/**
 * Reading-speed constants.
 * ---------------------------------------------------------------------------
 * These live here, in `lib/`, rather than in the reader engine where they began,
 * because of what importing them used to cost.
 *
 * `WPM_DEFAULT` is what every page uses to seed the saved reading speed — Home
 * wants it to caption the last-read book, Library to show a time-to-finish, Add
 * to preview a new book. All three were importing it from `../reader/useReader`,
 * which meant the reader engine, and with it framer-motion and the whole reader
 * component graph, was pulled into the entry chunk that every visitor downloads
 * before seeing the home page. Three numbers were dragging along roughly a third
 * of a megabyte.
 *
 * Keeping them in a leaf module with no imports of its own means the bundler can
 * satisfy those pages with a few bytes, and route-level `lazy()` in `App.tsx`
 * can actually split the reader out — which it cannot do while a static import
 * of the engine exists on the other side of the split.
 */

/** Below 150 the app is unusable; above 900 nobody reads. */
export const WPM_MIN = 150;
export const WPM_MAX = 900;
export const WPM_STEP = 25;

/** The original default. Fast, but under the point where comprehension drops. */
export const WPM_DEFAULT = 600;
