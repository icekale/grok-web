import { postMeta } from "@/lib/session-http";

export async function POST(req: Request) {
  return postMeta(req);
}
