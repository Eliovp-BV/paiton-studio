function normalized(value) {
  return typeof value === "string" ? value.normalize("NFKC").toLowerCase() : "";
}

export function isPageMedia(asset) {
  return asset?.kind === "image" || asset?.kind === "video";
}

export function filterLibraryAssets(
  assets,
  { projectId, query = "", kind = "all", favorites = false } = {},
) {
  if (!projectId) return [];
  const terms = normalized(query).trim().split(/\s+/).filter(Boolean);
  return assets.filter((asset) => {
    if (
      asset?.project !== projectId ||
      (kind !== "all" && asset.kind !== kind) ||
      (favorites && !asset.favorite)
    )
      return false;
    const metadata = asset.metadata || {};
    const request = metadata.request || {};
    const profile = request.profile || {};
    const searchable = [
      asset.name,
      metadata.prompt,
      request.prompt,
      metadata.model,
      request.model,
      profile.model,
      profile.label,
      profile.id,
      profile.package,
    ]
      .map(normalized)
      .join("\n");
    return terms.every((term) => searchable.includes(term));
  });
}
