/**
 * Minimal `ImageData` stand-in for Node.
 *
 * The pipeline only ever reads `width`, `height` and `data`, so the shim is
 * tiny — but it has to satisfy the DOM type for `tsc` to accept passing it to
 * the pipeline, hence the `asImg` escape hatch.
 */
export class NodeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  colorSpace: PredefinedColorSpace = 'srgb';

  constructor(
    a: number | Uint8ClampedArray,
    b?: number,
    c?: number,
  ) {
    if (typeof a === 'number') {
      this.width = a;
      this.height = b!;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      this.data = a;
      this.width = b!;
      this.height = c!;
    }
  }
}

/** Install the shim as the global `ImageData`. */
export function installImageDataShim(): void {
  (globalThis as unknown as Record<string, unknown>).ImageData = NodeImageData;
}

/** The shim stands in for a DOM ImageData at the pipeline boundary. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const asImg = (x: NodeImageData): any => x;
