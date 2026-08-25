"use client";

import { useState } from "react";

/**
 * Renders an algo's Pine source as text and nothing else. Source is placed in a
 * text node, never dangerouslySetInnerHTML — a strategy body is data, not
 * markup (CLAUDE.md 19).
 */
export function AlgoSource({ source, fileName }: { source: string; fileName: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (insecure context, or the browser said no). The code
      // is on screen and selectable, so this is a convenience, not the delivery.
      setCopied(false);
    }
  }

  return (
    <div className="algo-source">
      <div className="algo-source-bar">
        <span className="algo-source-file">{fileName}</span>
        <button type="button" className="btn" onClick={copy}>
          {copied ? "Copied" : "Copy source"}
        </button>
      </div>
      <pre>
        <code>{source}</code>
      </pre>
    </div>
  );
}
