#!/usr/bin/env python3
"""Headless zero-shot labeler for semantic_splat_scan views — OWL-v2 over the CLEAN renders.

Input (argv[1], JSON): {views:[{clean, name, boxes2d:{id:[x0,y0,x1,y1]}}], queries:[str,...],
                        model?, minScore?, minIou?}
For each clean view: zero-shot-detect the queries, match each detection to the cluster whose
projected 2D box best overlaps it (IoU, best-cluster-wins), and vote (score x IoU) across views.
Output (stdout, last line): {labels:{id:{label,score,votes,views:[name,...]}}, detections:int,
                             unmatched:[{view,label,score,box}], model}
The labels are DETECTOR OPINIONS (auto_judged), not vision-verified truth — the caller spot-checks.
"""
import sys, json, warnings

def log(*a): print("[OWL]", *a, file=sys.stderr); sys.stderr.flush()

def iou(a, b):
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0

def main():
    cfg = json.loads(sys.argv[1])
    views = cfg["views"]
    queries = cfg["queries"]
    model_id = cfg.get("model", "google/owlv2-base-patch16-ensemble")
    min_score = cfg.get("minScore", 0.15)
    min_iou = cfg.get("minIou", 0.20)

    warnings.filterwarnings("ignore")
    import torch
    from PIL import Image
    from transformers import Owlv2Processor, Owlv2ForObjectDetection

    if not hasattr(Owlv2Processor, "post_process_grounded_object_detection"):
        log("ERROR: transformers too old — Owlv2Processor lacks post_process_grounded_object_detection (need >=4.46)")
        sys.exit(3)

    log("loading", model_id)
    processor = Owlv2Processor.from_pretrained(model_id)
    model = Owlv2ForObjectDetection.from_pretrained(model_id)
    model.eval()

    # votes: id -> label -> view -> best single-detection weight. OWL-v2 emits near-duplicate
    # boxes for one object (no NMS), so per (cluster,label,view) only the BEST detection counts;
    # the aggregate score sums across views.
    votes = {}
    unmatched = []
    n_det = 0
    for view in views:
        vname = view.get("name") or "?"
        img = Image.open(view["clean"]).convert("RGB")
        boxes2d = {int(k): v for k, v in view.get("boxes2d", {}).items()}
        if not boxes2d:
            continue
        inputs = processor(text=[queries], images=img, return_tensors="pt")
        with torch.no_grad():
            outputs = model(**inputs)
        res = processor.post_process_grounded_object_detection(
            outputs=outputs, threshold=min_score,
            target_sizes=torch.tensor([[img.height, img.width]]))[0]
        for score, label_idx, box in zip(res["scores"], res["labels"], res["boxes"]):
            n_det += 1
            det_box = [float(v) for v in box]
            label = queries[int(label_idx)]
            best_id, best_iou = None, 0.0
            for cid, cbox in boxes2d.items():
                v = iou(det_box, cbox)
                if v > best_iou:
                    best_id, best_iou = cid, v
            if best_id is not None and best_iou >= min_iou:
                per_view = votes.setdefault(best_id, {}).setdefault(label, {})
                w = float(score) * best_iou
                per_view[vname] = max(per_view.get(vname, 0.0), w)
            else:
                unmatched.append({"view": vname, "label": label,
                                  "score": round(float(score), 3),
                                  "box": [round(v, 1) for v in det_box]})
        log(vname, "detections so far", n_det)

    # aggregate score >= minAgg -> trustworthy label; below -> lowConfidence (verified split on
    # the ramen splat: >=0.2 all correct, <=0.06 all noise)
    min_agg = cfg.get("minAggScore", 0.10)
    labels, low = {}, {}
    for cid, cand in votes.items():
        label, per_view = max(cand.items(), key=lambda kv: sum(kv[1].values()))
        w = sum(per_view.values())
        entry = {"label": label, "score": round(w, 3),
                 "votes": len(per_view), "views": sorted(per_view)}
        (labels if w >= min_agg else low)[str(cid)] = entry
    print(json.dumps({"labels": labels, "lowConfidence": low, "detections": n_det,
                      "unmatched": unmatched[:20], "model": model_id}))

if __name__ == "__main__":
    main()
