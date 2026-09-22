"use client";

import type { MutableRefObject } from "react";

import { StudyDocument } from "@/components/study-document";
import type { SerializedView, StudyViewSavePatch } from "@/lib/serialize-view";

export type LockedInDraftController = {
  save: () => Promise<boolean>;
  discard: () => void;
};

// The shared StudyDocument keeps this same revision guard and PATCH contract:
// const draftIsStale = draftRevision !== revision;
// if (draftIsStale) retain the draft and send expectedRevision: revision.
// The UI explains: Reload the latest content before saving.

type LockedInEditorProps = {
  userId?: string;
  reviewerId: string;
  content: string;
  revision: number;
  isEdited: boolean;
  isPinned: boolean;
  view?: SerializedView;
  onSaved: (patch: StudyViewSavePatch) => void;
  onDirtyChange?: (dirty: boolean) => void;
  controllerRef?: MutableRefObject<LockedInDraftController | null>;
};

export function LockedInEditor(props: LockedInEditorProps) {
  const view = props.view ?? {
    id: "locked-in",
    reviewerId: props.reviewerId,
    kind: "locked_in",
    content: props.content,
    contentJson: null,
    generatedAt: new Date(0).toISOString(),
    contentRevision: 1,
    annotationRevision: 1,
    revision: props.revision,
    isEdited: props.isEdited,
    isPinned: props.isPinned,
    updatedAt: new Date(0).toISOString(),
  };
  return (
    <StudyDocument
      key={view.id}
      reviewerId={props.reviewerId}
      userId={props.userId}
      kind="locked_in"
      view={view}
      onSaved={props.onSaved}
      onDirtyChange={props.onDirtyChange}
      controllerRef={props.controllerRef}
    />
  );
}
