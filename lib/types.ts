/** Shared TypeScript types mirroring `lib/schema.ts`. */

export type SourceKind =
  | "pdf"
  | "image"
  | "text"
  | "document"
  | "presentation"
  | "paste"
  | "video"
  | "audio";

export type IngestStatus = "ready" | "unprocessed" | "failed";

export type ViewKind = "locked_in" | "summary" | "test_me" | "carded";

export type GenerationJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "partial";

export type GenerationJobStep = "locked_in" | "summary" | "test_me" | "carded";

export type GenerationJobMode = "full" | "single";

export type Topic = {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: Date;
};

export type Reviewer = {
  id: string;
  topicId: string;
  name: string;
  createdAt: Date;
  lastGeneratedAt: Date | null;
  examDate: string | null;
};

export type Source = {
  id: string;
  reviewerId: string;
  filename: string;
  mime: string;
  kind: SourceKind;
  blobUrl: string | null;
  blobPathname: string | null;
  ingestStatus: IngestStatus;
  extractedText: string | null;
  errorMessage: string | null;
  createdAt: Date;
};

export type StudyView = {
  id: string;
  reviewerId: string;
  kind: ViewKind;
  content: string;
  contentJson: unknown | null;
  modelId?: string | null;
  generationRunId?: string | null;
  generatedAt: Date;
  revision: number;
  isEdited: boolean;
  isPinned: boolean;
  updatedAt: Date;
};

export type GenerationJob = {
  id: string;
  reviewerId: string;
  status: GenerationJobStatus;
  step: GenerationJobStep | null;
  mode: GenerationJobMode;
  intent: "generate_missing" | "redo";
  targetKinds: ViewKind[];
  completedKinds: ViewKind[];
  upstreamRevisions: Partial<Record<ViewKind, number>>;
  generationRunId: string;
  active: boolean;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  claimedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  modelUsed: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  forceOverwrite: boolean;
};

export type TestMeItem = {
  id: string;
  question: string;
  /** New generated items are MC; legacy v1 items may remain open-ended. */
  choices?: string[];
  answer: string;
  explanation: string;
};

export type CardedItem = {
  id: string;
  front: string;
  back: string;
  /** Inferred from the validated {{answer}} template when present. */
  kind?: "basic" | "cloze";
};

export type CardRating = "again" | "good";

export type DurableCard = CardedItem & {
  sourceKey: string;
  revision: number;
  isEdited: boolean;
  isPinned: boolean;
  dueAt: Date;
  intervalDays: number;
  repetitions: number;
  easeFactor: number;
  lastReviewedAt: Date | null;
};

export type TestAttemptStats = {
  itemId: string;
  attempts: number;
  misses: number;
  lastAttemptedAt: Date | null;
};
