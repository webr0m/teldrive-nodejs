import createFetchClient from "openapi-fetch";
import createQueryClient from "openapi-react-query";
import { normalizeApiError } from "./errors";
import type { paths } from "./schema";

const API_BASE_URL = "/api";
let cookieRefresh: Promise<boolean> | undefined;

async function fetchWithApiErrors(input: RequestInfo | URL, init?: RequestInit) {
  let response: Response;
  try {
    const request = new Request(input instanceof Request ? input : new URL(String(input), window.location.origin), init);
    const retry = request.clone();
    response = await fetch(request);
    // All UI callers share one refresh so concurrent requests cannot rotate the same token twice.
    if (response.status === 401 && !new URL(request.url).pathname.includes("/auth/")) {
      cookieRefresh ??= fetch(`${API_BASE_URL}/v1/auth/cookie/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(result => result.ok).catch(() => false).finally(() => { cookieRefresh = undefined; });
      if (await cookieRefresh) response = await fetch(retry);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw normalizeApiError(error);
  }

  if (response.ok) return response;

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    body = undefined;
  }
  throw normalizeApiError(body, response);
}

export const fetchClient = createFetchClient<paths>({
  baseUrl: API_BASE_URL,
  fetch: fetchWithApiErrors,
});

export const $api = createQueryClient(fetchClient);

export function apiFetch(path: string, init?: RequestInit) {
  return fetchWithApiErrors(`${API_BASE_URL}${path}`, init);
}
