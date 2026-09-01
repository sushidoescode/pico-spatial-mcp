export type GuideFrame = { width: number; height: number };
export type GuideDetection = { pixels: number; bbox: [number, number, number, number] } | null;
export type ColorKeyDetections = {
  available?: boolean;
  expected?: string[];
  found?: string[];
  missing?: string[];
  neutralSkipped?: string[];
  detections?: Record<string, GuideDetection>;
};
export type NavigationFiducial = {
  colors: number[][];
  pattern: string;
  maxCenterSkewFraction?: number;
};

export type GuideMeasurement = {
  status: "measured";
  pattern: "nested-corners-v1";
  bbox: [number, number, number, number];
  center: { x: number; y: number };
  error: { x: number; y: number };
  width: number;
  height: number;
  areaFraction: number;
};
export type GuideRejection = {
  status: "rejected";
  reason: "invalid_frame" | "unsupported_pattern" | "colors_not_distinct" | "missing_detection" | "invalid_bbox" | "duplicate_bbox" | "not_nested" | "center_skew";
};

type Bbox = [number, number, number, number];

function isDistinctSaturatedColor(color: number[]): boolean {
  if (!Array.isArray(color) || color.length !== 3 || !color.every(Number.isFinite)) return false;
  const scaled = color.map((channel) => channel <= 1 ? channel * 255 : channel);
  if (scaled.some((channel) => channel < 0 || channel > 255)) return false;
  return Math.max(...scaled) - Math.min(...scaled) > 50;
}

function canonicalColor(color: number[]): string {
  return color.map((channel) => Math.round(channel <= 1 ? channel * 255 : channel)).join(",");
}

function isFrame(frame: GuideFrame): boolean {
  return Number.isFinite(frame?.width) && Number.isFinite(frame?.height) && frame.width > 0 && frame.height > 0;
}

function isBbox(bbox: Bbox, frame: GuideFrame): boolean {
  return Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)
    && bbox[0] >= 0 && bbox[1] >= 0 && bbox[2] <= frame.width && bbox[3] <= frame.height
    && bbox[2] > bbox[0] && bbox[3] > bbox[1];
}

function area(bbox: Bbox): number {
  return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
}

function center(bbox: Bbox): { x: number; y: number } {
  return { x: (bbox[0] + bbox[2]) / 2, y: (bbox[1] + bbox[3]) / 2 };
}

function contains(outer: Bbox, inner: Bbox): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

/**
 * Validates a two-key guide purely from the color-key detector's geometry. Detector key names are
 * intentionally opaque: the guide is identified by the supplied saturated colors and geometry,
 * never by an inferred semantic meaning for a color.
 */
export function measureTwoColorGuide(
  frame: GuideFrame,
  colorKeys: ColorKeyDetections,
  fiducial: NavigationFiducial,
): GuideMeasurement | GuideRejection {
  if (!isFrame(frame)) return { status: "rejected", reason: "invalid_frame" };
  if (fiducial?.pattern !== "nested-corners-v1") return { status: "rejected", reason: "unsupported_pattern" };
  if (!Array.isArray(fiducial.colors) || fiducial.colors.length !== 2
    || !fiducial.colors.every(isDistinctSaturatedColor)
    || canonicalColor(fiducial.colors[0]) === canonicalColor(fiducial.colors[1])) {
    return { status: "rejected", reason: "colors_not_distinct" };
  }

  const detected = Object.values(colorKeys?.detections ?? {}).filter((detection): detection is Exclude<GuideDetection, null> => detection !== null);
  if (detected.length !== 2) return { status: "rejected", reason: "missing_detection" };
  const boxes = detected.map((detection) => detection.bbox);
  if (!boxes.every((bbox) => isBbox(bbox, frame))) return { status: "rejected", reason: "invalid_bbox" };
  const [first, second] = boxes;
  if (first.every((value, index) => value === second[index])) return { status: "rejected", reason: "duplicate_bbox" };

  const [outer, inner] = area(first) > area(second) ? [first, second] : [second, first];
  if (!contains(outer, inner)) return { status: "rejected", reason: "not_nested" };
  const outerCenter = center(outer);
  const innerCenter = center(inner);
  const skew = Math.max(Math.abs(outerCenter.x - innerCenter.x) / (outer[2] - outer[0]), Math.abs(outerCenter.y - innerCenter.y) / (outer[3] - outer[1]));
  if (skew > (fiducial.maxCenterSkewFraction ?? 0.25)) return { status: "rejected", reason: "center_skew" };

  const bbox: Bbox = [
    Math.min(first[0], second[0]), Math.min(first[1], second[1]),
    Math.max(first[2], second[2]), Math.max(first[3], second[3]),
  ];
  const width = bbox[2] - bbox[0];
  const height = bbox[3] - bbox[1];
  const measuredCenter = center(bbox);
  return {
    status: "measured",
    pattern: "nested-corners-v1",
    bbox,
    center: measuredCenter,
    error: { x: measuredCenter.x - frame.width / 2, y: measuredCenter.y - frame.height / 2 },
    width,
    height,
    areaFraction: (width * height) / (frame.width * frame.height),
  };
}
