import { TokenStore } from "@t3tools/client-runtime/authorization";
import { EMPTY_CONNECTION_CATALOG_DOCUMENT } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeProvisionedEnvironments, type ProvisionDocument } from "./provisionBootstrap";

function provisionDocument(environments: ProvisionDocument["environments"]): ProvisionDocument {
  return { version: 1, environments };
}

describe("mergeProvisionedEnvironments", () => {
  it("inserts a bearer target, profile, and credential for a provisioned environment", () => {
    const personalId = EnvironmentId.make("environment-personal");
    const merged = mergeProvisionedEnvironments(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      provisionDocument([
        {
          environmentId: personalId,
          label: "Personal",
          httpBaseUrl: "https://lateshiftcloud.com/app/env/personal",
          wsBaseUrl: "wss://lateshiftcloud.com/app/env/personal",
          token: "personal-token",
        },
      ]),
    );

    expect(merged.targets).toEqual([
      {
        _tag: "BearerConnectionTarget",
        environmentId: personalId,
        label: "Personal",
        connectionId: "bearer:environment-personal",
      },
    ]);
    expect(merged.profiles).toEqual([
      {
        _tag: "BearerConnectionProfile",
        connectionId: "bearer:environment-personal",
        environmentId: personalId,
        label: "Personal",
        httpBaseUrl: "https://lateshiftcloud.com/app/env/personal",
        wsBaseUrl: "wss://lateshiftcloud.com/app/env/personal",
      },
    ]);
    expect(merged.credentials).toEqual([
      {
        connectionId: "bearer:environment-personal",
        credential: { _tag: "BearerConnectionCredential", token: "personal-token" },
      },
    ]);
    expect(merged.remoteDpopTokens).toEqual([]);
  });

  it("upserts multiple provisioned environments and preserves unrelated existing entries", () => {
    const personalId = EnvironmentId.make("environment-personal");
    const companyId = EnvironmentId.make("environment-company");
    const otherId = EnvironmentId.make("environment-other");

    const existing = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [
        {
          _tag: "BearerConnectionTarget" as const,
          environmentId: otherId,
          label: "Other",
          connectionId: "bearer:environment-other",
        },
        {
          _tag: "BearerConnectionTarget" as const,
          environmentId: personalId,
          label: "Stale Personal Label",
          connectionId: "bearer:environment-personal",
        },
      ],
      profiles: [
        {
          _tag: "BearerConnectionProfile" as const,
          connectionId: "bearer:environment-other",
          environmentId: otherId,
          label: "Other",
          httpBaseUrl: "https://other.example.com/",
          wsBaseUrl: "wss://other.example.com/",
        },
        {
          _tag: "BearerConnectionProfile" as const,
          connectionId: "bearer:environment-personal",
          environmentId: personalId,
          label: "Stale Personal Label",
          httpBaseUrl: "https://stale.example.com/",
          wsBaseUrl: "wss://stale.example.com/",
        },
      ],
      credentials: [
        {
          connectionId: "bearer:environment-other",
          credential: { _tag: "BearerConnectionCredential" as const, token: "other-token" },
        },
        {
          connectionId: "bearer:environment-personal",
          credential: { _tag: "BearerConnectionCredential" as const, token: "stale-token" },
        },
      ],
      remoteDpopTokens: [
        new TokenStore.RemoteDpopAccessToken({
          environmentId: otherId,
          label: "Other",
          endpoint: {
            httpBaseUrl: "https://other.example.com/",
            wsBaseUrl: "wss://other.example.com/",
            providerKind: "manual",
          },
          accessToken: "other-access-token",
          expiresAtEpochMs: 1_800_000_000_000,
          dpopThumbprint: "other-thumbprint",
        }),
      ],
    };

    const merged = mergeProvisionedEnvironments(
      existing,
      provisionDocument([
        {
          environmentId: personalId,
          label: "Personal",
          httpBaseUrl: "https://lateshiftcloud.com/app/env/personal",
          wsBaseUrl: "wss://lateshiftcloud.com/app/env/personal",
          token: "personal-token",
        },
        {
          environmentId: companyId,
          label: "Company",
          httpBaseUrl: "https://lateshiftcloud.com/app/env/company",
          wsBaseUrl: "wss://lateshiftcloud.com/app/env/company",
          token: "company-token",
        },
      ]),
    );

    // The unrelated "other" environment is untouched, including its remote
    // DPoP token, and "personal" is replaced rather than duplicated.
    expect(merged.targets).toHaveLength(3);
    expect(merged.targets).toContainEqual({
      _tag: "BearerConnectionTarget",
      environmentId: otherId,
      label: "Other",
      connectionId: "bearer:environment-other",
    });
    expect(merged.targets).toContainEqual({
      _tag: "BearerConnectionTarget",
      environmentId: personalId,
      label: "Personal",
      connectionId: "bearer:environment-personal",
    });
    expect(merged.targets).toContainEqual({
      _tag: "BearerConnectionTarget",
      environmentId: companyId,
      label: "Company",
      connectionId: "bearer:environment-company",
    });

    const personalProfile = merged.profiles.find(
      (profile) => profile.connectionId === "bearer:environment-personal",
    );
    expect(personalProfile).toMatchObject({
      httpBaseUrl: "https://lateshiftcloud.com/app/env/personal",
      wsBaseUrl: "wss://lateshiftcloud.com/app/env/personal",
      label: "Personal",
    });

    const personalCredential = merged.credentials.find(
      (entry) => entry.connectionId === "bearer:environment-personal",
    );
    expect(personalCredential?.credential).toEqual({
      _tag: "BearerConnectionCredential",
      token: "personal-token",
    });

    expect(merged.remoteDpopTokens).toEqual(existing.remoteDpopTokens);
  });

  it("is a no-op for an empty provisioned environments list", () => {
    const merged = mergeProvisionedEnvironments(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      provisionDocument([]),
    );
    expect(merged).toEqual(EMPTY_CONNECTION_CATALOG_DOCUMENT);
  });
});
