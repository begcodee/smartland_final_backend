import { SignJWT, jwtVerify, importPKCS8, importSPKI } from "jose";

/**
 * Minimal SSI scaffold:
 * - DID: did:pkh for an EVM address (or did:web for org)
 * - VC: JWT-VC signed by Lands Commission (backend-held key) for "GhanaCardVerified" / "RegistryVerified"
 *
 * This is not a full SSI stack (no status-list revocation yet), but it creates a cryptographically verifiable
 * credential that other services can verify without calling SmartLand.
 */

export function didPkh(address, chainId = 1) {
  const a = String(address || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
  return `did:pkh:eip155:${Number(chainId)}:${a}`;
}

function envOrThrow(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export async function issueRegistryVcJwt({
  subjectDid,
  subjectUserId,
  subjectEmail,
  claims,
  ttlSeconds = 60 * 60 * 24 * 30,
}) {
  const issuerDid = envOrThrow("SSI_ISSUER_DID"); // e.g. did:web:lands.gov.gh or did:pkh...
  const pkcs8 = envOrThrow("SSI_ISSUER_PRIVATE_KEY_PEM"); // ES256 (P-256) or RS256
  const alg = String(process.env.SSI_JWT_ALG || "ES256").trim();

  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(pkcs8, alg);

  // Minimal JWT-VC shape (W3C VC as JWT payload)
  const vc = {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    type: ["VerifiableCredential", "SmartLandRegistryCredential"],
    credentialSubject: {
      id: subjectDid,
      userId: String(subjectUserId || ""),
      email: subjectEmail || null,
      ...claims,
    },
  };

  return await new SignJWT({ vc })
    .setProtectedHeader({ alg, typ: "JWT" })
    .setIssuer(issuerDid)
    .setSubject(subjectDid)
    .setAudience(String(process.env.SSI_AUDIENCE || "smartland"))
    .setIssuedAt(now)
    .setExpirationTime(now + Number(ttlSeconds))
    .sign(key);
}

export async function verifyRegistryVcJwt(jwt) {
  const spki = envOrThrow("SSI_ISSUER_PUBLIC_KEY_PEM");
  const alg = String(process.env.SSI_JWT_ALG || "ES256").trim();
  const issuerDid = envOrThrow("SSI_ISSUER_DID");
  const audience = String(process.env.SSI_AUDIENCE || "smartland");

  const key = await importSPKI(spki, alg);
  const out = await jwtVerify(String(jwt), key, {
    issuer: issuerDid,
    audience,
    algorithms: [alg],
  });
  return { payload: out.payload, protectedHeader: out.protectedHeader };
}

