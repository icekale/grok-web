export type WorkspaceTreeNode = {
  name: string;
  path: string;
  children?: WorkspaceTreeNode[];
};

export function buildWorkspaceTree(paths: string[]): WorkspaceTreeNode[] {
  const root: WorkspaceTreeNode[] = [];
  const folders = new Map<string, WorkspaceTreeNode>();

  for (const rel of paths) {
    const parts = rel.split(/[/\\]/).filter(Boolean);
    if (parts.length === 0) continue;
    let siblings = root;
    let acc = "";
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      acc = acc ? `${acc}/${name}` : name;
      const isFile = index === parts.length - 1;
      if (isFile) {
        siblings.push({ name, path: acc });
        continue;
      }
      let folder = folders.get(acc);
      if (!folder) {
        folder = { name, path: acc, children: [] };
        folders.set(acc, folder);
        siblings.push(folder);
      }
      siblings = folder.children ?? [];
    }
  }

  const sortNodes = (nodes: WorkspaceTreeNode[]) => {
    nodes.sort((left, right) => {
      const leftFolder = left.children ? 0 : 1;
      const rightFolder = right.children ? 0 : 1;
      if (leftFolder !== rightFolder) return leftFolder - rightFolder;
      return left.name.localeCompare(right.name);
    });
    for (const node of nodes) {
      if (node.children) sortNodes(node.children);
    }
  };
  sortNodes(root);
  return root;
}
