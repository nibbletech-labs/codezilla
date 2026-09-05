import type { Thread } from "../store/types";
import type { TranscriptInfo } from "../store/transcriptTypes";

/** One timestamp per live terminal. Repeated samples never extend an idle
 * terminal's activity window; quiet but currently working agents stay active. */
export function usageActivity(
  threads: Thread[],
  info: Record<string, TranscriptInfo>,
  lastWorking: Map<string, number>,
  now: number,
): { claude: number[]; codex: number[] } {
  const result = { claude: [] as number[], codex: [] as number[] };
  const live = new Set<string>();
  for (const thread of threads) {
    if (thread.state !== "running" || thread.type === "shell") continue;
    live.add(thread.id);
    const activity = info[thread.id];
    const working = activity?.hookAuthoritative
      ? activity.activityState === "working"
      : activity?.ptyActive === true;
    if (working) lastWorking.set(thread.id, now);
    const last = Math.max(thread.lastActivityAt, lastWorking.get(thread.id) ?? 0);
    if (last > 0 && last <= now && now - last <= 5 * 60_000) {
      result[thread.type].push(Math.floor(last / 1000));
    }
  }
  for (const id of lastWorking.keys()) if (!live.has(id)) lastWorking.delete(id);
  return result;
}
