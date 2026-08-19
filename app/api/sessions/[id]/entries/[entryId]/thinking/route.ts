import { getThinking } from "@/lib/session-http";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  return getThinking(req, id, entryId);
}
