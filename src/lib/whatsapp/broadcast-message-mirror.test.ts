import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { recordBroadcastMessage } from './broadcast-message-mirror';

// findOrCreateConversationRow is exercised by its own tests
// (resolve-conversation.test.ts) — stub it here so this file only
// asserts what recordBroadcastMessage itself does with the result.
const findOrCreateConversationRow = vi.fn(async () => 'conv-1');
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  findOrCreateConversationRow: (...args: unknown[]) =>
    (findOrCreateConversationRow as unknown as (...a: unknown[]) => unknown)(
      ...args,
    ),
}));

interface Captured {
  message?: Record<string, unknown>;
  messageOpts?: Record<string, unknown>;
  conversationUpdate?: Record<string, unknown>;
}

function mirrorDb(captured: Captured, messageError: unknown = null): SupabaseClient {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {
        upsert: (row: Record<string, unknown>, opts: Record<string, unknown>) => {
          if (table === 'messages') {
            captured.message = row;
            captured.messageOpts = opts;
          }
          return { then: (r: (v: { error: unknown }) => unknown) => r({ error: messageError }) };
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations') captured.conversationUpdate = row;
          return b;
        },
        eq: () => ({ then: (r: (v: { error: null }) => unknown) => r({ error: null }) }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const BASE_PARAMS = {
  accountId: 'acct-1',
  contactId: 'contact-1',
  ownerUserId: 'owner-1',
  templateName: 'pending_ekyc_customers',
  templateRow: {
    body_text: 'Dear {{1}}, your consumer no. is {{2}}.',
  } as never,
  bodyParams: ['SATHIS B', '604319'],
  whatsappMessageId: 'wamid.abc123',
};

describe('recordBroadcastMessage', () => {
  it('writes the substituted body keyed by the wamid, so a later reaction can find it', async () => {
    const captured: Captured = {};
    await recordBroadcastMessage(mirrorDb(captured), BASE_PARAMS);

    expect(findOrCreateConversationRow).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'contact-1',
      'owner-1',
    );
    expect(captured.message).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'agent',
      content_type: 'template',
      content_text: 'Dear SATHIS B, your consumer no. is 604319.',
      template_name: 'pending_ekyc_customers',
      message_id: 'wamid.abc123',
      status: 'sent',
    });
    // Same idempotency shape the inbound webhook uses (migration 037) —
    // a resend of the same wamid must not create a second row.
    expect(captured.messageOpts).toEqual({
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    });
    expect(captured.conversationUpdate?.last_message_text).toBe(
      'Dear SATHIS B, your consumer no. is 604319.',
    );
  });

  it('falls back to a bracketed label when there is no local template row', async () => {
    const captured: Captured = {};
    await recordBroadcastMessage(mirrorDb(captured), {
      ...BASE_PARAMS,
      templateRow: null,
    });

    expect(captured.message?.content_text).toBe(
      '[template: pending_ekyc_customers]',
    );
  });

  it('never throws when the insert fails — a DB hiccup must not undo a send Meta already accepted', async () => {
    const captured: Captured = {};
    await expect(
      recordBroadcastMessage(
        mirrorDb(captured, { message: 'constraint violation' }),
        BASE_PARAMS,
      ),
    ).resolves.toBeUndefined();
  });

  it('never throws when conversation resolution itself fails', async () => {
    findOrCreateConversationRow.mockRejectedValueOnce(new Error('db down'));
    await expect(
      recordBroadcastMessage(mirrorDb({}), BASE_PARAMS),
    ).resolves.toBeUndefined();
  });
});
