import React from "react";
import { Code2, MessageSquare, PenLine, Play, Image } from "lucide-react";
import "./workspace-links.css";

export default function ResultActions({ source, onHandoff, compact = false }) {
  if (!onHandoff) return null;
  const choices =
    source.kind === "image"
      ? [
          ["image", Image, "Edit image"],
          ["video", Play, "Animate"],
        ]
      : source.kind === "code"
        ? [["coding", Code2, "Open in Coding"]]
        : [
            ["chat", MessageSquare, "Continue in Chat"],
            ["write", PenLine, "Edit in Writing"],
          ];
  return (
    <div
      className={`result-handoffs${compact ? " compact" : ""}`}
      role="group"
      aria-label="Continue with this result"
    >
      {choices.map(([target, Icon, label]) => (
        <button
          type="button"
          key={target}
          onClick={() => onHandoff({ ...source, target })}
        >
          <Icon size={13} />
          {label}
        </button>
      ))}
    </div>
  );
}
