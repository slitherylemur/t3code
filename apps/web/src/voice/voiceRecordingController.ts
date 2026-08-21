import type {
  PersistedRecordingMeta,
  RecordingPersistence,
  RetryScheduler,
  TranscribeFn,
  VoicePhase,
  VoiceRecordingSnapshot,
} from "./voiceRecordingTypes";

export interface VoiceRecordingControllerDeps {
  readonly persistence: RecordingPersistence;
  readonly transcribe: TranscribeFn;
  /** Insert a successful transcript into the composer. */
  readonly onTranscript: (text: string) => void;
  /** Surface a user-facing error (e.g. a toast). */
  readonly onError: (message: string) => void;
  readonly now?: () => number;
  readonly schedule?: RetryScheduler;
  readonly generateId?: () => string;
  readonly maxAutoRetries?: number;
  readonly backoffBaseMs?: number;
}

const DEFAULT_MAX_AUTO_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 2000;

function defaultId(): string {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const defaultScheduler: RetryScheduler = {
  schedule(delayMs, run) {
    const handle = setTimeout(run, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

const IDLE_SNAPSHOT: VoiceRecordingSnapshot = {
  phase: "idle",
  recordingId: null,
  errorMessage: null,
  autoRetryScheduled: false,
  queuedSegments: 0,
  rolloverCount: 0,
};

/**
 * Owns the durable lifecycle of segmented voice recordings: chunk persistence,
 * FIFO transcription queue, and the retry/backoff state machine. Supports
 * automatic rollover when a segment reaches max length, with sequential
 * transcription and in-order transcript insertion.
 *
 * State machine:
 * - captureId: the segment currently receiving chunks (null when not recording).
 * - queue: FIFO of segment ids awaiting/being transcribed (head may be in-flight).
 * - headFailed: true if the head segment failed transcription.
 * - processing: true while transcribing the head segment.
 * - rolloverCount: count of max-length rollovers in the current session.
 *
 * Phases derived from state:
 * - "recording": captureId is not null (actively capturing); show elapsed timer.
 * - "transcribing": captureId is null and queue is not empty (transcription in flight).
 * - "failed": headFailed is true (head segment failed).
 * - "idle": everything done and queue empty.
 *
 * Robustness guarantees:
 * - Every chunk is written to persistence as it arrives, so a crash/reload
 *   never loses audio.
 * - Segments are transcribed sequentially in enqueue order; transcripts are
 *   inserted in the correct order even if the first segment transcribes slowly.
 * - A failed head segment pauses the queue; retry() or discard() continues it.
 * - The queue persists until every segment is transcribed or discarded,
 *   and is recovered on the next launch via `hydrate()`.
 */
export class VoiceRecordingController {
  private readonly persistence: RecordingPersistence;
  private readonly transcribe: TranscribeFn;
  private readonly onTranscript: (text: string) => void;
  private readonly onError: (message: string) => void;
  private readonly now: () => number;
  private readonly scheduler: RetryScheduler;
  private readonly generateId: () => string;
  private readonly maxAutoRetries: number;
  private readonly backoffBaseMs: number;

  private snapshot: VoiceRecordingSnapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private cancelScheduledRetry: (() => void) | null = null;
  private captureId: string | null = null;
  private queue: string[] = [];
  private headFailed = false;
  private processing = false;
  private rolloverCount = 0;

  constructor(deps: VoiceRecordingControllerDeps) {
    this.persistence = deps.persistence;
    this.transcribe = deps.transcribe;
    this.onTranscript = deps.onTranscript;
    this.onError = deps.onError;
    this.now = deps.now ?? (() => Date.now());
    this.scheduler = deps.schedule ?? defaultScheduler;
    this.generateId = deps.generateId ?? defaultId;
    this.maxAutoRetries = deps.maxAutoRetries ?? DEFAULT_MAX_AUTO_RETRIES;
    this.backoffBaseMs = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): VoiceRecordingSnapshot => this.snapshot;

  private recomputeSnapshot(overrides?: Partial<VoiceRecordingSnapshot>): VoiceRecordingSnapshot {
    // Derive phase from state machine.
    const phase: VoicePhase = this.captureId
      ? "recording"
      : this.headFailed
        ? "failed"
        : this.queue.length > 0
          ? "transcribing"
          : "idle";

    // Current active recording is the segment being captured, or the head if transcribing.
    const recordingId = this.captureId ?? this.queue[0] ?? null;

    // Error and retry flags come from the head segment's persisted state (updated by processQueue).
    let errorMessage = this.snapshot.errorMessage;
    let autoRetryScheduled = this.snapshot.autoRetryScheduled;

    return {
      phase,
      recordingId,
      errorMessage,
      autoRetryScheduled,
      queuedSegments: this.queue.length,
      rolloverCount: this.rolloverCount,
      ...overrides,
    };
  }

  private setSnapshot(overrides?: Partial<VoiceRecordingSnapshot>): void {
    const next = this.recomputeSnapshot(overrides);
    if (
      next.phase === this.snapshot.phase &&
      next.recordingId === this.snapshot.recordingId &&
      next.errorMessage === this.snapshot.errorMessage &&
      next.autoRetryScheduled === this.snapshot.autoRetryScheduled &&
      next.queuedSegments === this.snapshot.queuedSegments &&
      next.rolloverCount === this.snapshot.rolloverCount
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Recover any recordings persisted by a previous session. */
  async hydrate(): Promise<void> {
    if (this.captureId !== null || this.queue.length > 0) {
      return;
    }
    const pendings = await this.persistence.getPendingRecordings().catch(() => []);
    if (pendings.length === 0) {
      return;
    }
    // Any non-completed status means the previous attempt was interrupted.
    // Mark "recording"/"transcribing" statuses as "captured" (worth transcribing),
    // enqueue them all, and surface as failed so the user can retry or discard.
    for (const meta of pendings) {
      if (meta.status === "recording" || meta.status === "transcribing") {
        await this.persistence
          .updateRecording(meta.id, { status: "captured" })
          .catch(() => undefined);
      }
      this.queue.push(meta.id);
    }
    this.headFailed = true;
    this.setSnapshot({
      errorMessage:
        "A previous recording was interrupted. Retry transcription or discard.",
      autoRetryScheduled: false,
    });
  }

  /** Begin a new capture segment. Returns the new recording id. */
  async beginCapture(mimeType: string): Promise<string> {
    this.clearScheduledRetry();
    const id = this.generateId();
    const meta: PersistedRecordingMeta = {
      id,
      mimeType,
      createdAt: this.now(),
      status: "recording",
      durationMs: 0,
      sizeBytes: 0,
      autoRetriesUsed: 0,
      lastError: null,
    };
    await this.persistence.createRecording(meta);
    this.captureId = id;
    this.rolloverCount = 0;
    this.setSnapshot();
    return id;
  }

  /** Persist a chunk as it arrives. Never throws. */
  async pushChunk(chunk: Blob): Promise<void> {
    const id = this.captureId;
    if (id === null || chunk.size === 0) {
      return;
    }
    try {
      await this.persistence.appendChunk(id, chunk);
    } catch {
      // A dropped chunk write must not crash capture; the recording keeps going
      // and remaining chunks still persist.
    }
  }

  /** Finish capture of the current segment and enqueue for transcription. */
  async finishCapture(durationMs: number): Promise<void> {
    const id = this.captureId;
    if (id === null) {
      return;
    }
    await this.persistence
      .updateRecording(id, { status: "captured", durationMs })
      .catch(() => undefined);
    this.queue.push(id);
    this.captureId = null;
    this.setSnapshot();
    void this.processQueue();
  }

  /**
   * Finish capture of the current segment and immediately start a new one,
   * keeping the mic stream active. The old segment is enqueued for
   * transcription (in the background), and the new one becomes the active
   * captureId. Returns the new segment's id. Increments rolloverCount.
   */
  async rolloverCapture(mimeType: string, durationMs: number): Promise<string> {
    const oldId = this.captureId;
    if (oldId === null) {
      return "";
    }

    // Finalize the old segment exactly like finishCapture.
    await this.persistence
      .updateRecording(oldId, { status: "captured", durationMs })
      .catch(() => undefined);
    this.queue.push(oldId);

    // Create a new segment immediately.
    const newId = this.generateId();
    const meta: PersistedRecordingMeta = {
      id: newId,
      mimeType,
      createdAt: this.now(),
      status: "recording",
      durationMs: 0,
      sizeBytes: 0,
      autoRetriesUsed: 0,
      lastError: null,
    };
    await this.persistence.createRecording(meta);
    this.captureId = newId;
    this.rolloverCount += 1;
    this.setSnapshot();

    // Kick off transcription of queued segments in the background.
    void this.processQueue();

    return newId;
  }

  /** Manual retry of the currently failed head segment. */
  async retry(): Promise<void> {
    if (this.queue.length === 0 || !this.headFailed) {
      return;
    }
    this.clearScheduledRetry();
    const headId = this.queue[0]!;
    // A manual retry resets the automatic-retry budget.
    await this.persistence
      .updateRecording(headId, { status: "captured", autoRetriesUsed: 0 })
      .catch(() => undefined);
    this.headFailed = false;
    this.setSnapshot();
    void this.processQueue();
  }

  /**
   * Discard the failed head segment and continue the queue.
   * Only available in the failed phase (and only discards the head, not all queued).
   */
  async discard(): Promise<void> {
    if (this.queue.length === 0 || !this.headFailed) {
      return;
    }
    this.clearScheduledRetry();
    const headId = this.queue.shift()!;
    await this.persistence.deleteRecording(headId).catch(() => undefined);
    this.headFailed = false;
    if (this.queue.length === 0 && this.captureId === null) {
      this.setSnapshot();
    } else {
      this.setSnapshot();
      void this.processQueue();
    }
  }

  private async discardInternal(id: string): Promise<void> {
    await this.persistence.deleteRecording(id).catch(() => undefined);
  }

  private clearScheduledRetry(): void {
    if (this.cancelScheduledRetry !== null) {
      this.cancelScheduledRetry();
      this.cancelScheduledRetry = null;
    }
  }

  /**
   * Process the FIFO transcription queue sequentially. If the head segment
   * fails and is not being auto-retried, the queue pauses until the user
   * retries or discards. Segments are transcribed and inserted in order.
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    this.processing = true;

    try {
      while (this.queue.length > 0 && !this.headFailed) {
        const headId = this.queue[0]!;
        const meta = await this.persistence.getRecording(headId).catch(() => null);
        if (!meta) {
          // Head vanished (discarded elsewhere); skip to next.
          this.queue.shift();
          continue;
        }

        const blob = await this.persistence.loadAudioBlob(headId).catch(() => null);
        if (!blob || blob.size === 0) {
          // Empty blob: non-retryable failure.
          await this.persistence
            .updateRecording(headId, {
              status: "failed",
              lastError: "The recording was empty.",
            })
            .catch(() => undefined);
          this.headFailed = true;
          this.setSnapshot({
            errorMessage: "The recording was empty.",
            autoRetryScheduled: false,
          });
          this.processing = false;
          return;
        }

        await this.persistence
          .updateRecording(headId, { status: "transcribing" })
          .catch(() => undefined);
        this.setSnapshot();

        let result: Awaited<ReturnType<TranscribeFn>>;
        try {
          result = await this.transcribe(blob, meta.mimeType);
        } catch (error) {
          result = {
            ok: false,
            retryable: true,
            message: error instanceof Error ? error.message : "Transcription failed.",
          };
        }

        const updatedMeta = await this.persistence
          .getRecording(headId)
          .catch(() => null);
        if (!updatedMeta) {
          // Recording was discarded while in flight; skip to next.
          this.queue.shift();
          continue;
        }

        if (result.ok) {
          // Success: insert transcript and continue to next.
          this.onTranscript(result.text);
          await this.discardInternal(headId);
          this.queue.shift();
          // Continue loop to process next segment.
          continue;
        }

        // Failure: check if we can auto-retry.
        const retriesUsed = updatedMeta.autoRetriesUsed;
        const canAutoRetry =
          result.retryable && retriesUsed < this.maxAutoRetries;
        await this.persistence
          .updateRecording(headId, {
            status: "failed",
            lastError: result.message,
            autoRetriesUsed: canAutoRetry ? retriesUsed + 1 : retriesUsed,
          })
          .catch(() => undefined);

        if (canAutoRetry) {
          // Schedule retry and pause the queue.
          this.headFailed = true;
          const delay = this.backoffBaseMs * Math.pow(2, retriesUsed);
          this.setSnapshot({
            errorMessage: result.message,
            autoRetryScheduled: true,
          });
          this.cancelScheduledRetry = this.scheduler.schedule(delay, () => {
            this.cancelScheduledRetry = null;
            // Reset headFailed so processQueue can retry the head segment.
            this.headFailed = false;
            this.setSnapshot({ autoRetryScheduled: false });
            void this.processQueue();
          });
          this.processing = false;
          return;
        }

        // Final failure: pause queue and surface the error.
        this.headFailed = true;
        this.onError(result.message);
        this.setSnapshot({
          errorMessage: result.message,
          autoRetryScheduled: false,
        });
        this.processing = false;
        return;
      }
    } finally {
      this.processing = false;
    }

    this.setSnapshot();
  }
}
