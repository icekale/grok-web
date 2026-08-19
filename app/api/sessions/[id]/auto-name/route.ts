import { autoNameSession } from "@/lib/session-http";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return autoNameSession(id);
}
