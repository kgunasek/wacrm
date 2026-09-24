-- ============================================================
-- 043_message_sender_attribution
--
-- Outbound messages record WHAT was said but not WHO said it. The
-- insert in `sendMessageToConversation` writes `sender_type = 'agent'`
-- and stops there, so once several people share an account — office
-- staff at a desk, deliverymen on their phones, all answering the same
-- customer thread through one WhatsApp number — the history is a wall
-- of identical bubbles with no way to tell them apart.
--
-- `messages.sender_id UUID` has existed since migration 001 but was
-- never wired up: no foreign key, no index, and nothing on the send
-- path ever wrote to it. This migration promotes that dormant column
-- into the real attribution trail.
--
-- The contract, deliberately narrow:
--
--   sender_id IS NOT NULL  <=>  a human pressed send in the dashboard.
--
-- Everything else stays NULL — inbound customer messages, bot/flow/AI
-- sends, and public-API sends. The bot case matters most: those paths
-- do have a user id in scope, but it belongs to whoever AUTHORED the
-- automation, not to a person who typed the message. Writing it would
-- make the inbox claim a human sent something no human ever saw.
-- API-key sends are left NULL too; attributing an integration is a
-- different question and wants its own `api_key_id`, not an overloaded
-- column meaning two things.
--
-- No CHECK constraint ties sender_id to sender_type. `sender_type =
-- 'agent'` legitimately covers both the new attributed rows and the
-- NULL ones (every message predating this migration, plus every
-- API-key send after it), so a constraint would reject valid history.
--
-- No backfill is possible. The identity of whoever sent an existing
-- message was never recorded anywhere; those rows stay NULL forever
-- and the inbox simply renders no name for them.
-- ============================================================

-- Clear any sender_id that does not resolve to a live user before the
-- foreign key is validated. One older code path (the automations
-- sender) wrote this column, so a value may point at a since-deleted
-- account; left in place it would fail the VALIDATE below and take the
-- whole migration with it.
UPDATE messages m
SET sender_id = NULL
WHERE m.sender_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = m.sender_id
  );

-- ON DELETE SET NULL matches conversations.user_id / assigned_agent_id:
-- removing a teammate must not cascade away the messages they sent, and
-- the thread stays readable with the name simply absent.
--
-- NOT VALID first, VALIDATE second: the ADD takes a brief lock without
-- scanning the table, and the separate VALIDATE scans under a weaker
-- lock that does not block concurrent inserts from the webhook.
ALTER TABLE messages
  ADD CONSTRAINT messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE SET NULL
  NOT VALID;

ALTER TABLE messages VALIDATE CONSTRAINT messages_sender_id_fkey;

-- Partial: inbound and bot rows are the large majority and all NULL, so
-- excluding them keeps this index small. Ordered by created_at DESC to
-- serve the query this exists for — "what did this person send, most
-- recent first" — without a sort.
CREATE INDEX IF NOT EXISTS idx_messages_sender
  ON messages(sender_id, created_at DESC)
  WHERE sender_id IS NOT NULL;

COMMENT ON COLUMN messages.sender_id IS
  'auth.users id of the team member who sent this message from the dashboard. '
  'NULL for inbound customer messages, bot/flow/AI sends, public-API sends, and '
  'any message predating migration 043. Set only on the human send path; see '
  'sendMessageToConversation in src/lib/whatsapp/send-message.ts.';
