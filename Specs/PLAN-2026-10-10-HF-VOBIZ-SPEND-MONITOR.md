# PLAN — Vobiz spend monitor + PDF proof report (HF-VOBIZ-SPEND-1)

Status: **BUILT 2026-10-10 (HF-VOBIZ-SPEND-1). Build contract: Specs/HF-VOBIZ-SPEND-CONTRACT.md.**
Date: 2026-10-10. Owner: Davy.

## Why

Last time Vobiz suspended the account, kept the balance and wiped the data, and we had no record of what was spent.
From now on **we keep our own copy of every rupee Vobiz takes**, check it every minute, and send copies outside
Vobiz and outside our own servers (to the owner's Gmail) every day. If Vobiz ever disputes or deletes anything,
we still have the proof.

## What I found (research)

**How a Hello Fraands call uses Vobiz today** (`worker/src/do/hf_call.ts`)
- Every call is **two Vobiz calls ("legs")** made from our one number (`HF_CALL_DID`):
  1. we ring the **host** (host leg), 2. when the host presses a key, we ring the **caller** (caller leg),
  then both are joined in a conference.
- Vobiz charges **both legs**. So one 5-minute call = about 10 billed minutes on Vobiz, plus any ringing that Vobiz bills.
- "Incoming" today = nobody calls in; all HF legs are outgoing from our number. If anyone dials our number,
  that is an incoming leg and it is charged too — the monitor will catch those as well.

**What we record today**
- We record **what we charge the user** (`hf_calls`: minutes, charged, host share).
- We record **nothing about what Vobiz charges us.** The hangup webhook ignores the fields Vobiz sends.
  This is the gap.

**What Vobiz lets us read** (docs at vobiz.ai/docs)
- `GET /Account/{id}/balance/INR` → `balance`, `reserved_funds`, `available_balance`, `promotional_balance`,
  `credit_limit`, `status`.
- `GET /Account/{id}/cdr` (list, filters by date / direction / number, 100 per page), `/cdr/{call_id}` (one call),
  `/cdr/recent` (latest), `/cdr/export` (their own CSV).
  Each CDR has `uuid`, `call_direction`, `caller_id_number`, `destination_number`, `start_time`, `answer_time`,
  `end_time`, `duration`, `billsec` (billed seconds), **`cost`**, `streaming_cost`, **`total_cost`**, `currency`,
  `hangup_cause`, quality (`mos`, `jitter`, `packet_loss`).
- Account object → `is_active`, `enabled`, `risk_status` (an early warning before a suspension).
- **Vobiz has no API for recharges, invoices or number rental charges.** We will catch those from balance
  changes and the owner types in each recharge (amount + UTR).

## What we will build

### 1. Our own spend ledger (every leg, every rupee)
New table `hf_vobiz_legs` — one row per Vobiz leg:
call id, role (host/caller/unknown), the user it was for (uid), direction, start / answer / end time,
duration, billed seconds, Vobiz cost, total cost, currency, hangup cause, quality, and Vobiz's raw record.
- Saved the moment the hangup webhook arrives (what Vobiz told us live), then **checked again against Vobiz's
  CDR 2 minutes later** (retries for 24 h). If the two disagree, it is flagged.
- **Append-only and tamper-evident**: rows are never edited or deleted; each row carries a hash of itself plus
  the previous row (a chain). If anyone changes an old row, the chain breaks and the report says so.

### 2. Live watcher (every minute)
- Every minute: read the Vobiz balance and save a snapshot (`hf_vobiz_balance`), and pull `cdr/recent`.
- Any Vobiz call that **does not belong to one of our calls** is saved as "unknown traffic" and alerted.
- **Money check**: balance drop in each window vs the CDR costs in that window. Any difference = "unexplained
  charge" (rental, hidden fees, or theft) — shown as a warning and alerted.

### 3. Alerts (WhatsApp + email to the owner)
- Unexplained charge above ₹ X.
- Balance below ₹ Y.
- A Vobiz call we did not make.
- Cost per minute higher than the agreed rate.
- Vobiz account not active / risk flag / API keys stop working (**suspension warning**). Alerts only — calls are not paused
  automatically (owner decision).

### 4. Admin page — `/admin/hosts/phone-costs` ("Phone costs")
Same Admin2 look as the other admin pages, full width, Nunito / Comfortaa, no small fonts, no green.
- Top: live Vobiz balance, spent today, spent this month, unexplained charges, what users paid vs what Vobiz took.
- Live feed of legs (updates every 15 s).
- **Per user**: calls, minutes, Vobiz cost of their legs (as caller and as host), what they paid, difference.
- Click a call → both legs side by side, our record vs Vobiz's record.
- Balance chart over time with recharges marked.
- Recharge log: owner adds amount, date, UTR / invoice number.
- Alerts list.
- **Download PDF** (pick dates, optionally one user) and **Download CSV**.

### 5. PDF report (the proof)
Made on our server, stamped with time and a fingerprint (hash) printed on every page:
1. Summary: opening balance + recharges − Vobiz call charges − other charges = closing balance; unexplained total.
2. Day-by-day table.
3. Per-user table.
4. Every leg: time, direction, full from / to numbers, billed seconds, Vobiz cost, Vobiz call ID.
5. Balance snapshots and every unexplained change.
6. Ledger check result ("chain intact" or where it broke).

### 6. Copies outside Vobiz and outside our servers
- **Every night 23:55 IST**: email the day's PDF + CSV + **Vobiz's own CSV export** (their document, untouched)
  to hdavy2005@gmail.com. Monthly statement on the 1st.
- So even if Vobiz wipes the account **and** our database is lost, the Gmail copies remain.

## Phases (each one checked by me before the next)

| Phase | What | Result |
|---|---|---|
| P1 | Ledger tables + save hangup fields + CDR check after each call | every leg recorded |
| P2 | Every-minute watcher, balance snapshots, unknown traffic, money check, alerts | live monitoring |
| P3 | Admin "Phone costs" page | see it live |
| P4 | PDF + CSV download, nightly and monthly email | proof outside Vobiz |
| P5 | First test call with admin credits: confirm the real Vobiz field names (marked VERIFY) | done |

Calls are still dark (`hfCallsEnabled` off) — the monitor will be on from the first test call.

## Owner decisions (2026-10-10)

1. **Keep spend records 8 years.** `hf_vobiz_legs`, `hf_vobiz_balance`, recharges and alerts are left out of the
   1-year purge (HF-PRIV-6).
2. **Full phone numbers** are kept in the ledger, the admin page and the PDF (admin-only). Admin views and
   downloads are audited. The nightly PDF emailed to Gmail also carries full numbers, so that inbox must stay secure.
3. **Alerts only, no auto-pause.** Calls keep running; the owner decides.
4. **Alert levels:** unexplained charge above **₹20**, low balance below **₹500**. WhatsApp + email to the owner.

## About the old account

We cannot recover data Vobiz deleted. You can still ask Vobiz **in writing (email)** for a full statement,
all recharge receipts and GST invoices for the old account — keep that email as a record of the request.
