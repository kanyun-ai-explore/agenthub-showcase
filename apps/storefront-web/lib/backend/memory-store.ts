/**
 * File-backed memory facts (reproduction plan §6 contract c), same on-disk shape as
 * `commerce_common.memory.JsonFileMemoryStore`'s file (`{version, facts: {subject:
 * {key: fact}}, purges: {subject: n}}`) — not because anything reads both files
 * (the Python side never touches this one; `storefront_stdio_server`'s
 * `HttpMemoryStore` calls these routes instead of the local file once
 * `BACKEND_BASE_URL` is set), but so the shape stays recognizable to anyone who has
 * read the Python store.
 */

import type { MemoryFact } from "./types";
import { MEMORY_FILE } from "./paths";
import { updateJsonFile, readJsonFile } from "./file-store";

interface MemoryFile {
  version: number;
  facts: Record<string, Record<string, MemoryFact>>;
  purges: Record<string, number>;
}

const EMPTY: MemoryFile = { version: 2, facts: {}, purges: {} };

export async function getFacts(subjectId: string): Promise<MemoryFact[]> {
  const data = await readJsonFile(MEMORY_FILE, EMPTY);
  return Object.values(data.facts[subjectId] ?? {});
}

export async function upsertFacts(subjectId: string, facts: MemoryFact[]): Promise<void> {
  await updateJsonFile<MemoryFile, void>(MEMORY_FILE, EMPTY, (data) => {
    const bucket = { ...(data.facts[subjectId] ?? {}) };
    for (const fact of facts) bucket[fact.key] = fact;
    return {
      next: { ...data, facts: { ...data.facts, [subjectId]: bucket } },
      result: undefined,
    };
  });
}

function matchFacts(facts: MemoryFact[], query: string): MemoryFact[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return facts;
  return facts.filter((fact) => {
    const haystack = `${fact.key} ${fact.value} ${fact.category}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
}

export async function searchFacts(subjectId: string, query: string): Promise<MemoryFact[]> {
  return matchFacts(await getFacts(subjectId), query);
}

export async function deleteFact(subjectId: string, key: string): Promise<boolean> {
  return updateJsonFile<MemoryFile, boolean>(MEMORY_FILE, EMPTY, (data) => {
    const bucket = { ...(data.facts[subjectId] ?? {}) };
    if (!(key in bucket)) return { next: data, result: false };
    delete bucket[key];
    return {
      next: { ...data, facts: { ...data.facts, [subjectId]: bucket } },
      result: true,
    };
  });
}

/** Re-key a subject's facts onto another id (existing facts on the target win). Same
 * identity hand-off as `cart-store.moveCart`. */
export async function moveSubject(fromSubjectId: string, toSubjectId: string): Promise<number> {
  if (fromSubjectId === toSubjectId) return 0;
  return updateJsonFile<MemoryFile, number>(MEMORY_FILE, EMPTY, (data) => {
    const from = data.facts[fromSubjectId];
    if (!from || Object.keys(from).length === 0) return { next: data, result: 0 };
    const facts = { ...data.facts, [toSubjectId]: { ...from, ...(data.facts[toSubjectId] ?? {}) } };
    delete facts[fromSubjectId];
    return { next: { ...data, facts }, result: Object.keys(from).length };
  });
}

export async function clearSubject(subjectId: string): Promise<void> {
  await updateJsonFile<MemoryFile, void>(MEMORY_FILE, EMPTY, (data) => {
    const facts = { ...data.facts };
    delete facts[subjectId];
    const purges = { ...data.purges, [subjectId]: (data.purges[subjectId] ?? 0) + 1 };
    return { next: { ...data, facts, purges }, result: undefined };
  });
}

export async function purgeGeneration(subjectId: string): Promise<number> {
  const data = await readJsonFile(MEMORY_FILE, EMPTY);
  return data.purges[subjectId] ?? 0;
}
