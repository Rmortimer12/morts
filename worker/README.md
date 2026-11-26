# Morts forms worker

Cloudflare backend for Shopify contact and quote submissions, including server-side Turnstile verification and email delivery through Resend.

## GitHub deployment settings

- Production branch: `main`
- Root directory: `worker`
- Worker name: `morts`
- Build command: `npm run check`
- Deploy command: `npm run deploy`

## Runtime configuration

Add these as **Secrets** under the worker Settings > Variables and Secrets:

- `RESEND_API_KEY`: a Resend sending key authorized for the sender domain.
- `TURNSTILE_SECRET_KEY`: secret matching the storefront Turnstile site key.
- `RESEND_FROM_EMAIL`: verified sender in `Display Name <address>` format.
- `QUOTE_EMAIL_TO`: comma-separated quote notification recipients.
- `QUOTE_EMAIL_CC`: comma-separated quote copy recipients.
- `CONTACT_EMAIL_TO`: comma-separated contact notification recipients.

Runtime secrets are separate from build environment variables. Never commit actual values. The allowed origins and Turnstile hostnames are in `wrangler.jsonc`; the Turnstile widget must allow the same storefront hosts. Shopify's `forms_api_url` must point to the deployed worker.

## Development

```sh
cd worker
npm ci
cp .dev.vars.example .dev.vars
npm run check
npm run dev
```

`GET /` is the health endpoint. The form routes are `POST /api/submit-contact/` and `POST /api/submit-quote/`. Successful deployment and health checks do not prove email delivery. Complete a clearly labelled storefront test after adding the runtime secrets.
