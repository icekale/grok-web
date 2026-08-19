import { deleteSession, getSessionDetail } from "@/lib/session-http";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return getSessionDetail(req, id);
}

export async function PATCH() {
  return Response.json({ error: "Session not found" }, { status: 404 });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return deleteSession(id);
}
