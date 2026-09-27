/// <reference lib="webworker" />
import { process } from './pipeline';
import type { Analysis, Params } from './pipeline';

/** One decoded frame through the full image pipeline. */
export interface FrameReq {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  /** Final params — auto already resolved by the caller. */
  params: Params;
  /**
   * Analysis for this frame. The caller computes it once per clip: re-running
   * `analyse` per frame costs a whole extra pass, and letting auto re-derive
   * per frame is what makes the grade flicker.
   */
  analysis: Analysis;
}

self.onmessage = (ev: MessageEvent<FrameReq>) => {
  const { id, width, height, buffer, params, analysis } = ev.data;
  const src = new ImageData(new Uint8ClampedArray(buffer), width, height);
  const { image } = process(src, params, analysis);

  (self as unknown as Worker).postMessage(
    { id, buffer: image.data.buffer, width, height },
    [image.data.buffer as unknown as Transferable],
  );
};
