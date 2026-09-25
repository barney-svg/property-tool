// Small shared valuation helper. Kept separate so date fallbacks remain safe even
// if a malformed/unknown sale date is returned by an upstream data source.
function monthsAgo(dateValue) {
  const date = new Date(`${String(dateValue || '').slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return 999;
  const now = new Date();
  return Math.max(
    0,
    (now.getUTCFullYear() - date.getUTCFullYear()) * 12 +
      now.getUTCMonth() - date.getUTCMonth()
  );
}
