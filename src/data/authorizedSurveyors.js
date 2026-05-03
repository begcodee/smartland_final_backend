/**
 * Authorized surveyor licence tokens for Protocol C (simulated GELIS / stamp rule).
 * Matches text like "Licensed Surveyor #LS-GH-4432" or bare licence codes.
 */
export const AUTHORIZED_SURVEYOR_LICENSES = [
  "LS-GH-4432",
  "LS-GH-5521",
  "LS-GH-9910",
  "GH-SRV-001",
  "GH-SRV-002",
];

/** Build regex alternation for OCR-extracted text search */
export function authorizedSurveyorPattern() {
  const escaped = AUTHORIZED_SURVEYOR_LICENSES.map((s) =>
    String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  return new RegExp(`(${escaped.join("|")})`, "i");
}
