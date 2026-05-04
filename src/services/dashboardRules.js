/**
 * Strict rule matrix by dashboard persona (thesis / RBAC documentation for SmartLand prototype).
 * Enforcement lives in route middleware + conflict engine; this module is the single source of truth for intent.
 */

export const DASHBOARD_RULES = {
  seller: {
    role: "seller",
    narrative:
      "Seller / landowner — lists parcels; must pass Protocols A→B (Ghana Card) via mock IVS under Lands Commission rules; parcel listings run Protocol C (land documents) when OCR text is supplied.",
    allowed: [
      "POST /api/parcels (when submissionAllowed + Protocol A satisfied; Protocol C may flag parcel)",
      "POST /api/conversations",
      "GET /api/parcels",
      "PATCH /api/users/me (save idVerification + smartlandProtocols)",
    ],
    requiredForAutomatedSettlement: [
      "niaStatus === verified",
      "smartlandProtocols.protocolA.passed !== false",
      "smartlandProtocols.protocolB.passed === true OR protocolB.skipped with Lands Commission verified override",
      "parcel.protocolC.passed !== false when Protocol C was evaluated",
    ],
  },

  buyer: {
    role: "buyer",
    narrative:
      "Purchaser / investor — checkout and transfers; gated by parcel and seller red-flag engine, Lands Commission verification, and seller protocol completeness.",
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

  lands_commission: {
    role: "lands_commission",
    narrative:
      "Ghana Lands Commission (main registrar admin) — verifies Ghana Card / identity prescreening and land documents for sellers, landowners, buyers, and investors; endorses accounts and registry readiness when checks pass.",
    allowed: [
      "PATCH /api/users/:id/verify (account + document gate after identity prescreen)",
      "GET /api/users/pending",
      "GET /api/lands-commission/users or GET /api/nia/users (same handler; identity prescreen queue)",
      "POST /api/lands-commission/users/:id/decision or POST /api/nia/users/:id/decision",
      "GET /api/lands-commission/employees/* or GET /api/nia/employees/*",
      "GET /api/users (read-only roster)",
      "Parcel / transfer review aligned with statutory land rules",
    ],
    blockingRules: ["Users with niaStatus !== verified cannot receive LC account approval (field name retained for API compatibility)"],
    obligations: [
      "Verify Ghana Card IVS prescreening and resolve suspicious identity signals",
      "Verify land instruments / listing documents before clearing sellers and investors for transaction",
    ],
  },

  admin: {
    role: "admin",
    narrative:
      "Supervisory Ghana Lands Commission / system admin — same verification authority as lands_commission with full operational oversight (users, parcels, disputes, settlements).",
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
