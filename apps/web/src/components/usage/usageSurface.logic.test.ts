import { describe, it, expect } from "vite-plus/test";
import {
  usageEndpointPath,
  formatResetsIn,
  formatAgo,
  meterSeverity,
  planLabel,
} from "./usageSurface.logic";

describe("usageSurface.logic", () => {
  describe("usageEndpointPath", () => {
    it("returns /api/usage for undefined baseUrl", () => {
      expect(usageEndpointPath(undefined)).toBe("/api/usage");
    });

    it("returns /api/usage for empty string", () => {
      expect(usageEndpointPath("")).toBe("/api/usage");
    });

    it("returns /api/usage for root slash", () => {
      expect(usageEndpointPath("/")).toBe("/api/usage");
    });

    it("normalizes /app/ to /app/api/usage", () => {
      expect(usageEndpointPath("/app/")).toBe("/app/api/usage");
    });

    it("normalizes /app to /app/api/usage", () => {
      expect(usageEndpointPath("/app")).toBe("/app/api/usage");
    });

    it("appends /api/usage to non-root paths", () => {
      expect(usageEndpointPath("/chat")).toBe("/chat/api/usage");
    });
  });

  describe("formatResetsIn", () => {
    const baseTime = new Date("2025-08-21T12:00:00Z").getTime();

    it("returns null when resetsAt is null", () => {
      expect(formatResetsIn(null, baseTime)).toBeNull();
    });

    it("returns null when resetsAt is invalid", () => {
      expect(formatResetsIn("invalid-date", baseTime)).toBeNull();
    });

    it("returns 'resets soon' when time has passed", () => {
      const pastTime = new Date(baseTime - 1000).toISOString();
      expect(formatResetsIn(pastTime, baseTime)).toBe("resets soon");
    });

    it("formats minutes only", () => {
      const futureTime = new Date(baseTime + 5 * 60 * 1000).toISOString();
      expect(formatResetsIn(futureTime, baseTime)).toBe("resets in 5m");
    });

    it("formats hours and minutes", () => {
      const futureTime = new Date(baseTime + (2 * 60 + 15) * 60 * 1000).toISOString();
      expect(formatResetsIn(futureTime, baseTime)).toBe("resets in 2h 15m");
    });

    it("formats hours only when minutes are zero", () => {
      const futureTime = new Date(baseTime + 3 * 60 * 60 * 1000).toISOString();
      expect(formatResetsIn(futureTime, baseTime)).toBe("resets in 3h");
    });

    it("formats days and hours", () => {
      const futureTime = new Date(baseTime + (3 * 24 + 4) * 60 * 60 * 1000).toISOString();
      expect(formatResetsIn(futureTime, baseTime)).toBe("resets in 3d 4h");
    });

    it("formats days only when hours are zero", () => {
      const futureTime = new Date(baseTime + 7 * 24 * 60 * 60 * 1000).toISOString();
      expect(formatResetsIn(futureTime, baseTime)).toBe("resets in 7d");
    });
  });

  describe("formatAgo", () => {
    const baseTime = new Date("2025-08-21T12:00:00Z").getTime();

    it("returns null when iso is undefined", () => {
      expect(formatAgo(undefined, baseTime)).toBeNull();
    });

    it("returns null when iso is invalid", () => {
      expect(formatAgo("invalid-date", baseTime)).toBeNull();
    });

    it("returns null when time is in the future", () => {
      const futureTime = new Date(baseTime + 1000).toISOString();
      expect(formatAgo(futureTime, baseTime)).toBeNull();
    });

    it("formats minutes", () => {
      const pastTime = new Date(baseTime - 5 * 60 * 1000).toISOString();
      expect(formatAgo(pastTime, baseTime)).toBe("5m ago");
    });

    it("formats as 1m ago when less than a minute", () => {
      const pastTime = new Date(baseTime - 30 * 1000).toISOString();
      expect(formatAgo(pastTime, baseTime)).toBe("1m ago");
    });

    it("formats hours", () => {
      const pastTime = new Date(baseTime - 3 * 60 * 60 * 1000).toISOString();
      expect(formatAgo(pastTime, baseTime)).toBe("3h ago");
    });

    it("formats days", () => {
      const pastTime = new Date(baseTime - 2 * 24 * 60 * 60 * 1000).toISOString();
      expect(formatAgo(pastTime, baseTime)).toBe("2d ago");
    });
  });

  describe("meterSeverity", () => {
    it("returns ok for percent < 70 with no api severity", () => {
      expect(meterSeverity(50)).toBe("ok");
    });

    it("returns warning for percent >= 70 and < 90", () => {
      expect(meterSeverity(70)).toBe("warning");
      expect(meterSeverity(89)).toBe("warning");
    });

    it("returns critical for percent >= 90", () => {
      expect(meterSeverity(90)).toBe("critical");
      expect(meterSeverity(99)).toBe("critical");
    });

    it("returns ok for 69 percent", () => {
      expect(meterSeverity(69)).toBe("ok");
    });

    it("returns warning for api severity 'warning'", () => {
      expect(meterSeverity(50, "warning")).toBe("warning");
    });

    it("returns warning for api severity 'elevated'", () => {
      expect(meterSeverity(50, "elevated")).toBe("warning");
    });

    it("returns critical for api severity 'exceeded'", () => {
      expect(meterSeverity(50, "exceeded")).toBe("critical");
    });

    it("returns critical for api severity 'critical'", () => {
      expect(meterSeverity(50, "critical")).toBe("critical");
    });

    it("returns critical for api severity 'error'", () => {
      expect(meterSeverity(50, "error")).toBe("critical");
    });
  });

  describe("planLabel", () => {
    it("transforms claude tier 'default_claude_max_20x' to 'Max 20x'", () => {
      expect(planLabel("claude", undefined, "default_claude_max_20x")).toBe("Max 20x");
    });

    it("removes default_claude_ prefix from tier", () => {
      expect(planLabel("claude", undefined, "default_claude_free")).toBe("Free");
    });

    it("replaces underscores with spaces in tier", () => {
      expect(planLabel("claude", undefined, "default_claude_pro_monthly")).toBe("Pro monthly");
    });

    it("capitalizes first letter of tier", () => {
      expect(planLabel("claude", undefined, "default_claude_something")).toBe("Something");
    });

    it("falls back to plan for claude", () => {
      expect(planLabel("claude", "max", undefined)).toBe("Max");
    });

    it("returns 'Unknown plan' for claude with no tier or plan", () => {
      expect(planLabel("claude")).toBe("Unknown plan");
    });

    it("capitalizes openai plan", () => {
      expect(planLabel("openai", "prolite")).toBe("Prolite");
      expect(planLabel("openai", "plus")).toBe("Plus");
      expect(planLabel("openai", "pro")).toBe("Pro");
    });

    it("returns 'Unknown plan' for openai with no plan", () => {
      expect(planLabel("openai")).toBe("Unknown plan");
    });
  });
});
