import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../store/appStore";
import { scheduleToHumanReadable, buildJobCommand } from "../../lib/scheduleHelpers";
import { THREAD_LABELS } from "../../store/types";
import {
  listJobRuns,
  readJobLog,
  revealLogInFinder,
  runJobNow,
  removeLaunchdEntry,
  deleteJobLogs,
  writeLaunchdEntry,
  type JobRun,
} from "../../lib/tauri";
import JobCreationForm from "./JobCreationForm";

interface JobDetailPanelProps {
  jobId: string;
}

/** Same spinning indicator as thread WorkingSpinner */
function WorkingSpinner({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 12 12" aria-label="Running" style={{ width: size, height: size, flexShrink: 0, display: "inline-block" }}>
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--text-secondary)" strokeOpacity="0.35" strokeWidth="1.2" />
      <g>
        <ellipse cx="6" cy="1.7" rx="1.8" ry="1" fill="var(--text-secondary)" />
        <animateTransform attributeName="transform" type="rotate" from="0 6 6" to="360 6 6" dur="0.9s" repeatCount="indefinite" />
      </g>
    </svg>
  );
}

export default function JobDetailPanel({ jobId }: JobDetailPanelProps) {
  const job = useAppStore((s) => s.scheduledJobs.find((j) => j.id === jobId));
  const project = useAppStore((s) => s.projects.find((p) => p.id === job?.projectId));
  const updateScheduledJob = useAppStore((s) => s.updateScheduledJob);
  const removeScheduledJob = useAppStore((s) => s.removeScheduledJob);

  const [runs, setRuns] = useState<JobRun[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [logContents, setLogContents] = useState<Record<string, string>>({});
  const [editMode, setEditMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshRuns = useCallback(() => {
    listJobRuns(jobId).then((r) => {
      setRuns(r);
    }).catch(console.error);
  }, [jobId]);

  useEffect(() => {
    setExpandedRun(null);
    setLogContents({});
    refreshRuns();
  }, [jobId, refreshRuns]);

  // Live-poll runs every 3s so detail screen updates in real time
  useEffect(() => {
    pollRef.current = setInterval(refreshRuns, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refreshRuns]);

  // Load log when a run is expanded
  useEffect(() => {
    if (expandedRun && !logContents[expandedRun]) {
      readJobLog(jobId, expandedRun)
        .then((content) => setLogContents((prev) => ({ ...prev, [expandedRun]: content })))
        .catch(() => setLogContents((prev) => ({ ...prev, [expandedRun]: "Failed to load log." })));
    }
  }, [expandedRun, jobId, logContents]);

  if (!job || !project) return null;

  const scheduleText = scheduleToHumanReadable(job.schedule);
  const typeLabel = THREAD_LABELS[job.type];

  const handleRunNow = async () => {
    const jobCommand = buildJobCommand(job, project.path);
    await runJobNow(job.id, jobCommand).catch(console.error);
    setTimeout(refreshRuns, 1000);
  };

  const handleToggleEnabled = async () => {
    const newEnabled = !job.enabled;
    updateScheduledJob(job.id, { enabled: newEnabled });
    if (newEnabled) {
      const jobCommand = buildJobCommand(job, project.path);
      await writeLaunchdEntry(job.id, job.schedule, jobCommand).catch(console.error);
    } else {
      await removeLaunchdEntry(job.id).catch(console.error);
    }
  };

  const handleDelete = async () => {
    await removeLaunchdEntry(job.id).catch(console.error);
    await deleteJobLogs(job.id).catch(console.error);
    removeScheduledJob(job.id);
  };

  const toggleExpand = (filename: string) => {
    setExpandedRun((prev) => prev === filename ? null : filename);
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={styles.headerTitle}>{job.name}</div>
            <span style={{ color: job.enabled ? "#73c991" : "#f14c4c", fontSize: "var(--font-size-sm)", fontWeight: 500 }}>
              {job.enabled ? "Enabled" : "Disabled"}
            </span>
            <button onClick={() => setEditMode(true)} style={styles.actionBtn}>Edit</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <button onClick={handleRunNow} style={styles.actionBtn}>Run Now</button>
            <button onClick={handleToggleEnabled} style={styles.actionBtn}>
              {job.enabled ? "Disable" : "Enable"}
            </button>
            {confirmDelete ? (
              <>
                <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)" }}>Delete?</span>
                <button onClick={handleDelete} style={{ ...styles.actionBtn, color: "#f14c4c", borderColor: "#f14c4c" }}>Yes</button>
                <button onClick={() => setConfirmDelete(false)} style={styles.actionBtn}>No</button>
              </>
            ) : (
              <button onClick={() => setConfirmDelete(true)} style={{ ...styles.actionBtn, color: "var(--text-secondary)", borderColor: "transparent" }}>Delete</button>
            )}
          </div>
        </div>
        <div style={styles.headerSubtitle}>
          <span>{typeLabel}</span>
          <span style={styles.dot}>·</span>
          <span style={{ color: "var(--text-primary)", opacity: 0.8 }}>{scheduleText}</span>
        </div>
        <div style={styles.promptLine}>
          "{job.command}"
        </div>
      </div>

      <div style={styles.divider} />

      {/* Run history */}
      {runs.length === 0 ? (
        <div style={styles.emptyState}>
          No runs yet. This job runs {scheduleText}.
        </div>
      ) : (
        <div style={styles.runList}>
          <div style={styles.sectionTitle}>Run History</div>
          {runs.map((run) => {
            const isExpanded = expandedRun === run.filename;
            const log = logContents[run.filename];
            return (
              <RunRow
                key={run.filename}
                run={run}
                command={job.command}
                isExpanded={isExpanded}
                logContent={log}
                onToggle={() => toggleExpand(run.filename)}
                onReveal={() => revealLogInFinder(jobId, run.filename).catch(console.error)}
              />
            );
          })}
        </div>
      )}

      {/* Edit form overlay */}
      {editMode && createPortal(
        <JobCreationForm
          projectId={job.projectId}
          anchor={{ x: window.innerWidth / 2 - 180, y: window.innerHeight / 2 - 260 }}
          onClose={() => {
            setEditMode(false);
            refreshRuns();
          }}
          editJob={job}
        />,
        document.body,
      )}
    </div>
  );
}

function RunRow({ run, command, isExpanded, logContent, onToggle, onReveal }: {
  run: JobRun;
  command: string;
  isExpanded: boolean;
  logContent?: string;
  onToggle: () => void;
  onReveal: () => void;
}) {
  const passed = run.exit_code === 0;
  const pending = run.exit_code == null;
  const [hovered, setHovered] = useState(false);

  return (
    <div style={{ marginBottom: "2px" }}>
      <div
        onClick={onToggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "5px 8px",
          borderRadius: "3px",
          cursor: "pointer",
          backgroundColor: isExpanded ? "var(--accent-selection)" : hovered ? "var(--bg-hover)" : "transparent",
          fontSize: "var(--font-size-sm)",
        }}
      >
        {/* Status indicator: spinner for running, tick/cross for completed */}
        <span style={{
          width: 16,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}>
          {pending ? (
            <WorkingSpinner size={14} />
          ) : (
            <span style={{
              color: passed ? "#73c991" : "#f14c4c",
              fontWeight: 600,
              textAlign: "center" as const,
            }}>
              {passed ? "✓" : "✗"}
            </span>
          )}
        </span>
        <span style={{ color: "var(--text-primary)", flexShrink: 0 }}>
          {formatTimestamp(run.timestamp)}
        </span>
        {pending ? (
          <span style={{ color: "var(--accent)", fontSize: "var(--font-size-xs, 11px)", flexShrink: 0 }}>
            running
          </span>
        ) : run.duration_s != null ? (
          <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono, monospace)", flexShrink: 0, opacity: 0.85 }}>
            {run.duration_s}s
          </span>
        ) : null}
        <span style={{
          color: "var(--text-secondary)",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap" as const,
          fontSize: "var(--font-size-xs, 11px)",
          opacity: 0.5,
        }}>
          {command.slice(0, 40)}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onReveal(); }}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            padding: "0 2px",
            fontSize: "var(--font-size-xs, 11px)",
            opacity: hovered || isExpanded ? 0.8 : 0,
            transition: "opacity 0.1s",
          }}
          title="Open log file"
        >
          ↗
        </button>
      </div>

      {/* Expanded log content */}
      {isExpanded && (
        <pre style={{
          margin: "0 0 4px 24px",
          padding: "8px 12px",
          background: "var(--bg-primary)",
          border: "1px solid var(--border-default)",
          borderRadius: "4px",
          color: "var(--text-primary)",
          fontSize: "var(--font-size-sm)",
          fontFamily: "var(--font-mono, monospace)",
          whiteSpace: "pre-wrap" as const,
          wordBreak: "break-all" as const,
          lineHeight: 1.5,
          maxHeight: "300px",
          overflow: "auto",
        }}>
          {logContent === undefined ? "Loading..." : logContent || "(empty)"}
        </pre>
      )}
    </div>
  );
}

