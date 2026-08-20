"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { getFileName, resolveWorkspaceFilePath } from "@/lib/file-paths";
import { buildWorkspaceTree, type WorkspaceTreeNode } from "@/lib/workspace-tree";

type GitRow = { filePath: string; status?: string };

export function WorkspaceBrowser({
  cwd,
  refreshKey,
  onOpenFile,
}: {
  cwd?: string | null;
  refreshKey?: number;
  onOpenFile: (filePath: string, fileName: string, options?: { modeHint?: "diff" }) => void;
}) {
  const { t } = useI18n();
  const [files, setFiles] = useState<string[]>([]);
  const [git, setGit] = useState<GitRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd) {
      setFiles([]);
      setGit([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setError(null);
      try {
        const [indexRes, gitRes] = await Promise.all([
          fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}`),
          fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`),
        ]);
        const indexBody = await indexRes.json() as { files?: string[]; error?: string };
        const gitBody = await gitRes.json() as {
          files?: Array<{ filePath?: string; path?: string; status?: string }>;
          unstaged?: Array<{ filePath?: string; path?: string; status?: string }>;
          staged?: Array<{ filePath?: string; path?: string; status?: string }>;
          error?: string;
        };
        if (cancelled) return;
        if (!indexRes.ok) {
          setFiles([]);
          setGit([]);
          setError(indexBody.error || `HTTP ${indexRes.status}`);
          return;
        }
        const listed = Array.isArray(indexBody.files) ? indexBody.files : [];
        setFiles(listed);
        if (!gitRes.ok) {
          setGit([]);
          setError(gitBody.error || `HTTP ${gitRes.status}`);
          return;
        }
        const rawGit = [
          ...(Array.isArray(gitBody.files) ? gitBody.files : []),
          ...(Array.isArray(gitBody.unstaged) ? gitBody.unstaged : []),
          ...(Array.isArray(gitBody.staged) ? gitBody.staged : []),
        ];
        const seen = new Set<string>();
        const gitRows: GitRow[] = [];
        for (const row of rawGit) {
          const rel = row.filePath ?? row.path;
          if (!rel || seen.has(rel)) continue;
          seen.add(rel);
          gitRows.push({ filePath: rel, status: row.status });
        }
        setGit(gitRows);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [cwd, refreshKey]);

  const openRelative = (rel: string, modeHint?: "diff") => {
    if (!cwd) return;
    const abs = resolveWorkspaceFilePath(cwd, rel);
    onOpenFile(abs, getFileName(abs), modeHint ? { modeHint } : undefined);
  };

  if (!cwd) {
    return (
      <div className="workspace-browser" data-empty="project">
        {t("files.pickProject")}
      </div>
    );
  }

  const tree = buildWorkspaceTree(files);

  return (
    <div className="workspace-browser">
      <div className="workspace-browser-heading">{t("files.gitChanges")}</div>
      {git.length === 0 ? (
        <div className="workspace-browser-empty">{t("files.noGitChanges")}</div>
      ) : (
        <ul className="workspace-browser-list">
          {git.map((row) => (
            <li key={row.filePath}>
              <button type="button" className="workspace-browser-row" onClick={() => openRelative(row.filePath, "diff")}>
                <span className="workspace-browser-status">{row.status ?? "M"}</span>
                <span className="workspace-browser-path">{row.filePath}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="workspace-browser-heading">{t("files.browseProject")}</div>
      {error && <div role="alert" className="workspace-browser-error">{error}</div>}
      {tree.length === 0 ? (
        <div className="workspace-browser-empty">{t("files.noFiles")}</div>
      ) : (
        <TreeNodes nodes={tree} depth={0} onOpen={openRelative} />
      )}
    </div>
  );
}

function TreeNodes({
  nodes,
  depth,
  onOpen,
}: {
  nodes: WorkspaceTreeNode[];
  depth: number;
  onOpen: (rel: string) => void;
}) {
  return (
    <ul className="workspace-browser-list" data-depth={depth}>
      {nodes.map((node) => (
        <TreeNodeRow key={node.path} node={node} depth={depth} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function TreeNodeRow({
  node,
  depth,
  onOpen,
}: {
  node: WorkspaceTreeNode;
  depth: number;
  onOpen: (rel: string) => void;
}) {
  const isFolder = Boolean(node.children);
  const [open, setOpen] = useState(depth === 0);
  if (!isFolder) {
    return (
      <li>
        <button type="button" className="workspace-browser-row" style={{ paddingLeft: 6 + depth * 12 }} onClick={() => onOpen(node.path)}>
          <span className="workspace-browser-path">{node.name}</span>
        </button>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        className="workspace-browser-row"
        style={{ paddingLeft: 6 + depth * 12 }}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight className="workspace-browser-chevron" data-open={open} size={12} strokeWidth={2} aria-hidden="true" />
        <span className="workspace-browser-path">{node.name}</span>
      </button>
      {open && node.children && node.children.length > 0 && (
        <TreeNodes nodes={node.children} depth={depth + 1} onOpen={onOpen} />
      )}
    </li>
  );
}
