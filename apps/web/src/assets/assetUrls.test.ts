import { describe, expect, it } from "vite-plus/test";

import { resolveAssetUrl } from "./assetUrls";

describe("resolveAssetUrl", () => {
  it("resolves a root-relative asset URL against a root environment base URL", () => {
    expect(
      resolveAssetUrl("https://environment.example/", "/api/assets/signed-token/favicon.png"),
    ).toBe("https://environment.example/api/assets/signed-token/favicon.png");
  });

  it("joins a root-relative asset URL onto a reverse-proxy path prefix instead of dropping it", () => {
    expect(
      resolveAssetUrl("https://environment.example/base/", "/api/assets/signed-token/favicon.png"),
    ).toBe("https://environment.example/base/api/assets/signed-token/favicon.png");
  });

  it("rejects an invalid environment base URL", () => {
    expect(resolveAssetUrl("not a URL", "/api/assets/signed-token/favicon.png")).toBeNull();
  });
});
