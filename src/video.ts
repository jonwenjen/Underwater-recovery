import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  InputVideoTrack,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  WebMOutputFormat,
  canEncodeVideo,
} from 'mediabunny';
import { DEFAULT_PARAMS, analyse, autoParams } from './pipeline';
import type { Analysis, Params } from './pipeline';
import VideoWorker from './video.worker?worker';

/**
 * Video recovery.
 *
 * Two paths with opposite constraints:
 *
 *   Preview — must keep up with playback. The full pipeline costs ~200 ms per
 *             720p frame, so preview runs at a reduced resolution and reuses
 *             one analysis across a burst of frames. It is a look, not the
 *             deliverable.
 *
 *   Export  — no real-time constraint. Every frame is decoded, put through the
 *             full image pipeline, and re-encoded offline. Audio is passed
 *             through untouched, so quality and sync match the source.
 */

export interface VideoMeta {
  name: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

const PREVIEW_MAX_EDGE = 480;

/* ------------------------------------------------------------------ worker */

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (r: FrameResult) => void>();

interface FrameResult {
  image: ImageData;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w: Worker = new VideoWorker();
  worker = w;
  w.onmessage = (ev: MessageEvent) => {
    const { id, buffer, width, height } = ev.data as {
      id: number;
      buffer: ArrayBuffer;
      width: number;
      height: number;
    };
    const cb = pending.get(id);
    pending.delete(id);
    cb?.({
      image: new ImageData(new Uint8ClampedArray(buffer), width, height),
    });
  };
  return w;
}

/**
 * Grade one frame.
 *
 * `analysis` is always supplied by the caller. The worker no longer infers
 * anything: an implicit per-frame re-analysis made the grade flicker, and
 * reusing the preview's cached analysis made an export depend on where the
 * user last scrubbed.
 */
function processFrame(
  data: ImageData,
  params: Params,
  analysis: Analysis,
): Promise<FrameResult> {
  const w = ensureWorker();
  const id = ++seq;
  const copy = data.data.slice().buffer;
  const p = new Promise<FrameResult>((res) => pending.set(id, res));
  w.postMessage(
    {
      id,
      width: data.width,
      height: data.height,
      buffer: copy,
      params,
      analysis,
    },
    [copy],
  );
  return p;
}

/**
 * Analyse a clip once, from frames spread across its whole duration.
 *
 * Sampling evenly rather than only the first few frames matters: clips
 * commonly open on a black fade-in, and grading the whole video from frame 0
 * means grading it from black. Taking the per-field median across the samples
 * also stops one strobe-lit frame from dragging the white balance.
 */
async function analyseClip(
  track: InputVideoTrack,
  duration: number,
  w: number,
  h: number,
  signal?: { cancelled: boolean },
): Promise<Analysis | null> {
  const sink = new VideoSampleSink(track);
  const canvas = new OffscreenCanvas(w, h);
  const cx = canvas.getContext('2d', { willReadFrequently: true })!;
  const samples: Analysis[] = [];

  const N = 7;
  for (let i = 0; i < N; i++) {
    if (signal?.cancelled) break;
    // 5%..95% of the clip: skip the fade-in and the tail
    const t = duration * (0.05 + (0.9 * i) / (N - 1));
    try {
      const sample = await sink.getSample(t);
      if (!sample) continue;
      try {
        sample.draw(cx, 0, 0, w, h);
        samples.push(analyse(cx.getImageData(0, 0, w, h)));
      } finally {
        sample.close();
      }
    } catch {
      // a frame we cannot decode is not fatal; the median copes
    }
  }

  if (!samples.length) return null;
  const pick = (f: (a: Analysis) => number) => {
    const v = samples.map(f).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  return {
    ...samples[0],
    meanA: pick((a) => a.meanA),
    meanB: pick((a) => a.meanB),
    castA: pick((a) => a.castA),
    castB: pick((a) => a.castB),
    redDeficit: pick((a) => a.redDeficit),
    blueDominance: pick((a) => a.blueDominance),
    contrast: pick((a) => a.contrast),
    isUnderwater: pick((a) => a.isUnderwater),
    suggestedRed: pick((a) => a.suggestedRed),
    suggestedDehaze: pick((a) => a.suggestedDehaze),
    suggestedGamma: pick((a) => a.suggestedGamma),
  };
}

/* ------------------------------------------------------------------- probe */

/** Thrown when the user cancels an export, so the UI can say so rather than "匯出失敗". */
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export async function probeVideo(file: File): Promise<VideoMeta> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('這個檔案沒有影片軌');
  const audio = await input.getPrimaryAudioTrack();
  const duration = await track.computeDuration();
  // Frame rate: mediabunny has no direct getter, and the exact value does not
  // matter much here (we re-encode from decoded frames and keep each frame's
  // own timestamp), so report a conventional 30 and let the export path decide
  // the real cadence from the sample timestamps.
  return {
    name: file.name,
    duration,
    width: track.displayWidth,
    height: track.displayHeight,
    fps: 30,
    hasAudio: !!audio,
  };
}

/* ----------------------------------------------------------------- preview */

export class VideoPreview {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private video: HTMLVideoElement;
  private raf = 0;
  private playing = false;
  private disposed = false;

