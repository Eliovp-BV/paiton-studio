import React, { useEffect, useRef } from "react";
import { Download } from "lucide-react";
import WorkspaceDialog from "./WorkspaceDialog";
import ResultActions from "./ResultActions";

export default function SavedResultReader({
  result,
  projectName,
  onClose,
  onHandoff,
}) {
  const first = useRef(null);
  const parts = [];
  if (result.query) {
    const expression = new RegExp(
      result.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "giu",
    );
    let match,
      start = 0,
      count = 0;
    while ((match = expression.exec(result.text)) && count < 200) {
      parts.push(result.text.slice(start, match.index));
      parts.push(
        <mark key={match.index} ref={count === 0 ? first : undefined}>
          {match[0]}
        </mark>,
      );
      start = match.index + match[0].length;
      count++;
    }
    parts.push(result.text.slice(start));
  } else parts.push(result.text);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      first.current?.scrollIntoView({ block: "center" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [result.id, result.query]);
  return (
    <WorkspaceDialog title={result.name} onClose={onClose}>
      <p className="workspace-source-note">
        Saved {result.kind === "document" ? "document text" : "result"} ·{" "}
        {projectName}
      </p>
      {result.query && (
        <p>
          Search: <strong>{result.query}</strong> · first 200 matches
          highlighted
        </p>
      )}
      <pre tabIndex={0}>{parts}</pre>
      <ResultActions
        source={{
          kind: "text",
          project_id: result.project_id,
          asset_id: result.id,
          text: result.text,
          title: result.name,
        }}
        onHandoff={onHandoff}
      />
      <a className="button" href={`/api/assets/${result.id}?download=true`}>
        <Download size={14} /> Download original
      </a>
    </WorkspaceDialog>
  );
}
