"use client";

import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import vs from "react-syntax-highlighter/dist/esm/styles/prism/vs";
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";

const preStyle = {
  margin: 0,
  padding: "11px 13px",
  fontSize: "var(--text-ui)",
  lineHeight: "var(--leading-prose)",
  borderRadius: 0,
  background: "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))",
} as const;

export function HighlightedCode({
  code,
  lang,
  isDark,
}: {
  code: string;
  lang: string;
  isDark: boolean;
}) {
  return (
    <SyntaxHighlighter
      language={lang || "text"}
      style={isDark ? vscDarkPlus : vs}
      showLineNumbers
      lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal" }}
      customStyle={preStyle}
      codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
    >
      {code}
    </SyntaxHighlighter>
  );
}
