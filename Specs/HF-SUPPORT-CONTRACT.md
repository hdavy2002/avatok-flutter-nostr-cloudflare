# HF-SUPPORT contract (v1, 29 Oct 2026). Shared by the worker, Flutter and web agents

Owner-approved plan: Projects doc `claude/hello-fraands-support-ticketing-plan.md` (v5). A summary of what matters is below.
Approved screen designs (static HTML mockups, the look to copy): Main (app Terms page), AppSupport, AppTicket, WebSignIn, WebCustomerInbox, AdminInbox, AdminTicket, AdminQueues, AdminSignature.

## Rules (owner decisions)
- Every email to support@hellofraands.com, every app/web Contact Support form, and every support-site "New ticket" becomes a ticket. Ticket numbers are `HF-` + a running integer starting at 10001, never reused.
- Threading: outgoing subject `[HF-10234] <subject>`, Reply-To `support+10234@hellofraands.com`, plus Message-ID / In-Reply-To / References. A reply to a Solved ticket within 7 days reopens it. A reply to a Closed ticket opens a new ticket linked to the old one.
- Statuses: `new`, `open`, `waiting` (waiting on customer), `on_hold`, `solved`, `closed`, `spam`, `trash`. A customer reply on `waiting` → `open`. After 5 days `waiting`, one reminder; 7 more days → `solved`. 7 days `solved` → `closed`.
- Customer-facing status labels: new/open/on_hold → "Open"; waiting → "We replied"; solved → "Solved"; closed → "Closed".
- Auto-acknowledgement email + in-app note: "Your ticket HF-10234 is open. Someone from Hello Fraands will respond back soon." Outside business hours (Mon–Sat 10:00–19:00 IST) add "Our team works 10 am–7 pm IST, Monday to Saturday. We'll reply within 24 hours."
- No auto-reply to no-reply addresses, lists, bounces or auto-replies (Auto-Submitted / Precedence / List-Id headers), and at most 3 auto-replies per sender per hour. Spam gets no auto-reply and no alert.
- Limits: 5 new tickets per person per day. Identical text from the same person within 10 min is merged.
- Attachments: images, PDFs and screenshots, ≤10 MB each, ≤25 MB per message. Refuse .exe, .apk, .bat, .js, .scr and zips. Store in R2 (BACKUP_R2, prefix `support/`).
- **Queues carry IDs, never content** (`safeQueueSend` in `worker/src/lib/queue_guard.ts`, 16 KB cap). Email goes through `enqueueEmail` (`worker/src/lib/email_outbox.ts`, lanes priority/bulk). WhatsApp goes through `enqueueWhatsApp` (`worker/src/lib/whatsapp_queue.ts`).
- Admin WhatsApp alerts go to the number stored in `support_settings` key `alert_whatsapp` (seed `+917817058560`): every new ticket and every customer reply. Above 10 tickets/min, switch to one summary per minute. Urgent tickets always alert individually.
- Customer WhatsApp nudge "Hello Fraands support replied to HF-10234. Open the app to read." at most once per ticket per 30 min, with no message content.
- Business hours / SLA: first reply 24 h, Urgent 2 h, counted in business hours only.
- Retention: 3 years normally, 8 years for money categories (`wallet`, `withdraw`, `refund`, `calls`). A nightly job deletes rows + R2 objects. When an account is deleted, its tickets are anonymised (money tickets are still kept 8 years).
- Admin: role via `support_staff` table (uid, email, role admin|agent|viewer). Seed the owner's account `hdavy2002@gmail.com` as admin, and also accept existing `isAdminUid` admins as admin.
- Brand name/domain/emails come from the central brand config (`worker/src/lib/brand.ts`); never hard-code "hellofraands.com".

## Categories (slug → label)
`calls` Calls · `wallet` Wallet & top-ups · `withdraw` Withdraw to UPI · `bookings` Bookings · `influencer` Influencer account · `app` App problem · `report` Report someone · `other` Other.
Default priority: `report` → urgent; `wallet`, `withdraw` → high; everything else → normal.

