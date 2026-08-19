import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import { getAgentDir, parseFrontmatter } from "@/lib/pi-stubs/coding-agent";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { listGrokSkills } from "@/lib/grok-settings/home-config.ts";

type AcpSkill = {
  name: string;
  description?: string;
  path: string;
  scope?: string;
  enabled?: boolean;
  disable_model_invocation?: boolean;
};

let lastListedSkills: AcpSkill[] = [];
let lastListCwd: string | undefined;

function mapAcpSkill(skill: AcpSkill, cwd: string) {
  return {
    name: skill.name,
    description: skill.description ?? "",
    filePath: skill.path,
    baseDir: cwd,
    disableModelInvocation: skill.enabled === false || skill.disable_model_invocation === true,
    sourceInfo: { source: "grok", scope: skill.scope === "user" ? "user" : "project" },
  };
}

async function listAcpSkills(cwd: string): Promise<AcpSkill[]> {
  const listed = await getAgentRuntime().listSkills(cwd);
  lastListedSkills = listed.skills ?? [];
  lastListCwd = cwd;
  return lastListedSkills;
}

// GET /api/skills?cwd=<path>
// Uses DefaultResourceLoader (same logic as AgentSession startup) so settings.json
// skill paths, package skills, and .agents/skills directories are all included.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return Response.json({ error: "cwd required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }
    try {
      const skills = await listAcpSkills(cwd);
      return Response.json({
        skills: skills.map((skill) => mapAcpSkill(skill, cwd)),
        diagnostics: [],
        projectResourcesLoaded: true,
      });
    } catch {
      // ACP unavailable — fall back to disk loaders
    }
    let loaded = { skills: [], diagnostics: [], projectResourcesLoaded: false };
    try {
      loaded = await loadSkillsWithInstallInfo(cwd);
    } catch {
      loaded = { skills: [], diagnostics: [], projectResourcesLoaded: false };
    }
    const extra = listGrokSkills(undefined, cwd).filter((skill) => (
      !loaded.skills.some((item) => item.filePath === skill.path)
    )).map((skill) => ({
      name: skill.name,
      description: "",
      filePath: skill.path,
      baseDir: cwd,
      disableModelInvocation: false,
      sourceInfo: { source: "grok", scope: "project" },
    }));
    return Response.json({ ...loaded, skills: [...loaded.skills, ...extra] });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
export async function PATCH(req: Request) {
  try {
    const body = await req.json() as { filePath: string; disableModelInvocation: boolean };
    const { filePath, disableModelInvocation } = body;
    if (!filePath) return Response.json({ error: "filePath required" }, { status: 400 });
    try {
      const runtime = getAgentRuntime();
      let skill = lastListedSkills.find((item) => item.path === filePath);
      if (!skill) {
        const listed = await listAcpSkills(lastListCwd ?? process.cwd());
        skill = listed.find((item) => item.path === filePath);
      }
      if (skill) {
        await runtime.toggleSkill(skill.name, !disableModelInvocation);
        const cached = lastListedSkills.find((item) => item.name === skill.name);
        if (cached) cached.enabled = !disableModelInvocation;
        return Response.json({ success: true });
      }
    } catch {
      // ACP unavailable — fall back to SKILL.md frontmatter
    }
    if (!existsSync(filePath)) return Response.json({ error: "file not found" }, { status: 404 });
    const allowedRoots = new Set(await getAllowedFileRoots());
    allowedRoots.add(getAgentDir());
    // Globally installed skills live in ~/.agents/skills and are symlinked into
    // the agent's skills dir; isExistingFilePathAllowed resolves the symlink, so
    // the real target sits outside getAgentDir(). Allow the global skills root
    // too (the SDK always treats ~/.agents/skills as trusted).
    const globalSkillsDir = path.join(homedir(), ".agents", "skills");
    if (existsSync(globalSkillsDir)) allowedRoots.add(globalSkillsDir);
    if (!isExistingFilePathAllowed(filePath, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    const content = readFileSync(filePath, "utf8");
    const key = "disable-model-invocation";

    // Use parseFrontmatter to check current value, then do a surgical line edit
    // to preserve the original YAML formatting of all other fields.
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
    const alreadySet = Boolean(frontmatter[key]);

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
