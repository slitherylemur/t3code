/**
 * Usage surface helpers and types.
 */

export interface UsageLimit {
  id: string;
  label: string;
  percent: number;
  resetsAt: string | null;
  severity?: string | null;
  scope?: string | null;
  windowMinutes?: number;
  active?: boolean;
}

export interface UsageProvider {
  ok: boolean;
  error?: string;
  plan?: string | null;
  tier?: string | null;
  capturedAt?: string | null;
  stale?: boolean;
  limits?: UsageLimit[];
}

export interface UsageResponse {
  generatedAt: string;
  providers: {
    claude?: UsageProvider;
    openai?: UsageProvider;
  };
}

export function usageEndpointPath(baseUrl: string | undefined): string {
  if (!baseUrl) return "/api/usage";
  const normalized = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  if (normalized === "") return "/api/usage";
  if (normalized === "/") return "/api/usage";
  if (normalized === "/app") return "/app/api/usage";
  if (normalized.endsWith("/app")) return `${normalized}/api/usage`;
  return `${normalized}/api/usage`;
}

export function formatResetsIn(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;

  const resetTime = new Date(resetsAt).getTime();
  if (isNaN(resetTime)) return null;

  const diff = resetTime - now;
  if (diff <= 0) return "resets soon";

  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `resets in ${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    if (remainingMinutes === 0) return `resets in ${hours}h`;
    return `resets in ${hours}h ${remainingMinutes}m`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (remainingHours === 0) return `resets in ${days}d`;
  return `resets in ${days}d ${remainingHours}h`;
}

export function formatAgo(iso: string | undefined, now: number): string | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (isNaN(time)) return null;

  const diff = now - time;
  if (diff < 0) return null;

  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function meterSeverity(
  percent: number,
  apiSeverity?: string | null,
): "ok" | "warning" | "critical" {
  const criticalSeverities = new Set(["exceeded", "critical", "error"]);
  const warningSeverities = new Set(["warning", "elevated"]);

  if (percent >= 90 || (apiSeverity && criticalSeverities.has(apiSeverity))) {
    return "critical";
  }
  if (percent >= 70 || (apiSeverity && warningSeverities.has(apiSeverity))) {
    return "warning";
  }
  return "ok";
}

export function planLabel(
  provider: "claude" | "openai",
  plan?: string | null,
  tier?: string | null,
): string {
  if (provider === "claude") {
    if (tier) {
      // Transform "default_claude_max_20x" -> "Max 20x"
      let label = tier;
      if (label.startsWith("default_claude_")) {
        label = label.slice("default_claude_".length);
      }
      // Replace underscores with spaces and capitalize first letter
      label = label.replace(/_/g, " ");
      if (label.length > 0) {
        label = label.charAt(0).toUpperCase() + label.slice(1);
      }
      return label;
    }
    if (plan) {
      return plan.charAt(0).toUpperCase() + plan.slice(1);
    }
    return "Unknown plan";
  }

  // OpenAI provider
  if (plan) {
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  }
  return "Unknown plan";
}
