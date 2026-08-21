import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { toastManager } from "../components/ui/toast";
import { isIndexedDbAvailable } from "./voiceRecordingDb";
import { setVoiceRecordingHandlers, voiceRecordingController } from "./voiceRecordingSingleton";
import type { VoiceRecordingSnapshot } from "./voiceRecordingTypes";

// Hard cap per segment so a forgotten recording cannot grow unbounded; well
// under the server's 25 MB payload ceiling for typical Opus bitrates.
// Recording continues across segments via automatic rollover.
const MAX_SEGMENT_MS = 10 * 60 * 1000;

// Compressed formats the OpenAI transcription API accepts, in preference order.
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

function pickSupportedMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export interface VoiceRecordingApi {
  readonly snapshot: VoiceRecordingSnapshot;
  readonly elapsedMs: number;
  readonly isSupported: boolean;
  start(): Promise<void>;
  stop(): void;
  retry(): void;
  discard(): void;
}

/**
 * React binding over the shared {@link voiceRecordingController}. Owns the
 * browser capture concerns — microphone permission, MediaRecorder lifecycle,
 * elapsed timer, and the max-duration cap — and forwards chunks/results to the
 * controller, which owns persistence, transcription, and retries.
 */
export function useVoiceRecording(options: {
  onInsertTranscript: (text: string) => void;
  disabled?: boolean;
}): VoiceRecordingApi {
  const snapshot = useSyncExternalStore(
    voiceRecordingController.subscribe,
    voiceRecordingController.getSnapshot,
  );
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const segmentStartedAtRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rolloverRequestedRef = useRef(false);

  useEffect(() => {
    setVoiceRecordingHandlers({
      onTranscript: options.onInsertTranscript,
      onError: (message) => {
        toastManager.add({ type: "error", title: "Transcription failed", description: message });
      },
    });
  }, [options.onInsertTranscript]);

  useEffect(() => {
    // Recover any recording left behind by a crashed/closed session.
    void voiceRecordingController.hydrate();
  }, []);

  const clearTimers = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (maxTimeoutRef.current !== null) {
      clearTimeout(maxTimeoutRef.current);
      maxTimeoutRef.current = null;
    }
  }, []);

  const teardownStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const stop = useCallback(() => {
    clearTimers();
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state !== "inactive") {
      recorder.stop();
    }
  }, [clearTimers]);

  const startRecorder = useCallback(
    (stream: MediaStream, effectiveMime: string) => {
      // Create a new MediaRecorder for this segment.
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(
          stream,
          effectiveMime === undefined ? undefined : { mimeType: effectiveMime }
        );
      } catch {
        recorder = new MediaRecorder(stream);
      }
      recorderRef.current = recorder;
      segmentStartedAtRef.current = Date.now();

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          void voiceRecordingController.pushChunk(event.data);
        }
      });

      recorder.addEventListener(
        "stop",
        () => {
          const segMs = Date.now() - segmentStartedAtRef.current;

          // If this stop was triggered by a rollover request, start a new
          // segment on the same stream. Only the max-length timeout is
          // cleared — the elapsed interval keeps showing total time.
          if (rolloverRequestedRef.current && streamRef.current?.active) {
            rolloverRequestedRef.current = false;
            if (maxTimeoutRef.current !== null) {
              clearTimeout(maxTimeoutRef.current);
              maxTimeoutRef.current = null;
            }
            void (async () => {
              await voiceRecordingController.rolloverCapture(effectiveMime, segMs);
              if (streamRef.current?.active) {
                startRecorder(streamRef.current, effectiveMime);
              }
            })();
            // Show notification that we're continuing to record.
            toastManager.add({
              type: "warning",
              title: "Recording continues",
              description: "Reached the maximum clip length — that part was sent for transcription.",
            });
          } else {
            // Normal stop: teardown stream and finish capture.
            clearTimers();
            teardownStream();
            void voiceRecordingController.finishCapture(segMs);
          }
        },
        { once: true }
      );

      recorder.addEventListener(
        "error",
        () => {
          clearTimers();
          teardownStream();
          toastManager.add({
            type: "error",
            title: "Recording error",
            description: "Recording stopped unexpectedly.",
          });
        },
        { once: true }
      );

      recorder.start(1000); // 1s timeslice
      maxTimeoutRef.current = setTimeout(() => {
        rolloverRequestedRef.current = true;
        recorder.stop();
      }, MAX_SEGMENT_MS);
    },
    [clearTimers, teardownStream]
  );

  const start = useCallback(
    async () => {
      if (options.disabled === true || recorderRef.current !== null) {
        return;
      }
      if (typeof navigator === "undefined" || navigator.mediaDevices?.getUserMedia === undefined) {
        toastManager.add({
          type: "error",
          title: "Microphone unavailable",
          description: "This browser does not support audio recording.",
        });
        return;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        const name = error instanceof DOMException ? error.name : "";
        const description =
          name === "NotAllowedError" || name === "SecurityError"
            ? "Microphone permission was denied. Enable it in your browser settings to use voice input."
            : name === "NotFoundError"
              ? "No microphone was found on this device."
              : "Could not access the microphone.";
        toastManager.add({ type: "error", title: "Microphone unavailable", description });
        return;
      }

      streamRef.current = stream;
      const mimeType = pickSupportedMimeType();
      const effectiveMime = mimeType || "audio/webm";

      // Begin capture of the first segment.
      await voiceRecordingController.beginCapture(effectiveMime);

      // Set the overall timer (for UI display of total elapsed time across all segments).
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      intervalRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current);
      }, 250);

      // Start the first recorder for this segment.
      startRecorder(stream, effectiveMime);
    },
    [options.disabled, startRecorder]
  );

  const retry = useCallback(() => {
    void voiceRecordingController.retry();
  }, []);

  const discard = useCallback(() => {
    void voiceRecordingController.discard();
  }, []);

  useEffect(
    () => () => {
      clearTimers();
    },
    [clearTimers],
  );

  return {
    snapshot,
    elapsedMs,
    isSupported: isIndexedDbAvailable() && typeof MediaRecorder !== "undefined",
    start,
    stop,
    retry,
    discard,
  };
}
