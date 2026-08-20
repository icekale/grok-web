import { ModelsConfigError, readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export async function GET() {
  try {
    return Response.json(readModelsConfig());
  } catch (error) {
    const status = error instanceof ModelsConfigError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}

export async function PUT(req: Request) {
  try {
    const body: unknown = await req.json();
    if (!isRecord(body)) {
      return Response.json({ error: "Models config root must be an object" }, { status: 400 });
    }
    writeModelsConfig(body);
    return Response.json({ success: true });
  } catch (error) {
    const status = error instanceof ModelsConfigError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
