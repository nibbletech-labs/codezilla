import { useState, useEffect, useRef } from "react";
import { useAppStore } from "../../store/appStore";
import { scheduleToExpression, buildJobCommand } from "../../lib/scheduleHelpers";
import type { ScheduleConfig } from "../../lib/scheduleHelpers";
import type { ThreadType, ScheduledJob } from "../../store/types";
import { writeLaunchdEntry, runJobNow } from "../../lib/tauri";
import ThreadIcon from "../LeftPanel/ThreadIcons";

const FORM_WIDTH = 360;
const FORM_MAX_HEIGHT = 520;

interface JobCreationFormProps {
  projectId: string;
  anchor: { x: number; y: number };
  onClose: () => void;
  /** If provided, edit an existing job instead of creating a new one */
  editJob?: ScheduledJob;
}

const TYPE_OPTIONS: { type: ThreadType; label: string }[] = [
  { type: "claude", label: "Claude" },
  { type: "codex", label: "Codex" },
  { type: "shell", label: "Terminal" },
];

const DAY_OPTIONS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

function parseScheduleToConfig(expression: string): ScheduleConfig {
  const parts = expression.split(" ");
  if (parts.length !== 5) return { mode: "interval", value: 30, unit: "minutes" };
  const [minute, hour, , , dayOfWeek] = parts;

  if (minute.startsWith("*/") && hour === "*") {
    return { mode: "interval", value: parseInt(minute.slice(2)) || 30, unit: "minutes" };
  }
  if (minute === "0" && hour.startsWith("*/")) {
    return { mode: "interval", value: parseInt(hour.slice(2)) || 1, unit: "hours" };
  }
  const dayNum = parseInt(dayOfWeek);
  if (!isNaN(dayNum) && dayNum >= 0 && dayNum <= 6) {
    return { mode: "weekly", day: dayNum, hour: parseInt(hour) || 9, minute: parseInt(minute) || 0 };
  }
  if (dayOfWeek === "*" && !hour.includes("/") && !minute.includes("/")) {
    return { mode: "daily", hour: parseInt(hour) || 9, minute: parseInt(minute) || 0 };
  }
  return { mode: "interval", value: 30, unit: "minutes" };
}

