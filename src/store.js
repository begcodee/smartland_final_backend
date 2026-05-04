import bcrypt from "bcryptjs";

function nowIso() {
  return new Date().toISOString();
}

function id(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

// Demo in-memory store (no DB required).
/** Demo users/parcels: on in local dev; off on Render/production unless SEED_DEMO_USERS=true */
function shouldSeedDemoData() {
  if (process.env.SEED_DEMO_USERS === "true") return true;
  if (process.env.SEED_DEMO_USERS === "false") return false;
  const prodLike =
    process.env.NODE_ENV === "production" || String(process.env.RENDER || "") === "true";
  return !prodLike;
}

/**
 * One admin/LC user when the DB has no rows yet (Render first boot).
 * Set BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD, deploy once, then remove the password from env.
 */
function bootstrapProdAdminFromEnv() {
  const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return;
  if (store.users.size > 0) return;
  const name =
    String(process.env.BOOTSTRAP_ADMIN_NAME || "Ghana Lands Commission Admin").trim() ||
    "Ghana Lands Commission Admin";
  const roleRaw = String(process.env.BOOTSTRAP_ADMIN_ROLE || "admin").trim().toLowerCase();
  const role = roleRaw === "lands_commission" ? "lands_commission" : "admin";
  const passwordHash = bcrypt.hashSync(String(password), 10);
  const uid = id("user");
  store.users.set(uid, {
    id: uid,
    name,
    email,
    phoneNumber: process.env.BOOTSTRAP_ADMIN_PHONE?.trim() || null,
    role,
    staffId: process.env.BOOTSTRAP_ADMIN_STAFF_ID?.trim() || "GLC-BOOTSTRAP-001",
    organization: process.env.BOOTSTRAP_ADMIN_ORG?.trim() || "Ghana Lands Commission",
    passwordHash,
    createdAt: nowIso(),
    verified: true,
    niaStatus: "verified",
    niaReferenceId: null,
    niaVerifiedAt: nowIso(),
    idVerification: null,
    reputation: { score: 0, totalTransactions: 0, successfulTransactions: 0, disputesWon: 0, communityVotes: 0 },
    creditScore: { score: 0, rating: "Unscored", paymentHistory: 0, creditUtilization: 0, lengthOfHistory: 0, newCredit: 0, creditMix: 0 },
  });
  console.warn(
    `[store] Bootstrap ${role} user for ${email}. Remove BOOTSTRAP_ADMIN_PASSWORD from env after first deploy; change password in-app.`
  );
}

export const store = {
  users: new Map(),
  parcels: new Map(),
  conversations: new Map(),
  messages: new Map(), // conversationId -> array
  payments: new Map(), // reference -> payment record
  transfers: new Map(), // id -> transfer record
  ratings: [], // array of { id, fromUserId, toUserId, stars, context, createdAt }
  niaEmployees: new Map(), // staffId -> employee
  employeeAttempts: [], // array audit log
  auditLogs: [],
  notifications: [],
  /** Document hash registry (sha256 -> { parcelId, docName, createdAt }) */
  documentHashes: new Map(),
  /** Image hash registry (sha256 -> { userId, parcelId?, context, createdAt }) */
  imageHashes: new Map(),
  /** Encrypted file vault (fileId -> meta) */
  files: new Map(),
  /** Short-lived download tokens (token -> { fileId, userId, expMs }) */
  fileTokens: new Map(),
  /** Land / registry policy records (admin-managed) */
  laws: [],
};

export function seedIfEmpty() {
  if (store.users.size === 0 && shouldSeedDemoData()) {
  const demoPasswordHash = bcrypt.hashSync("Password123!", 10);

  const admin = {
    id: id("user"),
    name: "Lands Commission Admin",
    email: "admin@lands.gov.gh",
    phoneNumber: "+233000000001",
    role: "admin",
    staffId: "GLC-EMP-0001",
    organization: "Ghana Lands Commission",
    passwordHash: demoPasswordHash,
    niaStatus: "pending",
    niaReferenceId: null,
    niaVerifiedAt: null,
    createdAt: nowIso(),
    verified: false,
  };

  // Extra demo accounts matching the UI "Demo:" line (kept in addition to the generic demo accounts).
  const adminGlc = {
    id: id("user"),
    name: "Ghana Land Commission",
    email: "admin@ghanalandcommission.gov.gh",
    phoneNumber: "+233302123456",
    role: "admin",
    staffId: "GLC-EMP-2024-001",
    organization: "Ghana Lands Commission",
    passwordHash: demoPasswordHash,
    niaStatus: "pending",
    niaReferenceId: null,
    niaVerifiedAt: null,
    createdAt: nowIso(),
    verified: true,
  };

  const buyerAkosua = {
    id: id("user"),
    name: "Akosua Frimpong",
    email: "akosua.frimpong@yahoo.com",
    phoneNumber: "+233201987654",
    role: "buyer",
    passwordHash: demoPasswordHash,
    niaStatus: "verified",
    niaReferenceId: "NIA-DEMO-AKOSUA",
    niaVerifiedAt: nowIso(),
    createdAt: nowIso(),
    verified: true,
  };

  const sellerJohn = {
    id: id("user"),
    name: "John Doe",
    email: "john.doe@gmail.com",
    phoneNumber: "+233244123456",
    role: "seller",
    passwordHash: demoPasswordHash,
    niaStatus: "verified",
    niaReferenceId: "NIA-DEMO-JOHN",
    niaVerifiedAt: nowIso(),
    createdAt: nowIso(),
    verified: true,
    submissionAllowed: true,
    riskScore: 80,
    riskReasons: [],
  };

  // Requested demo accounts (owners + buyers + staff)
  const sellerLatif = {
    id: id("user"),
    name: "Latif Dabone",
    email: "latif.dabone@demo.smartland",
    phoneNumber: "+233000001101",
    role: "seller",
    passwordHash: demoPasswordHash,
    niaStatus: "pending",
    niaReferenceId: null,
    niaVerifiedAt: null,
    createdAt: nowIso(),
    verified: false,
    submissionAllowed: false,
    riskScore: 85,
    riskReasons: [],
  };

  const sellerSheriff = {
    id: id("user"),
    name: "Sheriff Adonoo",
    email: "sheriff.adonoo@demo.smartland",
    phoneNumber: "+233000001102",
    role: "seller",
    passwordHash: demoPasswordHash,
    niaStatus: "pending",
    niaReferenceId: null,
    niaVerifiedAt: null,
    createdAt: nowIso(),
    verified: false,
    submissionAllowed: false,
    riskScore: 85,
    riskReasons: [],
  };

  const sellerKojo = {
    id: id("user"),
    name: "Kojo Nkansah",
    email: "kojo.nkansah@demo.smartland",
    phoneNumber: "+233000001103",
    role: "seller",
    passwordHash: demoPasswordHash,
    niaStatus: "pending",
    niaReferenceId: null,
    niaVerifiedAt: null,
    createdAt: nowIso(),
    verified: false,
    submissionAllowed: false,
    riskScore: 85,
    riskReasons: [],
  };

  const buyerPrecious = {
    id: id("user"),
    name: "Precious Adjetey",
    email: "precious.adjetey@demo.smartland",
    phoneNumber: "+233000001201",
    role: "buyer",
    passwordHash: demoPasswordHash,
    niaStatus: "verified",
    niaReferenceId: "NIA-DEMO-PRECIOUS",
    niaVerifiedAt: nowIso(),
    createdAt: nowIso(),
    verified: true,
  };

  const buyerAkua = {
    id: id("user"),
    name: "Akua Amankwa",
    email: "akua.amankwa@demo.smartland",
    phoneNumber: "+233000001202",
    role: "buyer",
    passwordHash: demoPasswordHash,
    niaStatus: "verified",
    niaReferenceId: "NIA-DEMO-AKUA",
    niaVerifiedAt: nowIso(),
    createdAt: nowIso(),
    verified: true,
  };

  const adminFlorence = {
    id: id("user"),
    name: "Florence Ntiamah",
    email: "florence.ntiamah@lands.gov.gh",
    phoneNumber: "+233000001301",
    role: "admin",
    staffId: "GLC-EMP-2026-010",
    organization: "Ghana Lands Commission",
    passwordHash: demoPasswordHash,
    niaStatus: "verified",
    niaReferenceId: "NIA-DEMO-FLORENCE",
    niaVerifiedAt: nowIso(),
    createdAt: nowIso(),
    verified: true,
  };

  const arbitratorEmmanuella = {
    id: id("user"),
    name: "Emmanuella Addobea",
    email: "emmanuella.addobea@arbitrator.gh",
    phoneNumber: "+233000001501",
    role: "arbitrator",
    arbitratorRegNo: "ARB-GH-2026-010",
    organization: "Ghana Arbitration Centre",
    passwordHash: demoPasswordHash,
    niaStatus: "verified",
    niaReferenceId: "NIA-DEMO-EMMA",
    niaVerifiedAt: nowIso(),
    createdAt: nowIso(),
    verified: true,
  };

  const arbitratorAma = {
    id: id("user"),
    name: "Dr. Ama Osei",
    email: "ama.osei@arbitrator.gh",
    phoneNumber: "+233244567890",
    role: "arbitrator",
    arbitratorRegNo: "ARB-GH-2023-045",
    organization: "Ghana Arbitration Centre",
    passwordHash: demoPasswordHash,
    niaStatus: "verified",
    niaReferenceId: "NIA-DEMO-ARB",
    niaVerifiedAt: nowIso(),
    createdAt: nowIso(),
    verified: true,
  };

  const buyer = {
    id: id("user"),
    name: "Buyer Demo",
    email: "buyer@example.com",
    phoneNumber: "+233000000010",
    role: "buyer",
    passwordHash: demoPasswordHash,
    niaStatus: "pending",
    niaReferenceId: null,
    niaVerifiedAt: null,
    createdAt: nowIso(),
    verified: false,
  };

  const seller = {
    id: id("user"),
    name: "Seller Demo",
    email: "seller@example.com",
    phoneNumber: "+233000000020",
    role: "seller",
    passwordHash: demoPasswordHash,
    niaStatus: "verified",
    niaReferenceId: "NIA-DEMO-SELLER",
    niaVerifiedAt: nowIso(),
    createdAt: nowIso(),
    verified: true,
    submissionAllowed: true,
    riskScore: 80,
    riskReasons: [],
  };

  const landsOfficer = {
    id: id("user"),
    name: "Lands Officer (GLC)",
    email: "glc.officer@demo.smartland",
    phoneNumber: "+233000000301",
    role: "lands_commission",
    staffId: "GLC-STAFF-0002",
    organization: "Ghana Lands Commission",
    passwordHash: demoPasswordHash,
    niaStatus: "verified",
    niaReferenceId: "NIA-DEMO-GLC",
    niaVerifiedAt: nowIso(),
    createdAt: nowIso(),
    verified: true,
  };

  const arbitratorB = {
    id: id("user"),
    name: "Arbitrator B",
    email: "arb.b@demo.smartland",
    phoneNumber: "+233000000401",
    role: "arbitrator",
    arbitratorRegNo: "ARB-GH-2024-101",
    organization: "Ghana Arbitration Centre",
    passwordHash: demoPasswordHash,
    niaStatus: "verified",
    niaReferenceId: "NIA-DEMO-ARB-B",
    niaVerifiedAt: nowIso(),
    createdAt: nowIso(),
    verified: true,
  };

  for (const u of [
    admin,
    buyer,
    seller,
    adminGlc,
    buyerAkosua,
    sellerJohn,
    arbitratorAma,
    landsOfficer,
    arbitratorB,
    sellerLatif,
    sellerSheriff,
    sellerKojo,
    buyerPrecious,
    buyerAkua,
    adminFlorence,
    arbitratorEmmanuella,
  ])
    store.users.set(u.id, u);

  // Demo parcel catalog (images served from frontend uploads: /public/images)
  // NOTE: user-uploaded filenames like "land at oyarifa" were not present in /public/images yet,
  // so we map requested parcels onto the 5 available uploaded images (land-1..land-5).
  const parcelOyarifaAvailable = {
    id: id("parcel"),
    title: "Land at Oyarifa",
    location: "Oyarifa, Greater Accra",
    priceGhs: 18000,
    size: "0.12 acre",
    status: "available",
    registryClearance: "clear",
    redFlag: null,
    sellerId: sellerLatif.id,
    createdAt: nowIso(),
    transfers: [],
    images: [
      { id: "img_land_1", url: "/images/land-1.jpg", caption: "Listing photo (uploaded)", type: "main", uploadedAt: nowIso() },
    ],
  };

  const parcelTemaDemarcated = {
    id: id("parcel"),
    title: "Demarcated land at Tema",
    location: "Tema, Greater Accra",
    priceGhs: 32000,
    size: "0.15 acre",
    status: "available",
    registryClearance: "clear",
    redFlag: null,
    sellerId: sellerSheriff.id,
    createdAt: nowIso(),
    transfers: [],
    images: [
      { id: "img_land_2", url: "/images/land-2.jpg", caption: "Listing photo (uploaded)", type: "main", uploadedAt: nowIso() },
    ],
  };

  const parcelRealEstateForSale = {
    id: id("parcel"),
    title: "Real estate land for sale",
    location: "Spintex, Greater Accra",
    priceGhs: 45000,
    size: "0.20 acre",
    status: "available",
    registryClearance: "clear",
    redFlag: null,
    sellerId: sellerKojo.id,
    createdAt: nowIso(),
    transfers: [],
    images: [
      { id: "img_land_3", url: "/images/land-3.jpg", caption: "Listing photo (uploaded)", type: "main", uploadedAt: nowIso() },
    ],
  };

  const parcelUncompletedBuilding = {
    id: id("parcel"),
    title: "Uncompleted building on 1 plot",
    location: "Kasoa, Central Region",
    priceGhs: 60000,
    size: "1 plot",
    status: "available",
    registryClearance: "clear",
    redFlag: null,
    sellerId: sellerLatif.id,
    createdAt: nowIso(),
    transfers: [],
    images: [
      { id: "img_land_4", url: "/images/land-4.jpg", caption: "Listing photo (uploaded)", type: "main", uploadedAt: nowIso() },
    ],
  };

  const parcelOnePlotWithBuilding = {
    id: id("parcel"),
    title: "1 plot with building on it",
    location: "East Legon, Accra",
    priceGhs: 85000,
    size: "1 plot",
    status: "available",
    registryClearance: "clear",
    redFlag: null,
    sellerId: sellerSheriff.id,
    createdAt: nowIso(),
    transfers: [],
    images: [
      { id: "img_land_5", url: "/images/land-5.jpg", caption: "Listing photo (uploaded)", type: "main", uploadedAt: nowIso() },
    ],
  };

  store.parcels.set(parcelOyarifaAvailable.id, parcelOyarifaAvailable);
  store.parcels.set(parcelTemaDemarcated.id, parcelTemaDemarcated);
  store.parcels.set(parcelRealEstateForSale.id, parcelRealEstateForSale);
  store.parcels.set(parcelUncompletedBuilding.id, parcelUncompletedBuilding);
  store.parcels.set(parcelOnePlotWithBuilding.id, parcelOnePlotWithBuilding);

  // Seed demo Lands Commission identity staff registry (in-memory demo)
  store.niaEmployees.set("NIA-001", {
    staffId: "NIA-001",
    fullName: "Ama Mensah",
    ghanaCardNumber: "GHA-482951734-1",
    active: true,
  });
  store.niaEmployees.set("NIA-002", {
    staffId: "NIA-002",
    fullName: "Kwame Boateng",
    ghanaCardNumber: "GHA-739105284-2",
    active: true,
  });
  store.niaEmployees.set("NIA-003", {
    staffId: "NIA-003",
    fullName: "Esi Owusu",
    ghanaCardNumber: "GHA-615204987-3",
    active: false,
  });
  }

  if (store.users.size === 0) {
    bootstrapProdAdminFromEnv();
  }

  if (!store.laws.length) {
    const t = nowIso();
    store.laws.push(
      {
        id: id("law"),
        code: "REG-GLC-001",
        title: "Parcel registration — documentary evidence",
        summary: "Minimum documents required before a parcel may be listed on SmartLand.",
        body: "Sellers must provide a valid site plan or survey, evidence of identity consistent with Ghana Card verification by the Lands Commission, and declaration of encumbrances. The Lands Commission may request further evidence where overlap or chain gaps are flagged.",
        category: "registration",
        effectiveFrom: "2024-01-01",
        status: "active",
        createdAt: t,
        updatedAt: t,
      },
      {
        id: id("law"),
        code: "REG-GLC-002",
        title: "Transfer and payment settlement",
        summary: "Rules for escrow-backed transfers between verified parties.",
        body: "Transfers require verified buyer and seller, cleared conflict checks, and completion of statutory fees where applicable. Disputed parcels cannot complete transfer until dispute status is resolved or withdrawn.",
        category: "transfer",
        effectiveFrom: "2024-06-01",
        status: "active",
        createdAt: t,
        updatedAt: t,
      }
    );
  }
}

function initialsFromName(name) {
  const n = String(name || "").trim();
  if (!n) return "?";
  const parts = n.split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "";
  const b = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  const out = (a + b).toUpperCase();
  return out || "?";
}

/**
 * Returns a user object safe for the requesting viewer.
 * - Buyers/Sellers/Public only see initials for other users (neutral anonymity).
 * - Staff (admin/lands_commission/arbitrator) sees full profiles.
 * - Everyone can see their own full profile.
 */
export function publicUser(user, viewer) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  const viewerId = viewer?.id ?? null;
  const viewerRole = viewer?.role ?? "public";

  // Self can always see full details
  if (viewerId && safe.id === viewerId) return safe;

  const isNeutralViewer = viewerRole === "buyer" || viewerRole === "seller" || viewerRole === "public";
  if (!isNeutralViewer) return safe;

  const initials = initialsFromName(safe.name);
  return {
    id: safe.id,
    role: safe.role,
    name: initials, // UI-friendly "KA" identity
    initials,
    verified: Boolean(safe.verified),
    niaStatus: safe.niaStatus ?? null,
    createdAt: safe.createdAt ?? null,
  };
}

export function safeParcel(parcel, viewer) {
  const seller = store.users.get(parcel.sellerId);
  const viewerCtx = viewer ?? { id: null, role: "public" };
  return {
    ...parcel,
    seller: seller ? publicUser(seller, viewerCtx) : null,
  };
}

