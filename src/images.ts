import { createContext, useContext } from "react";
import type { Product } from "./model";

// Where a product's pictures come from, in order of preference:
//  1. A direct image URL in the sheet cell (a file such as .jpg/.png/.webp, or a known image host):
//     shown as-is, so changing it in the sheet changes the site with no rebuild.
//  2. A saved local copy of a screenshot page, from public/images/index.json (written by
//     `npm run images`), used only for a URL that is still in the sheet cell.
//  3. Otherwise a placeholder, plus a "View photo" link to the page.
export type ImageIndex = Record<string, string>;
export const ImageIndexContext = createContext<ImageIndex>({});
export const useImageIndex = () => useContext(ImageIndexContext);

const DIRECT_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
const IMAGE_HOSTS = new Set(["image.prntscr.com", "img.lightshot.app", "i.imgur.com"]);
const LOCAL_FILE = /^images\/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp|gif|avif)$/i;

export function isDirectImage(link: string) {
  try {
    const u = new URL(link);
    return DIRECT_EXT.test(u.pathname) || IMAGE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export function resolveImages(product: Pick<Product, "imageLinks">, index: ImageIndex) {
  const sources: string[] = [];
  const pages: string[] = [];
  for (const link of product.imageLinks) {
    const local = index[link];
    if (isDirectImage(link)) sources.push(link);
    else if (typeof local === "string" && LOCAL_FILE.test(local))
      sources.push(`${import.meta.env.BASE_URL}${local}`);
    else pages.push(link);
  }
  return { sources, pages };
}

export async function loadImageIndex(signal?: AbortSignal): Promise<ImageIndex> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}images/index.json`, { signal });
    if (!res.ok) return {};
    const raw: unknown = await res.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter(([k, v]) => typeof v === "string" && LOCAL_FILE.test(v) && k.startsWith("https://")),
    );
  } catch {
    return {};
  }
}
