"use client";

import type { ComponentProps } from "react";
import type { Components, ExtraProps } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { defaultSchema, type Schema } from "hast-util-sanitize";

import { CitationChip } from "@/components/citation-chip";
import { UNSOURCED_CLAIM_CLASS, UnsourcedTag } from "@/components/unsourced-tag";
import { remarkCitations } from "@/lib/citations";
import { prepareStudyMarkdown } from "@/lib/study-markdown";
import {
  normalizeDocumentText,
  remarkDropStudyFootnotes,
  remarkStudyAnnotations,
  type AnnotationRecord,
} from "@/lib/annotations";
import { remarkStudyHeadingIds, STUDY_HEADING_CLOBBER_PREFIX, STUDY_HEADING_ID_PATTERN } from "@/lib/study-outline";
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
  // KaTeX wraps each formula as <semantics><mrow/><annotation/></semantics>.
  // Without it the TeX annotation sits loose in <math> and Chrome draws it as a box.
  "semantics",
] as const;

const SAFE_STUDY_SPAN_CLASS =
  /^(?:katex|katex-error|ink-idea|ink-example|ink-fact|ink-warning|ink-exam|user-annotation-(?:sun|sky|mint|rose)|study-cite|study-unsourced|study-claim)$/;
const SAFE_MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
const INK_CLASS_NAMES = [
  "ink-idea",
  "ink-example",
  "ink-fact",
  "ink-warning",
  "ink-exam",
] as const;
const INK_CLASS_GROUP = INK_CLASS_NAMES.join("|");
const ANNOTATION_CLASS_GROUP = "user-annotation-(?:sun|sky|mint|rose)";
const OPEN_INK_SPAN = new RegExp(
  `^<span\\s+class=["'](${INK_CLASS_GROUP})["']\\s*>$`,
  "i",
);
const FULL_INK_SPAN = new RegExp(
  `^<span\\s+class=["'](${INK_CLASS_GROUP})["']\\s*>([\\s\\S]*?)</span\\s*>$`,
  "i",
);
const FULL_ANNOTATION_SPAN = new RegExp(
  `^<span\\s+class=["'](${ANNOTATION_CLASS_GROUP})["']\\s*>([\\s\\S]*?)</span\\s*>$`,
  "i",
);
const CLOSE_SPAN = /^<\/span\s*>$/i;

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: {
    hName?: string;
    hProperties?: { className?: string[] };
  };
};

function inkSpanNode(className: string, children: MdastNode[]): MdastNode {
  return {
    type: "inkSpan",
    data: {
      hName: "span",
      hProperties: { className: [className] },
    },
    children,
  };
}

function annotationSpanNode(className: string, children: MdastNode[]): MdastNode {
  return {
    type: "annotationSpan",
    data: {
      hName: "span",
      hProperties: { className: [className] },
    },
    children,
  };
}

/**
 * Turn allowlisted ink <span> HTML into real span nodes so skipHtml can keep
 * dropping every other raw tag. Do not parse arbitrary HTML.
 */
function remarkInkSpans() {
  return (tree: MdastNode) => {
    rewriteInkHtml(tree);
  };
}

function rewriteInkHtml(node: MdastNode) {
  const children = node.children;
  if (!children) return;

  const next: MdastNode[] = [];
  let index = 0;
  while (index < children.length) {
    const child = children[index];
    if (child.type === "html" && typeof child.value === "string") {
      const trimmed = child.value.trim();
      const full = FULL_INK_SPAN.exec(trimmed);
      if (full) {
        next.push(inkSpanNode(full[1].toLowerCase(), [{ type: "text", value: full[2] }]));
        index += 1;
        continue;
      }
      const annotation = FULL_ANNOTATION_SPAN.exec(trimmed);
      if (annotation) {
        next.push(annotationSpanNode(annotation[1].toLowerCase(), [{ type: "text", value: annotation[2] }]));
        index += 1;
        continue;
      }

      const open = OPEN_INK_SPAN.exec(trimmed);
      if (open) {
        let closeAt = -1;
        for (let cursor = index + 1; cursor < children.length; cursor += 1) {
          const sibling = children[cursor];
          if (
            sibling.type === "html" &&
            typeof sibling.value === "string" &&
            CLOSE_SPAN.test(sibling.value.trim())
          ) {
            closeAt = cursor;
            break;
          }
        }
        if (closeAt !== -1) {
          const inner = children.slice(index + 1, closeAt);
          const wrapped = inkSpanNode(open[1].toLowerCase(), inner);
          rewriteInkHtml(wrapped);
          next.push(wrapped);
          index = closeAt + 1;
          continue;
        }
        index += 1;
        continue;
      }

      index += 1;
      continue;
    }

    rewriteInkHtml(child);
    next.push(child);
    index += 1;
  }

  node.children = next;
}

