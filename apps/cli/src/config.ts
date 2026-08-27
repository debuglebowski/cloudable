function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}
export const config = {
  apiUrl: required("CLOUDABLE_API_URL"),
};
