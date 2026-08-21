import { describe, expect, it } from "vite-plus/test";

import {
  classifyHostedHttpsCompatibility,
  createAdvertisedEndpoint,
  deriveWsBaseUrl,
  environmentEndpointUrl,
  normalizeHttpBaseUrl,
} from "./endpoint.ts";

const coreProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
} as const;

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe(
      "https://example.com/path",
    );
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/socket");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/api");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });

  it("preserves a non-root path prefix when normalizing base urls", () => {
    expect(normalizeHttpBaseUrl("https://gateway.example.com/app/env/personal")).toBe(
      "https://gateway.example.com/app/env/personal",
    );
    expect(normalizeHttpBaseUrl("https://gateway.example.com/app/env/personal/")).toBe(
      "https://gateway.example.com/app/env/personal",
    );
    expect(deriveWsBaseUrl("https://gateway.example.com/app/env/personal")).toBe(
      "wss://gateway.example.com/app/env/personal",
    );
  });

  it("resolves an environment endpoint at the root when the base url has no path", () => {
    expect(environmentEndpointUrl("https://remote.example.com/", "/oauth/token")).toBe(
      "https://remote.example.com/oauth/token",
    );
  });

  it("joins an environment endpoint onto a reverse-proxy path prefix instead of overwriting it", () => {
    expect(
      environmentEndpointUrl("https://gateway.example.com/app/env/personal", "/oauth/token"),
    ).toBe("https://gateway.example.com/app/env/personal/oauth/token");
    expect(
      environmentEndpointUrl("https://gateway.example.com/app/env/personal/", "/oauth/token"),
    ).toBe("https://gateway.example.com/app/env/personal/oauth/token");
  });

  it("marks HTTP endpoints as blocked from hosted HTTPS apps", () => {
    expect(classifyHostedHttpsCompatibility("http://192.168.1.44:3773")).toBe(
      "mixed-content-blocked",
    );
    expect(classifyHostedHttpsCompatibility("https://desktop.example.com", "compatible")).toBe(
      "compatible",
    );
  });

  it("creates provider-neutral endpoint records", () => {
    expect(
      createAdvertisedEndpoint({
        id: "lan:http://192.168.1.44:3773",
        label: "LAN",
        provider: coreProvider,
        httpBaseUrl: "http://192.168.1.44:3773",
        reachability: "lan",
        source: "desktop-core",
        isDefault: true,
      }),
    ).toEqual({
      id: "lan:http://192.168.1.44:3773",
      label: "LAN",
      provider: coreProvider,
      httpBaseUrl: "http://192.168.1.44:3773/",
      wsBaseUrl: "ws://192.168.1.44:3773/",
      reachability: "lan",
      compatibility: {
        hostedHttpsApp: "mixed-content-blocked",
        desktopApp: "compatible",
      },
      source: "desktop-core",
      status: "available",
      isDefault: true,
    });
  });
});
