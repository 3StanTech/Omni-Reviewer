/** Copy hats Kirby can wear in a pack (Dream Land only). */
export const KIRBY_HATS = ["sword", "beam", "fire", "cook", "parasol", "mike"] as const;

export type KirbyHatId = (typeof KIRBY_HATS)[number];

/** FNV-1a 32-bit hash of the pack id, so a pack keeps the same hat on every device. */
export function kirbyHat(packId: string): KirbyHatId {
  let hash = 0x811c9dc5;
  for (let i = 0; i < packId.length; i++) {
    hash ^= packId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return KIRBY_HATS[(hash >>> 0) % KIRBY_HATS.length];
}
