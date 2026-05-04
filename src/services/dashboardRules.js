/**
 * Strict rule matrix by dashboard persona (thesis / RBAC documentation for SmartLand prototype).
 * Enforcement lives in route middleware + conflict engine; this module is the single source of truth for intent.
 */

export const DASHBOARD_RULES = {
  seller: {
    role: "seller",
    narrative:
      "Seller / landowner — lists land parcels; must have Ghana Card AND land documents verified by the Ghana Lands Commission; parcel listings run Protocol C (document OCR) when text is supplied.",
    allowed: [
      "POST /api/parcels (when submissionAllowed + Protocol A satisfied; Protocol C may flag parcel)",
      "POST /api/conversations",
      "GET /api/parcels",
      "PATCH /api/users/me (save idVerification + smartlandProtocols)",
    ],
    requiredForAutomatedSettlement: [
      "niaStatus === verified (Ghana Card verified by Lands Commission)",
      "smartlandProtocols.protocolA.passed !== false",
      "smartlandProtocols.protocolB.passed === true OR protocolB.skipped with Lands Commission verified override",
      "parcel.protocolC.passed !== false when Protocol C was evaluated",
    ],
  },

  buyer: {
    role: "buyer",
    narrative:
      "Purchaser / investor — checkout and transfers; must have Ghana Card verified by Lands Commission; gated by parcel/seller red-flag engine and protocol completeness.",
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
      "Ghana Lands Commission — sole authority for all identity and land document verification. " +
      "Buyers/investors: Ghana Card only. Sellers/landowners: Ghana Card + land documents. Arbitrators: Ghana Card only.",
    verificationByRole: {
      buyer: ["Ghana Card (Protocol A + B)"],
      seller: ["Ghana Card (Protocol A + B)", "Land Certificate", "Indenture (Deed/Lease)", "Certified Survey Plan", "Site Plan"],
      arbitrator: ["Ghana Card (Protocol A + B)"],
    },
    allowed: [
      "POST /api/lands-commission/users/:id/decision  — Ghana Card (+ land docs for sellers) decision",
      "PATCH /api/users/:id/verify                    — Final account approval/rejection",
      "GET  /api/lands-commission/users               — Identity verification queue",
      "GET  /api/users/pending                        — Accounts awaiting full approval",
      "GET  /api/users                                — Full user roster",
      "GET  /api/parcels                              — All parcels (any status)",
      "PATCH /api/parcels/:id/review                  — Approve/reject parcel listing",
      "POST /api/parcels/:id/unlock-fraud             — Release fraud lock after investigation",
    ],
    blockingRules: [
      "Sellers cannot list parcels until both Ghana Card AND land documents are LC-verified",
      "Buyers cannot transact until Ghana Card is LC-verified",
      "Parcels are not visible to buyers until LC approves them",
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
