import { describe, expect, it, vi } from "vite-plus/test";

import { VoiceRecordingController } from "./voiceRecordingController.ts";
import type {
  PersistedRecordingMeta,
  RecordingPersistence,
  RetryScheduler,
  TranscribeResult,
} from "./voiceRecordingTypes.ts";

class InMemoryPersistence implements RecordingPersistence {
  readonly metas = new Map<string, PersistedRecordingMeta>();
  readonly chunks = new Map<string, Blob[]>();

  async createRecording(meta: PersistedRecordingMeta): Promise<void> {
    this.metas.set(meta.id, { ...meta });
    this.chunks.set(meta.id, []);
  }
  async appendChunk(id: string, chunk: Blob): Promise<void> {
    const list = this.chunks.get(id) ?? [];
    list.push(chunk);
    this.chunks.set(id, list);
    const meta = this.metas.get(id);
    if (meta) {
      meta.sizeBytes += chunk.size;
    }
  }
  async updateRecording(
    id: string,
    patch: Partial<Omit<PersistedRecordingMeta, "id" | "createdAt" | "mimeType">>,
  ): Promise<void> {
    const meta = this.metas.get(id);
    if (meta) {
      Object.assign(meta, patch);
    }
  }
  async getRecording(id: string): Promise<PersistedRecordingMeta | null> {
    const meta = this.metas.get(id);
    return meta ? { ...meta } : null;
  }
  async getPendingRecordings(): Promise<PersistedRecordingMeta[]> {
    const all = [...this.metas.values()].sort((a, b) => a.createdAt - b.createdAt);
    return all.map((meta) => ({ ...meta }));
  }
  async loadAudioBlob(id: string): Promise<Blob | null> {
    const list = this.chunks.get(id);
    if (!list || list.length === 0) {
      return null;
    }
    const mimeType = this.metas.get(id)?.mimeType;
    return new Blob(list, mimeType === undefined ? undefined : { type: mimeType });
  }
  async deleteRecording(id: string): Promise<void> {
    this.metas.delete(id);
    this.chunks.delete(id);
  }
}

