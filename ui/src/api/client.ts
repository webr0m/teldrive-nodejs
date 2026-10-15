import createFetchClient from "openapi-fetch";
import createQueryClient from "openapi-react-query";
import { normalizeApiError } from "./errors";
import type { paths } from "./schema";
import { createSessionTransport } from "./session-transport";
import { serverOrigin, nativeClient } from "@/lib/client-runtime";
import { clientFetch, nativeRefresh } from "@/lib/native-session";

const API_BASE_URL = `${serverOrigin}/api`;
const transport = createSessionTransport(
  clientFetch,
  serverOrigin,
);
export const refreshCookieSession = nativeClient ? nativeRefresh : transport.refresh;

async function fetchWithApiErrors(input: RequestInfo | URL, init?: RequestInit) {
  let response: Response;
  try {
    response = await (nativeClient ? clientFetch(input, init) : transport.request(input, init));
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
