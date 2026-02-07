import * as path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';

const AI_CONTEXT_BRANCH_PREFIX = 'ai-context-';
let savedBranchBeforeAiContext: string | null = null;

/** ai-context-{username} 브랜치 이름 반환 */
export async function getAiContextBranchName(workspaceRoot: string): Promise<string> {
  const git = simpleGit(workspaceRoot);
  let userName = 'default';
  try {
    const config = await git.raw(['config', 'user.name']);
    if (typeof config === 'string' && config.trim()) {
      userName = config.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 32) || 'default';
    }
  } catch {
    // ignore
  }
  return AI_CONTEXT_BRANCH_PREFIX + userName;
}

/**
 * ai-context-{username} orphan 브랜치 확보 후 checkout
 * - 없으면 orphan 생성 후 checkout
 * - 있으면 해당 브랜치로 checkout
 */
export async function ensureAiContextBranch(
  workspaceRoot: string
): Promise<{ branchName: string; created: boolean }> {
  const git = simpleGit(workspaceRoot);
  const branchName = await getAiContextBranchName(workspaceRoot);

  // 복귀용: 체크아웃 전 현재 브랜치 저장
  const current = await git.revparse(['--abbrev-ref', 'HEAD']);
  savedBranchBeforeAiContext = typeof current === 'string' ? current.trim() : 'main';

  const branches = await git.branchLocal();
  const exists = branches.all.includes(branchName);

  if (exists) {
    await git.checkout(branchName);
    return { branchName, created: false };
  }

  // orphan 브랜치 생성 (커밋 이력 없음)
  await git.raw(['checkout', '--orphan', branchName]);
  try {
    await git.raw(['rm', '-rf', '--cached', '.']);
  } catch {
    // ignore
  }
  return { branchName, created: true };
}

/**
 * 매칭된 파일만 스테이징 후 커밋 (ai-context 브랜치에서 호출 가정)
 * @returns 커밋 해시 또는 null
 */
export async function commitMatchedFiles(
  workspaceRoot: string,
  filePaths: string[]
): Promise<string | null> {
  const git = simpleGit(workspaceRoot);
  if (filePaths.length === 0) return null;

  const root = path.resolve(workspaceRoot);
  const toAdd = filePaths
    .map((p) => path.resolve(root, p))
    .filter((p) => p.startsWith(root));

  if (toAdd.length === 0) return null;

  try {
    await git.add(filePaths);
    const status = await git.status();
    if (status.staged.length === 0) return null;
    const commitResult = await git.commit(`ai-context: ${filePaths.length} file(s)`, [
      '--no-verify',
    ]);
    const hash = commitResult?.commit;
    return hash ?? null;
  } catch {
    return null;
  }
}

/**
 * ai-context 브랜치 작업 후 원래 브랜치로 복귀
 */
export async function restoreBranch(workspaceRoot: string): Promise<void> {
  const git = simpleGit(workspaceRoot);
  const target = savedBranchBeforeAiContext ?? 'main';
  try {
    await git.checkout(target);
  } finally {
    savedBranchBeforeAiContext = null;
  }
}
