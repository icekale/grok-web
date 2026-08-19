import { currentUpdateStatus } from "@/lib/app-update";

export async function GET() {
  return Response.json(currentUpdateStatus(process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"));
}
