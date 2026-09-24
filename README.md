# otm-whatsapp-group-bot-service

An **unofficial** WhatsApp client (using [Baileys](https://github.com/WhiskeySockets/Baileys),
which automates the WhatsApp Web protocol) that exists for exactly one
reason: **Meta's official WhatsApp Business Platform Cloud API — the API
`otm_whatsapp_coexistence` and `otm_whatsapp_broadcast` use — has no way to
send a message into a WhatsApp Group.** There is no official/BSP-supported
way to do this at all, on any provider. This is the only route that exists.

## Read this before deploying

- **This violates WhatsApp's Terms of Service.** WhatsApp actively detects
  and bans numbers running automated/unofficial clients. It works for many
  people in practice, but there is no guarantee, and Meta can change
  detection at any time without notice.
- **Never use your Coexistence/Cloud-API number here.** Use a completely
  separate, disposable number, ideally not your main business line. If this
  number gets banned, it does not affect `otm_whatsapp_coexistence` or your
  real customer-facing WhatsApp at all — that's the whole point of keeping
  this as a separate service instead of bolting it onto the existing
  integration.
- This service is **not affiliated with or endorsed by WhatsApp/Meta**.
- Keep `auth_info/` (the paired session) private and backed up — anyone
  with those files can send/receive as that WhatsApp number. It's in
  `.gitignore` for that reason; don't commit it.

## What it does

A small always-on Node.js process that:
1. Pairs with a WhatsApp account via QR code (scan once from the phone's
   WhatsApp app → Linked Devices).
2. Stays connected, auto-reconnecting on transient drops.
3. Exposes a tiny private HTTP API for Odoo to call:
   - `GET /status` → `{"state": "connected"|"qr_pending"|"disconnected", "connected": bool, "phone_number": "...", "last_error": "..."}`
   - `GET /qr` → `{"qr": "data:image/png;base64,..." | null}` — the current pairing QR code, so Odoo can display it in the `otm.whatsapp.group.bot` form instead of you needing terminal access.
   - `POST /send` → `{"group_id": "120363xxxxxxxxxx@g.us", "message": "text", "media": {"base64": "...", "mimeType": "image/jpeg", "fileName": "photo.jpg", "mediaType": "image"} }` (media optional) → `{"success": true, "message_id": "..."}` or `{"success": false, "error": "...", "code": "..."}`

Every request needs `Authorization: Bearer <API_TOKEN>` (your own secret,
set in `.env`) — this service should never be exposed to the public
internet; keep it reachable only from your Odoo server (same host, or a
firewalled internal network / VPN).

## Deploy on your server

```
git clone <wherever you push this> otm_whatsapp_group_bot_service
cd otm_whatsapp_group_bot_service
npm install
cp .env.example .env
# edit .env: set API_TOKEN to a real secret (openssl rand -hex 32), and
# a PORT that doesn't collide with anything else on the server
node src/index.js
```

First run prints a QR code to the terminal (and it's also available via
`GET /qr` once the HTTP server is up). Open WhatsApp on the **dedicated**
phone/number → **Settings → Linked Devices → Link a Device** → scan it.
Once connected, `GET /status` reports `"connected": true` and the session
persists in `auth_info/` across restarts — you won't need to re-scan unless
you explicitly log out from the phone or the session is invalidated.

For a permanent deployment, use the included `otm-whatsapp-group-bot.service`
systemd unit (edit the paths/user first) so it survives reboots and restarts
automatically on crash.

## Group ID format

WhatsApp group JIDs look like `120363xxxxxxxxxxxx@g.us` — this is what goes
into Odoo's `otm.whatsapp.group.group_id` field, not the group's display
name. The easiest way to get a group's JID: add this bot's number to the
group, then check this service's logs (Baileys logs the JID of any group
message it sees) — or use any Baileys "list groups" script once connected.

## Limits this service does not try to work around

- WhatsApp's own media size caps apply (roughly 16MB video, 5MB image,
  100MB document — exact limits are WhatsApp's, not this service's).
- No guaranteed delivery/retry inside this service — that's handled on the
  Odoo side by `otm_whatsapp_group_scheduler`'s own retry mechanism; this
  service just reports success/failure per call.
- One WhatsApp account = one socket = one number. To send from multiple
  group-bot numbers, run multiple instances of this service on different
  ports with different `AUTH_STATE_DIR`/`.env` files.
