function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}
export const config = {
  controlPlaneUrl: required("CONTROL_PLANE_URL"),
  machineToken: process.env.MACHINE_TOKEN ?? "",
};
