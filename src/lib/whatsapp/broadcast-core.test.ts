import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createBroadcast,
  deliverBroadcast,
  finalizeBroadcastStatus,
  BroadcastError,
  type BroadcastPlan,
} from './broadcast-core';

// Contact resolution and token decryption are exercised elsewhere — stub
// them so these tests focus on the persistence boundary.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.ok' })),
}));

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// Build a Supabase-shaped mock that gets createBroadcast past its config +
// template lookups and into persistence. `rpcResult` is what the atomic
// create_broadcast_with_recipients RPC returns.
function makeDb(rpcResult: { data: unknown; error: unknown }) {
  const calls = {
    rpc: [] as { name: string; args: unknown }[],
    // Incremented if the OLD non-atomic path (a direct broadcasts /
    // broadcast_recipients insert) is ever reached — it must not be.
    usedDirectInsert: 0,
  };
  const database = {
    from(table: string) {
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { phone_number_id: 'pn-1', access_token: 'enc' },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === 'message_templates') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        };
        return chain;
      }
      if (table === 'broadcasts' || table === 'broadcast_recipients') {
        calls.usedDirectInsert++;
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'orphan' }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(name: string, args: unknown) {
      calls.rpc.push({ name, args });
      return Promise.resolve(rpcResult);
    },
  } as unknown as SupabaseClient;
  return { db: database, calls };
}

describe('createBroadcast recipient validation (#586)', () => {
  it('counts a recipient without a leading + as rejected instead of sending it abroad', async () => {
    const { db } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [
        { to: '4155551212' }, // US national → Meta would read +41 (Switzerland)
        { to: '14155550123' }, // country code but no + — indistinguishable
        { to: '+14155550123' },
      ],
    });

    expect(plan.rejected).toBe(2);
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', contactId: 'c1', phone: '14155550123', params: [] },
    ]);
  });

  it('fails the whole request when no recipient carries a country code', async () => {
    const { db, calls } = makeDb({ data: [], error: null });
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '4155551212' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(calls.rpc).toHaveLength(0);
  });
});

describe('createBroadcast atomicity (#370)', () => {
  it('creates parent + recipients through the atomic RPC, never a bare parent insert', async () => {
    const { db, calls } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });

    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe('create_broadcast_with_recipients');
    expect(calls.usedDirectInsert).toBe(0);
    expect(plan.broadcastId).toBe('b-1');
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', contactId: 'c1', phone: '14155550123', params: [] },
    ]);
  });

  it('throws and leaves no orphaned parent when the atomic create fails', async () => {
    const { db, calls } = makeDb({
      data: null,
      error: { message: 'recipient insert failed' },
    });

    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toBeInstanceOf(BroadcastError);

    // The RPC was the only persistence attempt; because it runs both
    // inserts in a single transaction, its failure rolls the parent back —
    // there is no separate parent insert that could survive as an orphan.
    expect(calls.rpc).toHaveLength(1);
    expect(calls.usedDirectInsert).toBe(0);
  });
});

// ============================================================
// Terminal status (#472). Derived from the recipient rows, not from a
// counter local to one delivery pass — a resume only sends the
// leftovers, so "nothing sent this pass" must not condemn a campaign
// that already delivered hundreds.
// ============================================================

function statusDb(
  counts: Record<string, number>,
  total: number,
  writes: { update?: Record<string, unknown> },
) {
  return {
    from(table: string) {
      let status: string | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'status') status = val as string;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'broadcasts') writes.update = row;
          return b;
        },
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({
            count: status === null ? total : (counts[status] ?? 0),
            error: null,
          }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('finalizeBroadcastStatus', () => {
  it('leaves a capped pass in "sending" while recipients are still pending', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(statusDb({ pending: 25 }, 1025, writes), 'b-1');
    // No write at all — the UI keeps offering Resume.
    expect(writes.update).toBeUndefined();
  });

  it('marks a fully-failed broadcast failed', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 10 }, 10, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('failed');
  });

  it('marks a partially-failed broadcast sent', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 3 }, 10, writes),
      'b-1',
    );
    // 7 people got the message; failed_count carries the other 3.
    expect(writes.update?.status).toBe('sent');
  });

  it('does not condemn a campaign whose resume pass sent nothing new', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    // 800 delivered on the original pass, the 200-recipient resume all
    // failed. Pre-fix this wrote 'failed' off a pass-local counter.
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 200 }, 1000, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('sent');
  });
});

// ============================================================
// Time-budgeted delivery. A resume pass runs inside `after()`, so the
// host kills it once the function's limit is up — and a killed process
// skips the caller's `finally`, stranding the delivery lock. The lock
// then blocks every retry for its full staleness window. Stopping on
// our own terms is what keeps the campaign resumable.
// ============================================================

function deliveryDb(updates: Record<string, unknown>[]) {
  return {
    from() {
      const b: Record<string, unknown> = {
        select: () => b,
        update: (row: Record<string, unknown>) => {
          updates.push(row);
          return b;
        },
        eq: () => b,
        // Serves the recipient-row updates and finalizeBroadcastStatus's
        // counts alike; a non-zero `pending` keeps it in 'sending'.
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({ count: 1, error: null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

function planOf(n: number): BroadcastPlan {
  return {
    broadcastId: 'b-1',
    templateName: 'tpl',
    templateLanguage: 'en',
    phoneNumberId: 'pn-1',
    accessToken: 'token',
    templateRow: null,
    planned: Array.from({ length: n }, (_, i) => ({
      recipientRowId: `r-${i}`,
      phone: '+15550000000',
      params: [],
    })),
    rejected: [],
  } as unknown as BroadcastPlan;
}

describe('deliverBroadcast time budget', () => {
  it('stops once the budget is spent, leaving the rest pending', async () => {
    const updates: Record<string, unknown>[] = [];
    // Each read of the clock advances 10s. The first is consumed by
    // `startedAt` (0s), so the loop's checks read 10s, 20s, 30s — the
    // first two fit the 25s budget, the third does not.
    let clock = -10_000;
    const result = await deliverBroadcast(deliveryDb(updates), planOf(50), {
      budgetMs: 25_000,
      now: () => (clock += 10_000),
    });

    expect(result.stoppedEarly).toBe(true);
    expect(result.sent).toBe(2);
    expect(result.unattempted).toBe(48);
    // Crucially the other 48 were never stamped, so they stay 'pending'
    // and the next pass picks them up — nobody is messaged twice.
    expect(updates).toHaveLength(2);
  });

  it('runs the whole plan when the budget is ample', async () => {
    const updates: Record<string, unknown>[] = [];
    const result = await deliverBroadcast(deliveryDb(updates), planOf(5), {
      budgetMs: 10_000,
      now: () => 0,
    });

    expect(result.stoppedEarly).toBe(false);
    expect(result.sent).toBe(5);
    expect(result.unattempted).toBe(0);
  });

  it('runs to completion when no budget is given', async () => {
    const updates: Record<string, unknown>[] = [];
    const result = await deliverBroadcast(deliveryDb(updates), planOf(7));

    expect(result.stoppedEarly).toBe(false);
    expect(result.sent).toBe(7);
  });
});
