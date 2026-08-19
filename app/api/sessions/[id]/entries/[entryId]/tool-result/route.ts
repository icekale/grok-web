import { getToolResult } from "@/lib/session-http";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  return getToolResult(_req, id, entryId);
}
