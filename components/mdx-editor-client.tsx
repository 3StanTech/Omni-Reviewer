"use client";

import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
  InsertTable,
  ListsToggle,
  MDXEditor,
  UndoRedo,
  headingsPlugin,
  linkPlugin,
  listsPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
} from "@mdxeditor/editor";

import "@mdxeditor/editor/style.css";

type MdxEditorClientProps = {
  markdown: string;
  onChange: (markdown: string) => void;
  ariaLabel: string;
};

export function MdxEditorClient({ markdown, onChange, ariaLabel }: MdxEditorClientProps) {
  return (
    <div className="study-editor-rich" aria-label={ariaLabel}>
      <MDXEditor
        markdown={markdown}
        onChange={onChange}
        contentEditableClassName="study-editor-content"
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          linkPlugin(),
          tablePlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <BlockTypeSelect />
                <BoldItalicUnderlineToggles />
                <ListsToggle />
                <CreateLink />
                <InsertTable />
              </>
            ),
          }),
        ]}
      />
    </div>
  );
}
