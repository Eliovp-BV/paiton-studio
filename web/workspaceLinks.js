export const destinationName = (target) =>
  ({
    chat: "Chat",
    coding: "Coding",
    write: "Writing",
    image: "Image",
    video: "Video",
    page: "Build Website",
  })[target] || "workspace";

export function suggestedCodeName(language = "") {
  const extension =
    {
      python: "py",
      py: "py",
      javascript: "js",
      js: "js",
      typescript: "ts",
      ts: "ts",
      jsx: "jsx",
      tsx: "tsx",
      html: "html",
      css: "css",
      json: "json",
      bash: "sh",
      shell: "sh",
      sh: "sh",
      c: "c",
      cpp: "cpp",
      rust: "rs",
      go: "go",
      java: "java",
      sql: "sql",
      yaml: "yaml",
      yml: "yaml",
      markdown: "md",
      md: "md",
    }[language.trim().toLowerCase()] || "txt";
  return `result.${extension}`;
}

export function uniqueCodeName(name, paths) {
  const existing = new Set(paths);
  if (!existing.has(name)) return name;
  const dot = name.lastIndexOf("."),
    stem = dot > 0 ? name.slice(0, dot) : name,
    extension = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i <= 1000; i++) {
    const candidate = `${stem}-${i}${extension}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw Error("Choose a new file name for this result.");
}

export function appendDraft(existing, incoming, limit = 8000) {
  const value = existing?.trim() ? `${existing}\n\n${incoming}` : incoming;
  if ([...value].length > limit)
    throw Error(
      `The combined draft is longer than ${limit.toLocaleString()} characters. Shorten it before adding this task; your existing draft is kept.`,
    );
  return value;
}
