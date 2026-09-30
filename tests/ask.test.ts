import { describe, expect, it, vi } from "vitest";
import {
  ASK_HISTORY_CHARS,
  ASK_HISTORY_MESSAGES,
  buildAskPrompt,
  buildAskWhyQuestion,
  buildExplainQuestion,
  groundAnswer,
  MAX_ASK_WHY_SENTENCE_CHARS,
  originKeyFor,
  parseAskAnswer,
  REFUSAL_MARKER,
  selectAskSources,
} from "@/lib/ask";
import * as grounding from "@/lib/grounding";
import { UNSOURCED_TOKEN } from "@/lib/citations";
import { splitPages } from "@/lib/source-markers";

const SLIDES = [
  "<<<page 1>>>",
  "",
  "Aminoglycosides such as gentamicin bind the 30S ribosomal subunit and cause misreading of mRNA.",
  "",
  "<<<page 2>>>",
  "",
  "Weather patterns in the northern hemisphere shift with the seasons and ocean currents.",
  "",
  "<<<page 3>>>",
  "",
  "Macrolides bind the 50S ribosomal subunit and block translocation during protein synthesis.",
  "",
  "<<<page 4>>>",
  "",
  "Gardening tips for tomatoes include regular watering and plenty of sunlight.",
].join("\n");

describe("selectAskSources", () => {
  it("sends everything when the pack fits the budget", () => {
    const sources = [{ filename: "a.pdf", text: SLIDES, sourceId: "s1" }];
    const result = selectAskSources(sources, "anything", 10_000);
    expect(result.pagesSent).toBe("all");
    expect(result.texts).toEqual(sources);
  });

  it("keeps the best pages in page order with markers when over budget", () => {
    const sources = [{ filename: "a.pdf", text: SLIDES, sourceId: "s1" }];
    const result = selectAskSources(sources, "ribosomal subunit binding by macrolides and aminoglycosides", 260);
    expect(result.pagesSent).toEqual({ 1: [1, 3] });
    const text = result.texts[0].text;
    expect(text.indexOf("<<<page 1>>>")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("<<<page 1>>>")).toBeLessThan(text.indexOf("<<<page 3>>>"));
    expect(text).not.toContain("<<<page 2>>>");
    expect(splitPages(text).map((page) => page.page)).toEqual([1, 3]);
    expect(result.texts[0].sourceId).toBe("s1");
  });

  it("keeps a source without pages whole when it fits and one entry per source", () => {
    const notes = { filename: "notes.txt", text: "Gentamicin binds the 30S subunit and is bactericidal." };
    const other = { filename: "b.pdf", text: SLIDES };
    const result = selectAskSources([other, notes], "gentamicin 30S subunit", 200);
    expect(result.texts).toHaveLength(2);
    expect(result.texts[1].text).toBe(notes.text);
    expect(result.pagesSent[2]).toEqual([0]);
  });

  it("leaves a source empty (not removed) when nothing of it fits", () => {
    const big = { filename: "big.txt", text: "x".repeat(500) };
    const result = selectAskSources([big, { filename: "a.pdf", text: SLIDES }], "ribosomal", 200);
    expect(result.texts[0].text).toBe("");
    expect(result.pagesSent).not.toHaveProperty("1");
  });
});

describe("buildAskPrompt", () => {
  const sources = [{ filename: "pharm.pdf", text: SLIDES }];

  it("frames sources as S<n> blocks with the tutor rules", () => {
    const prompt = buildAskPrompt({ sources, history: [], question: "What do macrolides do?" });
    expect(prompt).toContain("### Source S1: pharm.pdf (pages 1-4)");
    expect(prompt).toContain("ONLY the source materials");
    expect(prompt).toContain(`first line exactly ${REFUSAL_MARKER}`);
    expect(prompt).toContain("[S1 p.14]");
    expect(prompt).toContain("No raw HTML");
    expect(prompt).toContain("250 words");
    expect(prompt).toContain("What do macrolides do?");
    expect(prompt).not.toContain("\u2014");
  });

  it("lists only the pages that were sent", () => {
    const partial = [{ filename: "pharm.pdf", text: "<<<page 1>>>\n\nA\n\n<<<page 3>>>\n\nB\n\n<<<page 4>>>\n\nC" }];
    expect(buildAskPrompt({ sources: partial, history: [], question: "q" })).toContain("(pages 1, 3-4)");
  });

  it("passes the last 6 history messages, each cut to 2,000 characters", () => {
    const history = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `msg${i}-${"z".repeat(3000)}`,
    }));
    const prompt = buildAskPrompt({ sources, history, question: "next?" });
    expect(prompt).not.toContain("msg0-");
    expect(prompt).not.toContain("msg1-");
    expect(prompt).toContain("msg2-");
    expect(prompt).toContain("msg7-");
    expect(ASK_HISTORY_MESSAGES).toBe(6);
    const longest = Math.max(...prompt.split("\n").map((line) => line.length));
    expect(longest).toBeLessThanOrEqual(ASK_HISTORY_CHARS + "Student: ".length);
  });
});

