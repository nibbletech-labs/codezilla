export type PreviewTarget =
  | { kind: "file"; path: string; line?: number }
  | { kind: "commit"; hash: string };

export type ThreadType = "claude" | "codex" | "shell";
export type ThreadState = "running" | "exited" | "dormant";

export interface Thread {
  id: string;
  projectId: string;
  type: ThreadType;
  name: string;
  sessionId: string | null;        // null when dormant (no PTY yet)
  claudeSessionId: string | null;  // stable ID for claude --session-id
  codexThreadId: string | null;    // captured from Codex (future)
  state: ThreadState;
  exitCode: number | null;
  resuming: boolean;
  lastActivityAt: number;          // epoch ms, 0 = no activity recorded
}

// Subset persisted to codezilla-config.json
export interface PersistedThread {
  id: string;
  projectId: string;
  type: ThreadType;
  name: string;
  claudeSessionId: string | null;
  codexThreadId: string | null;
  exitCode: number | null;
  lastActivityAt: number;          // epoch ms, 0 = no activity recorded
}

export interface Project {
  id: string;
  name: string;
  path: string;
  expanded: boolean;
  threadCounter: Record<ThreadType, number>;
  missing?: boolean;
}

export const THREAD_LABELS: Record<ThreadType, string> = {
  claude: "Claude Code",
  codex: "Codex",
  shell: "Terminal",
};

export const THREAD_NEW_LABELS: Record<ThreadType, string> = {
  claude: "Claude Code",
  codex: "Codex",
  shell: "Terminal",
};
