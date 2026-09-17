-- [UPI-SMOKE-1] One explicitly labelled production smoke-test event.
-- The HDFC route recognizes this id and applies a fee-exempt ₹1 quote only for
-- this row. It is not included in normal marketplace discovery by the attrs flag.
INSERT OR IGNORE INTO listings
  (id,creator_id,kind,title,description,category,price,currency_display,starts_at,duration_min,capacity,attrs,free_entry,status,created_at,updated_at)
VALUES
  ('avatok-upi-smoke-2026','user_3AuqQadIDHJftJtTkLD0DtKM8MB','live_event',
   'AvaTOK UPI ₹1 Smoke Test','Private payment-pipeline test event. No real event is scheduled.',
   'business',1,'INR',4102444800000,60,1,
   '{"upi_smoke_test":true,"hide_from_marketplace":true}',0,'published',strftime('%s','now')*1000,strftime('%s','now')*1000);
