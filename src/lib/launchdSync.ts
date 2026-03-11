import type { ScheduledJob } from "../store/types";
import type { Project } from "../store/types";
import { listLaunchdEntries, writeLaunchdEntry, removeLaunchdEntry, pruneJobLogs } from "./tauri";
import { buildJobCommand } from "./scheduleHelpers";

/**
 * Reconcile Codezilla's persisted job config with launchd agents.
 * - Enabled jobs missing from launchd → re-write
 * - Orphan launchd entries not in config → remove
 */
export async function syncLaunchdEntries(jobs: ScheduledJob[], projects: Project[]): Promise<void> {
  const launchdJobIds = new Set(await listLaunchdEntries());
  const configJobIds = new Set(jobs.map((j) => j.id));

  // Jobs in config but not in launchd: re-write if enabled
  for (const job of jobs) {
    if (job.enabled && !launchdJobIds.has(job.id)) {
      const project = projects.find((p) => p.id === job.projectId);
      if (project) {
        const command = buildJobCommand(job, project.path);
        await writeLaunchdEntry(job.id, job.schedule, command).catch(console.error);
      }
    }
  }

  // Entries in launchd but not in config (orphans): remove
  for (const launchdJobId of launchdJobIds) {
    if (!configJobIds.has(launchdJobId)) {
      await removeLaunchdEntry(launchdJobId).catch(console.error);
    }
  }

  // Prune old log files (keep last 50 per job)
  for (const job of jobs) {
    await pruneJobLogs(job.id, 50).catch(console.error);
  }
}
