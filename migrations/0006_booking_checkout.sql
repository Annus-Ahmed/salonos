ALTER TABLE settings ADD COLUMN bank_qr_url text;
ALTER TABLE services ADD COLUMN details jsonb;
ALTER TABLE bookings ADD COLUMN initial_payment_method text, ADD COLUMN confirmation_sms text;
ALTER TABLE booking_items ADD COLUMN detail_id uuid, ADD COLUMN detail_name text;
