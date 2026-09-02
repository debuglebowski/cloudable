function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}
export const config = {
  controlPlaneUrl: required("CONTROL_PLANE_URL"),
  machineToken: process.env.MACHINE_TOKEN ?? "",
  /** Which `AttestationMethod` this agent authenticates with. Join token is the default: first-class, not a fallback. */
  attestationMethod: (process.env.ATTESTATION_METHOD ?? "join_token") as
    | "join_token"
    | "managed_identity",
};
