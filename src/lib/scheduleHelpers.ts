import type { ScheduledJob } from "../store/types";

// --- Schedule config types ---

export interface IntervalSchedule { mode: "interval"; value: number; unit: "minutes" | "hours" }
export interface DailySchedule { mode: "daily"; hour: number; minute: number }
export interface WeeklySchedule { mode: "weekly"; day: number; hour: number; minute: number }
export type ScheduleConfig = IntervalSchedule | DailySchedule | WeeklySchedule;

// --- Schedule expression generation ---

export function scheduleToExpression(config: ScheduleConfig): string {
  switch (config.mode) {
    case "interval":
      if (config.unit === "minutes") return `*/${config.value} * * * *`;
      return `0 */${config.value} * * *`;
    case "daily":
      return `${config.minute} ${config.hour} * * *`;
    case "weekly":
      return `${config.minute} ${config.hour} * * ${config.day}`;
  }
}

// --- Human-readable schedule display ---

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function scheduleToHumanReadable(schedule: string): string {
  const parts = schedule.split(" ");
  if (parts.length !== 5) return schedule;
  const [minute, hour, , , dayOfWeek] = parts;

  // Interval: */N * * * * or 0 */N * * *
  if (minute.startsWith("*/") && hour === "*") {
    const n = parseInt(minute.slice(2));
    return n === 1 ? "every minute" : `every ${n} min`;
  }
  if (minute === "0" && hour.startsWith("*/")) {
    const h = parseInt(hour.slice(2));
    return h === 1 ? "every hour" : `every ${h}h`;
  }

  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

  // Weekly: M H * * D
  const dayNum = parseInt(dayOfWeek);
  if (!isNaN(dayNum) && dayNum >= 0 && dayNum <= 6) {
    return `${DAY_NAMES[dayNum]} ${time}`;
  }

  // Daily: M H * * *
  if (dayOfWeek === "*" && !hour.includes("/") && !minute.includes("/")) {
    return `daily ${time}`;
  }

  return schedule;
}

// --- Job command construction ---

export function buildJobCommand(job: ScheduledJob, projectPath: string): string {
  let innerCommand: string;
  switch (job.type) {
    case "claude":
      innerCommand = `claude "${job.command.replace(/"/g, '\\"')}"`;
      break;
    case "codex":
      innerCommand = `codex "${job.command.replace(/"/g, '\\"')}"`;
      break;
    case "shell":
      innerCommand = job.command;
      break;
  }

  const escapedPath = projectPath.replace(/"/g, '\\"');

  return [
    `_CZ_DIR=~/.codezilla/logs/${job.id}`,
    `mkdir -p "$_CZ_DIR"`,
    `_CZ_LOG="$_CZ_DIR/$(date +%Y-%m-%dT%H%M%S).log"`,
    `_CZ_START=$(date +%s)`,
    `(cd "${escapedPath}" && ${innerCommand}) > "$_CZ_LOG" 2>&1`,
  ].join(" && ")
    + `; _CZ_EC=$?; echo "" >> "$_CZ_LOG"; echo "---" >> "$_CZ_LOG"; echo "exit_code: $_CZ_EC" >> "$_CZ_LOG"; echo "duration_s: $(( $(date +%s) - _CZ_START ))" >> "$_CZ_LOG"; exit $_CZ_EC`;
}