  constructor(file: File, canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    this.video = document.createElement('video');
    this.video.src = URL.createObjectURL(file);
    this.video.muted = true;
    this.video.playsInline = true;
  }

  async ready(): Promise<void> {
    if (this.video.readyState >= 1) return;
    await new Promise<void>((res) => {
      this.video.addEventListener('loadedmetadata', () => res(), { once: true });
    });
  }

  /**
   * Wait until the element has a decoded frame available.
   *
   * `readyState >= HAVE_CURRENT_DATA` is the gate: seeking to the position the
   * element is already on fires no `seeked` event, so without this the first
   * render draws an empty (black) frame.
   */
  private async waitForFrame(): Promise<void> {
    if (this.video.readyState >= 2 && this.video.videoWidth) return;
    await new Promise<void>((res) => {
      const ok = () => {
        if (this.video.readyState < 2 || !this.video.videoWidth) return;
        this.video.removeEventListener('loadeddata', ok);
        this.video.removeEventListener('canplay', ok);
        res();
      };
      this.video.addEventListener('loadeddata', ok);
      this.video.addEventListener('canplay', ok);
      ok();
    });
  }

  private async seek(time: number): Promise<void> {
    await this.ready();
    if (Math.abs(this.video.currentTime - time) < 1e-3) {
      // Already there — but the frame may not be decoded yet.
      await this.waitForFrame();
      return;
    }
    await new Promise<void>((res) => {
      const done = () => {
        this.video.removeEventListener('seeked', done);
        res();
      };
      this.video.addEventListener('seeked', done);
      this.video.currentTime = time;
    });
    await this.waitForFrame();
  }

  /** @returns the analysis of the frame just drawn, for the auto UI. */
  private async renderOnce(params: Params): Promise<Analysis | null> {
    if (this.disposed) return null;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw) return null;
    const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(vw, vh));
    const w = Math.max(2, Math.round((vw * scale) / 2) * 2);
    const h = Math.max(2, Math.round((vh * scale) / 2) * 2);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(this.video, 0, 0, w, h);
    const frame = this.ctx.getImageData(0, 0, w, h);
    // The preview analyses the frame it is actually showing, so Auto tracks
    // the frame under the playhead and the diagnosis panel matches what is on
    // screen. The export path analyses the clip separately and never reuses
    // this.
    const analysis = analyse(frame);
    const res = await processFrame(frame, params, analysis);
    if (this.disposed) return analysis;
    this.ctx.putImageData(res.image, 0, 0);
    return analysis;
  }

  /** Render the frame at `time` once — used for scrubbing. */
  async grab(time: number, params: Params): Promise<Analysis | null> {
    this.pause();
    await this.seek(time);
    return this.renderOnce(params);
  }

  /**
   * Play through, processing each frame as it arrives.
   *
   * `getParams` is called per frame rather than capturing `params` once, so a
   * slider moved mid-playback takes effect immediately instead of only after
   * the next preset click replaced the captured object.
   */
  async play(
    getParams: () => Params,
    onTick?: (t: number) => void,
  ): Promise<void> {
    await this.ready();
    this.playing = true;
    this.video.currentTime = 0;
    await this.video.play().catch(() => {});
    const loop = async () => {
      if (this.disposed || !this.playing) return;
      await this.renderOnce(getParams());
      if (this.disposed || !this.playing) return;
      onTick?.(this.video.currentTime);
      if (this.video.ended) {
        this.playing = false;
        return;
      }
      this.raf = requestAnimationFrame(() => void loop());
    };
    await loop();
  }

  pause() {
    this.playing = false;
    this.video.pause();
    cancelAnimationFrame(this.raf);
  }

  get currentTime() {
    return this.video.currentTime;
  }

  dispose() {
    this.disposed = true;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.video.pause();
    URL.revokeObjectURL(this.video.src);
  }
}

/* ------------------------------------------------------------------ export */

export interface ExportOptions {
  params: Params;
  /** 0 keeps the source resolution. */
  maxEdge: number;
  format: 'mp4' | 'webm';
  onProgress?: (p: number, note: string) => void;
  signal?: { cancelled: boolean };
  /**
   * Keys the user pinned via a slider or preset. Auto must not overwrite them
   * here either, or the video export would ignore the same controls the photo
   * mode now respects.
   */
  manual?: ReadonlySet<keyof Params>;
}

