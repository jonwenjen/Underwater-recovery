"""Write UIEB raw/ground-truth pairs out as NAME-before.jpg / NAME-after.jpg.

Useful as a test corpus for analyze-transfer.mjs. pyarrow is deliberately NOT a
project dependency, so run this out-of-tree:

    curl -sL -o /tmp/uwbench/val.parquet \
      https://huggingface.co/datasets/Hikari0608/UIEB/resolve/main/data/val-00000-of-00001-ee22087fd151f704.parquet
    uv run --with pyarrow --with pillow python scripts/make-benchmark-pairs.py 6 /tmp/pairs
    node scripts/analyze-transfer.mjs /tmp/pairs

Note these pairs are raw -> a DIFFERENT photograph of the same scene, not raw ->
a function of raw, so the recovered matrix is indicative of the correction
character, not an exact transfer function.
"""
import io
import sys

import pyarrow.parquet as pq
from PIL import Image

N = int(sys.argv[1]) if len(sys.argv) > 1 else 6
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/pairs"

tbl = pq.ParquetFile("/tmp/uwbench/val.parquet").read_row_group(0, columns=["raw", "gt"])
raw = tbl.column("raw").to_pylist()
gt = tbl.column("gt").to_pylist()

for i in range(min(N, len(raw))):
    for key, col in (("before", raw), ("after", gt)):
        d = col[i]
        blob = d["bytes"] if isinstance(d, dict) else d
        im = Image.open(io.BytesIO(blob)).convert("RGB")
        im = im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
        im.save(f"{OUT}/uieb{i:02d}-{key}.jpg", quality=96)
print("pairs written:", min(N, len(raw)))
