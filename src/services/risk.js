import { isObviouslyFakeGhanaCard, nameSimilarity } from "../utils/ghanaCard.js";

export function computeRiskScore(input) {
  // Default is "manual review" unless you earn trust points.
  let score = 0;
  const reasons = [];

  const idwise = input?.idwise || {};
  const user = input?.user || {};

  // Identity verified (Ghana Card prescreen / Lands Commission decision)
  if (idwise.status === "approved") score += 40;
  else if (idwise.status === "pending") reasons.push("IDWise pending");
  else reasons.push("IDWise not approved");

  const face = Number(idwise.faceMatchScore ?? 0);
  if (face >= Number(process.env.FACE_MATCH_THRESHOLD || 85)) score += 20;
  else if (face > 0) reasons.push("Low face match score");

  // Biodata consistency
  const sim = nameSimilarity(user.fullName, idwise.fullName);
  if (sim >= Number(process.env.NAME_SIMILARITY_THRESHOLD || 0.8)) score += 10;
  else reasons.push("Name mismatch");

  if (user.dob && idwise.dob && String(user.dob) === String(idwise.dob)) score += 10;
  else if (user.dob && idwise.dob) reasons.push("DOB mismatch");

  // Ghana Card structural checks
  if (user.ghanaCardNumber && isObviouslyFakeGhanaCard(user.ghanaCardNumber)) {
    score -= 30;
    reasons.push("Ghana Card looks fake/sequential");
  }

  // Account maturity / failed attempts (demo)
  const failed = Number(input?.failedAttempts || 0);
  if (failed >= 3) {
    score -= 30;
    reasons.push("Multiple failed verification attempts");
  }

  return {
    score,
    reasons,
    allow: score >= Number(process.env.RISK_ALLOW_THRESHOLD || 60),
    manualReview: score >= 40 && score < Number(process.env.RISK_ALLOW_THRESHOLD || 60),
  };
}

