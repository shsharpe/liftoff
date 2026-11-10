const MAX = 60;
const entries = [];

export function record(entry) {
  entries.push(entry);
  if (entries.length > MAX) entries.shift();
}

// Newest first.
export function recent(limit = 30) {
  return entries.slice(-limit).reverse();
}
