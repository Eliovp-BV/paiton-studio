import React, { useMemo } from "react";
import { lineDiff, diffContext } from "./codeDiff";

export default function CodeDiff({ before, after }) {
  const diff = useMemo(() => lineDiff(before, after), [before, after]);
  const rows = useMemo(() => diffContext(diff.rows), [diff]);
  return (
    <section className="coding-diff" aria-label="Line changes">
      <p className="coding-diff-summary">
        {diff.added} added · {diff.removed} removed
        {!diff.added && !diff.removed ? " · Files are identical" : ""}
      </p>
      {diff.simplified && (
        <p className="helper">
          Large change: the changed region is shown as a replacement. Full files
          are available below.
        </p>
      )}
      <div
        className="coding-diff-lines"
        tabIndex={0}
        aria-label="Line diff, saved or original lines followed by new lines"
      >
        {rows.slice(0, 1200).map((row, index) =>
          row.kind === "skip" ? (
            <div className="coding-diff-skip" key={index}>
              {row.count} unchanged lines
            </div>
          ) : (
            <div
              className={`coding-diff-row coding-diff-${row.kind}`}
              key={index}
            >
              <span
                aria-label={
                  row.oldLine ? `Original line ${row.oldLine}` : undefined
                }
              >
                {row.oldLine}
              </span>
              <span
                aria-label={row.newLine ? `New line ${row.newLine}` : undefined}
              >
                {row.newLine}
              </span>
              <span
                aria-label={
                  row.kind === "delete"
                    ? "Removed"
                    : row.kind === "insert"
                      ? "Added"
                      : "Unchanged"
                }
              >
                {row.kind === "delete"
                  ? "−"
                  : row.kind === "insert"
                    ? "+"
                    : " "}
              </span>
              <code>
                {row.text.replace(/\n$/, "")}
                {!row.text.endsWith("\n") && (
                  <small> ⏎ No newline at end of file</small>
                )}
              </code>
            </div>
          ),
        )}
      </div>
      {rows.length > 1200 && (
        <p className="helper">
          The first 1,200 diff rows are shown. Expand Full files to review the
          entire change.
        </p>
      )}
    </section>
  );
}
