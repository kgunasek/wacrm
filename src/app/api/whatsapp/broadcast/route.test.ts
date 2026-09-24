import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Every recipient the dashboard wizard's batch-send loop posts here carries
// a contact_id (use-broadcast-sending.ts reads it straight off the
// broadcast_recipients row). This test is the direct check on the fix for
// the empty-conversation bug: a successful send must mirror into
// `messages` so a later reaction/reply has something to attach to, and a
// recipient with no contact_id (an older/legacy caller) must still send —
// it just can't mirror.
// ---------------------------------------------------------------------------

const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.sent' }));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
}));

vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: vi.fn(async () => ({
    malformed: false,
    row: { body_text: 'Hello {{1}}' },
    language: 'en_US',
  })),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { broadcast: {} },
}));

const recordBroadcastMessage = vi.fn(async () => {});
vi.mock('@/lib/whatsapp/broadcast-message-mirror', () => ({
  recordBroadcastMessage: (...args: unknown[]) =>
    (recordBroadcastMessage as unknown as (...a: unknown[]) => unknown)(
      ...args,
    ),
}));

const CONFIG = {
  id: 'cfg-1',
  account_id: 'acct-1',
  user_id: 'owner-1',
  phone_number_id: 'PNID-1',
  access_token: 'enc-token',
};

function supabaseMock() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: CONFIG, error: null }),
        }),
      }),
    }),
  };
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({
    supabase: supabaseMock(),
    accountId: 'acct-1',
    userId: 'user-1',
  })),
  toErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 500 }),
}));

import { POST } from './route';

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/whatsapp/broadcast', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/whatsapp/broadcast — message mirroring', () => {
  beforeEach(() => {
    sendTemplateMessage.mockClear();
    recordBroadcastMessage.mockClear();
  });

  it('mirrors a successful send when the recipient carries a contact_id', async () => {
    const res = await POST(
      makeRequest({
        recipients: [{ phone: '+15551234567', params: ['A'], contact_id: 'contact-1' }],
        template_name: 'pending_ekyc_customers',
        template_language: 'en_US',
      }),
    );

    expect(res.status).toBe(200);
    expect(recordBroadcastMessage).toHaveBeenCalledTimes(1);
    expect(recordBroadcastMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'acct-1',
        contactId: 'contact-1',
        ownerUserId: 'owner-1',
        templateName: 'pending_ekyc_customers',
        whatsappMessageId: 'wamid.sent',
      }),
    );
  });

  it('still sends, but skips mirroring, when the recipient carries no contact_id', async () => {
    const res = await POST(
      makeRequest({
        recipients: [{ phone: '+15551234567', params: ['A'] }],
        template_name: 'pending_ekyc_customers',
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(1);
    expect(recordBroadcastMessage).not.toHaveBeenCalled();
  });

  it('never mirrors a failed send', async () => {
    sendTemplateMessage.mockRejectedValueOnce(new Error('Meta rejected it'));

    const res = await POST(
      makeRequest({
        recipients: [{ phone: '+15551234567', params: ['A'], contact_id: 'contact-1' }],
        template_name: 'pending_ekyc_customers',
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failed).toBe(1);
    expect(recordBroadcastMessage).not.toHaveBeenCalled();
  });
});
