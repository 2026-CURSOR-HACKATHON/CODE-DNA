import simpleGit, { SimpleGit } from 'simple-git';

const BRANCH_PREFIX = 'ai-context-';

let savedBranch: string | null = null;

/** 현재 Git 사용자 이름 (브랜치명용) */
export async function getGitUsername(workspaceRoot: string): Promise<string> {
  const git = simpleGit(workspaceRoot);
  const name = await git.raw(['config', 'user.name']);
  return (name || 'unknown').trim().replace(/\s+/g, '-');
}

/** ai-context-{username} 브랜치명 */
export async function getAiContextBranchName(workspaceRoot: string): Promise<string> {
  const user = await getGitUsername(workspaceRoot);
  return `${BRANCH_PREFIX}${user}`;
}

/**
 * ai-context-{username} 브랜치로 전환
 * - 이미 있으면 checkout
 * - 없으면 orphan 생성 후 reset (히스토리 없음)
 * - 반환: { branchName, created } (created = 이번에 새로 만든 경우)
 */
export async function ensureAiContextBranch(workspaceRoot: string): Promise<{ branchName: string; created: boolean }> {
  const git = simpleGit(workspaceRoot);
  const branchName = await getAiContextBranchName(workspaceRoot);

  let currentBranch: string | null = null;
  try {
    const current = await git.revparse(['--abbrev-ref', 'HEAD']);
    currentBranch = current.trim();
  } catch (e) {
    // 초기 커밋이 없는 저장소 등에서 HEAD가 없을 수 있음
    console.warn(
      '[AiContextGit] 현재 브랜치 이름을 가져오지 못했습니다 (초기 커밋 없음 가능성):',
      e instanceof Error ? e.message : e
    );
  }

  if (currentBranch === branchName) return { branchName, created: false };

  // 현재 브랜치가 유효한 경우에만 복귀용으로 저장
  if (currentBranch) {
    savedBranch = currentBranch;
  }

  const branches = await git.branchLocal();
  if (branches.all.includes(branchName)) {
    await git.checkout(branchName);
    return { branchName, created: false };
  }

  await git.checkout(['--orphan', branchName]);
  try {
    // 일부 환경 / 초기 커밋 없음에서는 HEAD가 없어 reset이 실패할 수 있음 → 무시
    await git.reset(['HEAD']);
  } catch (e) {
    console.warn(
      '[AiContextGit] HEAD 기준 reset 실패 (새 저장소 또는 orphan 브랜치 초기 상태로 추정):',
      e instanceof Error ? e.message : e
    );
  }
  return { branchName, created: true };
}

/** 원래 브랜치로 복귀 */
export async function restoreBranch(workspaceRoot: string): Promise<void> {
  if (!savedBranch) return;
  const git = simpleGit(workspaceRoot);
  await git.checkout(savedBranch);
  savedBranch = null;
}

/**
 * 매칭된 파일만 add 후 커밋 (ai-context 브랜치에서 호출 가정)
 * - filePaths: 상대 경로 배열. 비어 있으면 전체 working dir (Fallback)
 * - 반환: commit hash 또는 null (변경 없음)
 */
export async function commitMatchedFiles(
  workspaceRoot: string,
  filePaths: string[],
  message?: string
): Promise<string | null> {
  const git = simpleGit(workspaceRoot);

  if (filePaths.length > 0) {
    await git.add(filePaths);
  } else {
    await git.add('.');
  }

  const status = await git.status();
  if (status.staged.length === 0 && !status.created.length && !status.modified.length) {
    return null;
  }

  const commitMsg = message ?? `[AI] ${new Date().toISOString()}`;
  await git.commit(commitMsg);
  const rev = await git.revparse(['HEAD']);
  return rev.trim();
}