describe("parseAskAnswer", () => {
  it("detects and strips the refusal marker", () => {
    const parsed = parseAskAnswer(`${REFUSAL_MARKER}\nThe lecture covers macrolides nearby. [S1 p.3]`, 1);
    expect(parsed.refused).toBe(true);
    expect(parsed.markdown).toBe("The lecture covers macrolides nearby. [S1 p.3]");
  });

  it("returns a normal answer unchanged and drops unknown sources", () => {
    const parsed = parseAskAnswer("Gentamicin binds 30S. [S1 p.1] It is bactericidal. [S4 p.2]", 2);
    expect(parsed.refused).toBe(false);
    expect(parsed.markdown).toBe("Gentamicin binds 30S. [S1 p.1] It is bactericidal.");
  });
});

describe("parseAskAnswer with reasoning sections", () => {
  const sampleA =
    '### Reasoning Summary\n\n1. **Analyze the Source Material**: \n   - Source S3 ("Amplitude Modulation_Princom.pdf") defines the modulation index ($m$) as the ratio [S3 p.9].\n\n---\n\n### Answer\n\nThe modulation index is the ratio of message to carrier amplitude. [S3 p.13]';
  const sampleB =
    "### Reasoning Summary\n\n1. **Analyze the Source Material**: \n   - The provided sources consist of a pharmacology lecture ... \n   - None of these documents contain information regarding sports, football, or the 2022 FIFA World Cup.\n\n2. **Formulate the Answer**:\n   - Since the question is completely outside the scope of the provided lecture materials, the response must indicate that the information is not available in the sources.\n\n---\n\n### Answer\n\n The provided lecture materials do not cover sports or the 2022 FIFA World Cup; they focus on pharmacology, control systems, and amplitude modulation.";

  it("keeps only the text after the Answer heading (covered question)", () => {
    const parsed = parseAskAnswer(sampleA, 3);
    expect(parsed.refused).toBe(false);
    expect(parsed.markdown).toBe("The modulation index is the ratio of message to carrier amplitude. [S3 p.13]");
  });

  it("keeps only the final sentence for an uncovered question without a marker", () => {
    const parsed = parseAskAnswer(sampleB, 3);
    expect(parsed.refused).toBe(false);
    expect(parsed.markdown).toBe(
      "The provided lecture materials do not cover sports or the 2022 FIFA World Cup; they focus on pharmacology, control systems, and amplitude modulation.",
    );
  });

  it("marks a refusal when the marker follows a reasoning section", () => {
    const parsed = parseAskAnswer(`${sampleB.split("### Answer")[0]}### Answer\n\n${REFUSAL_MARKER}\nThe lecture covers pharmacology nearby.`, 3);
    expect(parsed.refused).toBe(true);
    expect(parsed.markdown).toBe("The lecture covers pharmacology nearby.");
  });

  it("finds the marker after a reasoning section with no Answer heading", () => {
    const parsed = parseAskAnswer(`## Analysis\n\nNothing relevant.\n\n---\n\n${REFUSAL_MARKER}\nThe lecture covers X.`, 1);
    expect(parsed.refused).toBe(true);
    expect(parsed.markdown).toBe("The lecture covers X.");
  });

  it("drops a leading reasoning section up to the next heading", () => {
    const parsed = parseAskAnswer("## Thinking\n\nsome notes\n\n## Binding\n\nIt binds 30S. [S1 p.1]", 1);
    expect(parsed.markdown).toBe("## Binding\n\nIt binds 30S. [S1 p.1]");
  });

  it("uses the last Answer line and accepts bold or plain forms", () => {
    expect(parseAskAnswer("**Final answer:**\nHello there friend.", 1).markdown).toBe("Hello there friend.");
    expect(parseAskAnswer("Answer\nOne.\n\n### Answer\n\nTwo.", 1).markdown).toBe("Two.");
  });

  it("asks for the final answer only and repeats the refusal rule last", () => {
    const prompt = buildAskPrompt({ sources: [{ filename: "a", text: "t" }], history: [], question: "q?" });
    expect(prompt).toContain("Do not write a reasoning summary");
    expect(prompt.trimEnd().split("\n").pop()).toContain(REFUSAL_MARKER);
  });
});

