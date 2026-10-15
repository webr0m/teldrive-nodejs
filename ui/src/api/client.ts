import createFetchClient from "openapi-fetch";
import createQueryClient from "openapi-react-query";
import { normalizeApiError } from "./errors";
import type { paths } from "./schema";
import { createSessionTransport } from "./session-transport";

const API_BASE_URL = "/api";
const transport = createSessionTransport(
  (input, init) => fetch(input, init),
  window.location.origin,
);
export const refreshCookieSession = transport.refresh;

async function fetchWithApiErrors(input: RequestInfo | URL, init?: RequestInit) {
  let response: Response;
  try {
    response = await transport.request(input, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw normalizeApiError(error);
  }

  if (response.ok) return response;

  let body: unknown;
  try {
    body = await response.json();
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
