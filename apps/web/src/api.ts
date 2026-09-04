export class ApiFailure extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
    };
    throw new ApiFailure(
      response.status,
      body.message ?? body.error ?? `Request failed (${response.status})`,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
export const put = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
