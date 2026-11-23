"use client";

import { memo, useRef, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "./Icons";

function CodeBlock(props: ComponentPropsWithoutRef<"pre">) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pre.current?.textContent ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused; the text can still be selected by hand.
    }
  }

  return (
    <div className="code-wrap">
      <pre ref={pre} {...props} />
      <button type="button" className={copied ? "code-copy is-copied" : "code-copy"} onClick={() => void copy()} aria-label={copied ? "Copied" : "Copy code"}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );
}

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  // Wide tables scroll inside their own box instead of pushing the page sideways.
  table: ({ node: _node, ...props }) => (
    <div className="table-scroll">
      <table {...props} />
    </div>
  ),
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