class FakeScheduler implements RetryScheduler {
  pending: Array<{ delayMs: number; run: () => void }> = [];
  schedule(delayMs: number, run: () => void): () => void {
    const entry = { delayMs, run };
    this.pending.push(entry);
    return () => {
      this.pending = this.pending.filter((candidate) => candidate !== entry);
    };
  }
  async runNext(): Promise<void> {
    const entry = this.pending.shift();
    if (entry) {
      entry.run();
    }
    await flushPromises();
  }
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeController(options: {
  persistence?: InMemoryPersistence;
  scheduler?: FakeScheduler;
  outcomes?: TranscribeResult[];
  transcribe?: (blob: Blob, mimeType: string) => Promise<TranscribeResult>;
  onTranscript?: (text: string) => void;
  onError?: (message: string) => void;
}) {
  const persistence = options.persistence ?? new InMemoryPersistence();
  const scheduler = options.scheduler ?? new FakeScheduler();
  const outcomes = options.outcomes ? [...options.outcomes] : [];
  const transcribe =
    options.transcribe ||
    vi.fn(async (): Promise<TranscribeResult> => {
      const next = outcomes.shift();
      if (!next) {
        throw new Error("no more outcomes");
      }
      return next;
    });
  let counter = 0;
  const controller = new VoiceRecordingController({
    persistence,
    transcribe,
    onTranscript: options.onTranscript ?? (() => {}),
    onError: options.onError ?? (() => {}),
    schedule: scheduler,
    now: () => 1000 + counter,
    generateId: () => `rec-${(counter += 1)}`,
    backoffBaseMs: 10,
  });
  return { controller, persistence, scheduler, transcribe };
}

async function captureAndFinish(controller: VoiceRecordingController): Promise<void> {
  await controller.beginCapture("audio/webm");
  await controller.pushChunk(new Blob(["chunk-a"]));
  await controller.pushChunk(new Blob(["chunk-b"]));
  await controller.finishCapture(4200);
}

describe("VoiceRecordingController", () => {
  it("persists chunks as they arrive during capture", async () => {
    const { controller, persistence } = makeController({ outcomes: [{ ok: true, text: "hi" }] });
    const id = await controller.beginCapture("audio/webm");
    await controller.pushChunk(new Blob(["a"]));
    await controller.pushChunk(new Blob(["bb"]));
    expect(persistence.chunks.get(id)).toHaveLength(2);
    expect(persistence.metas.get(id)?.sizeBytes).toBe(3);
    expect(controller.getSnapshot().phase).toBe("recording");
  });

  it("inserts the transcript and clears persistence on success", async () => {
    const onTranscript = vi.fn();
    const { controller, persistence } = makeController({
      outcomes: [{ ok: true, text: "hello world" }],
      onTranscript,
    });
    await captureAndFinish(controller);
    await flushPromises();
    expect(onTranscript).toHaveBeenCalledWith("hello world");
    expect(controller.getSnapshot().phase).toBe("idle");
    expect(persistence.metas.size).toBe(0);
  });

  it("auto-retries a retryable failure with backoff, then succeeds", async () => {
    const onTranscript = vi.fn();
    const { controller, scheduler, transcribe } = makeController({
      outcomes: [
        { ok: false, retryable: true, message: "5xx" },
        { ok: false, retryable: true, message: "5xx" },
        { ok: true, text: "third time" },
      ],
      onTranscript,
    });
    await captureAndFinish(controller);
    await flushPromises();
    expect(controller.getSnapshot().phase).toBe("failed");
    expect(controller.getSnapshot().autoRetryScheduled).toBe(true);
    expect(scheduler.pending).toHaveLength(1);
    expect(scheduler.pending[0]!.delayMs).toBe(10); // base * 2^0

    await scheduler.runNext(); // auto-retry 1 fails
    expect(scheduler.pending[0]!.delayMs).toBe(20); // base * 2^1

    await scheduler.runNext(); // auto-retry 2 succeeds
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(onTranscript).toHaveBeenCalledWith("third time");
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("stops auto-retrying after the max and holds for manual retry", async () => {
    const onError = vi.fn();
    const { controller, scheduler } = makeController({
      outcomes: [
        { ok: false, retryable: true, message: "fail-1" },
        { ok: false, retryable: true, message: "fail-2" },
        { ok: false, retryable: true, message: "fail-3" },
      ],
      onError,
    });
    await captureAndFinish(controller);
    await flushPromises();
    await scheduler.runNext();
    await scheduler.runNext();
    expect(scheduler.pending).toHaveLength(0);
    expect(controller.getSnapshot().phase).toBe("failed");
    expect(controller.getSnapshot().autoRetryScheduled).toBe(false);
    expect(controller.getSnapshot().errorMessage).toBe("fail-3");
    expect(onError).toHaveBeenCalledWith("fail-3");
  });

  it("does not auto-retry a non-retryable failure", async () => {
    const onError = vi.fn();
    const { controller, scheduler, transcribe } = makeController({
      outcomes: [{ ok: false, retryable: false, message: "unsupported audio" }],
      onError,
    });
    await captureAndFinish(controller);
    await flushPromises();
    expect(scheduler.pending).toHaveLength(0);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("failed");
    expect(onError).toHaveBeenCalledWith("unsupported audio");
  });

  it("supports a one-click manual retry after failure", async () => {
    const onTranscript = vi.fn();
    const { controller } = makeController({
      outcomes: [
        { ok: false, retryable: false, message: "nope" },
        { ok: true, text: "manual win" },
      ],
      onTranscript,
    });
    await captureAndFinish(controller);
    await flushPromises();
    expect(controller.getSnapshot().phase).toBe("failed");
    await controller.retry();
    await flushPromises();
    expect(onTranscript).toHaveBeenCalledWith("manual win");
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("discards a failed recording and returns to idle", async () => {
    const { controller, persistence } = makeController({
      outcomes: [{ ok: false, retryable: false, message: "nope" }],
    });
    await captureAndFinish(controller);
    await flushPromises();
    expect(persistence.metas.size).toBe(1);
    await controller.discard();
    expect(persistence.metas.size).toBe(0);
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("recovers an interrupted recording from persistence on hydrate", async () => {
    const persistence = new InMemoryPersistence();
    await persistence.createRecording({
      id: "rec-prev",
      mimeType: "audio/webm",
      createdAt: 500,
      status: "recording", // interrupted mid-capture
      durationMs: 3000,
      sizeBytes: 10,
      autoRetriesUsed: 0,
      lastError: null,
    });
    await persistence.appendChunk("rec-prev", new Blob(["persisted-audio"]));

    const onTranscript = vi.fn();
    const { controller } = makeController({
      persistence,
      outcomes: [{ ok: true, text: "recovered" }],
      onTranscript,
    });
    await controller.hydrate();
    expect(controller.getSnapshot().phase).toBe("failed");
    expect(controller.getSnapshot().recordingId).toBe("rec-prev");
    // hydrate marks "recording" status as "captured" (worth transcribing)
    expect(persistence.metas.get("rec-prev")?.status).toBe("captured");

    await controller.retry();
    await flushPromises();
    expect(onTranscript).toHaveBeenCalledWith("recovered");
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("rollover: finalize segment, enqueue, and start new capture", async () => {
    const onTranscript = vi.fn();
    const { controller, persistence, transcribe } = makeController({
      outcomes: [{ ok: true, text: "seg-1" }, { ok: true, text: "seg-2" }],
      onTranscript,
    });
    const seg1Id = await controller.beginCapture("audio/webm");
    await controller.pushChunk(new Blob(["chunk-a"]));

    // Simulate rollover at max length: finalize seg 1 and create seg 2 while still recording
    const seg2Id = await controller.rolloverCapture("audio/webm", 4200);
    expect(seg2Id).not.toBe(seg1Id);
    expect(controller.getSnapshot().phase).toBe("recording"); // Still recording seg 2
    expect(controller.getSnapshot().queuedSegments).toBe(1);
    expect(controller.getSnapshot().rolloverCount).toBe(1);

    // Finish seg 2
    await controller.pushChunk(new Blob(["chunk-b"]));
    await controller.finishCapture(2200);
    await flushPromises();

    // Both should be transcribed in order
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(onTranscript).toHaveBeenCalledTimes(2);
    expect(onTranscript).toHaveBeenNthCalledWith(1, "seg-1");
    expect(onTranscript).toHaveBeenNthCalledWith(2, "seg-2");
    expect(controller.getSnapshot().phase).toBe("idle");
    expect(persistence.metas.size).toBe(0);
  });

  it("ordering: slow first segment, transcripts inserted sequentially", async () => {
    const onTranscript = vi.fn();

    // Controlled promises to delay seg-1's transcription
    let resolveTranscribe1: ((value: TranscribeResult) => void) | null = null;
    const transcribe1Promise = new Promise<TranscribeResult>((resolve) => {
      resolveTranscribe1 = resolve;
    });

    let callCount = 0;
    const transcribeImpl = vi.fn(async (): Promise<TranscribeResult> => {
      callCount += 1;
      if (callCount === 1) {
        return transcribe1Promise;
      }
      return { ok: true, text: "seg-2" };
    });

    const { controller, persistence } = makeController({
      transcribe: transcribeImpl,
      onTranscript,
    });

    // Begin capture and rollover before resolving seg-1's transcription
    const seg1Id = await controller.beginCapture("audio/webm");
    await controller.pushChunk(new Blob(["chunk-1"]));

    // Rollover: enqueue seg-1, start seg-2 (seg-1 transcription is still pending)
    const seg2Id = await controller.rolloverCapture("audio/webm", 1000);
    await controller.pushChunk(new Blob(["chunk-2"]));
    await controller.finishCapture(1500);

    // Now resolve seg-1, which should finish its transcription and move to seg-2
    resolveTranscribe1!({ ok: true, text: "seg-1" });
    await flushPromises();

    // Transcripts must be in order even though seg-1 finished transcribing last
    expect(onTranscript).toHaveBeenCalledTimes(2);
    expect(onTranscript).toHaveBeenNthCalledWith(1, "seg-1");
    expect(onTranscript).toHaveBeenNthCalledWith(2, "seg-2");
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("failed middle segment pauses queue until retry/discard", async () => {
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const { controller, persistence } = makeController({
      outcomes: [
        { ok: true, text: "seg-1" },
        { ok: false, retryable: false, message: "seg-2 failed" },
        { ok: true, text: "seg-2" }, // retry of seg-2 succeeds
        { ok: true, text: "seg-3" },
      ],
      onTranscript,
      onError,
    });

    // Capture 3 segments using rollover
    const seg1Id = await controller.beginCapture("audio/webm");
    await controller.pushChunk(new Blob(["chunk-1"]));

    const seg2Id = await controller.rolloverCapture("audio/webm", 1000);
    await controller.pushChunk(new Blob(["chunk-2"]));

    const seg3Id = await controller.rolloverCapture("audio/webm", 1000);
    await controller.pushChunk(new Blob(["chunk-3"]));
    await controller.finishCapture(1000);

    await flushPromises();

    // Seg 1 succeeds, seg 2 fails and pauses the queue
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("seg-1");
    expect(onError).toHaveBeenCalledWith("seg-2 failed");
    expect(controller.getSnapshot().phase).toBe("failed");
    expect(controller.getSnapshot().queuedSegments).toBe(2); // seg 2 and seg 3 waiting

    // Retry succeeds, which processes both seg 2 and seg 3
    await controller.retry();
    await flushPromises();
    expect(onTranscript).toHaveBeenCalledTimes(3);
    expect(onTranscript).toHaveBeenNthCalledWith(2, "seg-2");
    expect(onTranscript).toHaveBeenNthCalledWith(3, "seg-3");
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("discard of failed head resumes the rest", async () => {
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const { controller, persistence } = makeController({
      outcomes: [
        { ok: true, text: "seg-1" },
        { ok: false, retryable: false, message: "seg-2 failed" },
        { ok: true, text: "seg-3" }, // seg-3 processed after seg-2 is discarded
      ],
      onTranscript,
      onError,
    });

    // Capture 3 segments using rollover
    await controller.beginCapture("audio/webm");
    await controller.pushChunk(new Blob(["chunk-1"]));

    await controller.rolloverCapture("audio/webm", 1000);
    await controller.pushChunk(new Blob(["chunk-2"]));

    await controller.rolloverCapture("audio/webm", 1000);
    await controller.pushChunk(new Blob(["chunk-3"]));
    await controller.finishCapture(1000);

    await flushPromises();

    // Seg 1 succeeds, seg 2 fails
    expect(onTranscript).toHaveBeenCalledWith("seg-1");
    expect(onError).toHaveBeenCalledWith("seg-2 failed");
    expect(controller.getSnapshot().phase).toBe("failed");
    expect(controller.getSnapshot().queuedSegments).toBe(2); // seg 2 and seg 3

    // Discard the failed seg 2, which allows seg 3 to continue
    await controller.discard();
    await flushPromises();
    expect(onTranscript).toHaveBeenCalledTimes(2);
    expect(onTranscript).toHaveBeenNthCalledWith(2, "seg-3");
    expect(controller.getSnapshot().phase).toBe("idle");
    expect(persistence.metas.size).toBe(0);
  });

  it("hydrate with two persisted recordings", async () => {
    const persistence = new InMemoryPersistence();
    await persistence.createRecording({
      id: "rec-1",
      mimeType: "audio/webm",
      createdAt: 100,
      status: "recording",
      durationMs: 1000,
      sizeBytes: 10,
      autoRetriesUsed: 0,
      lastError: null,
    });
    await persistence.appendChunk("rec-1", new Blob(["audio-1"]));

    await persistence.createRecording({
      id: "rec-2",
      mimeType: "audio/webm",
      createdAt: 200,
      status: "transcribing",
      durationMs: 1500,
      sizeBytes: 15,
      autoRetriesUsed: 0,
      lastError: null,
    });
    await persistence.appendChunk("rec-2", new Blob(["audio-2"]));

    const onTranscript = vi.fn();
    const { controller } = makeController({
      persistence,
      outcomes: [{ ok: true, text: "transcript-1" }, { ok: true, text: "transcript-2" }],
      onTranscript,
    });

    await controller.hydrate();
    expect(controller.getSnapshot().phase).toBe("failed");
    expect(controller.getSnapshot().queuedSegments).toBe(2);
    expect(persistence.metas.get("rec-1")?.status).toBe("captured");
    expect(persistence.metas.get("rec-2")?.status).toBe("captured");

    await controller.retry();
    await flushPromises();

    // Both transcribed in createdAt order
    expect(onTranscript).toHaveBeenCalledTimes(2);
    expect(onTranscript).toHaveBeenNthCalledWith(1, "transcript-1");
    expect(onTranscript).toHaveBeenNthCalledWith(2, "transcript-2");
    expect(controller.getSnapshot().phase).toBe("idle");
  });
});
