import type { ScheduledJob } from "../store/types";
import type { ScheduledJobExecution } from "./tauri";

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

export function buildJobExecution(job: ScheduledJob, projectPath: string): ScheduledJobExecution {
  return {
    type: job.type,
    command: job.command,
    projectPath,
  };
}