describe("groundAnswer", () => {
  const sources = [{ index: 1, text: SLIDES }];

  it("trusts cited sentences and tags only uncited claim sentences", async () => {
    const markdown = [
      "Macrolides cause severe kidney failure through mitochondrial collapse in nephrons. [S1 p.3]",
      "",
      "Aminoglycosides such as gentamicin bind the 30S ribosomal subunit and cause misreading of mRNA.",
      "",
      "Bananas grow best in tropical climates with heavy rainfall every year.",
    ].join("\n");
    const { markdown: out, report } = await groundAnswer(markdown, sources);
    const lines = out.split("\n");
    expect(lines[0]).toBe("Macrolides cause severe kidney failure through mitochondrial collapse in nephrons. [S1 p.3]");
    expect(lines[2]).toBe(
      `Aminoglycosides such as gentamicin bind the 30S ribosomal subunit and cause misreading of mRNA. ${UNSOURCED_TOKEN}`,
    );
    expect(lines[4]).toBe(`Bananas grow best in tropical climates with heavy rainfall every year. ${UNSOURCED_TOKEN}`);
    expect(report).toMatchObject({ total: 3, cited: 1, unsourced: 2, verifierFailed: false, truncated: false });
  });

  it("leaves short sentences and existing tokens alone", async () => {
    const markdown = `Short one here.\n\nBananas grow best in tropical climates with heavy rain. ${UNSOURCED_TOKEN}`;
    const { markdown: out, report } = await groundAnswer(markdown, sources);
    expect(out).toBe(markdown);
    expect(report.unsourced).toBe(1);
  });

  it("treats list items and table rows like documents", async () => {
    const markdown = [
      "- Gentamicin binds the 30S subunit of bacterial ribosomes. [S1 p.1]",
      "- Bananas grow best in tropical climates with heavy rainfall.",
      "",
      "| Drug | Effect |",
      "| --- | --- |",
      "| Macrolides | Bind the 50S subunit and block translocation. [S1 p.3] |",
      "| Bananas | Grow best in tropical climates with heavy rainfall |",
    ].join("\n");
    const { markdown: out } = await groundAnswer(markdown, sources);
    const lines = out.split("\n");
    expect(lines[0]).not.toContain(UNSOURCED_TOKEN);
    expect(lines[1]).toBe(`- Bananas grow best in tropical climates with heavy rainfall. ${UNSOURCED_TOKEN}`);
    expect(lines[5]).not.toContain(UNSOURCED_TOKEN);
    expect(lines[6]).toBe(`| Bananas | Grow best in tropical climates with heavy rainfall ${UNSOURCED_TOKEN} |`);
  });

  it("does not tag a colon lead-in before cited bullets", async () => {
    const markdown = [
      "Antimicrobials that exhibit a PAE include:",
      "",
      "- Aminoglycosides show a post-antibiotic effect against gram-negative bacilli. [S1 p.1]",
      "- Fluoroquinolones show a post-antibiotic effect against gram-negative bacilli. [S1 p.1]",
      "- Macrolides show a post-antibiotic effect against many gram-positive cocci. [S1 p.3]",
      "- Tetracyclines show a post-antibiotic effect against many gram-positive cocci. [S1 p.3]",
      "- Carbapenems show a post-antibiotic effect against gram-positive cocci only. [S1 p.3]",
      "- Rifampin shows a post-antibiotic effect against mycobacteria and staphylococci. [S1 p.3]",
      "- Vancomycin shows a post-antibiotic effect against gram-positive cocci only. [S1 p.3]",
    ].join("\n");
    const { markdown: out, report } = await groundAnswer(markdown, sources);
    expect(out).toBe(markdown);
    expect(report.unsourced).toBe(0);
  });

  it("still tags uncited bullets after a colon lead-in", async () => {
    const markdown = "Common examples include:\n\n- Bananas grow best in tropical climates with heavy rainfall.\n- Short item here.";
    const { markdown: out } = await groundAnswer(markdown, sources);
    expect(out).toBe(
      `Common examples include:\n\n- Bananas grow best in tropical climates with heavy rainfall. ${UNSOURCED_TOKEN}\n- Short item here.`,
    );
  });

  it("never calls the verifier or the document grounder", async () => {
    const groundSpy = vi.spyOn(grounding, "groundDocument");
    const result = await groundAnswer("Bananas grow best in tropical climates with heavy rainfall every year.", sources);
    expect(groundSpy).not.toHaveBeenCalled();
    expect(result.report.verifierFailed).toBe(false);
    expect(result.report.unchecked).toBeUndefined();
    groundSpy.mockRestore();
  });
});

