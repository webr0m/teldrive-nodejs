import type { RCDClient } from 'rclone-sdk';
export { default as createRCDClient } from 'rclone-sdk';
export interface TeldriveOptions {
  apiHost: string;
  apiKey: string;
  name?: string;
  /** MiB, divisible by 16. Default 64. The server chooses its own part limit. */
  chunkMiB?: number;
  concurrency?: number;
  encrypt?: boolean;
  hash?: boolean;
  pageSize?: number;
}
export interface TransferOptions { async?: boolean; signal?: AbortSignal; }
export interface Job { jobid: number; }
export interface JobStatus {
  id: number; finished: boolean; success: boolean; error: string;
  output: Record<string, unknown> | null;
  [key: string]: unknown;
}
export interface Entry {
  Path: string; Name: string; Size: number; IsDir: boolean;
  MimeType?: string; ModTime?: string; ID?: string; Hashes?: Record<string, string>;
}
export interface TrashEntry { id: string; name: string; kind: 'file' | 'folder'; [key: string]: unknown; }
export interface TeldriveRemote {
  name: string;
  fs: string;
  /** Raw rclone SDK. Keep it on the server; it can access local files. */
  rcd: RCDClient;
  list(remote?: string, options?: { recursive?: boolean; hashes?: boolean; signal?: AbortSignal }): Promise<{ list: Entry[] }>;
  stat(remote: string, options?: { signal?: AbortSignal }): Promise<{ item: Entry | null }>;
  mkdir(remote: string): Promise<Record<string, unknown>>;
  upload(local: string, remote: string, options: TransferOptions & { async: true }): Promise<Job>;
  upload(local: string, remote: string, options?: TransferOptions & { async?: false }): Promise<Record<string, unknown>>;
  download(remote: string, local: string, options: TransferOptions & { async: true }): Promise<Job>;
  download(remote: string, local: string, options?: TransferOptions & { async?: false }): Promise<Record<string, unknown>>;
  copy(source: string, target: string, options: TransferOptions & { async: true }): Promise<Job>;
  copy(source: string, target: string, options?: TransferOptions & { async?: false }): Promise<Record<string, unknown>>;
  move(source: string, target: string, options: TransferOptions & { async: true }): Promise<Job>;
  move(source: string, target: string, options?: TransferOptions & { async?: false }): Promise<Record<string, unknown>>;
  /** Moves a file to the Teldrive trash; does not purge it. */
  remove(remote: string): Promise<Record<string, unknown>>;
  link(remote: string): Promise<{ url: string }>;
  trash(): Promise<TrashEntry[]>;
  restore(id: string): Promise<{ result: unknown }>;
  jobStatus(id: number): Promise<JobStatus>;
  stopJob(id: number): Promise<Record<string, unknown>>;
  waitJob(id: number, options?: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number }): Promise<JobStatus>;
  /** Removes only the remote created by this extension. */
  dispose(): Promise<void>;
}
export interface ManagedTeldriveRemote extends TeldriveRemote {
  /** Stops the owned daemon and removes its temporary credential file. */
  close(): Promise<void>;
  connection(): { baseUrl: string; authorization: string; pid: number; directory: string };
  detach(): void;
  [Symbol.asyncDispose](): Promise<void>;
}
export function createTeldriveRemote(rcd: RCDClient, options: TeldriveOptions): Promise<TeldriveRemote>;
export function openTeldriveRemote(rcd: RCDClient, name?: string): Promise<TeldriveRemote>;
export function startTeldriveRclone(options: TeldriveOptions & { executable?: string; startupTimeoutMs?: number; cacheDirectory?: string }): Promise<ManagedTeldriveRemote>;
