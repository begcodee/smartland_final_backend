/**
 * Strict rule matrix by dashboard persona (thesis / RBAC documentation for SmartLand prototype).
 * Enforcement lives in route middleware + conflict engine; this module is the single source of truth for intent.
 */

export const DASHBOARD_RULES = {
  seller: {
    role: "seller",
    narrative: "Landowner — lists parcels; must pass Protocols A→B (identity) via mock IVS; parcel listings run Protocol C when OCR text is supplied.",
    allowed: [
      "POST /api/parcels (when submissionAllowed + Protocol A satisfied; Protocol C may flag parcel)",
      "POST /api/conversations",
      "GET /api/parcels",
      "PATCH /api/users/me (save idVerification + smartlandProtocols)",
    ],
    requiredForAutomatedSettlement: [
      "niaStatus === verified",
      "smartlandProtocols.protocolA.passed !== false",
      "smartlandProtocols.protocolB.passed === true OR protocolB.skipped with NIA verified override",
      "parcel.protocolC.passed !== false when Protocol C was evaluated",
    ],
  },

  buyer: {
    role: "buyer",
    narrative: "Purchaser — checkout & transfers; gated by parcel/seller red-flag engine + seller protocol completeness.",
    allowed: [
      "POST /api/payments/initialize",
      "GET /api/payments/verify",
      "GET /api/transfers",
      "POST /api/ratings",
    ],
    requiredForCheckout: [
      "Conflict engine AUTO (includes seller protocol gate)",
      "Parcel registryClearance clear",
    ],
  },

  nia: {
    role: "nia",
    narrative: "National ID — simulated IVS queue; officers confirm or reject after Protocol A/B prescreening.",
    allowed: [
      "GET /api/nia/users",
      "POST /api/nia/users/:id/decision",
      "GET /api/nia/employees/*",
      "GET /api/users (read-only roster)",
    ],
    obligations: [
      "Reject suspicious identities; approve after mock ledger + biometric pathway",
      "Notify Lands Commission on verified users",
    ],
  },

  lands_commission: {
    role: "lands_commission",
    narrative: "Ghana Lands Commission — cannot approve users until NIA verified; endorses land readiness.",
    allowed: [
      "PATCH /api/users/:id/verify",
      "GET /api/users/pending",
    ],
    blockingRules: ["Users with niaStatus !== verified cannot be approved"],
  },

  admin: {
    role: "admin",
    narrative: "Supervisory Lands Commission / system admin — full oversight of users, parcels, disputes and settlements.",
    allowed: ["Inherits lands_commission + POST /api/parcels + red-flag clear"],
  },

  arbitrator: {
    role: "arbitrator",
    narrative: "Resolves red flags: ownership mismatch, biometric theft suspicion, unstamped instruments.",
    allowed: [
      "PATCH /api/parcels/:id/clear-red-flag",
      "Notification queue for BIOMETRIC_MISMATCH and SELLER_NOT_REGISTERED_OWNER",
    ],
  },
};
