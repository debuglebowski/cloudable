import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/** First-letter-of-first-two-tokens initials, splitting on whitespace, dots, `@`, and `-` so
 * both a full name ("Amara Chen" -> "AC") and an email-as-identity ("avery.chen@example.com"
 * -> "AC") produce something legible — this app has no separate "display name" field on
 * `Person`, so email is what People has to work with. */
function initials(name: string): string {
  const [first, second] = name
    .trim()
    .split(/[\s._@-]+/)
    .filter(Boolean);
  if (!first) return "?";
  if (!second) return first.slice(0, 2).toUpperCase();
  return (first.charAt(0) + second.charAt(0)).toUpperCase();
}

/**
 * Soft-fill/saturated-text pairs, same shape as the ok/drift/stale badge tokens
 * (pale background, dark saturated text) — self-contained chip colors, not page
 * surfaces, so — like those — they're left exactly the same in dark mode rather
 * than redefined: a person's color is part of their identity, not the theme.
 * Picked for even hue spacing (not just "8 random colors") so adjacent people in
 * a list are unlikely to land on visually similar hues.
 */
const AVATAR_PALETTE: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: "0 72% 92%", fg: "0 65% 38%" }, // red
  { bg: "25 85% 90%", fg: "22 75% 35%" }, // orange
  { bg: "45 85% 88%", fg: "38 70% 32%" }, // amber
  { bg: "150 45% 90%", fg: "152 50% 26%" }, // green
  { bg: "175 45% 88%", fg: "175 50% 26%" }, // teal
  { bg: "205 65% 90%", fg: "205 60% 34%" }, // blue
  { bg: "245 55% 93%", fg: "245 45% 48%" }, // indigo
  { bg: "285 50% 92%", fg: "285 40% 42%" }, // violet
  { bg: "330 60% 92%", fg: "330 55% 42%" }, // pink
];

/** Deterministic, not random — the same person gets the same color every render
 * (and across sessions), which matters once you're scanning the same list daily.
 * `% AVATAR_PALETTE.length` guarantees an in-bounds index; the `as` below is
 * `noUncheckedIndexedAccess` paperwork, not an actual escape hatch. */
function paletteFor(key: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[index] as { bg: string; fg: string };
}

export function PersonAvatar({ name, className }: { name: string; className?: string }) {
  const { bg, fg } = paletteFor(name);
  return (
    <Avatar className={cn("size-6", className)}>
      <AvatarFallback
        className="text-[10px] font-medium"
        style={{ backgroundColor: `hsl(${bg})`, color: `hsl(${fg})` }}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
