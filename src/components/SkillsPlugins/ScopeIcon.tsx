export function ScopeIcon({ scope }: { scope: "Global" | "Project" | string }) {
  const label = scope === "Global" ? "Global scope" : "Project scope";
  const color = "var(--text-secondary)";

  if (scope === "Global") {
    return (
      <span title={label}>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke={color}
          strokeWidth="1.3"
          style={{ marginRight: "5px", verticalAlign: "-1px" }}
        >
          <circle cx="8" cy="8" r="6.5" />
          <ellipse cx="8" cy="8" rx="3" ry="6.5" />
          <line x1="1.5" y1="8" x2="14.5" y2="8" />
        </svg>
      </span>
    );
  }

  return (
    <span title={label}>
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke={color}
        strokeWidth="1.3"
        style={{ marginRight: "5px", verticalAlign: "-1px" }}
      >
        <path d="M2 4V13H14V6H8L6.5 4H2Z" />
      </svg>
    </span>
  );
}
