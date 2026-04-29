/**
 * Front-end mirror of `zen_http::substitute_variables` for display
 * purposes — we never want to round-trip into the backend just to
 * render what URL a request will hit. Priority matches Rust:
 * extracted > local > env. Unresolved tokens are left as `{{var}}` so
 * the user can spot missing context.
 *
 * **Two-pass** like the Rust side: file-local declarations such as
 * `@baseUrl = {{host}}/api` reference env/extracted vars themselves,
 * so the local map is expanded *first*, then the result is used to
 * substitute placeholders in the actual input. Without this, the URL
 * preview shows `{{host}}/api/users` even though the executor sends
 * the correct URL — and the user reasonably wonders why.
 */
const VAR_PATTERN = /\{\{([^}]+)\}\}/g;

function substituteOnce(
  text: string,
  extracted: Record<string, string> | undefined,
  local: Record<string, string> | undefined,
  envVars: Record<string, string> | undefined,
): string {
  return text.replace(VAR_PATTERN, (_, raw) => {
    const name = (raw as string).trim();
    if (extracted?.[name] !== undefined) return extracted[name];
    if (local?.[name] !== undefined) return local[name];
    if (envVars?.[name] !== undefined) return envVars[name];
    return `{{${name}}}`;
  });
}

export function resolveUrl(
  url: string,
  envVars: Record<string, string> | undefined,
  extracted: Record<string, string> | undefined,
  local?: Record<string, string>,
): string {
  // Pass 1: expand each local-var *value* against extracted + env, so
  // a value like `{{host}}/api` becomes `https://host.example/api`
  // before we substitute it into the URL.
  let expandedLocal: Record<string, string> | undefined = local;
  if (local && Object.keys(local).length > 0) {
    expandedLocal = {};
    for (const [k, v] of Object.entries(local)) {
      expandedLocal[k] = substituteOnce(v, extracted, undefined, envVars);
    }
  }
  // Pass 2: substitute the input using the now-fully-resolved local map.
  return substituteOnce(url, extracted, expandedLocal, envVars);
}
