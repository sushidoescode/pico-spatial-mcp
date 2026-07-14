#!/usr/bin/env python3
"""Detect saturated color-keyed regions in a capture. Emits JSON:
{"detections": {"<name>": {"centroid": [u,v], "bboxCenter": [u,v], "bbox": [u0,v0,u1,v1], "pixels": N} | null}, "width": W, "height": H}

Usage: detect_colorkey.py <image.png> '<keysJson>'   (keysJson: {"name": [r,g,b], ...} 0-255)

Robustness (v20.1): a pixel belongs to a key only if (a) that key is its NEAREST among all keys,
(b) within tolerance, (c) clearly saturated, and (d) its channel-RANK signature matches the key's
(magenta needs R,B high / G low — rejects muted scene pinks). The final region is the LARGEST
connected component (a solid marker cube beats scattered scene neon). Needs numpy+PIL+scipy
(the pico venv has all three).
"""
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

img = np.asarray(Image.open(sys.argv[1]).convert("RGB"), dtype=np.int16)
keys = json.loads(sys.argv[2])
H, W = img.shape[:2]
names = list(keys.keys())
targets = np.array([keys[n] for n in names], dtype=np.int16)  # K x 3

spread = img.max(axis=2) - img.min(axis=2)
dists = np.stack([np.abs(img - t).sum(axis=2) for t in targets])  # K x H x W
nearest = dists.argmin(axis=0)


def rank_sig(v):
    order = np.argsort(v)  # ascending channel indices
    return (int(order[0]), int(order[2]))  # (min channel, max channel)


out = {}
for k, name in enumerate(names):
    tsig = rank_sig(targets[k])
    pix_min = img.argmin(axis=2)
    pix_max = img.argmax(axis=2)
    mask = (nearest == k) & (dists[k] < 220) & (spread > 50) & (pix_min == tsig[0]) & (pix_max == tsig[1])
    if int(mask.sum()) < 50:
        out[name] = None
        continue
    labeled, ncomp = ndimage.label(mask)
    sizes = ndimage.sum(mask, labeled, range(1, ncomp + 1))
    biggest = int(np.argmax(sizes)) + 1
    comp = labeled == biggest
    n = int(comp.sum())
    if n < 50:
        out[name] = None
        continue
    ys, xs = np.nonzero(comp)
    bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    out[name] = {
        "centroid": [round(float(xs.mean()), 1), round(float(ys.mean()), 1)],
        "bboxCenter": [round((bbox[0] + bbox[2]) / 2.0, 1), round((bbox[1] + bbox[3]) / 2.0, 1)],
        "bbox": bbox,
        "pixels": n,
    }
print(json.dumps({"detections": out, "width": W, "height": H}))
