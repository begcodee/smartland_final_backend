export function normalizeGhanaCardNumber(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9-]/g, "");
}

// Common format: GHA-XXXXXXXXX-X (examples vary; keep strict enough for demo)
export function isValidGhanaCardFormat(value) {
  const v = normalizeGhanaCardNumber(value);
  return /^GHA-\d{9}-\d$/.test(v);
}

export function isObviouslyFakeGhanaCard(value) {
  const v = normalizeGhanaCardNumber(value);
  if (!/^GHA-\d{9}-\d$/.test(v)) return true;
  const numeric = v.slice(4, 13); // 9 digits
  if (/^0{9}$/.test(numeric)) return true;
  // sequential patterns
  if (numeric === "123456789" || numeric === "987654321") return true;
  // repeated digits (e.g. 111111111)
  if (/^(\d)\1{8}$/.test(numeric)) return true;
  return false;
}

export function validateFullNameOnCard(fullName) {
  const name = String(fullName || "").trim();
  if (name.length < 2) return false;
  // Require at least 2 words
  return name.split(/\s+/).filter(Boolean).length >= 2;
}

export function nameSimilarity(a, b) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const aw = new Set(A.split(" "));
  const bw = new Set(B.split(" "));
  const inter = [...aw].filter((w) => bw.has(w)).length;
  const union = new Set([...aw, ...bw]).size || 1;
  return inter / union;
}


