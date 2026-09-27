/// <reference lib="webworker" />
import { process, autoParams, analyse, DEFAULT_PARAMS } from './pipeline';
import type { Analysis, Params } from './pipeline';

/** One decoded frame through the full image pipeline. */
export interface FrameReq {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  params: Params;
  /** Reuse a prior analysis instead of recomputing (adjacent frames match). */
  analysis?: Analysis;
  wantAnalysis?: boolean;
}

self.onmessage = (ev: MessageEvent<FrameReq>) => {
  const { id, width, height, buffer, params, analysis: carried, wantAnalysis } =
    ev.data;
  const src = new ImageData(new Uint8ClampedArray(buffer), width, height);

  // Adjacent video frames are near-identical, so re-running `analyse` on every
  // frame costs a whole extra pass for no change in the result.
  const analysis = carried ?? analyse(src);

  // Re-derive auto params only when the analysis was actually recomputed,
  // otherwise the gains would drift between frames.
  const p = params.auto && !carried
    ? autoParams({ ...DEFAULT_PARAMS, ...params }, analysis)
    : params;

  const { image } = process(src, p, analysis);
  const out: {
    id: number;
    buffer: ArrayBuffer;
    width: number;
    height: number;
    analysis?: Analysis;
  } = { id, buffer: image.data.buffer, width, height };
  if (wantAnalysis) out.analysis = analysis;

  (self as unknown as Worker).postMessage(out, [
    image.data.buffer as unknown as Transferable,
  ]);
};
