/**
 * Acronyms with a well-established synonym the sources may use instead. The
 * term guard treats the acronym as present when the source has any alias.
 * Add a pair only after a real false flag, and only when the two name the
 * same thing (PCP is the older name of PJP).
 */
export const ACRONYM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  PCP: [
    "PJP",
    "pneumocystis jiroveci pneumonia",
    "pneumocystis jirovecii pneumonia",
    "pneumocystis carinii pneumonia",
    "pneumocystis pneumonia",
  ],
  // AZT (azidothymidine) is the older name of zidovudine.
  AZT: ["zidovudine"],
  // CXR is the usual shorthand for a chest X-ray (chest radiograph).
  CXR: ["chest x-ray", "chest radiograph"],
};
