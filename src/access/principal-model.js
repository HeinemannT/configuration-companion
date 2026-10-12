// Search may be forgiving, but identity resolution always uses the canonical ID.
// A numeric business ID is still a business ID, never an inferred internal RID.
export function resolveUser(users, id) {
  if (typeof id !== 'string' || !id.trim()) return null;
  const matches = users.filter(user => user.id === id.trim());
  if (matches.length !== 1 || typeof matches[0].rid !== 'string' || !/^\d+$/.test(matches[0].rid)) return null;
  return matches[0];
}
export function userChoiceRows(users) {
  const counts = new Map();
  for (const user of users) counts.set(user.id, (counts.get(user.id) ?? 0) + 1);
  return users.map(user => ({
    rid: user.id,
    id: user.id,
    label: user.name || user.id,
    secondary: user.id,
    icon: 'assignment',
    depth: 0,
    reason: user.id?.trim() && counts.get(user.id) === 1 && typeof user.rid === 'string' && /^\d+$/.test(user.rid) ? '' : 'User identity needs to be refreshed'
  })).sort((a, b) => a.label.localeCompare(b.label));
}
