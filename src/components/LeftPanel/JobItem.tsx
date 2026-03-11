import { useState, useEffect, useRef } from "react";
import { useAppStore } from "../../store/appStore";
import { scheduleToHumanReadable } from "../../lib/scheduleHelpers";
import { listJobRuns } from "../../lib/tauri";

interface JobItemProps {
  jobId: string;
  isActive: boolean;
  onSelect: () => void;
}

function ClockIcon({ dimmed, hasError }: { dimmed?: boolean; hasError?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke={hasError ? "#f14c4c" : dimmed ? "var(--text-secondary)" : "var(--accent)"} strokeWidth="1.3" strokeOpacity={dimmed ? 0.5 : 1} />
      <path d="M8 4.5V8L10.5 9.5" stroke={hasError ? "#f14c4c" : dimmed ? "var(--text-secondary)" : "var(--accent)"} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" strokeOpacity={dimmed ? 0.5 : 1} />
    </svg>
  );
}

/** Same spinning indicator as thread WorkingSpinner, scaled to 14px */
function WorkingSpinner() {
  return (
    <svg viewBox="0 0 12 12" aria-label="Running" style={{ width: 14, height: 14, flexShrink: 0, display: "inline-block" }}>
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--text-secondary)" strokeOpacity="0.35" strokeWidth="1.2" />
      <g>
        <ellipse cx="6" cy="1.7" rx="1.8" ry="1" fill="var(--text-secondary)" />
        <animateTransform attributeName="transform" type="rotate" from="0 6 6" to="360 6 6" dur="0.9s" repeatCount="indefinite" />
      </g>
    </svg>
  );
}

export default function JobItem({ jobId, isActive, onSelect }: JobItemProps) {
  const job = useAppStore((s) => s.scheduledJobs.find((j) => j.id === jobId));
  const [hovered, setHovered] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [lastRunFailed, setLastRunFailed] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll for running state: check if newest log has no exit_code yet (still running)
  useEffect(() => {
    if (!job?.enabled) {
      setIsRunning(false);
      setLastRunFailed(false);
      return;
    }

    const check = () => {
      listJobRuns(jobId).then((runs) => {
        if (runs.length > 0) {
          const newest = runs[0];
          setIsRunning(newest.exit_code == null);
          // Last completed run failed?
          const lastCompleted = runs.find((r) => r.exit_code != null);
          setLastRunFailed(lastCompleted != null && lastCompleted.exit_code !== 0);
        } else {
          setIsRunning(false);
          setLastRunFailed(false);
        }
      }).catch(() => {});
    };

    check();
    pollRef.current = setInterval(check, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobId, job?.enabled]);

  if (!job) return null;

  const scheduleText = scheduleToHumanReadable(job.schedule);

  return (
    <div
      style={{
        ...styles.item,
        backgroundColor: isActive ? "var(--accent-selection)" : hovered ? "var(--bg-hover)" : "transparent",
        opacity: job.enabled ? 1 : 0.45,
      }}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={styles.contentWrapper}>
        <div style={styles.textContent}>
          <div style={styles.nameRow}>
            <span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, width: 14, height: 14 }}>
              {isRunning ? <WorkingSpinner /> : <ClockIcon dimmed={!job.enabled} hasError={lastRunFailed} />}
            </span>
            <span style={styles.name}>{job.name}</span>
          </div>
          <div style={styles.subtitleRow}>
            <span style={styles.subtitle}>{scheduleText}{isRunning ? " · running" : ""}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  item: {
    display: "flex",
    alignItems: "stretch",
    padding: "4px 6px",
    cursor: "pointer",
    borderRadius: "3px",
    marginBottom: "1px",
    transition: "background-color 0.1s ease",
  } as React.CSSProperties,
  contentWrapper: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  textContent: {
    display: "flex",
    flexDirection: "column" as const,
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  nameRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
  } as React.CSSProperties,
  name: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size)",
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  subtitleRow: {
    display: "flex",
    alignItems: "center",
    height: "16px",
  } as React.CSSProperties,
  subtitle: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    flex: 1,
    opacity: 0.85,
  } as React.CSSProperties,
};
