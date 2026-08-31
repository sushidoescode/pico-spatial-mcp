const count = "\\d{2,3}";
// Each repetition starts with one horizontal-space character or one newline, so a failed suffix
// has only one way to partition the gap. A blockquote marker is consumed only after a newline.
const gap = "(?=[ \\t]|\\r?\\n)(?:[ \\t]|\\r?\\n(?:[ \\t]*>)?)+";
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function canonicalPlatformCountClaim({ macTools, otherHostTools }) {
  return `${macTools} tools on macOS (installed-tarball runtime-measured) versus a source-derived ${otherHostTools} on Linux and Windows from the three-tool host-GUI registration delta`;
}

/**
 * Rewrite only complete, published platform-surface claims. This intentionally operates on the
 * whole document because the supported prose wraps across lines. A standalone number near
 * "macOS", "published", or "counts of" is not enough context to authorize a rewrite.
 */
export function rewritePlatformCountClaims(text, { macTools, otherHostTools }) {
  const canonical = canonicalPlatformCountClaim({ macTools, otherHostTools });
  let out = text;

  const directSlash = new RegExp(
    `\\b${count} tools on macOS \\/ ${count} on Linux are runtime-measured; Windows ${count} is source-derived`,
    "g",
  );
  out = out.replace(directSlash, canonical);

  const paired = new RegExp(
    `\\b${count}${gap}tools${gap}on${gap}macOS${gap}and${gap}${count}${gap}on${gap}Linux${gap}(?:are${gap}runtime-measured|\\(runtime-measured\\));${gap}(?:on${gap}Windows,${gap}the${gap}published${gap}${count}-tool${gap}count|Windows${gap}${count})${gap}is${gap}source-derived`,
    "g",
  );
  out = out.replace(paired, canonical);

  const insteadOf = new RegExp(
    `\\b(\\d{1,2} tools instead of )${count}${gap}on${gap}macOS${gap}and${gap}${count}${gap}on${gap}Linux,${gap}both${gap}runtime-measured;${gap}on${gap}Windows,${gap}the${gap}published${gap}${count}-tool${gap}count${gap}is${gap}source-derived`,
    "g",
  );
  out = out.replace(insteadOf, (_match, prefix) => `${prefix}${canonical}`);

  const exposes = new RegExp(
    `\\b((?:The|the) full server exposes )${count}${gap}on${gap}macOS${gap}and${gap}${count}${gap}on${gap}Linux${gap}\\(runtime-measured\\)\\.${gap}On${gap}Windows,${gap}the${gap}published${gap}${count}-tool${gap}count${gap}is${gap}source-derived`,
    "g",
  );
  out = out.replace(exposes, (_match, prefix) => `${prefix}${canonical}`);

  const respectively = new RegExp(
    `\\bmacOS${gap}and${gap}Linux${gap}have${gap}runtime-measured${gap}full-surface${gap}counts${gap}of${gap}${count}${gap}and${gap}${count}${gap}respectively\\.${gap}The${gap}Windows${gap}${count}${gap}count${gap}is${gap}source-derived`,
    "g",
  );
  out = out.replace(respectively, `The full surface has ${canonical}`);

  const alreadyCanonical = new RegExp(
    `\\b${count} tools on macOS \\(installed-tarball runtime-measured\\) versus a source-derived ${count} on Linux and Windows from the three-tool host-GUI registration delta`,
    "g",
  );
  out = out.replace(alreadyCanonical, canonical);

  // These suffix corrections are authorized only immediately after the complete canonical claim.
  const canonicalPattern = escapeRegExp(canonical);
  out = out.replace(
    new RegExp(`${canonicalPattern}${gap}because${gap}no${gap}native${gap}Windows${gap}`, "g"),
    `${canonical} because no native Linux or Windows `,
  );
  out = out.replace(
    new RegExp(`${canonicalPattern}:${gap}no${gap}native${gap}Windows${gap}`, "g"),
    `${canonical}: no native Linux or Windows `,
  );
  return out;
}
