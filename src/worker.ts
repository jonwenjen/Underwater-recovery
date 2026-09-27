/// <reference lib="webworker" />
import { process, autoParams, analyse, DEFAULT_PARAMS } from './pipeline';
import type { Analysis, Params } from './pipeline';

export interface ImageReq {
  kind: 'image';
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  params: Params;
}

export interface VideoReq {
  kind: 'video';
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  params: Params;
  /** Reuse the previous frame's analysis instead of recomputing per frame. */
  analysis?: Analysis;
  /** Return the analysis so the caller can carry it to the next frame. */
  wantAnalysis?: boolean;
}

export type Req = ImageReq | VideoReq;

export interface Res {
  id: number;
  buffer: ArrayBuffer;
  width: number;
  height: number;
  analysis?: Analysis;
}

self.onmessage = (ev: MessageEvent<Req>) => {
  const msg = ev.data;
  const { id, width, height, buffer, params } = msg;
  const src = new ImageData(new Uint8ClampedArray(buffer), width, height);

  // Video: adjacent frames are near-identical, so re-running `analyse` on every
  // frame costs a whole extra pass for no change in the result. The caller
  // carries the analysis forward and only refreshes it periodically.
  const carried = msg.kind === 'video' ? msg.analysis : undefined;
  const analysis = carried ?? analyse(src);

  // Only re-derive auto params when the analysis was actually recomputed,
  // otherwise params would drift between frames.
  const p =
    params.auto && !carried
      ? autoParams({ ...DEFAULT_PARAMS, ...params }, analysis)
      : params;

  const { image } = process(src, p, analysis);
  const out: Res = { id, buffer: image.data.buffer, width, height };
  if (msg.kind === 'video' && msg.wantAnalysis) out.analysis = analysis;

  (self as unknown as Worker).postMessage(out, [
    image.data.buffer as unknown as Transferable,
  ]);
};
