import type { Attachment } from "./types";

// Shrinks a photo in the browser before it is sent (docs/CONTRACT.md, "Attached photos").

export const MAX_IMAGES = 3;
const MAX_SIDE = 1280;
const THUMB_SIDE = 160;
const MAX_BASE64 = 400_000;

function load(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable"));
    };
    img.src = url;
  });
}

function draw(img: HTMLImageElement, longest: number, quality: number): string {
  const scale = Math.min(1, longest / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  // JPEG has no transparency; without this, clear areas of a PNG turn black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", quality);
  const comma = url.indexOf(",");
  if (!url.startsWith("data:image/jpeg") || comma === -1) throw new Error("no jpeg");
  return url.slice(comma + 1);
}

export async function shrinkImage(file: File): Promise<Attachment> {
  try {
    const img = await load(file);
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("empty");
    let side = MAX_SIDE;
    let data = "";
    // Lower the quality first, then the size, until it fits.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      for (const quality of [0.8, 0.68, 0.55]) {
        data = draw(img, side, quality);
        if (data.length <= MAX_BASE64) break;
      }
      if (data.length <= MAX_BASE64) break;
      side = Math.round(side * 0.8);
    }
    if (!data || data.length > MAX_BASE64) throw new Error("too large");
    const base = file.name.replace(/\.[^.]*$/, "") || "photo";
    return { name: `${base}.jpg`, type: "image/jpeg", data, thumb: draw(img, THUMB_SIDE, 0.6) };
  } catch {
    throw new Error("That image couldn't be read.");
  }
}

export const thumbUrl = (image: Attachment) => (image.thumb ? `data:image/jpeg;base64,${image.thumb}` : null);
