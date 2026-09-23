/**
 * Filename presentation.
 *
 * Small enough to inline, but shared by three pages and two dialogs, and the
 * extension stripping is the kind of thing that gets reimplemented slightly
 * differently in each place if it is not named once.
 */

/** A filename without its extension, for headings and prose. */
export function shortName(filename: string): string {
  return (filename || "").replace(/\.pdf$/i, "").trim() || "Untitled";
}

/** True when the filename looks like a PDF, by extension or by type. */
export function looksLikePdf(file: { name: string; type?: string }): boolean {
  if (/\.pdf$/i.test(file.name || "")) return true;
  return file.type === "application/pdf";
}
