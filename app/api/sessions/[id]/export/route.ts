import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapUpdatesJsonl } from "@/lib/history-map.ts";
import { packSessionArchive, renderSessionHtml } from "@/lib/session-export.ts";
import { findGrokSession } from "@/lib/session-index.ts";

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function contentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.zip";
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const inline = new URL(req.url).searchParams.get("inline") === "1";
  try {
    const session = await findGrokSession(id);
    if (!session) return Response.json({ error: "Session not found" }, { status: 404 });

    if (inline) {
      let text = "";
      try {
        text = readFileSync(join(session.path, "updates.jsonl"), "utf8");
      } catch {
        text = "";
      }
      const { messages } = mapUpdatesJsonl(text);
      const html = renderSessionHtml(session.name || id, messages);
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": contentDisposition(`${id}.html`, true),
          "Cache-Control": "no-cache",
        },
      });
    }

    const archive = packSessionArchive(session.path, id);
    return new Response(archive.bytes, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition(archive.fileName, false),
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
