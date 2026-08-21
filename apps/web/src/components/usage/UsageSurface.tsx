import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import type { UsageResponse, UsageLimit, UsageProvider } from "./usageSurface.logic";
import {
  usageEndpointPath,
  formatResetsIn,
  formatAgo,
  meterSeverity,
  planLabel,
} from "./usageSurface.logic";

type UsageFetchState = "loading" | "error" | "loaded";

interface UsageSurfaceState {
  state: UsageFetchState;
  data: UsageResponse | null;
  error: string | null;
  lastFetch: number;
}

export function UsageSurface() {
  const [usageState, setUsageState] = useState<UsageSurfaceState>({
    state: "loading",
    data: null,
    error: null,
    lastFetch: 0,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const fetchIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const visibilityListenerRef = useRef<(() => void) | null>(null);

  const fetchUsage = async (isInitial = false) => {
    // Abort any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    abortControllerRef.current = new AbortController();

    try {
      const path = usageEndpointPath(import.meta.env.BASE_URL);
      const response = await fetch(path, {
        credentials: "include",
        signal: abortControllerRef.current.signal,
      });

      if (response.status === 404 || response.status === 405) {
        setUsageState({
          state: "error",
          data: null,
          error: "Usage data is only available in the hosted app.",
          lastFetch: Date.now(),
        });
        return;
      }

      if (!response.ok) {
        setUsageState({
          state: "error",
          data: null,
          error: "Couldn't load usage data.",
          lastFetch: Date.now(),
        });
        return;
      }

      const data = (await response.json()) as UsageResponse;
      setUsageState({
        state: "loaded",
        data,
        error: null,
        lastFetch: Date.now(),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return; // Request was aborted, don't update state
      }

      if (isInitial) {
        setUsageState({
          state: "error",
          data: null,
          error:
            error instanceof Error
              ? error.message
              : "Couldn't load usage data.",
          lastFetch: Date.now(),
        });
      }
    }
  };

  useEffect(() => {
    // Initial fetch
    void fetchUsage(true);

    // Set up 60-second polling
    fetchIntervalRef.current = setInterval(() => {
      void fetchUsage(false);
    }, 60000);

    // Set up visibility listener for refetch on tab return
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchUsage(false);
      }
    };
    visibilityListenerRef.current = handleVisibilityChange;
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (fetchIntervalRef.current) {
        clearInterval(fetchIntervalRef.current);
      }
      if (visibilityListenerRef.current) {
        document.removeEventListener("visibilitychange", visibilityListenerRef.current);
      }
    };
  }, []);

  const handleRefresh = async () => {
    await fetchUsage(false);
  };

  if (usageState.state === "loading") {
    return (
      <ScrollArea className="h-full">
        <div className="p-4">
          <div className="text-xs text-muted-foreground">Loading usage data...</div>
        </div>
      </ScrollArea>
    );
  }

  if (usageState.state === "error") {
    return (
      <ScrollArea className="h-full">
        <div className="flex flex-col items-center justify-center p-4">
          <div className="text-center">
            <p className="text-xs text-muted-foreground">
              {usageState.error}
            </p>
            {usageState.error === "Couldn't load usage data." && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefresh}
                className="mt-3"
              >
                <RotateCcw className="size-3.5" />
                Retry
              </Button>
            )}
          </div>
        </div>
      </ScrollArea>
    );
  }

  const data = usageState.data;
  if (!data) {
    return (
      <ScrollArea className="h-full">
        <div className="p-4">
          <div className="text-xs text-muted-foreground">No usage data available.</div>
        </div>
      </ScrollArea>
    );
  }

  const now = Date.now();
  const formatTime = new Date(data.generatedAt);
  const timeStr = formatTime.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">Usage</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">updated {timeStr}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefresh}
              aria-label="Refresh usage"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* Claude Provider */}
        {data.providers.claude && (
          <ProviderCard
            name="Claude"
            provider={data.providers.claude}
            now={now}
          />
        )}

        {/* OpenAI Provider */}
        {data.providers.openai && (
          <ProviderCard
            name="ChatGPT / Codex"
            provider={data.providers.openai}
            now={now}
          />
        )}
      </div>
    </ScrollArea>
  );
}

function ProviderCard(props: {
  name: string;
  provider: UsageProvider;
  now: number;
}) {
  const { name, provider, now } = props;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{name}</h3>
        {provider.plan || provider.tier ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {planLabel(name === "Claude" ? "claude" : "openai", provider.plan, provider.tier)}
          </span>
        ) : null}
      </div>

      {!provider.ok && provider.error ? (
        <div className="mt-2 text-xs text-muted-foreground">{provider.error}</div>
      ) : provider.limits && provider.limits.length > 0 ? (
        <div className="mt-3 space-y-3">
          {provider.limits.map((limit) => (
            <LimitRow key={`${limit.id}:${limit.scope ?? ""}`} limit={limit} now={now} />
          ))}
        </div>
      ) : null}

      {provider.capturedAt && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          snapshot from {formatAgo(provider.capturedAt, now)}
        </div>
      )}
    </div>
  );
}

function LimitRow(props: { limit: UsageLimit; now: number }) {
  const { limit, now } = props;
  const severity = meterSeverity(limit.percent, limit.severity);

  const severityText =
    severity === "critical"
      ? limit.percent >= 100
        ? " — limit reached"
        : " — near limit"
      : severity === "warning"
        ? " — approaching limit"
        : null;

  return (
    <div className="space-y-1">
      {/* Label and percentage */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-foreground">{limit.label}</span>
        <span className="text-xs tabular-nums text-foreground">
          {Math.min(100, Math.max(0, limit.percent))}%
        </span>
      </div>

      {/* Meter */}
      <div
        className={cn(
          "h-1.5 w-full rounded-full bg-muted overflow-hidden",
        )}
      >
        <div
          className={cn(
            "h-full rounded-full transition-all",
            severity === "ok" && "bg-primary",
            severity === "warning" && "bg-amber-500",
            severity === "critical" && "bg-destructive",
          )}
          style={{
            width: `${Math.min(100, Math.max(0, limit.percent))}%`,
          }}
        />
      </div>

      {/* Reset time and severity text */}
      <div className="text-[11px] text-muted-foreground">
        {formatResetsIn(limit.resetsAt, now)}
        {severityText}
      </div>
    </div>
  );
}
