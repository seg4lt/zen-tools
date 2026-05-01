/**
 * Tauri commands reject with the serialised `AppError` shape (see
 * `src-tauri/src/error.rs`):
 *
 *   { kind: "db" | "io" | …, message: "human text" }
 *
 * That object is _not_ an `Error` instance, so naive code like
 * `err instanceof Error ? err.message : String(err)` ends up rendering
 * the literal string "[object Object]" in the UI. This helper unpacks
 * the common shapes (Error, Tauri AppError, plain string) into a
 * displayable message.
 */
export function formatError(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object") {
    const obj = err as { message?: unknown; kind?: unknown };
    if (typeof obj.message === "string" && obj.message.length > 0) {
      return obj.message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      // Fall through to String() below.
    }
  }
  return String(err);
}
