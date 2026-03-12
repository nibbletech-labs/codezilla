import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface PtyEvent {
  event: "Output" | "Activity" | "CommandStart" | "CommandEnd" | "Exit";
  data:
    | PtyOutputData
    | PtyActivityData
    | PtyCommandStartData
    | PtyCommandEndData
    | PtyExitData;
}

export interface PtyOutputData {
  data: number[];
}

export interface PtyExitData {
  code: number | null;
}

export interface PtyActivityData {
  active: boolean;
  source?: "output" | "progress";
}

export interface PtyCommandStartData {}

export interface PtyCommandEndData {
  exit_code: number | null;
}

export function spawnPty(
  sessionId: string,
  rows: number,
  cols: number,
  channel: Channel<PtyEvent>,
  cwd?: string,
  command?: string,
  activityMode?: "legacy" | "hybrid" | "marker",
): Promise<void> {
  return invoke("spawn_pty", {
    sessionId,
    rows,
    cols,
    channel,
    cwd,
    command,
    activityMode,
  });
}

export function writePty(sessionId: string, data: string): Promise<void> {
  return invoke("write_pty", { sessionId, data });
}

export function resizePty(
  sessionId: string,
  rows: number,
  cols: number,
): Promise<void> {
  return invoke("resize_pty", { sessionId, rows, cols });
}

export function killPty(sessionId: string): Promise<void> {
  return invoke("kill_pty", { sessionId });
}

// File system
export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export function readDirectory(path: string, projectRoot: string): Promise<FileEntry[]> {
  return invoke("read_directory", { path, projectRoot });
}

/** Recursively scan all files in a directory (respects .gitignore). Returns absolute paths. */
export function scanAllFiles(path: string, projectRoot: string): Promise<string[]> {
  return invoke("scan_all_files", { path, projectRoot });
}

export function readFile(path: string, projectRoot: string): Promise<string> {
  return invoke("read_file", { path, projectRoot });
}

export function readFileBase64(path: string, projectRoot: string): Promise<string> {
  return invoke("read_file_base64", { path, projectRoot });
}

export function previewFile(path: string, projectRoot: string): Promise<void> {
  return invoke("preview_file", { path, projectRoot });
}

export function pathExists(path: string): Promise<boolean> {
  return invoke("path_exists", { path });
}

export function revealInFinder(path: string, projectRoot: string): Promise<void> {
  return invoke("reveal_in_finder", { path, projectRoot });
}

export function openInDefaultApp(path: string, projectRoot: string): Promise<void> {
  return invoke("open_in_default_app", { path, projectRoot });
}

export function startWatching(path: string, projectRoot: string): Promise<void> {
  return invoke("start_watching", { path, projectRoot });
}

export function stopWatching(): Promise<void> {
  return invoke("stop_watching");
}

// Git
export type GitFileStatus =
  | "Modified"
  | "Added"
  | "Deleted"
  | "Renamed"
  | "Untracked"
  | "Ignored"
  | "Conflicted";

export interface GitStatusEntry {
  path: string;
  status: GitFileStatus;
}

export function getGitBranch(path: string): Promise<string> {
  return invoke("get_git_branch", { path });
}

export function getGitStatus(path: string): Promise<GitStatusEntry[]> {
  return invoke("get_git_status", { path });
}

export function getGitDiffStat(path: string): Promise<[number, number]> {
  return invoke("get_git_diff_stat", { path });
}

export function getFileDiffStat(repoPath: string, filePath: string): Promise<[number, number]> {
  return invoke("get_file_diff_stat", { repoPath, filePath });
}

export function getGitDiff(repoPath: string, filePath: string): Promise<string> {
  return invoke("get_git_diff", { repoPath, filePath });
}

// Commit info
export interface CommitFileStat {
  file: string;
  additions: number;
  deletions: number;
}

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files_changed: number;
  additions: number;
  deletions: number;
  file_stats: CommitFileStat[];
}

export function getCommitInfo(repoPath: string, commitRef: string): Promise<CommitInfo> {
  return invoke("get_commit_info", { repoPath, commitRef });
}

export function getCommitDiff(repoPath: string, commitRef: string): Promise<string> {
  return invoke("get_commit_diff", { repoPath, commitRef });
}

export async function pickDirectory(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  if (typeof selected === "string") return selected;
  return null;
}

// Transcript tailing
export function watchTranscript(threadId: string, path: string, fromEnd: boolean): Promise<void> {
  return invoke("watch_transcript", { threadId, path, fromEnd });
}

export function unwatchTranscript(threadId: string): Promise<void> {
  return invoke("unwatch_transcript", { threadId });
}

export function switchTranscript(threadId: string, newPath: string): Promise<void> {
  return invoke("switch_transcript", { threadId, newPath });
}

export function discoverTranscript(sessionId: string): Promise<string | null> {
  return invoke("discover_transcript", { sessionId });
}

export interface CodexBindingSnapshot {
  thread_id: string;
  state: "pending" | "bound" | "failed";
  path: string | null;
  codex_session_id: string | null;
  attempts: number;
  error: string | null;
}

export function registerCodexThread(
  threadId: string,
  cwd: string,
  startedAtMs: number,
  expectedCodexId?: string | null,
): Promise<void> {
  return invoke("register_codex_thread", {
    threadId,
    cwd,
    startedAtMs,
    expectedCodexId,
  });
}

export function unregisterCodexThread(threadId: string): Promise<void> {
  return invoke("unregister_codex_thread", { threadId });
}

export function getCodexBinding(threadId: string): Promise<CodexBindingSnapshot | null> {
  return invoke("get_codex_binding", { threadId });
}

// Scheduled Jobs (launchd)

export type ScheduledJobType = "claude" | "codex" | "shell";

export interface ScheduledJobExecution {
  type: ScheduledJobType;
  command: string;
  projectPath: string;
}

export function writeLaunchdEntry(
  jobId: string,
  schedule: string,
  execution: ScheduledJobExecution,
): Promise<void> {
  return invoke("write_launchd_entry", { jobId, schedule, execution });
}

export function removeLaunchdEntry(jobId: string): Promise<void> {
  return invoke("remove_launchd_entry", { jobId });
}

export function listLaunchdEntries(): Promise<string[]> {
  return invoke("list_launchd_entries");
}

export interface JobRun {
  filename: string;
  timestamp: string;
  exit_code: number | null;
  duration_s: number | null;
}

export function listJobRuns(jobId: string): Promise<JobRun[]> {
  return invoke("list_job_runs", { jobId });
}

export function readJobLog(jobId: string, filename: string): Promise<string> {
  return invoke("read_job_log", { jobId, filename });
}

export function deleteJobLogs(jobId: string): Promise<void> {
  return invoke("delete_job_logs", { jobId });
}

export function revealLogInFinder(jobId: string, filename: string): Promise<void> {
  return invoke("reveal_log_in_finder", { jobId, filename });
}

export function runJobNow(jobId: string, execution: ScheduledJobExecution): Promise<void> {
  return invoke("run_job_now", { jobId, execution });
}

export function pruneJobLogs(jobId: string, keep: number): Promise<number> {
  return invoke("prune_job_logs", { jobId, keep });
}
