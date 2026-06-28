import {
  ChatTurn,
  Consolidation,
  InteractionEvent,
  ReflectionRecord,
} from "../models.js";
import type { UserData } from "../storage.js";

// ========== History ==========

/** Append a turn dict to history, trimming to max 100 */
export function historyAppend(data: UserData, turnDict: Record<string, unknown>): void {
  const history = data.history ?? [];
  history.push(turnDict);
  if (history.length > 100) {
    data.history = history.slice(-100);
  } else {
    data.history = history;
  }
}

/** Get history as ChatTurn array, optionally limited */
export function historyGet(data: UserData, limit?: number): ChatTurn[] {
  const historyData = data.history ?? [];
  const all = historyData.map((h) => ChatTurn.fromDict(h));
  if (limit !== undefined && limit > 0 && all.length > limit) {
    return all.slice(-limit);
  }
  return all;
}

/** Clear all history turns */
export function historyClear(data: UserData): void {
  data.history = [];
}

/** Get last N turns */
export function historyGetLastTurns(data: UserData, count: number): ChatTurn[] {
  const historyData = data.history ?? [];
  const turns = historyData.map((h) => ChatTurn.fromDict(h));
  return turns.slice(-count);
}

// ========== Interactions ==========

/** Append an interaction event dict, trimming to max 200 */
export function interactionsSave(
  data: UserData,
  eventDict: Record<string, unknown>,
): void {
  const existing = data.interactions ?? [];
  existing.push(eventDict);
  if (existing.length > 200) {
    data.interactions = existing.slice(-200);
  } else {
    data.interactions = existing;
  }
}

/** Get all interaction events */
export function interactionsGetAll(data: UserData): InteractionEvent[] {
  const interactions = data.interactions ?? [];
  return interactions.map((i) => InteractionEvent.fromDict(i));
}

// ========== Consolidations ==========

/** Process a consolidation: dedup by date, push, trim to 30 */
export function consolidationsProcess(
  data: UserData,
  consolidationDict: Record<string, unknown>,
  targetDate: string,
): void {
  const consolidations = data.consolidations ?? [];
  const filtered = consolidations.filter(
    (c) => (c.date as string | undefined) !== targetDate,
  );
  filtered.push(consolidationDict);
  if (filtered.length > 30) {
    data.consolidations = filtered.slice(-30);
  } else {
    data.consolidations = filtered;
  }
}

// ========== Reflections ==========

/** Get all reflection records */
export function reflectionsGetAll(data: UserData): ReflectionRecord[] {
  const reflectionsData = data.reflections ?? [];
  return reflectionsData.map((r) => ReflectionRecord.fromDict(r));
}

/** Save a reflection record dict, trimming to 30 */
export function reflectionsSave(
  data: UserData,
  recordDict: Record<string, unknown>,
): void {
  const reflections = data.reflections ?? [];
  reflections.push(recordDict);
  if (reflections.length > 30) {
    data.reflections = reflections.slice(-30);
  } else {
    data.reflections = reflections;
  }
}
