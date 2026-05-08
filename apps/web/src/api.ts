/**
 * Typed REST client for the Bongos Hero backend.
 *
 * All requests use relative `/api/*` URLs; Vite's dev server proxies them to
 * `http://localhost:5174` and a production deploy is expected to colocate the
 * static bundle behind the same origin as the API.
 *
 * Non-2xx responses surface as an `ApiError` so callers can branch on
 * `err.status` (404 ≠ 500 ≠ network failure) without parsing strings.
 */

import type { ChartV1, JobState, SongMeta } from '@bongos-hero/shared';

/** Thrown by every helper in this module on a non-2xx response. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `API error ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function readBody(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  try {
    return await res.text();
  } catch {
    return null;
  }
}

async function request<T>(path: string, init?: RequestInit & { jsonBody?: unknown }): Promise<T> {
  const headers = new Headers(init?.headers);
  let body: BodyInit | undefined = init?.body ?? undefined;

  if (init?.jsonBody !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.jsonBody);
  }

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, body });
  } catch (err) {
    // Network failure / CORS / DNS — wrap as ApiError(0).
    const msg = err instanceof Error ? err.message : 'network error';
    throw new ApiError(0, null, `Network error: ${msg}`);
  }

  if (!res.ok) {
    const parsed = await readBody(res);
    throw new ApiError(res.status, parsed, `API ${res.status} ${res.statusText}`);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    return (await res.json()) as T;
  }
  // Fall back to text for non-JSON 2xx responses (caller may expect string).
  return (await res.text()) as unknown as T;
}

export async function listSongs(): Promise<SongMeta[]> {
  return request<SongMeta[]>('/api/songs');
}

export async function importSong(url: string): Promise<{ jobId: string }> {
  return request<{ jobId: string }>('/api/import', {
    method: 'POST',
    jsonBody: { url },
  });
}

export async function getJob(id: string): Promise<JobState> {
  return request<JobState>(`/api/jobs/${encodeURIComponent(id)}`);
}

export async function getSong(id: string): Promise<SongMeta> {
  return request<SongMeta>(`/api/songs/${encodeURIComponent(id)}`);
}

export async function getSongChart(id: string): Promise<ChartV1> {
  return request<ChartV1>(`/api/songs/${encodeURIComponent(id)}/chart`);
}

export async function deleteSong(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/songs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export interface RechartTunables {
  rmsFloor?: number;
  minSpacingMs?: number;
  centroidThreshold?: number;
}

export interface RechartOptions extends RechartTunables {
  /**
   * When true, the server builds the chart and returns it WITHOUT persisting
   * it over the existing chart.json. Used by the re-chart UI to render a
   * mini-timeline preview before the user commits.
   */
  preview?: boolean;
}

/**
 * Re-run the chart pipeline on an already-imported song with adjustable
 * tunables. By default (`preview` falsy) the result is persisted; pass
 * `preview: true` to receive the built chart without touching the on-disk
 * `chart.json`.
 */
export async function rechartSong(id: string, opts: RechartOptions = {}): Promise<ChartV1> {
  const body: Record<string, unknown> = { songId: id };
  if (typeof opts.rmsFloor === 'number') body.rmsFloor = opts.rmsFloor;
  if (typeof opts.minSpacingMs === 'number') body.minSpacingMs = opts.minSpacingMs;
  if (typeof opts.centroidThreshold === 'number') body.centroidThreshold = opts.centroidThreshold;
  if (opts.preview === true) body.preview = true;
  const res = await request<{ chart: ChartV1 }>('/api/rechart', {
    method: 'POST',
    jsonBody: body,
  });
  return res.chart;
}

export function songAudioUrl(id: string): string {
  return `/api/songs/${encodeURIComponent(id)}/audio`;
}
