import fs from 'node:fs';
import path from 'node:path';

// Reads the checked-out commit straight from .git, so it works even when the
// container image has no git binary. Returns null for ZIP deploys.
export function readGit(root) {
  try {
    const gitDir = path.join(root, '.git');
    if (!fs.statSync(gitDir).isDirectory()) return null;

    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head ? { commit: head.slice(0, 40), branch: null } : null;

    const ref = head.slice(5);
    const branch = ref.replace('refs/heads/', '');
    const refFile = path.join(gitDir, ref);
    if (fs.existsSync(refFile)) return { commit: fs.readFileSync(refFile, 'utf8').trim().slice(0, 40), branch };

    const packed = path.join(gitDir, 'packed-refs');
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
        if (line.endsWith(' ' + ref)) return { commit: line.split(' ')[0].slice(0, 40), branch };
      }
    }
    return null;
  } catch {
    return null;
  }
}
