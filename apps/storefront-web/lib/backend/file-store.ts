/**
 * A tiny JSON-file-backed store with per-path write serialization. Next.js route
 * handlers for the same dev/prod server process can run concurrently (unlike CMA's
 * own in-memory-only `MockRetail`, which documents its lack of persistence as a known
 * limitation rather than fixing it — see `storefront_stdio_server`'s
 * `_build_backend` docstring); a bare read-modify-write here would lose an update
 * under concurrent cart writes for the same user. `withFileLock` chains callers
 * through one promise per path so each read-modify-write is atomic relative to
 * every other call on the *same* path, without blocking unrelated paths.
 *
 * Known limitation, documented rather than hidden: this lock is in-process only. A
 * multi-instance deployment of this app would need a real datastore or a
 * distributed lock; this demo backend runs as one Node process (`next start`), the
 * same scope MockRetail's own in-memory carts assume.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const locks = new Map<string, Promise<unknown>>();

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve();
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(
    path,
    previous.then(() => gate),
  );
  await previous;
  try {
    return await fn();
  } finally {
    release!();
  }
}

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Read-modify-write a JSON file under this path's lock. `mutate` receives the
 * current value (or `fallback` when the file does not exist yet) and returns the
 * next value to persist, plus whatever the caller wants back.
 */
export async function updateJsonFile<T, R>(
  path: string,
  fallback: T,
  mutate: (current: T) => { next: T; result: R },
): Promise<R> {
  return withFileLock(path, async () => {
    const current = await readJsonFile(path, fallback);
    const { next, result } = mutate(current);
    await writeJsonFile(path, next);
    return result;
  });
}
