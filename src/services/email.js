import nodemailer from "nodemailer";

function hasSmtpEnv() {
  return (
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}

function transport() {
  if (!hasSmtpEnv()) return null;
  const port = Number(process.env.SMTP_PORT);
  return nodemailer.createTransport({
    host: String(process.env.SMTP_HOST),
    port: Number.isFinite(port) ? port : 587,
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
    auth: {
      user: String(process.env.SMTP_USER),
      pass: String(process.env.SMTP_PASS),
    },
  });
}

export async function sendEmail({ to, subject, text, html, category }) {
  const enabled = String(process.env.EMAIL_NOTIFICATIONS_ENABLED || "false").toLowerCase() === "true";
  const from = String(process.env.EMAIL_FROM || "SmartLand <no-reply@smartland.local>");
  if (!enabled) {
    console.log("[email] disabled", { to, subject, category });
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!to) return { ok: false, skipped: true, reason: "missing_to" };

  const tx = transport();
  if (!tx) {
    console.log("[email] missing SMTP env; logging only", { to, subject, category, preview: text?.slice?.(0, 120) });
    return { ok: true, skipped: true, reason: "missing_smtp_env" };
  }

  try {
    const info = await tx.sendMail({
      from,
      to,
      subject,
      text: text || undefined,
      html: html || undefined,
      headers: category ? { "X-SmartLand-Category": String(category) } : undefined,
    });
    return { ok: true, skipped: false, messageId: info.messageId };
  } catch (e) {
    console.warn("[email] send failed", e?.message || e);
    return { ok: false, skipped: false, error: e?.message || String(e) };
  }
}

