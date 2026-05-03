/**
 * Mock NIA PIN ledger — RESTful simulation of IVS lookup (L.I. 2111 thesis framing).
 * PIN must match Ghana Card format and exist in this ledger for Protocol A "handshake".
 */
export const MOCK_NIA_LEDGER = [
  { pin: "GHA-482951734-1", fullName: "Ama Mensah" },
  { pin: "GHA-739105284-2", fullName: "Kwame Boateng" },
  { pin: "GHA-615204987-3", fullName: "Esi Owusu" },
  /** Align with demo registration flows */
  { pin: "GHA-100100100-1", fullName: "John Doe" },
  { pin: "GHA-200200200-2", fullName: "Akosua Frimpong" },
  { pin: "GHA-300300300-3", fullName: "Ghana Land Commission" },
  { pin: "GHA-400400400-4", fullName: "Dr. Ama Osei" },
  { pin: "GHA-712230043-2", fullName: "Paul Hackman" },
  { pin: "GHA-728474024-7", fullName: "Leslie Ofosu-Kontoh" },
];
