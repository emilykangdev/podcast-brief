import pg from "pg";

// Promise.all([callA(), callB()]) is genuine concurrency, but nothing guarantees both calls
// actually reach the same critical section (row lock) at the same instant — a network
// round-trip stall could let call A fully commit before call B even starts, which would
// still make loose "one winner, one loser" assertions pass without ever exercising the lock.
//
// This forces the interleaving deterministically: open a raw Postgres connection (bypassing
// PostgREST, which only exposes single-statement RPC calls with no way to pause mid-transaction),
// BEGIN a transaction, and take the exact row lock (`SELECT ... FOR UPDATE`) that the RPC under
// test also takes. Any concurrent call that reaches that same row is provably blocked until
// release() runs — table/column are test-only literals, never user input.
export async function holdRowLock(table, column, id) {
  const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
  await client.connect();
  await client.query("BEGIN");
  await client.query(`SELECT * FROM ${table} WHERE ${column} = $1 FOR UPDATE`, [id]);
  return {
    release: async () => {
      await client.query("COMMIT");
      await client.end();
    },
  };
}

// Proves `promise` is genuinely blocked (not just slow) by confirming it hasn't settled after
// `waitMs`. Pair with holdRowLock: if this assertion fails, the concurrent call never actually
// reached the lock, so the race isn't being tested at all.
export async function assertStillPending(promise, waitMs = 300) {
  let settled = false;
  promise.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  if (settled) {
    throw new Error(
      "Expected the operation to still be pending (blocked on the held row lock), but it already settled — the race window isn't actually being forced."
    );
  }
}
