/// <reference lib="webworker" />
import { process, analyse } from './pipeline';
import type { Analysis, Params } from './pipeline';

export interface ImageReq {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  /**
   * Final params. Auto is resolved on the main thread before posting, so the
   * worker never re-derives them: a worker-side auto would overwrite the
   * values the sliders are showing.
   */
  params: Params;
}

export interface Res {
  id: number;
  buffer: ArrayBuffer;
  width: number;
  height: number;
  analysis?: Analysis;
}

self.onmessage = (ev: MessageEvent<ImageReq>) => {
  const { id, width, height, buffer, params } = ev.data;
  const src = new ImageData(new Uint8ClampedArray(buffer), width, height);
  const analysis = analyse(src);
  const { image } = process(src, params, analysis);
  const out: Res = { id, buffer: image.data.buffer, width, height };

  (self as unknown as Worker).postMessage(out, [
    image.data.buffer as unknown as Transferable,
  ]);
};
