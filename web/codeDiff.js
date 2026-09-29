// Bounded line alignment. Large edits fall back to an honest replacement hunk.
export function lineDiff(before, after, { maxCells = 2000000 } = {}) {
  const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const left = lines(before),
    right = lines(after),
    rows = [];
  let oldLine = 1,
    newLine = 1;
  const emit = (kind, text) =>
    rows.push({
      kind,
      text,
      oldLine: kind === "insert" ? null : oldLine++,
      newLine: kind === "delete" ? null : newLine++,
    });
  let prefix = 0,
    suffix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    emit("equal", left[prefix++]);
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  )
    suffix++;
  const a = left.slice(prefix, left.length - suffix),
    b = right.slice(prefix, right.length - suffix);
  const simplified =
    a.length > 0 && b.length > 0 && (a.length + 1) * (b.length + 1) > maxCells;
  if (simplified) {
    a.forEach((line) => emit("delete", line));
    b.forEach((line) => emit("insert", line));
  } else {
    const width = b.length + 1;
    const lengths = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        lengths[i * width + j] =
          a[i] === b[j]
            ? 1 + lengths[(i + 1) * width + j + 1]
            : Math.max(
                lengths[(i + 1) * width + j],
                lengths[i * width + j + 1],
              );
    let i = 0,
      j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        emit("equal", a[i++]);
        j++;
      } else if (
        i < a.length &&
        (j === b.length ||
          lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
      )
        emit("delete", a[i++]);
      else emit("insert", b[j++]);
    }
  }
  left.slice(left.length - suffix).forEach((line) => emit("equal", line));
  return {
    rows,
    simplified,
    added: rows.filter((row) => row.kind === "insert").length,
    removed: rows.filter((row) => row.kind === "delete").length,
  };
}

export function diffContext(rows, context = 3) {
  const output = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index].kind !== "equal") {
      output.push(rows[index++]);
      continue;
    }
    const start = index;
    while (index < rows.length && rows[index].kind === "equal") index++;
    const head = start ? Math.min(context, index - start) : 0;
    const tail =
      index < rows.length ? Math.min(context, index - start - head) : 0;
    output.push(...rows.slice(start, start + head));
    if (index - start > head + tail)
      output.push({ kind: "skip", count: index - start - head - tail });
    output.push(...rows.slice(index - tail, index));
  }
  return output;
}
