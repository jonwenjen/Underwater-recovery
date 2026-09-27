/// <reference lib="webworker" />
import { process, autoParams, analyse, DEFAULT_PARAMS } from './pipeline';
import type { Params } from './pipeline';

export interface Req {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  params: Params;
}

self.onmessage = (ev: MessageEvent<Req>) => {
  const { id, width, height, buffer, params } = ev.data;
  const src = new ImageData(new Uint8ClampedArray(buffer), width, height);
  const base = analyse(src);
  const p = params.auto ? autoParams({ ...DEFAULT_PARAMS, ...params }, base) : params;
  const { image } = process(src, p, base);
  (self as unknown as Worker).postMessage(
    { id, buffer: image.data.buffer, width, height },
    [image.data.buffer as unknown as Transferable],
  );
};
