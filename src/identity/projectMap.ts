/**
 * Resolves a session's enterprise project name from its working directory or the
 * API key it ran on, using a user-configured map (setting `tokenscope.projectMap`).
 *
 * Resolution order (see improve/07 §5.2):
 *   1. exact match of cwd (normalized) or its slug against a map key
 *   2. `key:<keyHash>` match — chi phí gắn theo key thay vì repo
 *   3. fallback: basename(cwd)
 */
import { slugToCwd } from "../readers/claudeLive";

export type ProjectMap = Record<string, string>;

function normalize(p: string): string {
  return (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function basename(p: string): string {
  const parts = normalize(p).split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function resolveProject(
  cwd: string,
  keyHash: string | undefined,
  map: ProjectMap,
): string {
  const target = normalize(cwd);

  // 1. cwd or slug match. Map keys may be raw paths or slugs; normalize both.
  for (const [key, name] of Object.entries(map)) {
    if (key.startsWith("key:")) continue;
    const asPath = normalize(key);
    const asSlug = normalize(slugToCwd(key));
    if (target && (target === asPath || target === asSlug)) return name;
  }

  // 2. key:<keyHash> match.
  if (keyHash) {
    const byKey = map[`key:${keyHash}`];
    if (byKey) return byKey;
  }

  // 3. fallback to the last path segment.
  return basename(cwd);
}
