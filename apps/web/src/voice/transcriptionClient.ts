import type { TranscribeResult } from "./voiceRecordingTypes";

// Same-origin transcription endpoint route path on the environment server
// (see apps/server/src/http.ts). When paired to an environment server,
// ComposerMicButton resolves this against the paired server's base URL.
// When empty (dev / bundled), it resolves via the Vite base URL for
// same-origin requests; hosted-static builds use the gateway's transcription
// proxy, which transcribes with OpenAI gpt-4o-transcribe for high accuracy.
const TRANSCRIPTION_PATH = "/api/transcription/audio";

// Base URL for cross-origin paired server transcription. An empty value falls
// back to same-origin (dev / bundled / hosted-static via Vite base URL).
let transcriptionBaseUrl = "";

export function setTranscriptionBaseUrl(baseUrl: string | null): void {
  transcriptionBaseUrl = baseUrl?.trim() ?? "";
}

/**
 * Resolve the transcription path under the Vite base URL. Guards against
 * missing/empty BASE_URL and double slashes so a BASE_URL of "/" yields
 * "/api/transcription/audio" and "/app/" yields "/app/api/transcription/audio".
 */
export function pageOriginTranscriptionPath(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim() || "/";
  const normalized = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  return `${normalized}api/transcription/audio`.replace(/\/+/g, "/");
}

function transcriptionEndpoint(): string {
  if (!transcriptionBaseUrl) {
    return pageOriginTranscriptionPath(import.meta.env.BASE_URL);
  }
  try {
    return new URL(TRANSCRIPTION_PATH, transcriptionBaseUrl).toString();
  } catch {
    return pageOriginTranscriptionPath(import.meta.env.BASE_URL);
  }
}

interface TranscriptionErrorBody {
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function isRetryableStatus(status: number): boolean {
  // 5xx are transient; 408/429 are explicit "try again" signals. Other 4xx
  // (unsupported media type, too large, bad audio, not configured) will not
  // succeed on retry, so we surface them for a manual decision instead.
  return status >= 500 || status === 408 || status === 429;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as TranscriptionErrorBody;
    const message = body.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  } catch {
    // Non-JSON error body; fall through to the generic message.
  }
  return fallback;
}

/**
 * POST the recorded audio to the server transcription proxy. Maps transport and
 * HTTP failures into a {@link TranscribeResult} the controller uses to decide
 * whether to auto-retry (transient) or hold for a manual retry (client error).
 */
export async function transcribeAudioViaServer(
  blob: Blob,
  mimeType: string,
): Promise<TranscribeResult> {
  let response: Response;
  try {
    response = await fetch(transcriptionEndpoint(), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": mimeType || blob.type || "application/octet-stream" },
      body: blob,
    });
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      message:
        error instanceof Error && error.message.length > 0
          ? `Network error: ${error.message}`
          : "Network error while contacting the transcription service.",
    };
  }

  if (response.ok) {
    try {
      const body = (await response.json()) as { text?: unknown };
      if (typeof body.text === "string") {
        return { ok: true, text: body.text };
      }
    } catch {
      // fall through
    }
    return {
      ok: false,
      retryable: true,
      message: "The transcription service returned an unexpected response.",
    };
  }

  const message = await readErrorMessage(
    response,
    `Transcription failed (HTTP ${response.status}).`,
  );
  return { ok: false, retryable: isRetryableStatus(response.status), message };
}
