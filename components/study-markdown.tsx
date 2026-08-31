"use client";

import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { defaultSchema, type Schema } from "hast-util-sanitize";

import { prepareStudyMarkdown } from "@/lib/study-markdown";
import { sanitizeMarkdownUrl } from "@/lib/utils";

import "katex/dist/katex.min.css";

const MATH_TAGS = [
  "annotation",
  "annotation-xml",
  "maction",
  "maligngroup",
  "malignmark",
  "math",
  "menclose",
  "merror",
  "mfenced",
  "mglyph",
  "mi",
  "mlabeledtr",
  "mmultiscripts",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mprescripts",
  "mroot",
  "mrow",
  "ms",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msup",
  "msubsup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "none",
] as const;

const SAFE_KATEX_CLASS = /^(?:katex|katex-error)$/;
const SAFE_MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";

/**
 * Allow normal study Markdown plus the small MathML surface emitted by
 * KaTeX's mathml renderer. Raw HTML, images, styles, event handlers, and
 * arbitrary class names remain unavailable.
 */
const studySanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []).filter(
      (tagName) => !["img", "picture", "source"].includes(tagName),
    ),
    ...MATH_TAGS,
  ],
  attributes: {
    ...defaultSchema.attributes,
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className", SAFE_KATEX_CLASS],
      "ariaHidden",
    ],
    math: [
      ["xmlns", SAFE_MATHML_NAMESPACE],
      ["display", "block"],
    ],
    annotation: [["encoding", "application/x-tex"]],
    mo: [["stretchy", "false"]],
  },
  strip: ["script", "style"],
};

const components: Components = {
  a: ({ href, children, ...props }) => {
    const safeHref = typeof href === "string" ? sanitizeMarkdownUrl(href) : null;
    if (!safeHref) return <span>{children}</span>;
    return (
      <a
        {...props}
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
};

const inlineComponents: Components = {
  ...components,
  // Choices and answer labels are already interactive controls; do not nest
  // a second clickable anchor inside them.
  a: ({ children }) => <span>{children}</span>,
  p: ({ children }) => <span>{children}</span>,
  h1: ({ children }) => <span>{children}</span>,
  h2: ({ children }) => <span>{children}</span>,
  h3: ({ children }) => <span>{children}</span>,
  h4: ({ children }) => <span>{children}</span>,
  h5: ({ children }) => <span>{children}</span>,
  h6: ({ children }) => <span>{children}</span>,
  ul: ({ children }) => <span>{children}</span>,
  ol: ({ children }) => <span>{children}</span>,
  li: ({ children }) => <span>{children} </span>,
  blockquote: ({ children }) => <span>{children}</span>,
  pre: ({ children }) => <code>{children}</code>,
  table: ({ children }) => <span>{children}</span>,
  thead: ({ children }) => <span>{children}</span>,
  tbody: ({ children }) => <span>{children}</span>,
  tfoot: ({ children }) => <span>{children}</span>,
  tr: ({ children }) => <span>{children}</span>,
  th: ({ children }) => <span>{children}</span>,
  td: ({ children }) => <span>{children}</span>,
  hr: () => <span aria-hidden="true" />,
};

export function MarkdownBody({ source, inline = false }: { source: string; inline?: boolean }) {
  const prepared = prepareStudyMarkdown(source);
  if (!prepared) {
    return (
      <span className="prose-study" role="status">
        <span>This study content is too large to display safely.</span>
      </span>
    );
  }

  const Wrapper = inline ? "span" : "div";
  return (
    <Wrapper className={inline ? "prose-study prose-study-inline" : "prose-study"}>
      <ReactMarkdown
        skipHtml
        urlTransform={(url) => sanitizeMarkdownUrl(url) ?? ""}
        remarkPlugins={[[remarkGfm], [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[
          [
            rehypeKatex,
            {
              output: "mathml",
              throwOnError: false,
              trust: false,
              strict: "ignore",
            },
          ],
          [rehypeSanitize, studySanitizeSchema],
        ]}
        components={inline ? inlineComponents : components}
      >
        {prepared.source}
      </ReactMarkdown>
    </Wrapper>
  );
}

export { studySanitizeSchema };
