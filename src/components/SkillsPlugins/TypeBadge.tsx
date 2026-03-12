const typeColors: Record<string, { color: string; borderColor: string }> = {
  Plugin: { color: "#b48ead", borderColor: "#b48ead66" },
  Skill: { color: "#a3be8c", borderColor: "#a3be8c66" },
  Agent: { color: "#d08770", borderColor: "#d0877066" },
  Command: { color: "#88c0d0", borderColor: "#88c0d066" },
};

export function TypeBadge({ type }: { type: string }) {
  const colors = typeColors[type] ?? { color: "var(--text-secondary)", borderColor: "var(--border-medium)" };
  return (
    <span
      style={{
        fontSize: "10px",
        padding: "1px 6px",
        borderRadius: "3px",
        border: `1px solid ${colors.borderColor}`,
        color: colors.color,
        marginLeft: "6px",
      }}
    >
      {type.toLowerCase()}
    </span>
  );
}
