import { compactSessionForList, getSessions } from "@/lib/session-http";

export { compactSessionForList };

export async function GET(req: Request) {
  return getSessions(req);
}
