export type PromptImage = {
  data: string;
  mimeType: string;
};

export function parsePromptImages(value: unknown): PromptImage[] {
  if (!Array.isArray(value)) return [];
  const images: PromptImage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { data?: unknown; mimeType?: unknown };
    if (typeof record.data !== "string" || typeof record.mimeType !== "string") continue;
    if (!record.mimeType.startsWith("image/")) continue;
    images.push({ data: record.data, mimeType: record.mimeType });
  }
  return images;
}

export function buildAcpPrompt(text: string, images: PromptImage[]): unknown[] {
  const trimmed = text.trim();
  const blocks: unknown[] = [];
  if (trimmed) blocks.push({ type: "text", text: trimmed });
  for (const image of images) {
    blocks.push({
      type: "image",
      data: image.data,
      mimeType: image.mimeType,
    });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}
