import { Rocket } from "lucide-react";
import type { ProjectIcon } from "../../store/types";
import { LUCIDE_MAP } from "../ProjectIcon";

interface PresetIconButtonProps {
  icon?: ProjectIcon;
  size: number;
}

export default function PresetIconButton({ icon, size }: PresetIconButtonProps) {
  if (!icon) {
    return <Rocket size={size} color="var(--text-secondary)" strokeWidth={2} />;
  }

  if (icon.type === "emoji") {
    const emojiScale = 0.88;
    return (
      <span
        style={{
          width: size,
          height: size,
          fontSize: size * emojiScale,
          lineHeight: 1,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {icon.value}
      </span>
    );
  }

  const IconComponent = LUCIDE_MAP[icon.name];
  if (!IconComponent) {
    return <Rocket size={size} color="var(--text-secondary)" strokeWidth={2} />;
  }

  return <IconComponent size={size} color={icon.color} strokeWidth={2} />;
}
