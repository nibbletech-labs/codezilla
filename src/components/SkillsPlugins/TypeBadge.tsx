export function TypeBadge({ type }: { type: string }) {
  return (
    <span
      style={{
        fontSize: "10px",
        padding: "1px 6px",
        borderRadius: "3px",
        border: "1px solid var(--border-medium)",
        color: "var(--text-secondary)",
        marginLeft: "6px",
      }}
    >
      {type.toLowerCase()}
    </span>
  );
}
