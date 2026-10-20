import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';

/** Where snapshots go. The first implementation is a GitHub repository; the interface keeps the rest of the code free of it. */
export interface VersionStore {
  /** Writes `files` (paths relative to `folder`) into `folder`, removes files in `folder` that are no longer listed, and commits. */
  commit(input: { folder: string; files: Record<string, string>; message: string }): Promise<{ sha: string | null }>;
}

export class SnapshotsNotConfigured extends Error {}

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
    const m = repo ? /^([\w.-]+)\/([\w.-]+)$/.exec(repo) : null;
    if (!m || !token) throw new SnapshotsNotConfigured('Snapshots are not configured on this server.');
    return new GitHubVersionStore(m[1]!, m[2]!, token, process.env.SNAPSHOT_BRANCH?.trim() || undefined);
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