function formatTimestamp(ts: string): string {
  const match = ts.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return ts;
  const [, year, month, day, hour, minute] = match;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthName = months[parseInt(month) - 1] || month;
  return `${parseInt(day)} ${monthName} ${year}, ${hour}:${minute}`;
}

const styles = {
  container: {
    position: "absolute" as const,
    inset: 0,
    zIndex: 15,
    background: "var(--bg-primary)",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
  } as React.CSSProperties,
  header: {
    padding: "16px 20px 12px",
    flexShrink: 0,
  } as React.CSSProperties,
  headerTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "4px",
  } as React.CSSProperties,
  headerTitle: {
    color: "var(--text-primary)",
    fontSize: "calc(var(--font-size) + 4px)",
    fontWeight: 600,
  } as React.CSSProperties,
  headerSubtitle: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    marginBottom: "4px",
  } as React.CSSProperties,
  promptLine: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size-sm)",
    fontStyle: "italic",
    opacity: 0.7,
    marginBottom: "10px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  dot: {
    opacity: 0.5,
  } as React.CSSProperties,
  actionBtn: {
    background: "none",
    border: "1px solid var(--border-default)",
    color: "var(--text-primary)",
    fontSize: "var(--font-size-sm)",
    padding: "4px 10px",
    borderRadius: "4px",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  } as React.CSSProperties,
  divider: {
    height: 1,
    background: "var(--border-default)",
    flexShrink: 0,
  } as React.CSSProperties,
  emptyState: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    color: "var(--text-secondary)",
    fontSize: "var(--font-size)",
    opacity: 0.85,
  } as React.CSSProperties,
  runList: {
    flex: 1,
    overflow: "auto",
    padding: "8px 12px",
  } as React.CSSProperties,
  sectionTitle: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    marginBottom: "4px",
    padding: "0 8px",
    opacity: 0.85,
  } as React.CSSProperties,
};