export async function exportVideo(
  file: File,
  opts: ExportOptions,
): Promise<{ blob: Blob; name: string }> {
  const { params, maxEdge, format } = opts;
  const onProgress = opts.onProgress ?? (() => {});

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('這個檔案沒有影片軌');
  const duration = await track.computeDuration();

  const scale =
    maxEdge > 0
      ? Math.min(1, maxEdge / Math.max(track.displayWidth, track.displayHeight))
      : 1;
  // Even dimensions: H.264 encoders reject odd sizes.
  const outW = Math.max(2, Math.round((track.displayWidth * scale) / 2) * 2);
  const outH = Math.max(2, Math.round((track.displayHeight * scale) / 2) * 2);

  const candidates =
    format === 'mp4' ? (['avc', 'vp9', 'av1'] as const) : (['vp9', 'av1', 'avc'] as const);
  let encodable = false;
  for (const c of candidates) {
    if (await canEncodeVideo(c, { width: outW, height: outH })) {
      encodable = true;
      break;
    }
  }
  if (!encodable) {
    throw new Error('這個瀏覽器沒有可用的影片編碼器（需要 WebCodecs，請改用 Chrome / Edge / Safari）');
  }

  const output = new Output({
    format: format === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: new BufferTarget(),
  });

  onProgress(0, '準備中');

  // Analyse the clip ONCE, up front, from frames spread across its duration.
  //
  // This used to read the analysis the preview last cached — a single
  // <=480p frame from wherever the user scrubbed to — so the same file exported
  // differently depending on preview position, and if no preview had run, the
  // worker re-derived auto params per frame and the grade flickered.
  const clipAnalysis = await analyseClip(track, duration, outW, outH, opts.signal);
  const clipParams = { ...DEFAULT_PARAMS, ...params };
  const resolved = params.auto && clipAnalysis
    ? { ...autoParams(clipParams, clipAnalysis, opts.manual), auto: false }
    : { ...params, auto: false };
  if (opts.signal?.cancelled) {
    throw new CancelledError();
  }

  let processed = 0;
  let outCanvas: OffscreenCanvas | null = null;
  let outCtx: OffscreenCanvasRenderingContext2D | null = null;
  // Every frame is graded with the same analysis; if we could not analyse the
  // clip (unreadable frames), fall back to analysing frame 0 inline.
  let fallbackAnalysis: Analysis | null = null;
  const analysisFor = (frame: ImageData): Analysis => {
    if (clipAnalysis) return clipAnalysis;
    fallbackAnalysis ??= analyse(frame);
    return fallbackAnalysis;
  };

  const conversion = await Conversion.init({
    input,
    output,
    video: {
      // Declared track size. NOTE: mediabunny does *not* pre-scale samples
      // before calling `process` — the sample arrives at the source
      // resolution, and the encoder is configured from whatever size the
      // returned sample has. So the resize has to happen inside `process`
      // below, or the resolution selector would silently do nothing and a 4K
      // source would be processed at full 4K.
      width: outW,
      height: outH,
      // outW/outH already preserve the source aspect ratio, and the sample is
      // scaled by hand below, so 'fill' is the correct fit. mediabunny requires
      // `fit` whenever both width and height are set.
      fit: 'fill',
      // The pipeline sharpens, and sharpening amplifies compression artefacts,
      // so bitrate here is not cosmetic. Left unset, mediabunny derives a
      // bitrate from the codec's default quantizer, which is lower than we want.
      quality: QUALITY_HIGH,
      process: async (sample) => {
        if (opts.signal?.cancelled) throw new CancelledError();
        if (!outCanvas) {
          outCanvas = new OffscreenCanvas(outW, outH);
          outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
        }
        // Draw straight into the target-size canvas: one resample, and the
        // frame we process is already at the resolution we will encode.
        // A VideoSample is not a CanvasImageSource, so it must go through
        // its own draw(); the 5-arg form scales to dWidth/dHeight.
        sample.draw(outCtx!, 0, 0, outW, outH);
        const frame = outCtx!.getImageData(0, 0, outW, outH);

        const res = await processFrame(frame, resolved, analysisFor(frame));
        processed++;
        if (processed % 5 === 0) {
          onProgress(
            duration ? Math.min(0.99, sample.timestamp / duration) : 0.5,
            `處理中 ${processed} 幀`,
          );
        }
        outCtx!.putImageData(res.image, 0, 0);
        return outCanvas!;
      },
    },
    // audio untouched: copied through, so quality and sync match the source
    audio: { discard: false },
  });

  await conversion.execute();
  onProgress(1, '完成');

  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('輸出失敗');
  return {
    blob: new Blob([buffer], {
      type: format === 'mp4' ? 'video/mp4' : 'video/webm',
    }),
    name: file.name.replace(/\.[^.]+$/, '') + '-recovered.' + format,
  };
}
