import { useAppStore } from "../../store/appStore";
import { getThreadSubtitle } from "../../lib/threadRuntime";

export default function StatusBar() {
  const activeThreadId = useAppStore((s) => s.activeThreadId);
  const activeThread = useAppStore((s) =>
    s.threads.find((t) => t.id === s.activeThreadId),
  );
  const info = useAppStore((s) =>
    activeThreadId ? s.transcriptInfo[activeThreadId] ?? null : null,
  );

  const subtitle = activeThread ? getThreadSubtitle(activeThread, info) : null;
  const costUsd = info?.costUsd ?? null;

  return (
    <div
      style={{
        height: "24px",
        backgroundColor: "var(--accent)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        fontSize: "var(--font-size-sm)",
        color: "var(--text-on-accent)",
      }}
    >
      <span>Codezilla</span>
      {activeThread && subtitle && (
        <span style={{ marginLeft: "16px", opacity: 0.85 }}>
          {activeThread.name}: {subtitle}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {costUsd != null && (
        <span>${costUsd.toFixed(2)}</span>
      )}
    </div>
  );
}
