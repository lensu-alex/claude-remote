// A tiny in-memory stand-in for the parts of the Supabase client the helper uses.
// It checks the helper's own logic; it does not prove anything about the real database.

export function fakeDb(tables = {}) {
  let nextId = 1000;

  function from(name) {
    const rows = (tables[name] ??= []);
    const q = { op: 'select', filters: [], rows: null, patch: null, single: false, returning: false, limit: null, order: null };

    function run() {
      const match = (row) => q.filters.every((f) => f(row));
      let out = [];
      if (q.op === 'insert') {
        out = q.rows.map((row) => ({ id: nextId++, state: null, ...row }));
        rows.push(...out);
      } else if (q.op === 'upsert') {
        for (const row of q.rows) {
          const existing = rows.find((r) => (row.id !== undefined ? r.id === row.id : r.key === row.key));
          if (existing) Object.assign(existing, row);
          else rows.push({ ...row });
        }
        out = q.rows;
      } else if (q.op === 'update') {
        out = rows.filter(match);
        out.forEach((row) => Object.assign(row, q.patch));
      } else if (q.op === 'delete') {
        out = rows.filter(match);
        for (const row of out) rows.splice(rows.indexOf(row), 1);
      } else {
        out = rows.filter(match);
        if (q.order) out = [...out].sort((a, b) => (a[q.order] > b[q.order] ? 1 : -1));
        if (q.limit) out = out.slice(0, q.limit);
      }
      const copies = out.map((row) => ({ ...row }));
      if (q.op !== 'select' && !q.returning) return { data: null, error: null };
      return { data: q.single ? (copies[0] ?? null) : copies, error: null };
    }

    const builder = {
      select() {
        if (q.op !== 'select') q.returning = true;
        return builder;
      },
      insert(value) {
        q.op = 'insert';
        q.rows = Array.isArray(value) ? value : [value];
        return builder;
      },
      upsert(value) {
        q.op = 'upsert';
        q.rows = Array.isArray(value) ? value : [value];
        return builder;
      },
      update(patch) {
        q.op = 'update';
        q.patch = patch;
        return builder;
      },
      delete() {
        q.op = 'delete';
        return builder;
      },
      eq(key, value) {
        q.filters.push((row) => row[key] === value);
        return builder;
      },
      lt(key, value) {
        q.filters.push((row) => row[key] < value);
        return builder;
      },
      neq(key, value) {
        q.filters.push((row) => row[key] !== value);
        return builder;
      },
      order(key) {
        q.order = key;
        return builder;
      },
      limit(n) {
        q.limit = n;
        return builder;
      },
      maybeSingle() {
        q.single = true;
        return builder;
      },
      then(resolve, reject) {
        return Promise.resolve().then(run).then(resolve, reject);
      },
    };
    return builder;
  }

  const channel = { on: () => channel, subscribe: () => channel };
  return { from, channel: () => channel, tables };
}
