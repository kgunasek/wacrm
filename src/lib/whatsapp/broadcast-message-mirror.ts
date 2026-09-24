// ============================================================
// Mirror a sent broadcast template into `messages` / `conversations`.
//
// A broadcast send only ever wrote to `broadcast_recipients` — never
// to `messages`. That table is where the inbound webhook looks up the
// message a reaction or a reply targets (idx_messages_conversation_message_id,
// migration 037), so a customer reacting to (or replying to) a
// broadcast had nothing to attach to: the webhook logged "reaction
// target message not found" and silently dropped it. The conversation
// still got created (any inbound event opens one), so the symptom was
// an empty thread bearing the customer's name with no visible message
// — not stuck, just nothing to show, because nothing was ever kept.
//
// This is that missing write, factored out so the three send paths
// that deliver a broadcast — the public API (broadcast-core.ts), a
// resume pass (broadcast-resume.ts), and the dashboard wizard's
// per-batch endpoint (api/whatsapp/broadcast/route.ts) — call one
// function instead of three copies of the same insert.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findOrCreateConversationRow } from '@/lib/whatsapp/resolve-conversation';
import { templateContentText } from '@/lib/whatsapp/template-body';
import type { MessageTemplate } from '@/types';

export interface RecordBroadcastMessageParams {
  accountId: string;
  contactId: string;
  /** Audit user for a newly-created conversation row (NOT NULL FK). */
  ownerUserId: string;
  templateName: string;
  /** For rendering the substituted body; null renders a bare fallback. */
  templateRow: MessageTemplate | null;
  bodyParams: string[];
  /** Meta's wamid — what a later reaction/reply targets. */
  whatsappMessageId: string;
}

/**
 * Best-effort. Meta has already accepted the message by the time this
 * runs, so nothing here may throw back into a send loop and get a
 * successfully-delivered recipient stamped 'failed' over a DB hiccup —
 * every failure is caught and logged, never rethrown.
 */
export async function recordBroadcastMessage(
  db: SupabaseClient,
  params: RecordBroadcastMessageParams
): Promise<void> {
  try {
    const conversationId = await findOrCreateConversationRow(
      db,
      params.accountId,
      params.contactId,
      params.ownerUserId
    );

    const contentText =
      templateContentText(params.templateRow, params.bodyParams) ??
      `[template: ${params.templateName}]`;

    // Same upsert/ignoreDuplicates shape the inbound webhook uses
    // (migration 037's unique index) — belt-and-braces against the
    // same wamid being mirrored twice, e.g. a resend after a 429.
    const { error: msgError } = await db
      .from('messages')
      .upsert(
        {
          conversation_id: conversationId,
          sender_type: 'agent',
          content_type: 'template',
          content_text: contentText,
          template_name: params.templateName,
          message_id: params.whatsappMessageId,
          status: 'sent',
        },
        { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
      );

    if (msgError) {
      console.error('[broadcast-message-mirror] insert failed:', msgError.message);
      return;
    }

    await db
      .from('conversations')
      .update({
        last_message_text: contentText,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId);
  } catch (err) {
    console.error(
      '[broadcast-message-mirror] failed:',
      err instanceof Error ? err.message : err
    );
  }
}
