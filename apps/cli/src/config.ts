// ---------------------------------------------------------------------------
// Read lazily, through a getter, so it is the *use* of the API URL that
// demands it and not merely importing a command module. Without that, a
// mistyped flag reports the missing env var instead of the mistyped flag.
// ---------------------------------------------------------------------------
function required(name: string, hint: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}\n\n${hint}`);
  return v;
}

export const config = {
  get apiUrl(): string {
    return required(
      "CLOUDABLE_API_URL",
      "Point it at your control plane, e.g. export CLOUDABLE_API_URL=https://cloudable.example.com",
    );
  },
};
