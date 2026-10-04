import { describe, expect, it } from "vitest";
import { canonicalizeLatex } from "@/lib/latex-text";

function words(text: string): string[] {
  return canonicalizeLatex(text).split(/[^\p{L}\p{N}%.]+/u).filter(Boolean);
}

describe("canonicalizeLatex", () => {
  it("returns text without LaTeX unchanged", () => {
    expect(canonicalizeLatex("Vitamin K at 50 W, 80% duty.")).toBe("Vitamin K at 50 W, 80% duty.");
  });

  it("unwraps text commands and keeps units", () => {
    expect(words(String.raw`$P_c = 50\text{ W}$ and $\mathrm{dB}$ and $\mathbf{SNR}$`)).toEqual(["50", "W", "and", "dB", "and", "SNR"]);
  });

  it("keeps fractions, sub- and superscripts as their content and drops lone variable letters", () => {
    expect(words(String.raw`$$P_t = P_c \left( 1 + \frac{m^2}{2} \right)$$`)).toEqual(["1", "2", "2"]);
    expect(words(String.raw`$E_{m1}$ and $E_{\text{max}}$`)).toEqual(["m1", "and", "max"]);
  });

  it("maps escaped percent and Greek letters, and drops relation and operator commands", () => {
    expect(words(String.raw`$\ge 50\%$ at $\omega_c \approx 2\pi \times 10^{6}$ with $\theta \pm \alpha \cdot \sim \le \geq \leq$`)).toEqual([
      "50%", "at", "omega", "2", "pi", "10", "6", "with", "theta", "alpha",
    ]);
  });

  it("never leaves command words behind", () => {
    const out = words(String.raw`$\frac{a}{b} \left( \text{x} \right) \mathrm{y} \mathbf{z} \, \sqrt{2}$`);
    for (const command of ["frac", "left", "right", "text", "mathrm", "mathbf", "sqrt"]) expect(out).not.toContain(command);
  });

  it("keeps ordinary words between currency amounts", () => {
    expect(words("It costs $5 and $6 today.")).toEqual(["It", "costs", "5", "and", "6", "today."]);
  });
});
