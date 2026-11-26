const MAX_REQUEST_BYTES = 30 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 28 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

type QuoteItem = {
  variantId?: string;
  productId?: string;
  handle?: string;
  title: string;
  variantTitle?: string;
  image?: string | null;
  price?: string;
  currencyCode?: string;
  quantity: number;
};

type ResendAttachment = {
  filename: string;
  content: string;
  content_type: string;
};

type TurnstileResponse = {
  success: boolean;
  action?: string;
  hostname?: string;
  "error-codes"?: string[];
};

type EmailInput = {
  to: string[];
  cc?: string[];
  replyTo: string;
  subject: string;
  html: string;
  text: string;
  tag: string;
  attachments?: ResendAttachment[];
};

function splitSetting(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get("Origin");
  const headers = new Headers({ Vary: "Origin" });
  if (origin && splitSetting(env.ALLOWED_ORIGINS).includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

function response(
  request: Request,
  env: Env,
  body: BodyInit | null,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  corsHeaders(request, env).forEach((value, key) => headers.set(key, value));
  return new Response(body, { ...init, headers });
}

function textResponse(
  request: Request,
  env: Env,
  message: string,
  status: number,
): Response {
  return response(request, env, message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function jsonResponse(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
  status = 200,
): Response {
  return response(request, env, JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function isAllowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  return !origin || splitSetting(env.ALLOWED_ORIGINS).includes(origin);
}

function field(form: FormData, name: string, maxLength: number): string {
  return String(form.get(name) ?? "").trim().slice(0, maxLength);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function safeFilename(value: string): string {
  const sanitized = value.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
  return sanitized.slice(0, 180) || "attachment";
}

function formatMoney(item: QuoteItem): string {
  const amount = Number(item.price);
  const currency = item.currencyCode || "AUD";
  if (!Number.isFinite(amount)) return item.price ? `${item.price} ${currency}` : "Price on request";
  return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(amount);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function verifyTurnstile(
  request: Request,
  env: Env,
  token: string,
  expectedAction: "contact" | "quote",
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!env.TURNSTILE_SECRET_KEY) {
    throw new Error("Missing TURNSTILE_SECRET_KEY.");
  }
  if (!token) {
    return { ok: false, message: "Please complete the verification challenge." };
  }

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  const remoteIp =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (remoteIp) body.append("remoteip", remoteIp);

  const verifyResponse = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body },
  );
  if (!verifyResponse.ok) {
    throw new Error(`Turnstile verification failed: HTTP ${verifyResponse.status}`);
  }

  const result = (await verifyResponse.json()) as TurnstileResponse;
  if (!result.success) {
    return { ok: false, message: "Verification failed. Please try again." };
  }
  if (result.action && result.action !== expectedAction) {
    return { ok: false, message: "Verification failed. Please refresh and try again." };
  }
  const hostnames = splitSetting(env.TURNSTILE_EXPECTED_HOSTNAMES);
  if (hostnames.length && (!result.hostname || !hostnames.includes(result.hostname))) {
    return { ok: false, message: "Verification failed. Please refresh and try again." };
  }
  return { ok: true };
}

async function sendEmail(env: Env, input: EmailInput): Promise<void> {
  if (!env.RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY.");
  if (!input.to.length) throw new Error("Missing notification recipient.");

  const resendResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: input.to,
      ...(input.cc?.length ? { cc: input.cc } : {}),
      reply_to: input.replyTo,
      subject: input.subject,
      html: input.html,
      text: input.text,
      tags: [{ name: "category", value: input.tag }],
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    }),
  });

  if (!resendResponse.ok) {
    const detail = (await resendResponse.text()).slice(0, 1000);
    throw new Error(`Resend email failed: HTTP ${resendResponse.status} ${detail}`);
  }
}

function contactEmail(
  env: Env,
  input: { name: string; email: string; company: string; phone: string; message: string },
): EmailInput {
  const details: [string, string][] = [
    ["Name", input.name],
    ["Email", input.email],
  ];
  if (input.company) details.push(["Club / company", input.company]);
  if (input.phone) details.push(["Phone", input.phone]);
  const rows = details
    .map(
      ([label, value]) =>
        `<tr><th style="padding:6px 12px 6px 0;text-align:left;color:#4b5563;">${escapeHtml(label)}</th><td style="padding:6px 0;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const text = [
    `New contact enquiry from ${env.BRAND_NAME}`,
    "",
    "Customer",
    ...details.map(([label, value]) => `${label}: ${value}`),
    "",
    "Message",
    input.message,
  ].join("\n");

  return {
    to: splitSetting(env.CONTACT_EMAIL_TO),
    replyTo: input.email,
    subject: `New contact enquiry from ${singleLine(input.company || input.name)}`,
    text,
    html: `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#162d49;line-height:1.5;">
      <h1 style="font-size:22px;margin:0 0 12px;">New contact enquiry</h1>
      <p style="margin:0 0 20px;color:#4b5563;">Submitted through ${escapeHtml(env.BRAND_NAME)}.</p>
      <h2 style="font-size:16px;margin:20px 0 8px;">Customer</h2>
      <table style="border-collapse:collapse;width:100%;max-width:560px;">${rows}</table>
      <h2 style="font-size:16px;margin:24px 0 8px;">Message</h2>
      <p style="white-space:pre-wrap;">${escapeHtml(input.message)}</p>
    </body></html>`,
    tag: "contact_enquiry",
  };
}

function quoteEmail(
  env: Env,
  input: {
    name: string;
    email: string;
    company: string;
    phone: string;
    notes: string;
    items: QuoteItem[];
    files: File[];
    attachments: ResendAttachment[];
  },
): EmailInput {
  const details: [string, string][] = [
    ["Name", input.name],
    ["Email", input.email],
  ];
  if (input.company) details.push(["Club / company", input.company]);
  if (input.phone) details.push(["Phone", input.phone]);
  const detailRows = details
    .map(
      ([label, value]) =>
        `<tr><th style="padding:6px 12px 6px 0;text-align:left;color:#4b5563;">${escapeHtml(label)}</th><td style="padding:6px 0;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const itemRows = input.items
    .map((item) => {
      const variant = item.variantTitle && item.variantTitle !== "Default Title"
        ? `<br><span style="color:#6b7280;">${escapeHtml(item.variantTitle)}</span>`
        : "";
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;">${escapeHtml(item.title)}${variant}</td>
        <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:center;">${item.quantity}</td>
        <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;">${escapeHtml(formatMoney(item))}</td>
      </tr>`;
    })
    .join("");
  const textLines = [
    `New quote request from ${env.BRAND_NAME}`,
    "",
    "Customer",
    ...details.map(([label, value]) => `${label}: ${value}`),
    "",
    "Items",
    ...input.items.map((item) => {
      const variant = item.variantTitle && item.variantTitle !== "Default Title" ? ` - ${item.variantTitle}` : "";
      return `- ${item.title}${variant}: ${item.quantity} x ${formatMoney(item)}`;
    }),
  ];
  if (input.notes) textLines.push("", "Notes", input.notes);
  if (input.files.length) {
    textLines.push("", "Attachments", ...input.files.map((file) => `- ${file.name} (${formatBytes(file.size)})`));
  }

  const notes = input.notes
    ? `<h2 style="font-size:16px;margin:24px 0 8px;">Notes</h2><p style="white-space:pre-wrap;">${escapeHtml(input.notes)}</p>`
    : "";
  const files = input.files.length
    ? `<h2 style="font-size:16px;margin:24px 0 8px;">Attachments</h2><ul>${input.files
        .map((file) => `<li>${escapeHtml(file.name)} (${escapeHtml(formatBytes(file.size))})</li>`)
        .join("")}</ul>`
    : "";

  return {
    to: splitSetting(env.QUOTE_EMAIL_TO),
    cc: splitSetting(env.QUOTE_EMAIL_CC || ""),
    replyTo: input.email,
    subject: `New quote request from ${singleLine(input.company || input.name)}`,
    text: textLines.join("\n"),
    html: `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#162d49;line-height:1.5;">
      <h1 style="font-size:22px;margin:0 0 12px;">New quote request</h1>
      <p style="margin:0 0 20px;color:#4b5563;">Submitted through ${escapeHtml(env.BRAND_NAME)}.</p>
      <h2 style="font-size:16px;margin:20px 0 8px;">Customer</h2>
      <table style="border-collapse:collapse;width:100%;max-width:560px;">${detailRows}</table>
      <h2 style="font-size:16px;margin:24px 0 8px;">Items</h2>
      <table style="border-collapse:collapse;width:100%;max-width:720px;">
        <thead><tr><th style="padding:8px 0;border-bottom:2px solid #d1d5db;text-align:left;">Product</th><th style="padding:8px 0;border-bottom:2px solid #d1d5db;text-align:center;">Qty</th><th style="padding:8px 0;border-bottom:2px solid #d1d5db;text-align:right;">Unit price</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>${notes}${files}
    </body></html>`,
    tag: "quote_request",
    attachments: input.attachments,
  };
}

function parseQuoteItems(raw: string): QuoteItem[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
    const items = value.filter((item): item is QuoteItem => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<QuoteItem>;
      return (
        typeof candidate.title === "string" &&
        candidate.title.trim().length > 0 &&
        candidate.title.length <= 300 &&
        typeof candidate.quantity === "number" &&
        Number.isInteger(candidate.quantity) &&
        candidate.quantity > 0 &&
        candidate.quantity <= 100000
      );
    });
    return items.length === value.length ? items : null;
  } catch {
    return null;
  }
}

async function handleContact(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const name = field(form, "name", 120);
  const email = field(form, "email", 254);
  const company = field(form, "company", 160);
  const phone = field(form, "phone", 60);
  const message = field(form, "message", 10000);
  if (!name || !isEmail(email) || !message) {
    return textResponse(request, env, "Name, a valid email and message are required.", 400);
  }

  const turnstile = await verifyTurnstile(
    request,
    env,
    field(form, "cf-turnstile-response", 4096),
    "contact",
  );
  if (!turnstile.ok) return textResponse(request, env, turnstile.message, 400);

  await sendEmail(env, contactEmail(env, { name, email, company, phone, message }));
  return jsonResponse(request, env, { ok: true, notificationEmailSent: true });
}

async function handleQuote(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const name = field(form, "name", 120);
  const email = field(form, "email", 254);
  const company = field(form, "company", 160);
  const phone = field(form, "phone", 60);
  const notes = field(form, "notes", 10000);
  if (!name || !isEmail(email)) {
    return textResponse(request, env, "Name and a valid email are required.", 400);
  }
  if (!phone) {
    return textResponse(request, env, "Phone number is required.", 400);
  }

  const items = parseQuoteItems(String(form.get("items") ?? "[]"));
  if (!items) return textResponse(request, env, "Invalid or empty quote items.", 400);

  const turnstile = await verifyTurnstile(
    request,
    env,
    field(form, "cf-turnstile-response", 4096),
    "quote",
  );
  if (!turnstile.ok) return textResponse(request, env, turnstile.message, 400);

  const files = form
    .getAll("files")
    .filter((item): item is File => item instanceof File && item.size > 0);
  if (files.length > MAX_ATTACHMENTS) {
    return textResponse(request, env, `Please attach no more than ${MAX_ATTACHMENTS} files.`, 400);
  }
  const totalFileBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalFileBytes > MAX_ATTACHMENT_BYTES) {
    return textResponse(
      request,
      env,
      "Uploaded files are too large for email. Please keep combined artwork files under 28MB.",
      400,
    );
  }

  const attachments = await Promise.all(
    files.map(async (file): Promise<ResendAttachment> => ({
      filename: safeFilename(file.name),
      content: arrayBufferToBase64(await file.arrayBuffer()),
      content_type: file.type || "application/octet-stream",
    })),
  );
  await sendEmail(
    env,
    quoteEmail(env, { name, email, company, phone, notes, items, files, attachments }),
  );
  return jsonResponse(request, env, { ok: true, notificationEmailSent: true });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (request.method === "GET" && path === "/") {
    return jsonResponse(request, env, { ok: true, service: "morts-forms" });
  }
  if (!["/api/submit-contact", "/api/submit-quote"].includes(path)) {
    return textResponse(request, env, "Not found", 404);
  }
  if (request.method === "OPTIONS") {
    if (!isAllowedOrigin(request, env)) return textResponse(request, env, "Origin not allowed", 403);
    return response(request, env, null, { status: 204 });
  }
  if (request.method !== "POST") {
    return textResponse(request, env, "Method not allowed", 405);
  }
  if (!isAllowedOrigin(request, env)) {
    return textResponse(request, env, "Origin not allowed", 403);
  }
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return textResponse(request, env, "Request is too large.", 413);
  }

  try {
    return path === "/api/submit-contact"
      ? await handleContact(request, env)
      : await handleQuote(request, env);
  } catch (error) {
    console.error(JSON.stringify({
      event: "form_submission_failed",
      path,
      message: error instanceof Error ? error.message : "Unknown error",
    }));
    return textResponse(request, env, "Unable to submit the form right now. Please try again.", 500);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
