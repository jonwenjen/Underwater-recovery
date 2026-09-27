/**
 * Full-quality export. Both paths run the exact `Processor` the preview uses,
 * on an offscreen WebGL2 canvas at the output resolution, so the file matches
 * what was on screen — only sharper.
 *
 * Loaded on demand: mediabunny (~150 kB gzip) is only fetched for video.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Conversion,
  ConversionCanceledError,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  VideoSample,
  VideoSampleSink,
  WebMOutputFormat,
  canEncodeVideo,
  type VideoCodec,
} from 'mediabunny';
import type { Pick } from './auto.ts';
import { identityLook, type Look } from './look.ts';
import type { AutoKey, Params } from './params.ts';
import { NO_ORIENT, orientedSize, Processor, RESULT_VIEW, type Orient } from './renderer.ts';

export interface GradeSettings {
  params: Params;
  locked: ReadonlySet<AutoKey>;
  pick: Pick | null;
  orient?: Orient;
  look?: Look;
}

function prepare(proc: Processor, g: GradeSettings) {
  proc.engine.pick = g.pick && { ...g.pick };
  proc.setOrient(g.orient ?? NO_ORIENT);
  proc.setLook(g.look ?? identityLook());
}

/* ---------------------------------------------------------------- photo */

export async function exportPhoto(
  bitmap: ImageBitmap,
  g: GradeSettings,
  type: 'image/jpeg' | 'image/png' | 'image/webp',
  quality = 0.95,
): Promise<Blob> {
  const canvas = new OffscreenCanvas(1, 1);
  const proc = new Processor(canvas, { preserve: true });
  try {
    let src: ImageBitmap = bitmap;
    const max = proc.renderer.maxTexture;
    let w = bitmap.width,
      h = bitmap.height;
    if (Math.max(w, h) > max) {
      const s = max / Math.max(w, h);
      w = Math.floor(w * s);
      h = Math.floor(h * s);
      src = await createImageBitmap(bitmap, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    }
    prepare(proc, g);
    const [ow, oh] = orientedSize(w, h, g.orient ?? NO_ORIENT);
    proc.renderer.resize(ow, oh);
    proc.frame(src, w, h, { params: g.params, locked: g.locked, dt: 0 }, RESULT_VIEW);
    return await canvas.convertToBlob({ type, quality });
  } finally {
    proc.renderer.dispose();
  }
}

/* ---------------------------------------------------------------- video */

export interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  codec: string | null;
}

export async function probeVideo(file: Blob): Promise<VideoInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('這個檔案沒有影片軌');
  return {
    width: track.displayWidth,
    height: track.displayHeight,
    duration: await track.computeDuration(),
    hasAudio: !!(await input.getPrimaryAudioTrack()),
    codec: track.codec,
  };
}

export interface VideoExportOptions extends GradeSettings {
  /** Long edge of the output; 0 keeps the source size. */
  maxEdge: number;
  format: 'mp4' | 'webm';
  /** Write straight to disk instead of RAM (File System Access API). */
  writable?: FileSystemWritableFileStream;
  onProgress?: (p: number, framesDone: number) => void;
  /** Receives a cancel function once the conversion is running. */
  onCancelable?: (cancel: () => void) => void;
  /**
   * Playback speed of the result: 2 = twice as fast (frames dropped to keep
   * the source frame rate), 0.5 = slow motion (frames held longer).
   * Audio is dropped when ≠ 1 — resampling it without a pitch shift is out
   * of scope, and silent is better than chipmunks.
   */
  speed?: number;
}

export interface VideoExportResult {
  blob: Blob | null;
  frames: number;
  codec: VideoCodec;
  width: number;
  height: number;
  canceled: boolean;
}

