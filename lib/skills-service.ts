import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { getAgentDir } from "@/lib/pi-stubs/coding-agent";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { listGrokSkills } from "@/lib/grok-settings/home-config.ts";
import { getProjectTrustStatus } from "@/lib/project-trust";

type AcpSkill = {
  name: string;
  description?: string;
  path: string;
  scope?: string;
  enabled?: boolean;
  disable_model_invocation?: boolean;
};

function mapAcpSkill(skill: AcpSkill, cwd: string): SkillInfo {
  return {
    name: skill.name,
    description: skill.description ?? "",
    filePath: skill.path,
    baseDir: cwd,
    disableModelInvocation: skill.enabled === false || skill.disable_model_invocation === true,
    sourceInfo: { source: "grok", scope: skill.scope === "user" ? "user" : "project" },
  };
}

function mapGrokSkill(skill: { name: string; path: string }, cwd: string): SkillInfo {
  return {
    name: skill.name,
    description: "",
    filePath: skill.path,
    baseDir: cwd,
    disableModelInvocation: false,
    sourceInfo: { source: "grok", scope: "project" },
  };
}

export async function loadSkillsWithInstallInfo(cwd: string): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  const trust = getProjectTrustStatus(cwd, agentDir);
  let skills: SkillInfo[] = [];
  if (trust.trusted) {
    try {
      const listed = await getAgentRuntime().listSkills(cwd);
      skills = (listed.skills ?? []).map((skill) => mapAcpSkill(skill, cwd));
    } catch {
      skills = listGrokSkills(undefined, cwd).map((skill) => mapGrokSkill(skill, cwd));
    }
  } else {
    skills = listGrokSkills().map((skill) => mapGrokSkill(skill, cwd));
  }
  return {
    skills: annotateSkillsWithInstallInfo(skills, { cwd, agentDir }),
    diagnostics: [],
    projectResourcesLoaded: trust.trusted,
  };
}
