/**
 * Friendly default name for a machine created without one — "Add machine"
 * makes `name` optional (see `MachineService.create`), and this is what
 * fills the gap. `random` is injectable so tests can force a specific
 * sequence instead of relying on luck. 24×24×65536 ≈ 37.7M combinations
 * before `MachineService`'s own per-org uniqueness check even matters.
 */
const ADJECTIVES = [
  "swift",
  "calm",
  "bright",
  "quiet",
  "bold",
  "brave",
  "clever",
  "cosmic",
  "eager",
  "gentle",
  "golden",
  "happy",
  "keen",
  "lively",
  "lucky",
  "mighty",
  "nimble",
  "noble",
  "quick",
  "rapid",
  "sharp",
  "sturdy",
  "vivid",
  "wise",
] as const;

const NOUNS = [
  "falcon",
  "otter",
  "harbor",
  "meadow",
  "canyon",
  "comet",
  "ember",
  "forest",
  "glacier",
  "horizon",
  "island",
  "lagoon",
  "maple",
  "orbit",
  "pebble",
  "ridge",
  "river",
  "summit",
  "tundra",
  "willow",
  "beacon",
  "cove",
  "dune",
  "fjord",
] as const;

export function generateDefaultMachineName(random: () => number = Math.random): string {
  const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(random() * NOUNS.length)];
  const suffix = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `${adjective}-${noun}-${suffix}`;
}