type UnsourcedNode = MdastNode & {
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

/**
 * Number rendered `[[unsourced]]` markers in document order so a tag can name
 * which token in the Markdown it resolves (see `unsourcedTokenOffsets`).
 */
function remarkNumberUnsourced() {
  return (tree: MdastNode) => {
    let next = 0;
    const visit = (node: UnsourcedNode) => {
      if (node.type === "studyUnsourced") {
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, dataUnsourcedIndex: String(next) },
        };
        next += 1;
        return;
      }
      for (const child of node.children ?? []) visit(child as UnsourcedNode);
    };
    visit(tree as UnsourcedNode);
  };
}

type SpanProps = ComponentProps<"span"> & ExtraProps;
type DataAttributes = Record<`data-${string}`, string | undefined>;

function pageAttribute(value: string | undefined): number | null {
  if (value === undefined) return null;
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : null;
}

function studySpan(inline: boolean) {
  function StudySpan({ node, className, children, ...props }: SpanProps) {
    void node;
    const rest = props as typeof props & DataAttributes;
    const classes = typeof className === "string" ? className.split(/\s+/) : [];
    if (classes.includes("study-cite")) {
      return (
        <CitationChip
          source={Number(rest["data-cite-source"])}
          pageStart={pageAttribute(rest["data-cite-page-start"])}
          pageEnd={pageAttribute(rest["data-cite-page-end"])}
          inert={inline}
        >
          {children}
        </CitationChip>
      );
    }
    if (classes.includes("study-unsourced")) {
      const index = rest["data-unsourced-index"];
      return <UnsourcedTag occurrence={index === undefined ? null : Number(index)} inert={inline} />;
    }
    if (classes.includes("study-claim")) {
      return <span className={UNSOURCED_CLAIM_CLASS} data-claim="unsourced">{children}</span>;
    }
    return <span className={className} {...rest}>{children}</span>;
  }
  return StudySpan;
}

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
      ["className", SAFE_STUDY_SPAN_CLASS],
      "ariaHidden",
      // Citation chips and unsourced markers from remarkCitations.
      ["dataCiteSource", /^\d{1,2}$/],
      ["dataCitePageStart", /^\d{1,4}$/],
      ["dataCitePageEnd", /^\d{1,4}$/],
      ["dataUnsourced", ""],
      ["dataUnsourcedIndex", /^\d{1,5}$/],
      ["dataClaim", "unsourced"],
      ["dataStudySkip", ""],
    ],
    math: [
      ["xmlns", SAFE_MATHML_NAMESPACE],
      ["display", "block"],
    ],
    annotation: [["encoding", "application/x-tex"]],
    mo: [["stretchy", "false"]],
    h1: [...(defaultSchema.attributes?.h1 ?? []), ["id", STUDY_HEADING_ID_PATTERN]],
    h2: [...(defaultSchema.attributes?.h2 ?? []), ["id", STUDY_HEADING_ID_PATTERN]],
    h3: [...(defaultSchema.attributes?.h3 ?? []), ["id", STUDY_HEADING_ID_PATTERN]],
    h4: [...(defaultSchema.attributes?.h4 ?? []), ["id", STUDY_HEADING_ID_PATTERN]],
    h5: [...(defaultSchema.attributes?.h5 ?? []), ["id", STUDY_HEADING_ID_PATTERN]],
    h6: [...(defaultSchema.attributes?.h6 ?? []), ["id", STUDY_HEADING_ID_PATTERN]],
  },
  strip: ["script", "style"],
  clobberPrefix: STUDY_HEADING_CLOBBER_PREFIX,
};

const components: Components = {
  span: studySpan(false),
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
  span: studySpan(true),
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

export function MarkdownBody({ source, inline = false, annotations }: { source: string; inline?: boolean; annotations?: AnnotationRecord[] }) {
  const prepared = prepareStudyMarkdown(source);
  if (!prepared) {
    return (
      <span className="prose-study" role="status">
        <span>This study content is too large to display safely.</span>
      </span>
    );
  }

  const Wrapper = inline ? "span" : "div";
  const renderedSource = normalizeDocumentText(prepared.source);
  const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => {
    function Heading({ id, children }: { id?: string; children?: React.ReactNode }) {
      return <Tag id={id || "section"}>{children}</Tag>;
    }
    return Heading;
  };
  const renderedComponents = inline
    ? inlineComponents
    : {
      ...components,
      h1: heading("h1"),
      h2: heading("h2"),
      h3: heading("h3"),
      h4: heading("h4"),
      h5: heading("h5"),
      h6: heading("h6"),
    };
  return (
    <Wrapper className={inline ? "prose-study prose-study-inline" : "prose-study"}>
      <ReactMarkdown
        skipHtml
        urlTransform={(url) => sanitizeMarkdownUrl(url) ?? ""}
        remarkPlugins={[
          [remarkGfm],
          remarkDropStudyFootnotes,
          [remarkMath, { singleDollarTextMath: true }],
          remarkStudyHeadingIds,
          // After remarkMath (math stays literal) and heading ids (ids match the outline).
          remarkCitations,
          remarkNumberUnsourced,
          remarkInkSpans,
          remarkStudyAnnotations(annotations ?? []),
        ]}
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
        components={renderedComponents}
      >
        {renderedSource}
      </ReactMarkdown>
    </Wrapper>
  );
}

export { studySanitizeSchema };
