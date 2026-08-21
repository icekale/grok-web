import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import { grokHome } from "@/lib/grok-home";
import { parseFrontmatter } from "@/lib/frontmatter";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

type AcpSkill = {
  name: string;
  description?: string;
  path: string;
  scope?: string;
  enabled?: boolean;
  disable_model_invocation?: boolean;
};

async function listAcpSkills(cwd: string): Promise<AcpSkill[]> {
  const listed = await getAgentRuntime().listSkills(cwd);
  return listed.skills ?? [];
}

async function skillPatchAllowedRoots(): Promise<Set<string>> {
  const allowedRoots = new Set(await getAllowedFileRoots());
  allowedRoots.add(grokHome());
  // Globally installed skills live in ~/.agents/skills and are symlinked into
  // the agent's skills dir; isExistingFilePathAllowed resolves the symlink, so
  // the real target sits outside grokHome(). Allow the global skills root
  // too (the SDK always treats ~/.agents/skills as trusted).
  const globalSkillsDir = path.join(homedir(), ".agents", "skills");
  if (existsSync(globalSkillsDir)) allowedRoots.add(globalSkillsDir);
  return allowedRoots;
}

// GET /api/skills?cwd=<path>
// ACP skill list first, then GROK_HOME / project skill folders, with install lock metadata.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return Response.json({ error: "cwd required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }
    return Response.json(await loadSkillsWithInstallInfo(cwd));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
export async function PATCH(req: Request) {
  try {
    const body = await req.json() as {
      filePath: string;
      disableModelInvocation: boolean;
      cwd?: string;
    };
    const { filePath, disableModelInvocation } = body;
    if (!filePath) return Response.json({ error: "filePath required" }, { status: 400 });
    if (existsSync(filePath)) {
      const allowedRoots = await skillPatchAllowedRoots();
      if (!isExistingFilePathAllowed(filePath, allowedRoots)) {
        return Response.json({ error: "Access denied" }, { status: 403 });
      }
    }
    try {
      const runtime = getAgentRuntime();
      const listCwds = [...new Set(
        [body.cwd, grokHome(), path.dirname(filePath)].filter((value): value is string => Boolean(value)),
      )];
      for (const listCwd of listCwds) {
        const skill = (await listAcpSkills(listCwd)).find((item) => item.path === filePath);
        if (skill) {
          await runtime.toggleSkill(skill.name, !disableModelInvocation);
          return Response.json({ success: true });
        }
      }
    } catch {
      // ACP unavailable — fall back to SKILL.md frontmatter
    }
    if (!existsSync(filePath)) return Response.json({ error: "file not found" }, { status: 404 });
    const allowedRoots = await skillPatchAllowedRoots();
    if (!isExistingFilePathAllowed(filePath, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    const content = readFileSync(filePath, "utf8");
    const key = "disable-model-invocation";

    // Use parseFrontmatter to check current value, then do a surgical line edit
    // to preserve the original YAML formatting of all other fields.
    const { data } = parseFrontmatter(content);
    const alreadySet = Boolean(data?.[key]);

    let updated = content;
    if (disableModelInvocation && !alreadySet) {
      // Add key after the opening --- line
      updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
      // If no frontmatter exists, create one
      if (updated === content) updated = `---\n${key}: true\n---\n${content}`;
    } else if (!disableModelInvocation && alreadySet) {
      // Remove the key line entirely
      updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
    }

    writeFileSync(filePath, updated, "utf8");
    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
