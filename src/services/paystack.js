const PAYSTACK_BASE_URL = "https://api.paystack.co";

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export async function initializeTransaction({
  email,
  amountPesewas,
  currency = "GHS",
  channels,
  metadata,
  callback_url,
}) {
  const secret = requiredEnv("PAYSTACK_SECRET_KEY");
  const resp = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      amount: amountPesewas,
      currency,
      channels,
      metadata,
      callback_url,
    }),
  });

  const data = await resp.json();
  if (!resp.ok || !data?.status) {
    throw new Error(data?.message || "Paystack initialize failed");
  }
  return data.data;
}

export async function verifyTransaction(reference) {
  const secret = requiredEnv("PAYSTACK_SECRET_KEY");
  const resp = await fetch(
    `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: { Authorization: `Bearer ${secret}` },
    }
  );
  const data = await resp.json();
  if (!resp.ok || !data?.status) {
    throw new Error(data?.message || "Paystack verify failed");
  }
  return data.data;
}

