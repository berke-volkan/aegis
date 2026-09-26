/**
 * Microphone capture.
 *
 * ── Why not AnalyserNode? ───────────────────────────────────────────────────
 * The first version polled `AnalyserNode.getFloatTimeDomainData` every 8 ms and
 * appended whatever it got. That API returns the most recent `fftSize` samples —
 * a *window*, not a delta — so at 16 kHz you get 128 new samples per 8 ms poll
 * but 2048 samples in the buffer. Appending the whole window:
 *
 *   · duplicated every sample ~16×, so a nominal 3.2 s capture held ~0.33 s of
 *     unique audio;
 *   · stitched overlapping windows, which injects a hard periodic component at
 *     the poll interval (125 Hz at 16 kHz / 8 ms) that corrupts pitch, HNR,
 *     spectral flatness and the loop detector;
 *   · and if the tab was ever throttled, silently lost the gap.
 *
 * Deriving "how many samples are new?" from `ctx.currentTime` fixes the
 * duplication, but it is still an estimate: stream delivery does not start in
 * lockstep with the audio clock, and if the context never leaves `suspended`
 * (no user gesture, or a browser that keeps it suspended) the clock never
 * advances and you record pure silence while the UI cheerfully reports levels.
 *
 * ── What is used instead ────────────────────────────────────────────────────
 * An `AudioWorkletNode` hands us exactly the samples the graph rendered, in
 * order, with no windows and no clock arithmetic. The worklet source is inlined
 * as a string and instantiated from a Blob URL, so there is no extra file to
 * serve and no build coupling. Browsers without AudioWorklet fall back to
 * `ScriptProcessorNode`, which has the same "here are the samples" contract.
 *
 * ── Browser audio processing is switched OFF ────────────────────────────────
 * `noiseSuppression`, `echoCancellation` and `autoGainControl` are hostile to
 * voice anti-spoofing: they gate on speech likelihood (ducking exactly the
 * transient detail a liveness check measures), low-pass aggressively, and
 * normalise gain inconsistently. They are requested as `false` so the signal that
 * reaches the detector is the microphone's.
 */
import { TARGET_SAMPLE_RATE } from "./features";

export class MicUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicUnavailableError";
  }
}

export type RecorderHandle = {
  /** samples actually captured */
  readonly samples: number;
  /** how long that is, in ms */
  readonly durationMs: number;
  /** the device's real sample rate (may differ from the requested 16 kHz) */
  readonly sampleRate: number;
  /** latest block RMS, for the VU meter */
  readonly level: number;
  /** recent level history, newest last */
  readonly history: number[];
  /** true once the graph has actually delivered audio */
  readonly isLive: boolean;
  /**
   * Flushes the worklet's tail, tears the graph down and returns the samples
   * resampled to {@link TARGET_SAMPLE_RATE}.
   *
   * Async because the final partial chunk has to make a round trip through the
   * worklet's port. A timeout keeps a wedged audio thread from hanging the UI.
   */
  stop(): Promise<Float32Array>;
  dispose(): void;
};

export const WORKLET_SOURCE = `
class AegisCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const chunk = (options.processorOptions && options.processorOptions.chunkSize) || 1024;
    this._buf = new Float32Array(chunk);
    this._n = 0;
    // The main thread asks for the tail explicitly when it stops. Without this
    // the samples left in _buf at that moment are never posted and the capture
    // silently loses up to chunkSize-1 samples (up to 64 ms) from its end —
    // i.e. the end of the word the user just spoke.
    this.port.onmessage = (event) => {
      if (!event.data || event.data.flush !== true) return;
      if (this._n > 0) {
        this.port.postMessage(this._buf.slice(0, this._n));
        this._n = 0;
      }
      this.port.postMessage({ flushed: true });
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(this._buf.length - this._n, ch.length - i);
        this._buf.set(ch.subarray(i, i + take), this._n);
        this._n += take;
        i += take;
        if (this._n === this._buf.length) {
          // slice() copies: the buffer is reused on the next render quantum
          this.port.postMessage(this._buf.slice(0));
          this._n = 0;
        }
      }
    }
    // Returning true keeps the node alive. Output is intentionally silent: the
    // node is connected through a zero gain purely so the graph pulls it.
    return true;
  }
}
registerProcessor('aegis-capture', AegisCaptureProcessor);
`;

