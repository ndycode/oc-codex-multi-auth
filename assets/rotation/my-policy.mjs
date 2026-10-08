/** @type {import('oc-codex-multi-auth/rotation').RotationSelect} */
export function select({ accounts }) {
  const observed = accounts.filter((account) => account.primary.usedPercent.status === 'fresh');
  if (observed.length === 0) return null;
  const best = observed.reduce((current, account) =>
    (account.primary.usedPercent.value ?? 100) < (current.primary.usedPercent.value ?? 100)
      ? account : current);
  return best.id;
}
