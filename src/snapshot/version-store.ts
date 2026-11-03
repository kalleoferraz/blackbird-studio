import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';

/** Where snapshots go. The first implementation is a GitHub repository; the interface keeps the rest of the code free of it. */
export interface VersionStore {
  /** Writes `files` (paths relative to `folder`) into `folder`, removes files in `folder` that are no longer listed, and commits. */
  commit(input: { folder: string; files: Record<string, string>; message: string }): Promise<{ sha: string | null }>;
}

export class SnapshotsNotConfigured extends Error {}

export const REPO_PATTERN = /^([\w.-]+)\/([\w.-]+)$/;

export function gitBlobSha(content: string): string {
  const buf = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

export class GitHubVersionStore implements VersionStore {
  private octokit: Octokit;
  constructor(private owner: string, private repo: string, token: string, private branch?: string) {
    this.octokit = new Octokit({ auth: token });
  }

  static fromEnv(): GitHubVersionStore {
    const repo = process.env.SNAPSHOT_REPO?.trim();
    const token = process.env.SNAPSHOT_REPO_TOKEN?.trim();
    const m = repo ? REPO_PATTERN.exec(repo) : null;
    if (!m || !token) throw new SnapshotsNotConfigured('Snapshots are not configured on this server.');
    return new GitHubVersionStore(m[1]!, m[2]!, token, process.env.SNAPSHOT_BRANCH?.trim() || undefined);
  }

  /** From the settings saved in the admin area, falling back to the environment. Says what is missing. */
  static async fromSettings(): Promise<GitHubVersionStore> {
    const { snapshotSettings } = await import('../settings/settings.js');
    const c = await snapshotSettings();
    const m = c.repo ? REPO_PATTERN.exec(c.repo) : null;
    const missing = [
      !m && (c.repo ? 'a valid repository (owner/name)' : 'the repository'),
      !c.token && (c.tokenUnreadable ? 'the token (the saved one can no longer be read: enter it again)' : 'the token'),
    ].filter(Boolean);
    if (missing.length > 0 || !m || !c.token) {
      throw new SnapshotsNotConfigured(`Snapshots are not configured: missing ${missing.join(' and ')}. The administrator sets them in Administration, under Snapshots.`);
    }
    return new GitHubVersionStore(m[1]!, m[2]!, c.token, c.branch ?? undefined);
  }

  /** Checks that the token reaches the repository, can write to it, and that the branch exists. */
  async check(): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    const { owner, repo } = this;
    try {
      const r = (await this.octokit.rest.repos.get({ owner, repo })).data;
      if (r.permissions && !r.permissions.push) return { ok: false, message: `The token can see ${owner}/${repo} but cannot write to it. Give it "Contents: Read and write".` };
      const branch = this.branch ?? r.default_branch;
      await this.octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
      return { ok: true, message: `Connected to ${owner}/${repo}, branch ${branch}.` };
    } catch (e: any) {
      const status = e?.status;
      if (status === 401) return { ok: false, message: 'GitHub does not accept the token (wrong or expired).' };
      if (status === 404) return { ok: false, message: `GitHub cannot find ${owner}/${repo} with this token: the name is wrong, or the token has no access to this repository, or the branch does not exist.` };
      return { ok: false, message: `GitHub answered: ${e?.message ?? 'an error'}` };
    }
  }

  async commit({ folder, files, message }: { folder: string; files: Record<string, string>; message: string }) {
    const { owner, repo } = this;
    const git = this.octokit.rest.git;
    const branch = this.branch ?? (await this.octokit.rest.repos.get({ owner, repo })).data.default_branch;
    const ref = await git.getRef({ owner, repo, ref: `heads/${branch}` });
    const parent = await git.getCommit({ owner, repo, commit_sha: ref.data.object.sha });
    const existing = await git.getTree({ owner, repo, tree_sha: parent.data.tree.sha, recursive: 'true' });
    if (existing.data.truncated) throw new Error('The snapshot repository is too large to compare.');
    const prefix = `${folder}/`;
    const old = new Map(existing.data.tree.filter((e) => e.type === 'blob' && e.path?.startsWith(prefix)).map((e) => [e.path!, e.sha!]));

    const tree: { path: string; mode: '100644'; type: 'blob'; content?: string; sha?: string | null }[] = [];
    for (const [rel, content] of Object.entries(files)) {
      const path = prefix + rel;
      if (old.get(path) === gitBlobSha(content)) continue;
      tree.push({ path, mode: '100644', type: 'blob', content });
    }
    for (const path of old.keys()) if (!(path.slice(prefix.length) in files)) tree.push({ path, mode: '100644', type: 'blob', sha: null });
    if (tree.length === 0) return { sha: null };

    const newTree = await git.createTree({ owner, repo, base_tree: parent.data.tree.sha, tree: tree as any });
    const commit = await git.createCommit({ owner, repo, message, tree: newTree.data.sha, parents: [parent.data.sha] });
    await git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.data.sha });
    return { sha: commit.data.sha };
  }
}