export async function startRecording(
  options: {
    onLevel?: (level: number, history: number[]) => void;
    /** hard stop after this many ms */
    maxMs?: number;
    sampleRate?: number;
    /**
     * How long to wait for the first samples before declaring the graph dead.
     * A microphone that never delivers anything is a far more common problem
     * than a slow one, and it must be reported rather than silently recorded as
     * silence.
     */
    startupTimeoutMs?: number;
  } = {},
): Promise<RecorderHandle> {
  const targetRate = options.sampleRate ?? TARGET_SAMPLE_RATE;
  const maxMs = options.maxMs ?? 10_000;
  const startupTimeoutMs = options.startupTimeoutMs ?? 2_500;

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new MicUnavailableError("Bu tarayıcı mikrofon erişimini desteklemiyor.");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Deliberately off — see the note at the top of this file.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  } catch (err) {
    throw new MicUnavailableError(describeGumError(err));
  }

  const AudioCtx: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

  let ctx: AudioContext;
  try {
    ctx = new AudioCtx({ sampleRate: targetRate });
  } catch {
    ctx = new AudioCtx();
  }
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* handled by the liveness check below */
    }
  }

  const rate = ctx.sampleRate;
  const capacity = Math.ceil((maxMs / 1000) * rate) + rate;
  const buffer = new Float32Array(capacity);
  const history: number[] = [];
  let captured = 0;
  let level = 0;

  const source = ctx.createMediaStreamSource(stream);

  // A silent sink: the capture node must be connected to something downstream or
  // the graph will not pull it, but connecting the microphone straight to the
  // speakers would be an echo loop.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);

  let node: AudioNode & { port?: MessagePort; disconnect(): void } | null = null;
  let usingWorklet = true;
  /** Set while a `flush` round trip is in flight, so `onmessage` can await it. */
  let pendingFlush: (() => void) | null = null;

  const append = (chunk: Float32Array) => {
    const take = Math.min(chunk.length, buffer.length - captured);
    if (take <= 0) return;
    buffer.set(chunk.subarray(0, take), captured);
    captured += take;

    let sum = 0;
    for (let i = 0; i < take; i++) sum += chunk[i] * chunk[i];
    level = Math.sqrt(sum / take);
    history.push(level);
    if (history.length > 240) history.shift();
    options.onLevel?.(level, history);
  };

  try {
    if (!ctx.audioWorklet) throw new Error("no audioWorklet");
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const workletNode = new AudioWorkletNode(ctx, "aegis-capture", {
      processorOptions: { chunkSize: 1024 },
    });
    workletNode.port.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (data && typeof data === "object" && data.flushed === true) {
        pendingFlush?.();
        return;
      }
      append(new Float32Array(data as ArrayBuffer));
    };
    node = workletNode;
  } catch {
    // ── fallback: ScriptProcessorNode, same "here are the samples" contract ──
    usingWorklet = false;
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (event) => {
      append(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    node = proc;
  }

  source.connect(node);
  node.connect(mute);

  // ── startup liveness ──────────────────────────────────────────────────────
  // A suspended context, a muted OS device or a denied track all look identical
  // from the outside: zero samples. Fail loudly instead of returning silence.
  const startedAt = performance.now();
  while (captured === 0 && performance.now() - startedAt < startupTimeoutMs) {
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
  }
  if (captured === 0) {
    teardown();
    throw new MicUnavailableError(
      ctx.state === "suspended"
        ? "Ses motoru başlamadı (tarayıcı sekmesi arka planda kalmış olabilir). Sekmeye tıklayıp tekrar deneyin."
        : "Mikrofon ses üretmiyor. Cihaz seçimini, izinleri ve mikrofon kazancını kontrol edin.",
    );
  }

  let stopped = false;
  const handle: RecorderHandle = {
    get samples() {
      return captured;
    },
    get durationMs() {
      return (captured / rate) * 1000;
    },
    get sampleRate() {
      return rate;
    },
    get level() {
      return level;
    },
    get isLive() {
      return !stopped;
    },
    history,
    async stop() {
      stopped = true;
      // Pull the worklet's partial chunk out *before* tearing the graph down —
      // after `close()` the port is dead and the tail is gone.
      if (usingWorklet && node?.port) {
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            pendingFlush = null;
            resolve();
          };
          // A wedged audio thread must not hang the UI; losing ≤64 ms of tail is
          // strictly better than never returning.
          const timer = setTimeout(finish, 250);
          pendingFlush = finish;
          try {
            node?.port?.postMessage({ flush: true });
          } catch {
            finish();
          }
        });
      }
      teardown();
      const raw = trimTrailingSilence(buffer.subarray(0, captured));
      return rate === TARGET_SAMPLE_RATE
        ? new Float32Array(raw)
        : resample(raw, rate, TARGET_SAMPLE_RATE);
    },
    dispose() {
      stopped = true;
      teardown();
    },
  };

  const hardStop = setTimeout(() => {
    stopped = true;
    teardown();
  }, maxMs);

  function teardown() {
    clearTimeout(hardStop);
    try {
      if (node && "onaudioprocess" in node) (node as ScriptProcessorNode).onaudioprocess = null;
      if (node?.port) node.port.onmessage = null;
      source.disconnect();
      node?.disconnect();
      mute.disconnect();
    } catch {
      /* already torn down */
    }
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  }

  // Surfaced for diagnostics; the caller does not need to branch on it.
  void usingWorklet;
  return handle;
}

/**
 * Drops a run of digital silence from the end of a capture.
 *
 * The `ScriptProcessorNode` fallback always hands over whole 4096-sample
 * buffers, so its last buffer is zero-padded; keeping that padding would add a
 * silent MFCC frame and change `pcmDigest`. Bounded so a genuinely quiet
 * recording is never trimmed away entirely.
 */
function trimTrailingSilence(input: Float32Array, floor = 1e-5): Float32Array {
  let end = input.length;
  while (end > 0 && Math.abs(input[end - 1]) < floor) end--;
  return end >= input.length * 0.5 ? input : input.subarray(0, end);
}

function describeGumError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Mikrofon izni reddedildi. Tarayıcı adres çubuğundan izin verin.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Mikrofon bulunamadı.";
    case "NotReadableError":
      return "Mikrofon başka bir uygulama tarafından kullanılıyor.";
    default:
      return `Mikrofona erişilemedi${name ? ` (${name})` : ""}.`;
  }
}

/** Linear-interpolation resampler — good enough for MFCC front-ends. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return new Float32Array(input);
  const ratio = from / to;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}
