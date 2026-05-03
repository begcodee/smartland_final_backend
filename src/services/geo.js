import crypto from "crypto";
import * as turf from "@turf/turf";

function round(n, dp = 6) {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

export function normalizePolygon(points) {
  // Expected: [[lat,lng], ...] or [{lat,lng}, ...]
  const arr = (points || [])
    .map((p) => {
      if (Array.isArray(p) && p.length >= 2) return [Number(p[0]), Number(p[1])];
      if (p && typeof p === "object" && "lat" in p && "lng" in p) return [Number(p.lat), Number(p.lng)];
      return null;
    })
    .filter(Boolean);

  // Remove trailing duplicated last point
  if (arr.length >= 3) {
    const [a0, b0] = arr[0];
    const [al, bl] = arr[arr.length - 1];
    if (a0 === al && b0 === bl) arr.pop();
  }

  // Round for stable fingerprinting
  return arr.map(([lat, lng]) => [round(lat), round(lng)]);
}

function toGeoJsonPolygon(points) {
  const pts = normalizePolygon(points);
  if (pts.length < 3) return null;
  // GeoJSON uses [lng, lat]
  const ring = pts.map(([lat, lng]) => [lng, lat]);
  // Ensure closed ring
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
  return turf.polygon([ring]);
}

export function polygonAreaSqm(points) {
  const poly = toGeoJsonPolygon(points);
  if (!poly) return null;
  try {
    return turf.area(poly); // m²
  } catch {
    return null;
  }
}

export function polygonOverlapRatio(polyA, polyB) {
  const A = toGeoJsonPolygon(polyA);
  const B = toGeoJsonPolygon(polyB);
  if (!A || !B) return null;

  const areaA = turf.area(A);
  const areaB = turf.area(B);
  const denom = Math.max(1e-12, Math.min(areaA, areaB));

  // Fast reject: bbox
  const bbA = turf.bbox(A);
  const bbB = turf.bbox(B);
  const bbInter = !(
    bbA[2] < bbB[0] ||
    bbB[2] < bbA[0] ||
    bbA[3] < bbB[1] ||
    bbB[3] < bbA[1]
  );
  if (!bbInter) return 0;

  let interArea = 0;
  try {
    const inter = turf.intersect(A, B);
    if (inter) interArea = turf.area(inter);
  } catch {
    // If geometry is invalid, fall back to bbox-based estimate
    return null;
  }

  return interArea / denom;
}

export function polygonBbox(points) {
  const pts = normalizePolygon(points);
  if (pts.length < 3) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lat, lng] of pts) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }
  return { minLat, maxLat, minLng, maxLng };
}

export function bboxArea(b) {
  const w = Math.max(0, b.maxLng - b.minLng);
  const h = Math.max(0, b.maxLat - b.minLat);
  return w * h;
}

export function bboxIntersectionArea(a, b) {
  const minLat = Math.max(a.minLat, b.minLat);
  const maxLat = Math.min(a.maxLat, b.maxLat);
  const minLng = Math.max(a.minLng, b.minLng);
  const maxLng = Math.min(a.maxLng, b.maxLng);
  const w = Math.max(0, maxLng - minLng);
  const h = Math.max(0, maxLat - minLat);
  return w * h;
}

export function geoFingerprint(points) {
  const pts = normalizePolygon(points);
  const payload = JSON.stringify(pts);
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function conflictRiskFromOverlap(overlapRatio) {
  // overlapRatio is 0..1 (intersectionArea / minArea)
  if (overlapRatio >= 0.05) return { level: "high", action: "block" };
  if (overlapRatio >= 0.01) return { level: "medium", action: "review" };
  return { level: "low", action: "allow" };
}

