import { config } from "./config";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

// No auth header by default — CLI auth is a certificate/session flow handled by
// `cloudable login`, a separate feature unit's job.
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => undefined));
  return res.json() as Promise<T>;
}
