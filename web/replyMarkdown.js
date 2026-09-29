// A bounded Markdown subset for local model replies. Raw HTML is always text;
// images never trigger remote fetches, and only explicit safe links are active.
export function safeReplyUrl(value) {
  if (
    typeof value !== "string" ||
    !/^(?:https?:\/\/|mailto:)/i.test(value) ||
    value.length > 4096 ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function linkAt(text, start) {
  let cursor = start + 1,
    bracket = 1;
  for (; cursor < text.length && bracket; cursor++) {
    if (cursor - start > 2048 || bracket > 16) return null;
    if (text[cursor] === "\\") {
      cursor++;
      continue;
    }
    if (text[cursor] === "[") bracket++;
    if (text[cursor] === "]") bracket--;
  }
  if (bracket || text[cursor] !== "(") return null;
  const label = text.slice(start + 1, cursor - 1);
  const begin = ++cursor;
  let parens = 1;
  for (; cursor < text.length && parens; cursor++) {
    if (cursor - begin > 4096 || parens > 16) return null;
    if (text[cursor] === "\\") {
      cursor++;
      continue;
    }
    if (text[cursor] === "(") parens++;
    if (text[cursor] === ")") parens--;
  }
  if (parens) return null;
  const raw = text.slice(begin, cursor - 1).trim();
  const destination = raw.startsWith("<")
    ? /^<([^<>]*)>(?:\s+["'][\s\S]*["'])?$/.exec(raw)?.[1]
    : /^(\S+?)(?:\s+["'][\s\S]*["'])?$/.exec(raw)?.[1];
  return { label, href: safeReplyUrl(destination), end: cursor };
}

export function replyInline(text, depth = 0) {
  if (depth > 12) return [{ type: "text", text }];
  const result = [];
  function literal(value) {
    if (result.at(-1)?.type === "text") result.at(-1).text += value;
    else result.push({ type: "text", text: value });
  }
  let cursor = 0;
  while (cursor < text.length) {
    const char = text[cursor];
    if (
      char === "\\" &&
      /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(text[cursor + 1] || "")
    ) {
      literal(text[cursor + 1]);
      cursor += 2;
      continue;
    }
    if (char === "`") {
      const run = /^`+/.exec(text.slice(cursor))[0];
      const end = text.indexOf(run, cursor + run.length);
      if (end >= 0) {
        let value = text.slice(cursor + run.length, end).replace(/\n/g, " ");
        if (/^ .* $/.test(value) && value.trim()) value = value.slice(1, -1);
        result.push({ type: "code", text: value });
        cursor = end + run.length;
        continue;
      }
      literal(run);
      cursor += run.length;
      continue;
    }
    const image = char === "!" && text[cursor + 1] === "[";
    if (char === "[" || image) {
      const link = linkAt(text, cursor + Number(image));
      if (link) {
        if (image) literal(text.slice(cursor, link.end));
        else
          result.push({
            type: "link",
            href: link.href,
            children: replyInline(link.label, depth + 1),
          });
        cursor = link.end;
        continue;
      }
    }
    if (char === "<") {
      const relativeEnd = text.slice(cursor + 1, cursor + 4098).indexOf(">");
      const end = relativeEnd < 0 ? -1 : cursor + 1 + relativeEnd;
      const candidate = end >= 0 ? text.slice(cursor + 1, end) : "";
      const href = safeReplyUrl(candidate);
      if (href) {
        result.push({
          type: "link",
          href,
          children: [{ type: "text", text: candidate }],
        });
        cursor = end + 1;
        continue;
      }
    }
    const marker = ["**", "__", "~~", "*", "_"].find((value) =>
      text.startsWith(value, cursor),
    );
    if (
      marker &&
      !(marker.includes("_") && /[\p{L}\p{N}]/u.test(text[cursor - 1] || ""))
    ) {
      const end = text.indexOf(marker, cursor + marker.length);
      const value = text.slice(cursor + marker.length, end);
      if (end > cursor + marker.length && !/^\s|\s$/.test(value)) {
        result.push({
          type: marker === "~~" ? "del" : marker.length === 2 ? "strong" : "em",
          children: replyInline(value, depth + 1),
        });
        cursor = end + marker.length;
        continue;
      }
    }
    literal(char);
    cursor++;
  }
  return result;
}

function cells(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const result = [""];
  let code = "";
  for (let cursor = 0; cursor < value.length; cursor++) {
    const char = value[cursor];
    if (char === "\\" && cursor + 1 < value.length) {
      result[result.length - 1] += char + value[++cursor];
      continue;
    }
    if (char === "`") {
      const run = /^`+/.exec(value.slice(cursor))[0];
      if (!code) code = run;
      else if (code === run) code = "";
      result[result.length - 1] += run;
      cursor += run.length - 1;
      continue;
    }
    if (char === "|" && !code) result.push("");
    else result[result.length - 1] += char;
  }
  return result.map((cell) => cell.trim());
}
const fence = (line) => /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line || "");
const heading = (line) =>
  /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line || "");
const list = (line) => /^( *)([-+*]|\d{1,9}[.)])\s+(.*)$/.exec(line || "");
const rule = (line) =>
  /^ {0,3}(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/.test(line || "");
function table(lines, index) {
  if (!lines[index]?.includes("|") || !lines[index + 1]?.includes("|"))
    return null;
  const headers = cells(lines[index]),
    separators = cells(lines[index + 1]);
  if (
    headers.length !== separators.length ||
    !separators.every((cell) => /^:?-{3,}:?$/.test(cell))
  )
    return null;
  return {
    headers,
    align: separators.map((cell) =>
      cell.startsWith(":")
        ? cell.endsWith(":")
          ? "center"
          : "left"
        : cell.endsWith(":")
          ? "right"
          : undefined,
    ),
  };
}
function blockStart(lines, index) {
  const line = lines[index];
  return (
    !line.trim() ||
    fence(line) ||
    heading(line) ||
    rule(line) ||
    /^ {0,3}>/.test(line) ||
    list(line) ||
    table(lines, index)
  );
}

export function replyBlocks(text, depth = 0) {
  if (depth > 12)
    return [{ type: "paragraph", children: [{ type: "text", text }] }];
  const lines = String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n"),
    result = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    const open = fence(line);
    if (open) {
      const body = [],
        marker = open[1];
      index++;
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
      while (index < lines.length && !closing.test(lines[index]))
        body.push(lines[index++]);
      const closed = index < lines.length;
      if (closed) index++;
      result.push({
        type: "code",
        language: open[2].trim(),
        text: body.join("\n") + (closed && body.length ? "\n" : ""),
      });
      continue;
    }
    const title = heading(line);
    if (title) {
      result.push({
        type: "heading",
        level: title[1].length,
        children: replyInline(title[2]),
      });
      index++;
      continue;
    }
    if (/^ {0,3}(=+|-+)\s*$/.test(lines[index + 1] || "") && !rule(line)) {
      result.push({
        type: "heading",
        level: lines[index + 1].trim()[0] === "=" ? 1 : 2,
        children: replyInline(line.trim()),
      });
      index += 2;
      continue;
    }
    if (rule(line)) {
      result.push({ type: "rule" });
      index++;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index]))
        quoted.push(lines[index++].replace(/^ {0,3}> ?/, ""));
      result.push({
        type: "quote",
        children: replyBlocks(quoted.join("\n"), depth + 1),
      });
      continue;
    }
    const first = list(line);
    if (first) {
      const ordered = /^\d/.test(first[2]),
        indent = first[1].length,
        items = [];
      while (index < lines.length) {
        const entry = list(lines[index]);
        if (
          !entry ||
          entry[1].length !== indent ||
          /^\d/.test(entry[2]) !== ordered
        )
          break;
        const content = [entry[3]],
          contentIndent = entry[0].length - entry[3].length;
        index++;
        while (index < lines.length) {
          if (!lines[index].trim()) {
            if ((lines[index + 1]?.match(/^ */)?.[0].length || 0) <= indent)
              break;
            content.push("");
            index++;
            continue;
          }
          const nextIndent = /^ */.exec(lines[index])[0].length;
          if (nextIndent <= indent) break;
          content.push(
            lines[index++].slice(Math.min(nextIndent, contentIndent)),
          );
        }
        items.push(replyBlocks(content.join("\n"), depth + 1));
      }
      result.push({
        type: "list",
        ordered,
        start: ordered ? parseInt(first[2], 10) : undefined,
        items,
      });
      continue;
    }
    const grid = table(lines, index);
    if (grid) {
      index += 2;
      const rows = [];
      while (
        index < lines.length &&
        lines[index].trim() &&
        lines[index].includes("|")
      ) {
        const row = cells(lines[index++]);
        rows.push(
          grid.headers.map((_, position) => replyInline(row[position] || "")),
        );
      }
      result.push({
        type: "table",
        headers: grid.headers.map((cell) => replyInline(cell)),
        align: grid.align,
        rows,
      });
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && !blockStart(lines, index)) {
      if (/^ {0,3}(=+|-+)\s*$/.test(lines[index + 1] || "")) break;
      paragraph.push(lines[index++]);
    }
    result.push({
      type: "paragraph",
      children: replyInline(paragraph.join("\n")),
    });
  }
  return result;
}
