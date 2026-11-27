/**
 * Claude Code log helpers. Reading and aggregation moved to src/core/
 * (usageRecord → usageStore → aggregate) so the dashboard, history and pusher
 * share one implementation; only the slug decoding lives here.
 */

/** Decode a Claude project slug ("d--Work-Projects-x") back to a path ("D:/Work/Projects/x"). */
export function slugToCwd(slug: string): string {
  if (!slug) return slug;
  const parts = slug.split(/--(.*)/s);
  if (parts.length >= 2 && parts[0].length === 1) {
    const drive = parts[0].toUpperCase() + ":";
    const rest = parts[1].replace(/-/g, "/");
    return drive + "/" + rest;
  }
  return slug.replace(/-/g, "/");
}
