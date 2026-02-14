import type { TranscriptStatus } from "../store/transcriptTypes";

export function deriveCoreRuntimeStatus(
  currentStatus: TranscriptStatus,
  ptyActive: boolean,
): TranscriptStatus {
  if (currentStatus === "exited") {
    return "exited";
  }
  return ptyActive ? "working" : "idle";
}
