import { handleGitWrite } from "@/lib/git-http";

export async function POST(req: Request) {
  return handleGitWrite(req, "stage");
}
