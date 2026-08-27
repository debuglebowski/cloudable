import { config } from "./config";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.controlPlaneUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.machineToken}`, ...init?.headers },
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => undefined));
  return res.json() as Promise<T>;
}
