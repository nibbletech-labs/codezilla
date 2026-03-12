import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../store/appStore";
import { pickDirectory } from "../../lib/tauri";
import type { ThreadType, Project } from "../../store/types";
import { THREAD_NEW_LABELS } from "../../store/types";
import ThreadItem from "./ThreadItem";
import ThreadIcon from "./ThreadIcons";
import JobItem from "./JobItem";
import ProjectIcon from "../ProjectIcon";
import { IconPicker } from "../IconPicker";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";

const THREAD_TYPES: ThreadType[] = ["claude", "codex", "shell"];

export default function LeftPanel() {
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const activeThreadId = useAppStore((s) => s.activeThreadId);
  const addProject = useAppStore((s) => s.addProject);
  const addThread = useAppStore((s) => s.addThread);
  const setActiveProject = useAppStore((s) => s.setActiveProject);
  const setActiveThread = useAppStore((s) => s.setActiveThread);
  const baseFontSize = useAppStore((s) => s.baseFontSize);
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const reorderProjects = useAppStore((s) => s.reorderProjects);
  const setProjectIcon = useAppStore((s) => s.setProjectIcon);
  const activeJobId = useAppStore((s) => s.activeJobId);
  const setActiveJob = useAppStore((s) => s.setActiveJob);
  const [iconPickerProjectId, setIconPickerProjectId] = useState<string | null>(null);
  const [iconPickerPos, setIconPickerPos] = useState<{ x: number; y: number } | null>(null);
  const launchPresets = useAppStore((s) => s.launchPresets);
  const [ageTick, setAgeTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return;
      setAgeTick((n) => n + 1);
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = projects.findIndex((p) => p.id === active.id);
      const newIndex = projects.findIndex((p) => p.id === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        reorderProjects(oldIndex, newIndex);
      }
    },
    [projects, reorderProjects],
  );

  const handleAddProject = useCallback(async () => {
    const path = await pickDirectory();
    if (!path) return;
    const name = path.split("/").pop() || path;
    addProject(path, name);
  }, [addProject]);

  const handleNewThreadClick = useCallback(
    (e: React.MouseEvent, projectId: string) => {
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setMenuProjectId(projectId);
      setMenuPos({ x: rect.right, y: rect.top });
    },
    [],
  );

  const handleSpawnThread = useCallback(
    (type: ThreadType, extraArgs?: string | null) => {
      if (!menuProjectId) return;
      addThread(menuProjectId, type, extraArgs);
      setMenuProjectId(null);
      setMenuPos(null);
    },
    [menuProjectId, addThread],
  );

  // Close menu on outside click
  useEffect(() => {
    if (!menuProjectId) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuProjectId(null);
        setMenuPos(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuProjectId]);

  return (
    <div style={styles.container} onContextMenu={(e) => e.preventDefault()}>
      <div style={styles.header}>
        <span style={styles.headerText}>Projects</span>
        <button
          onClick={handleAddProject}
          className="icon-btn"
          style={styles.addProjectButton}
          title="Add Project"
        >
          Add project
        </button>
      </div>

      <div style={styles.list}>
        {projects.length === 0 && (
          <div style={styles.empty}>
            <div style={{ marginBottom: 8 }}>No projects yet</div>
            <button onClick={handleAddProject} style={styles.emptyButton}>
              Add a project
            </button>
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={projects.map((p) => p.id)}
            strategy={verticalListSortingStrategy}
          >
            {projects.map((project) => (
              <SortableProjectItem
                key={project.id}
                project={project}
                activeProjectId={activeProjectId}
                activeThreadId={activeThreadId}
                activeJobId={activeJobId}
                baseFontSize={baseFontSize}
                setActiveProject={setActiveProject}
                setActiveThread={setActiveThread}
                setActiveJob={setActiveJob}
                handleNewThreadClick={handleNewThreadClick}
                setIconPickerProjectId={setIconPickerProjectId}
                setIconPickerPos={setIconPickerPos}
                ageTick={ageTick}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* New thread type picker popup — rendered via portal to escape transform stacking context */}
      {menuProjectId && menuPos && createPortal(
        <div
          ref={menuRef}
          style={{
            ...styles.threadMenu,
            left: menuPos.x + 4,
            top: menuPos.y,
          }}
        >
          {THREAD_TYPES.map((type) => (
            <NewThreadMenuItem
              key={type}
              type={type}
              label={THREAD_NEW_LABELS[type]}
              onClick={() => handleSpawnThread(type)}
            />
          ))}
          {launchPresets.length > 0 && (
            <div style={{ height: 1, margin: "4px 0", background: "var(--border-subtle, var(--border-default))" }} />
          )}
          {launchPresets.map((preset) => (
            <PresetMenuItem
              key={preset.id}
              preset={preset}
              onClick={() => handleSpawnThread(preset.baseType, preset.args)}
            />
          ))}
        </div>,
        document.body,
      )}

      {/* Icon picker popover */}
      {iconPickerProjectId && iconPickerPos && createPortal(
        <IconPicker
          anchor={iconPickerPos}
          currentIcon={projects.find((p) => p.id === iconPickerProjectId)?.icon}
          onSelect={(icon) => {
            setProjectIcon(iconPickerProjectId, icon);
          }}
          onRemove={() => {
            setProjectIcon(iconPickerProjectId, undefined);
          }}
          onClose={() => {
            setIconPickerProjectId(null);
            setIconPickerPos(null);
          }}
        />,
        document.body,
      )}
    </div>
  );
}

interface SortableProjectItemProps {
  project: Project;
  activeProjectId: string | null;
  activeThreadId: string | null;
  activeJobId: string | null;
  baseFontSize: number;
  setActiveProject: (id: string) => void;
  setActiveThread: (id: string) => void;
  setActiveJob: (id: string) => void;
  handleNewThreadClick: (e: React.MouseEvent, projectId: string) => void;
  setIconPickerProjectId: (id: string | null) => void;
  setIconPickerPos: (pos: { x: number; y: number } | null) => void;
  ageTick: number;
}

function SortableProjectItem({
  project,
  activeProjectId,
  activeThreadId,
  activeJobId,
  baseFontSize,
  setActiveProject,
  setActiveThread,
  setActiveJob,
  handleNewThreadClick,
  setIconPickerProjectId,
  setIconPickerPos,
  ageTick,
}: SortableProjectItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });

  const [hovered, setHovered] = useState(false);

  // Subscribe to thread IDs for this project — only re-renders on add/remove
  const threadIdKey = useAppStore((s) =>
    s.threads
      .filter((t) => t.projectId === project.id)
      .map((t) => t.id)
      .join(","),
  );
  const threadIds = useMemo(
    () => threadIdKey ? threadIdKey.split(",") : [],
    [threadIdKey],
  );

  // Subscribe to job IDs for this project
  const jobIdKey = useAppStore((s) =>
    s.scheduledJobs
      .filter((j) => j.projectId === project.id)
      .map((j) => j.id)
      .join(","),
  );
  const jobIds = useMemo(
    () => jobIdKey ? jobIdKey.split(",") : [],
    [jobIdKey],
  );

  const style: React.CSSProperties = {
    ...styles.project,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
    position: "relative",
  };

  const isActive = project.id === activeProjectId;

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <div
        style={{
          ...styles.projectHeader,
          backgroundColor:
            isActive && !activeThreadId
              ? "var(--accent-selection)"
              : hovered
                ? "var(--bg-hover)"
                : "transparent",
        }}
        onClick={() => setActiveProject(project.id)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {project.missing && (
          <span style={styles.warningIcon} title="Directory not found">
            ⚠
          </span>
        )}
        <ProjectIcon
          project={project}
          size={baseFontSize + 2}
          onClick={(e) => {
            e.stopPropagation();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setIconPickerProjectId(project.id);
            setIconPickerPos({ x: rect.left, y: rect.bottom + 4 });
          }}
        />
        <span
          style={{
            ...styles.projectName,
            ...(project.missing ? { opacity: 0.5 } : {}),
          }}
          title={project.path}
        >
          {project.name}
        </span>
        <button
          onClick={(e) => handleNewThreadClick(e, project.id)}
          style={styles.newThreadBtn}
          title="New thread"
        >
          +
        </button>
      </div>

      {jobIds.length > 0 && (
        <ScheduledSection jobIds={jobIds} activeJobId={activeJobId} setActiveJob={setActiveJob} />
      )}
      {threadIds.length > 0 && (
        <div style={styles.projectBody}>
          {threadIds.map((threadId) => (
            <ThreadItem
              key={threadId}
              threadId={threadId}
              isActive={threadId === activeThreadId}
              ageTick={ageTick}
              onSelect={() => setActiveThread(threadId)}
            />
          ))}
        </div>
      )}
      <div style={styles.projectDivider} />
    </div>
  );
}

function ScheduledSection({ jobIds, activeJobId, setActiveJob }: { jobIds: string[]; activeJobId: string | null; setActiveJob: (id: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <>
      <div
        style={styles.scheduledHeader}
        onClick={() => setExpanded((e) => !e)}
      >
        <span style={{ display: "inline-flex", fontSize: "8px", opacity: 0.5, transition: "transform 0.15s", transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
        <span>Scheduled</span>
        <span style={{ opacity: 0.4 }}>({jobIds.length})</span>
      </div>
      {expanded && (
        <div style={styles.projectBody}>
          {jobIds.map((jobId) => (
            <JobItem
              key={jobId}
              jobId={jobId}
              isActive={jobId === activeJobId}
              onSelect={() => setActiveJob(jobId)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function PresetMenuItem({ preset, onClick }: { preset: { emoji: string; name: string; args: string }; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={preset.args}
      style={{
        ...styles.threadMenuItem,
        backgroundColor: hovered ? "var(--bg-hover)" : "transparent",
      }}
    >
      <span style={{ fontSize: "14px", width: "14px", textAlign: "center" }}>{preset.emoji}</span>
      {preset.name}
    </div>
  );
}

function NewThreadMenuItem({ type, label, onClick, icon }: { type: ThreadType; label: string; onClick: () => void; icon?: React.ReactNode }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...styles.threadMenuItem,
        backgroundColor: hovered ? "var(--bg-hover)" : "transparent",
      }}
    >
      {icon || <ThreadIcon type={type} />}
      {label}
    </div>
  );
}

const styles = {
  container: {
    height: "100%",
    backgroundColor: "var(--bg-panel)",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
    borderRight: "1px solid var(--border-default)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
  },
  headerText: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
  },
  addProjectButton: {
    color: "var(--accent)",
    border: "1px solid var(--accent)",
    fontSize: "var(--font-size-sm)",
    borderRadius: "3px",
    padding: "2px 8px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background-color 0.1s ease, color 0.1s ease",
  } as React.CSSProperties,
  list: {
    flex: 1,
    overflow: "auto",
  },
  empty: {
    padding: "24px 12px",
    textAlign: "center" as const,
    color: "var(--text-secondary)",
    fontSize: "var(--font-size)",
  },
  emptyButton: {
    background: "var(--accent)",
    border: "none",
    color: "var(--text-on-accent)",
    padding: "6px 16px",
    borderRadius: "3px",
    cursor: "pointer",
    fontSize: "var(--font-size)",
  },
  project: {
    marginTop: "6px",
  },
  projectHeader: {
    display: "flex",
    alignItems: "center",
    padding: "6px 8px",
    cursor: "pointer",
    gap: "4px",
    transition: "background-color 0.1s ease",
  } as React.CSSProperties,
  projectName: {
    color: "var(--text-heading)",
    fontSize: "calc(var(--font-size) + 2px)",
    fontWeight: 600,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  newThreadBtn: {
    background: "none",
    border: "none",
    color: "var(--accent)",
    fontSize: "calc(var(--font-size) + 3px)",
    cursor: "pointer",
    padding: "0 4px",
    flexShrink: 0,
    lineHeight: 1,
  } as React.CSSProperties,
  projectDivider: {
    height: "1px",
    margin: "0 12px",
    background: "linear-gradient(to right, transparent, var(--border-default) 30%, var(--border-default) 70%, transparent)",
  },
  projectBody: {
    paddingLeft: "8px",
    paddingBottom: "4px",
  },
  scheduledHeader: {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    padding: "6px 8px 2px",
    cursor: "pointer",
    opacity: 0.85,
    userSelect: "none" as const,
  } as React.CSSProperties,
  warningIcon: {
    fontSize: "var(--font-size-sm)",
    flexShrink: 0,
  } as React.CSSProperties,
  threadMenu: {
    position: "fixed" as const,
    zIndex: 1000,
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border-default)",
    borderRadius: "6px",
    padding: "4px 0",
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
    minWidth: "120px",
  } as React.CSSProperties,
  threadMenuItem: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 12px",
    fontSize: "var(--font-size)",
    color: "var(--text-primary)",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
};
