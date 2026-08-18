import { getSessionContext } from "@/lib/session-http";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return getSessionContext(req, id);
}
