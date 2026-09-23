import type { SVGProps } from "react";

/**
 * The icon set.
 * ---------------------------------------------------------------------------
 * Hand-inlined paths rather than an icon package: the app uses about twenty
 * glyphs, and a dependency for that would cost more than it saves. Every icon
 * is drawn on a 24×24 grid with a 1.75 stroke and `currentColor`, so a single
 * CSS `color` recolours it and the set stays visually consistent.
 *
 * Icons are `aria-hidden` by default — they decorate a label rather than carry
 * meaning. An icon that is the *only* content of a control gets its label from
 * the control itself (`aria-label`), never from here.
 */

export type IconName =
  | "home"
  | "books"
  | "plus"
  | "play"
  | "pause"
  | "restart"
  | "back10"
  | "fwd10"
  | "prevChapter"
  | "nextChapter"
  | "list"
  | "expand"
  | "collapse"
  | "close"
  | "trash"
  | "check"
  | "chevronRight"
  | "chevronLeft"
  | "spinner"
  | "clock"
  | "text"
  | "file"
  | "sparkle"
  | "sidebar"
  | "alert"
  | "layers"
  | "eye";

const PATHS: Record<IconName, JSX.Element> = {
  home: (
    <>
      <path d="M3 10.6 12 3.5l9 7.1" />
      <path d="M5.5 9.4V20a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9.4" />
    </>
  ),
  books: (
    <>
      <path d="M4 4.5h5.5a2.5 2.5 0 0 1 2.5 2.5v13a2 2 0 0 0-2-2H4z" />
      <path d="M20 4.5h-5.5a2.5 2.5 0 0 0-2.5 2.5v13a2 2 0 0 1 2-2H20z" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  play: <path d="M8 5.2v13.6a.6.6 0 0 0 .92.5l10.6-6.8a.6.6 0 0 0 0-1l-10.6-6.8a.6.6 0 0 0-.92.5Z" />,
  pause: (
    <>
      <rect x="7" y="5" width="3.6" height="14" rx="1.2" />
      <rect x="13.4" y="5" width="3.6" height="14" rx="1.2" />
    </>
  ),
  restart: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3.5 4.2V10H9" />
    </>
  ),
  back10: (
    <>
      <path d="M4 6v5h5" />
      <path d="M4.4 11A8 8 0 1 1 12 20a8 8 0 0 1-5.7-2.4" />
      <path d="M10 12.2 11.6 11v4.4" />
    </>
  ),
  fwd10: (
    <>
      <path d="M20 6v5h-5" />
      <path d="M19.6 11A8 8 0 1 0 12 20a8 8 0 0 0 5.7-2.4" />
      <path d="M10 12.2 11.6 11v4.4" />
    </>
  ),
  prevChapter: (
    <>
      <path d="M18.5 6.4v11.2a.6.6 0 0 1-.94.5L9.4 12.5a.6.6 0 0 1 0-1l8.16-5.6a.6.6 0 0 1 .94.5Z" />
      <path d="M5.8 5.6v12.8" />
    </>
  ),
  nextChapter: (
    <>
      <path d="M5.5 6.4v11.2a.6.6 0 0 0 .94.5l8.16-5.6a.6.6 0 0 0 0-1L6.44 5.9a.6.6 0 0 0-.94.5Z" />
      <path d="M18.2 5.6v12.8" />
    </>
  ),
  list: (
    <>
      <path d="M4 6.5h16" />
      <path d="M4 12h16" />
      <path d="M4 17.5h10" />
    </>
  ),
  expand: (
    <>
      <path d="M4 9V4.5h5" />
      <path d="M15 4.5h5V9" />
      <path d="M20 15v4.5h-5" />
      <path d="M9 19.5H4V15" />
    </>
  ),
  collapse: (
    <>
      <path d="M9 4.5V9H4.5" />
      <path d="M19.5 9H15V4.5" />
      <path d="M15 19.5V15h4.5" />
      <path d="M4.5 15H9v4.5" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V4.8a.8.8 0 0 1 .8-.8h3.4a.8.8 0 0 1 .8.8V7" />
      <path d="M6.5 7 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5L17.5 7" />
      <path d="M10.5 11.5v5" />
      <path d="M13.5 11.5v5" />
    </>
  ),
  check: <path d="M4.5 12.6 9.6 17.5 19.5 7" />,
  chevronRight: <path d="M9.5 5.5 16 12l-6.5 6.5" />,
  chevronLeft: <path d="M14.5 5.5 8 12l6.5 6.5" />,
  spinner: (
    <>
      <path d="M12 3.5v3.2" />
      <path d="M12 17.3v3.2" />
      <path d="M20.5 12h-3.2" />
      <path d="M6.7 12H3.5" />
      <path d="m18.01 5.99-2.26 2.26" />
      <path d="m8.25 15.75-2.26 2.26" />
      <path d="m18.01 18.01-2.26-2.26" />
      <path d="m8.25 8.25-2.26-2.26" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.2V12l3.2 2" />
    </>
  ),
  text: (
    <>
      <path d="M5 6.5V5h14v1.5" />
      <path d="M12 5v14" />
      <path d="M9.5 19h5" />
    </>
  ),
  file: (
    <>
      <path d="M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z" />
      <path d="M13.5 3.5v5h5" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3.5 13.9 9 19.5 11l-5.6 2L12 18.5 10.1 13 4.5 11 10.1 9z" />
      <path d="M18.5 4v2.6" />
      <path d="M17.2 5.3h2.6" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.8v5" />
      <path d="M12 16.1h.01" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3.5 8.5 4.6-8.5 4.6-8.5-4.6z" />
      <path d="m4.6 12.6 7.4 4 7.4-4" />
      <path d="m4.6 16.6 7.4 4 7.4-4" />
    </>
  ),
  eye: (
    <>
      <path d="M2.8 12S6.5 5.8 12 5.8 21.2 12 21.2 12 17.5 18.2 12 18.2 2.8 12 2.8 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
};

interface Props extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Edge length in px. */
  size?: number;
  /** Stroke width on the 24×24 grid. */
  weight?: number;
}

export function Icon({ name, size = 20, weight = 1.75, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