export async function exportVideo(file: Blob, o: VideoExportOptions): Promise<VideoExportResult> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('這個檔案沒有影片軌');
  // Samples arrive unrotated (rotation stays as container metadata), so size
  // the output from the coded orientation.
  const rotated = track.rotation === 90 || track.rotation === 270;
  const baseW = rotated ? track.displayHeight : track.displayWidth;
  const baseH = rotated ? track.displayWidth : track.displayHeight;
  const s = o.maxEdge > 0 ? Math.min(1, o.maxEdge / Math.max(baseW, baseH)) : 1;
  // the user's rotation turns the frame; quarter turns swap the sides
  const [rw, rh] = orientedSize(baseW, baseH, o.orient ?? NO_ORIENT);
  const outW = Math.max(2, Math.round((rw * s) / 2) * 2); // encoders want even sizes
  const outH = Math.max(2, Math.round((rh * s) / 2) * 2);
  const speed = o.speed && o.speed > 0 ? o.speed : 1;

  const candidates: VideoCodec[] = o.format === 'mp4' ? ['avc', 'hevc', 'vp9', 'av1'] : ['vp9', 'av1', 'vp8'];
  let codec: VideoCodec | null = null;
  for (const c of candidates)
    if (await canEncodeVideo(c, { width: outW, height: outH })) {
      codec = c;
      break;
    }
  if (!codec) throw new Error('這個瀏覽器沒有可用的影片編碼器（需要 WebCodecs）');

  const output = new Output({
    format: o.format === 'mp4' ? new Mp4OutputFormat({ fastStart: o.writable ? false : 'in-memory' }) : new WebMOutputFormat(),
    target: o.writable ? new StreamTarget(o.writable as unknown as WritableStream, { chunked: true }) : new BufferTarget(),
  });

  const canvas = new OffscreenCanvas(outW, outH);
  const proc = new Processor(canvas, { preserve: true });
  proc.renderer.resize(outW, outH);
  prepare(proc, o);
  let frames = 0;
  let lastT: number | null = null;
  let nextEmit = -Infinity;

  const conversion = await Conversion.init({
    input,
    output,
    video: {
      codec,
      quality: QUALITY_HIGH,
      processedWidth: outW,
      processedHeight: outH,
      process: (sample) => {
        const outT = sample.timestamp / speed;
        const srcDur = sample.duration > 0 ? sample.duration : 1 / 30;
        // faster than real time: keep only as many frames as the source rate
        // (half-frame tolerance: container timestamps are rounded, e.g. to ms)
        if (speed > 1) {
          if (outT + 0.5 * srcDur < nextEmit) return null;
          nextEmit = nextEmit === -Infinity || nextEmit < outT - srcDur ? outT + srcDur : nextEmit + srcDur;
        }
        const frame = sample.toVideoFrame();
        try {
          const t = sample.timestamp;
          // Same tracker as live playback: the grade follows the scene with the
          // user's response time, and snaps on cuts.
          const dt = lastT === null ? 0 : Math.max(0, Math.min(1, t - lastT));
          lastT = t;
          proc.frame(frame, frame.displayWidth, frame.displayHeight, { params: o.params, locked: o.locked, dt }, RESULT_VIEW);
        } finally {
          frame.close();
        }
        frames++;
        if (speed === 1) return canvas;
        return new VideoSample(canvas, { timestamp: outT, duration: speed > 1 ? srcDur : srcDur / speed });
      },
    },
    audio: speed === 1 ? undefined : { discard: true },
  });
  if (!conversion.isValid) {
    proc.renderer.dispose();
    throw new Error('無法轉換：' + conversion.discardedTracks.map((d) => d.reason).join(', '));
  }
  conversion.onProgress = (p) => o.onProgress?.(p, frames);
  o.onCancelable?.(() => void conversion.cancel());
  try {
    await conversion.execute();
  } catch (err) {
    if (err instanceof ConversionCanceledError) {
      return { blob: null, frames, codec, width: outW, height: outH, canceled: true };
    }
    throw err;
  } finally {
    proc.renderer.dispose();
  }
  const buf = o.writable ? null : (output.target as BufferTarget).buffer;
  return {
    blob: buf ? new Blob([buf], { type: o.format === 'mp4' ? 'video/mp4' : 'video/webm' }) : null,
    frames,
    codec,
    width: outW,
    height: outH,
    canceled: false,
  };
}

/* ------------------------------------------- verification-harness helpers */

/**
 * Encode `frames` frames drawn by `draw(i)` onto `canvas` into a WebM (VP9)
 * clip. Used by `scripts/verify.mjs` to build deterministic test footage with
 * known ground truth, inside the same browser that runs the app.
 */
export async function encodeCanvasClip(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  frames: number,
  fps: number,
  draw: (i: number) => void,
): Promise<Blob> {
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'vp9', bitrate: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  for (let i = 0; i < frames; i++) {
    draw(i);
    await source.add(i / fps, 1 / fps);
  }
  await output.finalize();
  return new Blob([(output.target as BufferTarget).buffer!], { type: 'video/webm' });
}

/** Mean colour and luma contrast of the frame nearest `t` seconds. */
export async function frameStats(file: Blob, t: number): Promise<{ r: number; g: number; b: number; contrast: number } | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) return null;
  const sample = await new VideoSampleSink(track).getSample(t);
  if (!sample) return null;
  const c = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
  const cx = c.getContext('2d')!;
  sample.draw(cx, 0, 0);
  sample.close();
  const d = cx.getImageData(0, 0, c.width, c.height).data;
  let r = 0, g = 0, b = 0, l = 0, l2 = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i]; g += d[i + 1]; b += d[i + 2];
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    l += y; l2 += y * y;
  }
  return { r: r / n, g: g / n, b: b / n, contrast: Math.sqrt(Math.max(0, l2 / n - (l / n) ** 2)) };
}

/** Count decodable frames of a finished file (used by the verification harness). */
export async function countFrames(file: Blob): Promise<{ frames: number; width: number; height: number; codec: string | null; duration?: number; hasAudio?: boolean }> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) return { frames: 0, width: 0, height: 0, codec: null };
  const stats = await track.computePacketStats();
  return {
    frames: stats.packetCount,
    width: track.displayWidth,
    height: track.displayHeight,
    codec: track.codec,
    duration: await track.computeDuration(),
    hasAudio: !!(await input.getPrimaryAudioTrack()),
  };
}
