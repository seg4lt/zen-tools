/**
 * Front-end mirror of `zen_http::substitute_variables` for display
 * purposes — we never want to round-trip into the backend just to
 * render what URL a request will hit. Priority matches Rust:
 * extracted > local > env. Unresolved tokens are left as `{{var}}` so
 * the user can spot missing context.
 */
export function resolveUrl(
  url: string,
  envVars: Record<string, string> | undefined,
  extracted: Record<string, string> | undefined,
  local?: Record<string, string>,
): string {
  return url.replace(/\{\{([^}]+)\}\}/g, (_, raw) => {
    const name = (raw as string).trim();
    if (extracted?.[name] !== undefined) return extracted[name];
    if (local?.[name] !== undefined) return local[name];
    if (envVars?.[name] !== undefined) return envVars[name];
    return `{{${name}}}`;
  });
}
