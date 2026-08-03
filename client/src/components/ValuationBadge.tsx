import { Award, Scale, Sparkles, HelpCircle } from "lucide-react";

/**
 * Shows WHY a listing surfaced: because of who made it, because of confirmed
 * metal content, because it's worth a closer look though unconfirmed, or a
 * combination. Without this the three paths are indistinguishable in the UI.
 */
type ValuationBadgeProps = {
  path: string | null | undefined;
  tag?: string | null;
};

const STYLES: Record<string, { label: string; className: string; Icon: typeof Award }> = {
  brand_path: {
    label: "Brand match",
    className: "bg-violet-600 text-white",
    Icon: Award,
  },
  scrap_path: {
    label: "Scrap value (confirmed)",
    className: "bg-amber-600 text-white",
    Icon: Scale,
  },
  both: {
    label: "Brand match + Scrap value (confirmed)",
    className: "bg-emerald-600 text-white",
    Icon: Sparkles,
  },
  // Deliberately muted: this path never confirms a material or a value.
  unmarked_suspicion_path: {
    label: "Suspected metal (unconfirmed - review)",
    className: "bg-sky-700 text-white",
    Icon: HelpCircle,
  },
};

export function ValuationBadge({ path, tag }: ValuationBadgeProps) {
  if (!path || path === "unscored") return null;
  const style = STYLES[path];
  if (!style) return null;
  const { className, Icon } = style;

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${className}`}
      data-testid={`badge-valuation-${path}`}
    >
      <Icon className="w-3 h-3" />
      {tag || style.label}
    </span>
  );
}

export default ValuationBadge;
