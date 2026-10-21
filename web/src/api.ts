export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: any) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/login')) onUnauthorized();
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? data?.error ?? `Error ${res.status}`, data);
  }
  return data as T;
}

/** Sends a file as the raw request body (the library's upload routes). */
export async function uploadFile<T = any>(method: 'PUT' | 'POST', url: string, file: File | Blob): Promise<T> {
  const res = await fetch(url, { method, credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file });
  let data: any = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? data?.error ?? `Error ${res.status}`, data);
  }
  return data as T;
}

/** The address of an asset's bytes (the reduced copy for thumbnails, when there is one). */
export const assetUrl = (id: string, light = false, download = false) =>
  `/api/assets/${id}/file${light || download ? '?' : ''}${light ? 'variant=light' : ''}${light && download ? '&' : ''}${download ? 'download=1' : ''}`;