export default function JobCreationForm({ projectId, anchor, onClose, editJob }: JobCreationFormProps) {
  const addScheduledJob = useAppStore((s) => s.addScheduledJob);
  const updateScheduledJob = useAppStore((s) => s.updateScheduledJob);
  const projects = useAppStore((s) => s.projects);
  const formRef = useRef<HTMLDivElement>(null);

  const [selectedType, setSelectedType] = useState<ThreadType>(editJob?.type ?? "claude");
  const [name, setName] = useState(editJob?.name ?? "");
  const [command, setCommand] = useState(editJob?.command ?? "");
  const [scheduleMode, setScheduleMode] = useState<ScheduleConfig["mode"]>(
    editJob ? parseScheduleToConfig(editJob.schedule).mode : "interval",
  );
  const [intervalValue, setIntervalValue] = useState(
    editJob ? (parseScheduleToConfig(editJob.schedule) as any).value ?? 30 : 30,
  );
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours">(
    editJob ? (parseScheduleToConfig(editJob.schedule) as any).unit ?? "minutes" : "minutes",
  );
  const [dailyHour, setDailyHour] = useState(
    editJob ? (parseScheduleToConfig(editJob.schedule) as any).hour ?? 9 : 9,
  );
  const [dailyMinute, setDailyMinute] = useState(
    editJob ? (parseScheduleToConfig(editJob.schedule) as any).minute ?? 0 : 0,
  );
  const [weeklyDay, setWeeklyDay] = useState(
    editJob ? (parseScheduleToConfig(editJob.schedule) as any).day ?? 1 : 1,
  );
  const [weeklyHour, setWeeklyHour] = useState(
    editJob ? (parseScheduleToConfig(editJob.schedule) as any).hour ?? 9 : 9,
  );
  const [weeklyMinute, setWeeklyMinute] = useState(
    editJob ? (parseScheduleToConfig(editJob.schedule) as any).minute ?? 0 : 0,
  );

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const buildScheduleConfig = (): ScheduleConfig => {
    switch (scheduleMode) {
      case "interval":
        return { mode: "interval", value: intervalValue, unit: intervalUnit };
      case "daily":
        return { mode: "daily", hour: dailyHour, minute: dailyMinute };
      case "weekly":
        return { mode: "weekly", day: weeklyDay, hour: weeklyHour, minute: weeklyMinute };
    }
  };

  const handleSubmit = async (andRun = false) => {
    const scheduleConfig = buildScheduleConfig();
    const schedule = scheduleToExpression(scheduleConfig);
    const jobName = name.trim() || command.slice(0, 30);
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;

    if (editJob) {
      updateScheduledJob(editJob.id, {
        name: jobName,
        type: selectedType,
        command,
        schedule,
      });
      const updatedJob = { ...editJob, name: jobName, type: selectedType, command, schedule };
      const jobCommand = buildJobCommand(updatedJob, project.path);
      await writeLaunchdEntry(editJob.id, schedule, jobCommand).catch(console.error);
    } else {
      const job = addScheduledJob(projectId, {
        projectId,
        name: jobName,
        type: selectedType,
        command,
        schedule,
        enabled: true,
      });
      const jobCommand = buildJobCommand(job, project.path);
      await writeLaunchdEntry(job.id, schedule, jobCommand).catch(console.error);
      if (andRun) {
        await runJobNow(job.id, jobCommand).catch(console.error);
      }
    }

    onClose();
  };

  const left = Math.min(anchor.x, window.innerWidth - FORM_WIDTH - 8);
  const top = Math.min(anchor.y, window.innerHeight - FORM_MAX_HEIGHT - 8);

  return (
    <>
      {/* Backdrop */}
      <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onClick={onClose} />

      <div
        ref={formRef}
        style={{
          position: "fixed",
          left,
          top,
          width: FORM_WIDTH,
          maxHeight: FORM_MAX_HEIGHT,
          zIndex: 9999,
          backgroundColor: "var(--bg-panel)",
          border: "1px solid var(--border-default)",
          borderRadius: 6,
          boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          overflow: "auto",
        }}
      >
        <div style={{ color: "var(--text-primary)", fontSize: "var(--font-size)", fontWeight: 600 }}>
          {editJob ? "Edit Scheduled Job" : "New Scheduled Job"}
        </div>

        {/* Type toggle buttons */}
        <div style={{ display: "flex", gap: "6px" }}>
          {TYPE_OPTIONS.map(({ type, label }) => (
            <button
              key={type}
              onClick={() => setSelectedType(type)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                background: selectedType === type ? "var(--accent-selection)" : "transparent",
                border: `1px solid ${selectedType === type ? "var(--accent)" : "var(--border-default)"}`,
                color: "var(--text-primary)",
                fontSize: "var(--font-size-sm)",
                cursor: "pointer",
                padding: "6px 14px",
                borderRadius: "4px",
                flex: 1,
                justifyContent: "center",
              }}
            >
              <ThreadIcon type={type} />
              {label}
            </button>
          ))}
        </div>

        {/* Name */}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Job name (optional)"
          style={inputStyle}
        />

        {/* Command */}
        {selectedType === "shell" ? (
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="Enter command..."
            rows={3}
            style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono, monospace)" }}
          />
        ) : (
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="Enter a prompt..."
            style={inputStyle}
          />
        )}

        {/* Schedule picker */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)" }}>Schedule</div>

          {/* Interval */}
          <label style={radioRowStyle(scheduleMode === "interval")} onClick={() => setScheduleMode("interval")}>
            <input type="radio" checked={scheduleMode === "interval"} onChange={() => setScheduleMode("interval")} style={radioStyle} />
            <span>Every</span>
            <input
              type="number"
              min={1}
              max={scheduleMode === "interval" && intervalUnit === "minutes" ? 59 : 23}
              value={intervalValue}
              onChange={(e) => setIntervalValue(parseInt(e.target.value) || 1)}
              disabled={scheduleMode !== "interval"}
              style={inlineInputStyle}
            />
            <select
              value={intervalUnit}
              onChange={(e) => setIntervalUnit(e.target.value as "minutes" | "hours")}
              disabled={scheduleMode !== "interval"}
              style={inlineSelectStyle}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
          </label>

          {/* Daily */}
          <label style={radioRowStyle(scheduleMode === "daily")} onClick={() => setScheduleMode("daily")}>
            <input type="radio" checked={scheduleMode === "daily"} onChange={() => setScheduleMode("daily")} style={radioStyle} />
            <span>Daily at</span>
            <select
              value={`${dailyHour}:${dailyMinute.toString().padStart(2, "0")}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                setDailyHour(h);
                setDailyMinute(m);
              }}
              disabled={scheduleMode !== "daily"}
              style={inlineSelectStyle}
            >
              {generateTimeOptions()}
            </select>
          </label>

          {/* Weekly */}
          <label style={radioRowStyle(scheduleMode === "weekly")} onClick={() => setScheduleMode("weekly")}>
            <input type="radio" checked={scheduleMode === "weekly"} onChange={() => setScheduleMode("weekly")} style={radioStyle} />
            <span>Weekly, every</span>
            <select
              value={weeklyDay}
              onChange={(e) => setWeeklyDay(parseInt(e.target.value))}
              disabled={scheduleMode !== "weekly"}
              style={inlineSelectStyle}
            >
              {DAY_OPTIONS.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
            <span>at</span>
            <select
              value={`${weeklyHour}:${weeklyMinute.toString().padStart(2, "0")}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                setWeeklyHour(h);
                setWeeklyMinute(m);
              }}
              disabled={scheduleMode !== "weekly"}
              style={inlineSelectStyle}
            >
              {generateTimeOptions()}
            </select>
          </label>
        </div>

        {/* Submit */}
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={() => handleSubmit(false)}
            disabled={!command.trim()}
            style={{
              ...submitBtnStyle,
              background: command.trim() ? "var(--accent)" : "var(--bg-hover)",
              color: command.trim() ? "#fff" : "var(--text-secondary)",
              cursor: command.trim() ? "pointer" : "default",
              flex: 1,
            }}
          >
            {editJob ? "Save" : "Create"}
          </button>
          {!editJob && scheduleMode === "interval" && (
            <button
              onClick={() => handleSubmit(true)}
              disabled={!command.trim()}
              style={{
                ...submitBtnStyle,
                background: command.trim() ? "var(--accent)" : "var(--bg-hover)",
                color: command.trim() ? "#fff" : "var(--text-secondary)",
                cursor: command.trim() ? "pointer" : "default",
                flex: 1,
                opacity: command.trim() ? 0.85 : 1,
              }}
            >
              Create & Run
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function generateTimeOptions() {
  const options: JSX.Element[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const val = `${h}:${m.toString().padStart(2, "0")}`;
      const label = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
      options.push(<option key={val} value={val}>{label}</option>);
    }
  }
  return options;
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-input, var(--bg-primary))",
  border: "1px solid var(--border-default)",
  color: "var(--text-primary)",
  fontSize: "var(--font-size-sm)",
  padding: "6px 8px",
  borderRadius: "4px",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const radioStyle: React.CSSProperties = {
  accentColor: "var(--accent)",
  margin: 0,
  flexShrink: 0,
};

function radioRowStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    cursor: "pointer",
    color: active ? "var(--text-primary)" : "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    opacity: active ? 1 : 0.6,
  };
}

const inlineInputStyle: React.CSSProperties = {
  ...inputStyle,
  width: "54px",
  textAlign: "center",
  padding: "4px 6px",
};

const submitBtnStyle: React.CSSProperties = {
  border: "none",
  fontSize: "var(--font-size-sm)",
  padding: "8px 16px",
  borderRadius: "4px",
  fontWeight: 600,
};

const inlineSelectStyle: React.CSSProperties = {
  background: "var(--bg-input, var(--bg-primary))",
  border: "1px solid var(--border-default)",
  color: "var(--text-primary)",
  fontSize: "var(--font-size-sm)",
  padding: "4px 6px",
  borderRadius: "4px",
  outline: "none",
};
