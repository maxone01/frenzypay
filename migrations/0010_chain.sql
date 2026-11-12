-- On-chain public records (server/chain.ts). D1 stays the source the app reads; these columns track what was
-- written to the FrenzyPay NEAR contract for each record, so a failed or pending write can be shown and retried.
--   chain_status:  NULL (nothing attempted), 'pending' (submitted, outcome unknown), 'confirmed', 'failed'.
--   chain_tx:      hash of the latest relayer transaction for this record.
--   chain_error:   why the latest write failed (shown to the owner).
--   chain_synced:  what the contract is known to hold: invoices 'issued'|'cancelled'|'paid';
--                  bills 'scheduled:<payload sha256>'|'cancelled'|'paid'; payees 'saved:<payload sha256>';
--                  payroll batches 'created'; payroll lines 'paid'.
--   chain_at:      when chain_status last changed (a write still pending long after this is treated as lost).
--   chain_payload: the call in flight ({method, args, onConfirm}), kept after a transport failure so an
--                  owner-signed write can be retried without signing again. Never holds the client email.
ALTER TABLE invoices ADD COLUMN chain_status TEXT CHECK (chain_status IN ('pending','confirmed','failed'));
ALTER TABLE invoices ADD COLUMN chain_tx TEXT;
ALTER TABLE invoices ADD COLUMN chain_error TEXT;
ALTER TABLE invoices ADD COLUMN chain_synced TEXT;
ALTER TABLE invoices ADD COLUMN chain_at TEXT;
ALTER TABLE invoices ADD COLUMN chain_payload TEXT;

ALTER TABLE bills ADD COLUMN chain_status TEXT CHECK (chain_status IN ('pending','confirmed','failed'));
ALTER TABLE bills ADD COLUMN chain_tx TEXT;
ALTER TABLE bills ADD COLUMN chain_error TEXT;
ALTER TABLE bills ADD COLUMN chain_synced TEXT;
ALTER TABLE bills ADD COLUMN chain_at TEXT;
ALTER TABLE bills ADD COLUMN chain_payload TEXT;

ALTER TABLE payees ADD COLUMN chain_status TEXT CHECK (chain_status IN ('pending','confirmed','failed'));
ALTER TABLE payees ADD COLUMN chain_tx TEXT;
ALTER TABLE payees ADD COLUMN chain_error TEXT;
ALTER TABLE payees ADD COLUMN chain_synced TEXT;
ALTER TABLE payees ADD COLUMN chain_at TEXT;
ALTER TABLE payees ADD COLUMN chain_payload TEXT;

ALTER TABLE payroll_batches ADD COLUMN chain_status TEXT CHECK (chain_status IN ('pending','confirmed','failed'));
ALTER TABLE payroll_batches ADD COLUMN chain_tx TEXT;
ALTER TABLE payroll_batches ADD COLUMN chain_error TEXT;
ALTER TABLE payroll_batches ADD COLUMN chain_synced TEXT;
ALTER TABLE payroll_batches ADD COLUMN chain_at TEXT;
ALTER TABLE payroll_batches ADD COLUMN chain_payload TEXT;

-- Lines only carry the relayer's mark_payroll_line_paid (no owner signature, rebuilt from the line), so no chain_payload.
ALTER TABLE payroll_lines ADD COLUMN chain_status TEXT CHECK (chain_status IN ('pending','confirmed','failed'));
ALTER TABLE payroll_lines ADD COLUMN chain_tx TEXT;
ALTER TABLE payroll_lines ADD COLUMN chain_error TEXT;
ALTER TABLE payroll_lines ADD COLUMN chain_synced TEXT;
ALTER TABLE payroll_lines ADD COLUMN chain_at TEXT;
