import type { AiBot, GenerateResponse, History, OpenGeoConfig, ProdResponse, State, TestMode, TestResponse } from './types';

/**
 * Every call goes to this page's own origin, which is 127.0.0.1. There is no other host in this
 * file and there never should be: the dashboard's whole claim is that nothing leaves the machine.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(`The server replied with something that was not JSON (${response.status}).`, response.status);
  }
  if (!response.ok) {
    const record = (body ?? {}) as Record<string, unknown>;
    throw new ApiError(String(record.error ?? `Request failed (${response.status}).`), response.status, record);
  }
  return body as T;
}

export const api = {
  state: () => call<State>('/api/state'),
  bots: () => call<{ bots: AiBot[] }>('/api/bots'),
  history: () => call<History>('/api/history'),
  saveConfig: (patch: Partial<OpenGeoConfig>) =>
    call<{ config: OpenGeoConfig; configPath: string }>('/api/config', { method: 'POST', body: JSON.stringify(patch) }),
  test: (input: { url?: string; mode?: TestMode; maxDocs?: number }) =>
    call<TestResponse>('/api/test', { method: 'POST', body: JSON.stringify(input) }),
  generate: (input: { url?: string; tier?: 'free' | 'ai'; single?: boolean; force?: boolean; skipSiteFiles?: boolean }) =>
    call<GenerateResponse>('/api/generate', { method: 'POST', body: JSON.stringify(input) }),
  prodTest: (input: { url?: string; bot?: string }) =>
    call<ProdResponse>('/api/prod-test', { method: 'POST', body: JSON.stringify(input) }),
  readFile: (path: string) =>
    call<{ path: string; content: string }>('/api/file', { method: 'POST', body: JSON.stringify({ path }) }),
  saveKey: (input: {
    provider: string;
    apiKey: string;
    model?: string;
    baseUrl?: string;
    api?: string;
    auth?: string;
  }) =>
    call<{ provider: string; model: string; envPath: string; gitignorePath: string; gitignoreAdded: boolean }>('/api/key', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
