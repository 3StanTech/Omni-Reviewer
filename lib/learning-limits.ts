/** Shared bounds for model output and persisted study-mode payloads. */
export const MAX_TEST_ME_ITEMS = 100;
export const MAX_CARDED_ITEMS = 100;
export const MAX_TEST_ME_CHOICES = 8;

export const MAX_LEARNING_ID_CHARS = 200;
export const MAX_TEST_ME_QUESTION_CHARS = 20_000;
export const MAX_TEST_ME_CHOICE_CHARS = 2_000;
export const MAX_TEST_ME_ANSWER_CHARS = 20_000;
export const MAX_TEST_ME_EXPLANATION_CHARS = 20_000;
export const MAX_CARD_FRONT_CHARS = 20_000;
export const MAX_CARD_BACK_CHARS = 20_000;

/** JSON text is capped before it can enter a persistence boundary. */
export const MAX_GENERATED_JSON_CHARS = 1_000_000;
export const MAX_GENERATED_MARKDOWN_CHARS = 500_000;

/** Request/persistence cap for one legacy bulk attempt payload. */
export const MAX_TEST_ATTEMPT_ITEMS = 100;
export const MAX_TEST_ATTEMPT_SELECTED_ANSWER_CHARS = 20_000;

/** Approximate token budgets used when a tokenizer is not available server-side. */
export const MAX_GENERATION_PROMPT_TOKENS = 165_000;
export const MAX_GENERATION_TEXT_OUTPUT_TOKENS = 40_000;
export const MAX_GENERATION_JSON_OUTPUT_TOKENS = 50_000;

/** Vision transcription is bounded independently of general text generation. */
export const MAX_VISION_TEXT_CHARS = 100_000;
export const MAX_VISION_OUTPUT_TOKENS = Math.ceil(MAX_VISION_TEXT_CHARS / 4);
