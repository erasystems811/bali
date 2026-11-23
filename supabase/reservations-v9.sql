-- v9 (2026-11-23): reservation numbers run R-001, R-002, ... Idempotent.
create sequence if not exists reservation_ref_seq start 1 minvalue 1;
grant usage, select on sequence reservation_ref_seq to bali_service;
