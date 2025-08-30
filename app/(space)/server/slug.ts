export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) {
    return 'space';
  }
  return base;
}

export function uniqueSlug(desired: string, existing: Set<string>): string {
  if (!existing.has(desired)) {
    return desired;
  }
  let i = 2;
  while (existing.has(`${desired}-${i}`)) {
    i += 1;
  }
  return `${desired}-${i}`;
}