describe("buildExplainQuestion", () => {
  it("includes the key, the chosen answer and the explanation for a Test Me item", () => {
    const { prompt, displayText } = buildExplainQuestion({
      question: "Which subunit do aminoglycosides bind?",
      choices: ["30S", "50S"],
      answer: "30S",
      explanation: "Aminoglycosides bind the 30S subunit. [S1 p.14]",
      chosen: "50S",
    });
    expect(prompt).toContain("Answer key: 30S");
    expect(prompt).toContain("I chose: 50S (incorrect)");
    expect(prompt).toContain("Aminoglycosides bind the 30S subunit.");
    expect(prompt).not.toContain("[S1");
    expect(displayText).toBe("Explain: Which subunit do aminoglycosides bind?");
  });

  it("removes every stored citation from the prompt", () => {
    const item = buildExplainQuestion({
      question: "Which subunit? [S2 p.3]",
      choices: ["30S [S1 p.1]", "50S [[unsourced]]"],
      answer: "30S [S1 p.1]",
      explanation: "Binds 30S. [S1 p.14] [[unsourced]]",
      chosen: "50S [S3]",
    });
    const card = buildExplainQuestion({ front: "{{30S}} [S1 p.2]", back: "Aminoglycosides. [S1 p.14]" });
    for (const { prompt } of [item, card]) {
      expect(prompt).not.toContain("[S");
      expect(prompt).not.toContain(UNSOURCED_TOKEN);
    }
    expect(item.prompt).toContain("Binds 30S.");
  });

  it("cuts the display stem to 120 characters", () => {
    const { displayText } = buildExplainQuestion({ question: "q".repeat(300), answer: "a", chosen: "a" });
    expect(displayText.length).toBe("Explain: ".length + 120);
  });

  it("blanks cloze braces in a card front", () => {
    const { prompt, displayText } = buildExplainQuestion({
      front: "{{Gentamicin}} binds the {{30S}} subunit",
      back: "Aminoglycosides. [S1 p.14]",
    });
    expect(displayText).toBe("Explain: ____ binds the ____ subunit");
    expect(prompt).toContain("Front: ____ binds the ____ subunit");
    expect(prompt).not.toContain("{{");
  });
});

describe("buildAskWhyQuestion and originKeyFor", () => {
  it("strips citations, caps the sentence and asks the support question", () => {
    const { prompt, displayText } = buildAskWhyQuestion(`${"Word ".repeat(600)} [S1 p.2] ${UNSOURCED_TOKEN}`);
    expect(prompt).toContain("Is this supported by my slides?");
    expect(prompt).not.toContain("[S1");
    expect(prompt).not.toContain(UNSOURCED_TOKEN);
    expect(prompt.length).toBeLessThan(MAX_ASK_WHY_SENTENCE_CHARS + 200);
    expect(displayText.startsWith("Ask why: ")).toBe(true);
  });

  it("builds stable origin keys", () => {
    expect(originKeyFor({ kind: "ask", question: "hi" })).toBeNull();
    expect(originKeyFor({ kind: "explain", target: { type: "test_item", itemId: "q1", chosen: "A" } })).toBe("test:q1");
    expect(originKeyFor({ kind: "explain", target: { type: "card", cardId: "c1" } })).toBe("card:c1");
    const a = originKeyFor({ kind: "ask_why", sentence: "  Gentamicin binds 30S. [S1 p.1] " });
    const b = originKeyFor({ kind: "ask_why", sentence: "gentamicin   binds 30S." });
    expect(a).toMatch(/^why:[0-9a-f]{40}$/);
    expect(a).toBe(b);
    expect(originKeyFor({ kind: "ask_why", sentence: "different sentence" })).not.toBe(a);
  });
});
