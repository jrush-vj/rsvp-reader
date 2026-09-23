import type {
  BookMeta,
  BookState,
  BookSummary,
  StreamPayload,
} from "./types";

/**
 * The API client.
 * ---------------------------------------------------------------------------
 * Every call is same-origin `/api/...`. In dev, Vite proxies that to Flask on
 * 5000; in production Flask serves the bundle itself. Because the base is a
 * relative path there is no environment-specific constant to configure, and no
 * CORS preflight in either mode.
 */

/** An error carrying the server's own message, so the UI can show it verbatim. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Turn any fetch rejection into a message worth showing a person.
 *
 * A bare `TypeError: Failed to fetch` is what a browser produces for both a
 * dead server and a dropped connection, and neither is actionable on its own.
 */
function networkError(cause: unknown): ApiError {
  return new ApiError(
    "Could not reach the BookTube server. Check that it is running and try again.",
    0,
    cause,
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (cause) {
    throw networkError(cause);
  }

  // 204 and an empty body are both legal for a DELETE, so the parse is
  // guarded rather than assumed.
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status}).`;
    throw new ApiError(message, res.status, body);
  }

  return body as T;
}

const enc = encodeURIComponent;

/**
 * Health probe.
 *
 * Resolves `true` for a healthy server rather than throwing, because the only
 * caller is a status indicator that has to render either way.
 */
export async function checkHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const body = await request<{ status?: string }>("/api/health", { signal });
    return body?.status === "ok";
  } catch {
    return false;
  }
}

/** Every processed book, most recently added first. */
export function listBooks(signal?: AbortSignal): Promise<BookSummary[]> {
  return request<{ books: BookSummary[] }>("/api/books", { signal }).then(
    (r) => r.books ?? [],
  );
}

/** A book's structure, saved state, and resolved selections. */
export function getBook(
  bookId: string,
  signal?: AbortSignal,
): Promise<{ book: BookSummary; meta: BookMeta; state: BookState }> {
  return request(`/api/books/${enc(bookId)}`, { signal });
}

/** A book's reading position and selections. */
export function getState(bookId: string, signal?: AbortSignal): Promise<BookState> {
  return request<BookState>(`/api/books/${enc(bookId)}/state`, { signal });
}

/**
 * Upload a PDF: process it, store it, and return the new library entry.
 *
 * This is the library path — the PDF is parsed once and kept, so opening the
 * book later is a file read rather than a re-parse. The server deletes the
 * half-built directory if nothing readable came out, so a scanned PDF leaves
 * no trace.
 */
export function createBook(
  file: File,
  signal?: AbortSignal,
): Promise<{ book: BookSummary; meta: BookMeta }> {
  const form = new FormData();
  form.append("file", file);
  return request("/api/books", { method: "POST", body: form, signal });
}

/** Delete a book and everything stored for it. */
export function deleteBook(bookId: string): Promise<{ deleted: string }> {
  return request(`/api/books/${enc(bookId)}`, { method: "DELETE" });
}

/**
 * The whole reading stream, ready to step through.
 *
 * `words` is already filtered by the saved selections, so unchecked chapters
 * are genuinely absent rather than merely hidden — which is why changing a
 * selection means re-fetching this.
 */
export function getStream(
  bookId: string,
  signal?: AbortSignal,
): Promise<StreamPayload> {
  return request<StreamPayload>(`/api/books/${enc(bookId)}/words`, { signal });
}

/**
 * Save reading position and/or selections.
 *
 * The server treats the body as a **partial merge**, which is load-bearing:
 * sending only `word_index` must leave `selections` untouched, and sending only
 * `selections` must leave the position intact. Two debounced saves racing is
 * exactly the case a whole-object overwrite breaks.
 */
export function putState(
  bookId: string,
  patch: { word_index?: number; section_id?: string | null; selections?: Record<string, boolean> },
  signal?: AbortSignal,
): Promise<{ book: BookSummary; state: BookState }> {
  return request(`/api/books/${enc(bookId)}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
    signal,
  });
}

/** Check or uncheck a single section. Instant, because nothing is re-parsed. */
export function patchSection(
  bookId: string,
  sectionId: string,
  checked: boolean,
): Promise<{ book: BookSummary; state: BookState }> {
  return request(`/api/books/${enc(bookId)}/sections/${enc(sectionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked }),
  });
}
