-- [HF-STD-PLAN-1] Standard calling plan + rupee wallet. ALTER ... ADD COLUMN only (apply with scripts/d1_apply_alters.py; safe to re-run).
-- hf_calls.pricing_snapshot: JSON {plan:"std", tariff:{tiers:[{fromSec,paisePerMin}]}, hostPaisePerMin, phoneCostPaisePerMin} frozen at call start.
ALTER TABLE hf_calls ADD COLUMN pricing_snapshot TEXT;
-- hf_token_lots.gst_paise: GST included in a GST-inclusive top-up (paid_paise = wallet credit + gst_paise). 0 for test / older lots.
ALTER TABLE hf_token_lots ADD COLUMN gst_paise INTEGER NOT NULL DEFAULT 0;
-- hf_token_lots.source_lot_id: a migration lot points at the lot it replaced (traceability, never a relabel).
ALTER TABLE hf_token_lots ADD COLUMN source_lot_id TEXT;
-- hf_token_products.list_price_paise: catalogue price of the Play pack (GST included), only used when Play reports no INR price.
ALTER TABLE hf_token_products ADD COLUMN list_price_paise INTEGER;
-- hf_play_purchases.pricing_snapshot: immutable product semantics selected by prepare; retries and RTDN never reinterpret a purchase after a flag flip.
ALTER TABLE hf_play_purchases ADD COLUMN pricing_snapshot TEXT;
-- hf_calls.phone_cost_actual_paise: actual Vobiz cost of both legs when known (HF-PAY-18 ledger), kept apart from the estimate.
ALTER TABLE hf_calls ADD COLUMN phone_cost_actual_paise INTEGER;
