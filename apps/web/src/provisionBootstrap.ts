import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as ConnectionCatalogDocumentType,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
} from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CATALOG_KEY,
  CATALOG_STORE_NAME,
  openDatabase,
  readDatabaseValue,
  writeDatabaseValue,
} from "./connection/storage";
import { isElectron } from "./env";

/**
 * Same-origin gateway document that auto-provisions t3 environments for a
 * path-prefixed hosted deployment (see apps/web/src/router.ts and the vite
 * `base` config for the matching path-prefix support). Each environment's
 * `token` is a long-lived bearer session token that is stored directly as a
 * connection credential -- there is no /oauth/token exchange for it.
 */
const ProvisionedEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  token: Schema.String,
});

const ProvisionDocument = Schema.Struct({
  version: Schema.Literal(1),
  environments: Schema.Array(ProvisionedEnvironment),
});
export type ProvisionDocument = typeof ProvisionDocument.Type;
export type ProvisionedEnvironment = typeof ProvisionedEnvironment.Type;

const decodeProvisionDocument = Schema.decodeUnknownSync(ProvisionDocument);

const ConnectionCatalogDocumentJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeConnectionCatalogDocument = Schema.decodeUnknownSync(ConnectionCatalogDocumentJson);
const encodeConnectionCatalogDocument = Schema.encodeSync(ConnectionCatalogDocumentJson);

/**
 * Pure merge: upserts one bearer connection (target + profile + credential)
 * per provisioned environment into the catalog document, keyed by
 * `bearer:<environmentId>` -- the same connectionId convention used by the
 * manual pairing flow (see connection/onboarding.ts). Unrelated existing
 * targets/profiles/credentials and all `remoteDpopTokens` are preserved
 * because `registerConnectionInCatalog` only touches the entry for the
 * environment being registered.
 */
export function mergeProvisionedEnvironments(
  document: ConnectionCatalogDocumentType,
  provisioned: ProvisionDocument,
): ConnectionCatalogDocumentType {
  return provisioned.environments.reduce((current, environment) => {
    const connectionId = `bearer:${environment.environmentId}`;
    const registration = new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: environment.environmentId,
        label: environment.label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: environment.environmentId,
        label: environment.label,
        httpBaseUrl: environment.httpBaseUrl,
        wsBaseUrl: environment.wsBaseUrl,
      }),
      credential: new BearerConnectionCredential({
        token: environment.token,
      }),
    });
    return registerConnectionInCatalog(current, registration);
  }, document);
}

function readExistingCatalogDocument(raw: unknown): ConnectionCatalogDocumentType {
  if (typeof raw !== "string" || raw.trim() === "") {
    return EMPTY_CONNECTION_CATALOG_DOCUMENT;
  }
  try {
    return decodeConnectionCatalogDocument(raw);
  } catch {
    // A corrupt catalog is handled by the normal app boot path (see
    // connection/storage.ts's quarantine logic); provisioning just treats
    // it as empty rather than overwriting or discarding it here.
    return EMPTY_CONNECTION_CATALOG_DOCUMENT;
  }
}

/**
 * Auto-provisions t3 environments from a same-origin `provision.json` before
 * the app renders. This is a no-op (and must stay byte-behavior-identical to
 * the live build) unless explicitly enabled for a hosted, path-prefixed
 * deployment via VITE_PROVISION_BOOTSTRAP=1. Any failure (missing file,
 * network error, malformed JSON, IndexedDB error) is swallowed -- the app
 * must still boot even if provisioning fails.
 */
export async function bootstrapProvisionedEnvironments(): Promise<void> {
  if (isElectron || import.meta.env.VITE_PROVISION_BOOTSTRAP !== "1") {
    return;
  }

  try {
    const response = await fetch(`${import.meta.env.BASE_URL}provision.json`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      return;
    }
    const raw: unknown = await response.json();
    const provisioned = decodeProvisionDocument(raw);
    if (provisioned.environments.length === 0) {
      return;
    }

    const database = await Effect.runPromise(openDatabase());
    try {
      const existingRaw = await Effect.runPromise(
        readDatabaseValue(database, CATALOG_STORE_NAME, CATALOG_KEY),
      );
      const existingDocument = readExistingCatalogDocument(existingRaw);
      const merged = mergeProvisionedEnvironments(existingDocument, provisioned);
      const encoded = encodeConnectionCatalogDocument(merged);
      await Effect.runPromise(
        writeDatabaseValue(database, CATALOG_STORE_NAME, CATALOG_KEY, encoded),
      );
    } finally {
      database.close();
    }
  } catch {
    // Provisioning is best-effort: swallow every failure so the app still
    // boots (e.g. no gateway, no provision.json, or a storage error).
  }
}
