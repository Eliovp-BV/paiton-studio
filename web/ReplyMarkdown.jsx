import React from "react";
import { Copy } from "lucide-react";
import { copyText } from "./codeWorkspace";
import { replyBlocks } from "./replyMarkdown";

function Inline({ nodes, links = true }) {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.text;
    if (node.type === "code") return <code key={index}>{node.text}</code>;
    if (node.type === "link")
      return node.href && links ? (
        <a
          key={index}
          href={node.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Inline nodes={node.children} links={false} />
        </a>
      ) : (
        <React.Fragment key={index}>
          <Inline nodes={node.children} links={false} />
        </React.Fragment>
      );
    const Tag = { strong: "strong", em: "em", del: "del" }[node.type];
    return (
      <Tag key={index}>
        <Inline nodes={node.children} links={links} />
      </Tag>
    );
  });
}
function Blocks({ nodes, report, onCode }) {
  return nodes.map((node, index) => {
    if (node.type === "code")
      return (
        <div className="gpt-code" key={index}>
          <div>
            <span>{node.language || "Code"}</span>
            {onCode && (
              <button
                type="button"
                onClick={() => onCode(node.text, node.language)}
              >
                Open in Files
              </button>
            )}
            <button
              type="button"
              aria-label="Copy code"
              onClick={() => copyText(node.text).catch(report)}
            >
              <Copy size={14} />
            </button>
          </div>
          <pre>
            <code>{node.text}</code>
          </pre>
        </div>
      );
    if (node.type === "rule") return <hr key={index} />;
    if (node.type === "quote")
      return (
        <blockquote key={index}>
          <Blocks nodes={node.children} report={report} onCode={onCode} />
        </blockquote>
      );
    if (node.type === "list") {
      const Tag = node.ordered ? "ol" : "ul";
      return (
        <Tag key={index} start={node.start}>
          {node.items.map((item, position) => (
            <li key={position}>
              <Blocks nodes={item} report={report} onCode={onCode} />
            </li>
          ))}
        </Tag>
      );
    }
    if (node.type === "table")
      return (
        <div
          className="gpt-markdown-table"
          key={index}
          role="region"
          aria-label="Reply table"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                {node.headers.map((cell, position) => (
                  <th
                    key={position}
                    style={{ textAlign: node.align[position] }}
                  >
                    <Inline nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, position) => (
                    <td
                      key={position}
                      style={{ textAlign: node.align[position] }}
                    >
                      <Inline nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    const Tag = node.type === "heading" ? `h${node.level}` : "p";
    return (
      <Tag key={index}>
        <Inline nodes={node.children} />
      </Tag>
    );
  });
}
export default function ReplyMarkdown({ text, report, onCode }) {
  return (
    <div className="gpt-answer gpt-markdown">
      <Blocks nodes={replyBlocks(text)} report={report} onCode={onCode} />
    </div>
  );
}
