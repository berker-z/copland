-- ============================================================================
-- Device login: a box connects without anyone copying tokens (COPL-47).
-- ----------------------------------------------------------------------------
-- The box (the daemon's window, daemon/) asks for a code with no credentials
-- (POST /api/device/start) and shows it. A signed-in person opens
-- /device?code=…, checks it is the code their box shows, ticks which of
-- their agents the box may run, and approves. That mints ordinary personal
-- tokens (api_tokens, the same rows settings makes, revocable there): a
-- read-only one for the person and a read-and-write one per agent. Their
-- secrets wait here, sealed under VAULT_KEY, until the box polls with its
-- device code (POST /api/device/poll), which gets them exactly once.
--
-- Only hashes of the device code are kept, like every other secret. The user
-- code is short and shown on a screen; it is the link between the two sides,
-- not a credential: approving still needs the person's session.
--
-- status: pending → approved → delivered, or denied, or expired (ten
-- minutes). A request approved but never picked up before it expires has
-- its tokens revoked (routes/device.ts); its tokens also carry the request's
-- expiry until delivery, so they are dead by then whatever happens.
-- ============================================================================

CREATE TABLE device_requests (
  id             TEXT PRIMARY KEY,
  device_hash    TEXT NOT NULL UNIQUE,              -- sha-256 hex of the device code
  user_code      TEXT NOT NULL UNIQUE,              -- "ABCD-EFGH"
  -- What the box said it is and where it runs, shown on the approval page.
  client         TEXT NOT NULL,
  host           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'denied', 'delivered', 'expired')),
  -- The person who approved or denied it.
  user_id        TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at     TEXT NOT NULL,
  approved_at    TEXT,
  -- The minted secrets, sealed (JSON of {iv, ciphertext}); null once delivered.
  payload_cipher TEXT,
  -- The tokens approval minted (JSON array of api_tokens ids), so an expired,
  -- unclaimed approval can revoke them without opening the payload.
  token_ids      TEXT,
  -- Rate limiting: who asked (sha-256 of the IP) and when the box last polled.
  ip_hash        TEXT,
  last_polled_at TEXT
);
CREATE INDEX device_requests_ip ON device_requests(ip_hash, created_at);
CREATE INDEX device_requests_status ON device_requests(status, expires_at);
