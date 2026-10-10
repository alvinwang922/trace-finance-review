/**
 * Accept exact evidence IDs in individual or comma/semicolon-separated brackets.
 * Every bracket must resolve entirely to known IDs; one valid citation cannot hide
 * an unknown citation elsewhere. This checks references, not the factual claims.
 */
export function hasValidEvidenceCitations(text: string, knownIds: ReadonlySet<string>): boolean {
  const brackets = [...text.matchAll(/\[([^\]]*)\]/g)];
  if (!brackets.length) return false;
  if (/[\[\]]/.test(text.replace(/\[[^\]]*\]/g, ''))) return false;
  return brackets.every(([, content]) => {
    const trimmed = content.trim();
    if (!trimmed) return false;
    if (knownIds.has(trimmed)) return true;
    const ids = trimmed.split(/[,;]/).map(id => id.trim());
    return ids.every(id => id.length > 0 && knownIds.has(id));
  });
}