## Customer API (requireUser; existing worker auth)
- `GET  /api/hf/support/tickets?status=open|solved|closed|all` → `{ok, tickets:[{number:"HF-10234", subject, category, status, statusLabel, preview, updatedAt, unread}]}`
- `POST /api/hf/support/tickets` body `{category, subject, message, attachmentIds?:[], meta?:{appVersion, build, device, os, lastScreen, platform}}` → `{ok, ticket:{number,...}}`
- `GET  /api/hf/support/tickets/:number` → `{ok, ticket:{number, subject, category, status, statusLabel, createdAt, updatedAt, canReopen}, messages:[{id, author:"customer"|"support"|"system", authorName, text, html?, createdAt, attachments:[{id,name,size,contentType}]}]}` (internal notes are NEVER returned). Marks the ticket read.
- `POST /api/hf/support/tickets/:number/reply` `{message, attachmentIds?}` → `{ok}`
- `POST /api/hf/support/tickets/:number/solve` → `{ok}`; `POST .../reopen` → `{ok}` (within 7 days of solved)
- `POST /api/hf/support/attachments` raw body, headers `content-type` and `x-file-name` (percent-encoded UTF-8, because headers can't carry non-ASCII) → `{ok, id, name, size}`
- `GET  /api/hf/support/attachments/:id` → the file stream (owner of the ticket, or staff)
- Error shape follows the existing worker convention (`{ok:false, error:"code"}`).

## Admin API (support_staff role or isAdminUid; viewer = read only)
- `GET /api/admin/hf/support/tickets?folder=unassigned|mine|open|waiting|on_hold|solved|closed|spam|trash&q=&category=&priority=&channel=&assignee=&cursor=` → rows with number, customer {name, role fan|influencer|unverified, uid?}, subject, preview, category, priority, assignee, sla {dueAt, state ok|amber|red}, updatedAt, unread; plus folder counts
- `GET /api/admin/hf/support/tickets/:number` → ticket + all messages incl. internal notes + events + customer panel {uid, name, handle, role, verified, whatsappMasked, email, joinedAt, walletRupees, pendingWithdrawRupees, calls30d, strikes, recentMoney:[...], otherTickets:[...]} + viewers (collision)
- `POST .../:number/reply` `{html, text, attachmentIds?, setStatus?}` (sends email + in-app; signature appended server-side; returns outbox delivery state)
- `POST .../:number/note` `{text}`
- `PATCH .../:number` `{status?, priority?, category?, assigneeUid?, snoozeUntil?}`
- `POST .../:number/merge` `{into}` · `POST .../:number/split` `{messageId}` · `POST .../:number/spam` · `POST /api/admin/hf/support/block` `{email?|domain?}`
- `POST /api/admin/hf/support/bulk` `{numbers:[], action, value?}`
- `POST .../:number/viewing` (heartbeat for the collision warning, 30 s TTL)
- Canned replies: `GET/POST/PUT/DELETE /api/admin/hf/support/canned[/:id]`
- Signature: `GET/PUT /api/admin/hf/support/signature?scope=team|me` `{html, useFor:"team"|"personal"}`; logo upload uses the attachments endpoint with `purpose=signature` (public URL); `POST /api/admin/hf/support/signature/test` sends a test email to the caller
- Settings: `GET/PUT /api/admin/hf/support/settings` (alert_whatsapp, business hours, holidays, whatsapp_min_interval_ms)
- Team: `GET/POST/DELETE /api/admin/hf/support/staff`
- Queues: `GET /api/admin/hf/support/queues` (per queue: waiting, done/min, failed 24h, oldest, from the outbox tables and the Cloudflare queue metrics if reachable), `GET .../failed`, `POST .../failed/:id/retry|discard`, `GET/DELETE .../suppressions`
- Reports: `GET /api/admin/hf/support/reports?range=7d`

## Inbound email
- Cloudflare Email Routing → the worker `email()` handler: stream the raw message to R2 `support/inbound/YYYY/MM/DD/<uuid>.eml`, `safeQueueSend` `{job:'inbound', r2Key}` to queue `support-inbound` (+ `support-inbound-dlq`), done. The ticket number comes from the `support+<n>@` recipient, else from `[HF-n]` in the subject, else from In-Reply-To matching a stored Message-ID.
- Unknown sender: create the ticket under a `support_contacts` row (email only, `uid` NULL). Auto-reply invites them to verify at support.<domain>. Once they verify (email OTP + WhatsApp OTP → normal fan account), all their earlier tickets attach to the account.

## Support site
- Host `support.<brand domain>`, signed in by email OTP (existing account system). Guest path: email OTP + WhatsApp OTP → creates a fan account. Customers see only their own tickets; staff see the admin desk.
