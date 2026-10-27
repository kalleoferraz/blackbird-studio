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

/** Sends a file as the raw request body (the library's upload routes). `onProgress` gets the share sent, 0 to 1. */
export function uploadFile<T = any>(method: 'PUT' | 'POST', url: string, file: File | Blob, onProgress?: (done: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    x.withCredentials = true;
    x.setRequestHeader('content-type', 'application/octet-stream');
    if (onProgress) x.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total); };
    x.onerror = () => reject(new ApiError(0, 'network', 'The upload could not reach the server.', null));
    x.onload = () => {
      let data: any = null;
      try { data = JSON.parse(x.responseText); } catch { /* no body */ }
      if (x.status >= 200 && x.status < 300) { onProgress?.(1); resolve(data as T); return; }
      if (x.status === 401) onUnauthorized();
      reject(new ApiError(x.status, data?.error ?? 'error', data?.message ?? data?.error ?? `Error ${x.status}`, data));
    };
    x.send(file);
  });
}

/** The address of an asset's bytes (the reduced copy for thumbnails, when there is one). */
export const assetUrl = (id: string, light = false, download = false) =>
  `/api/assets/${id}/file${light || download ? '?' : ''}${light ? 'variant=light' : ''}${light && download ? '&' : ''}${download ? 'download=1' : ''}`;

/** Downloads a JSON/other response as a file the user saves (the server names it in Content-Disposition). */
export async function downloadAs(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    let data: any = null;
    try { data = await res.json(); } catch { /* no body */ }
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? data?.error ?? `Error ${res.status}`, data);
  }
  const header = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  const name = star ? decodeURIComponent(star[1]!) : fallbackName;
  const href = URL.createObjectURL(await res.blob());
  startDownload(href, name);
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** Starts a browser download of an address that streams a file (a large zip): the browser saves it as it arrives. */
export function startDownload(href: string, name = ''): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
