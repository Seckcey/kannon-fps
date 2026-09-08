export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function api<T>(path: string, token?: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12000),
    });
  } catch { throw new ApiError('Could not reach the arena. Check your connection and try again.', 0); }
  let value: T & { error?: string };
  try { value = await response.json(); } catch { throw new ApiError('The arena server is unavailable. Please try again shortly.', response.status); }
  if (!response.ok) throw new ApiError(value.error || 'That request could not be completed.', response.status);
  return value;
}
