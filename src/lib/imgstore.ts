import { supabase } from "@/integrations/supabase/client";
import * as XLSX from "xlsx";

export const BUCKET = "product-images";
export const WORKSPACE_EMAIL = "workspace@lepdo.local";
export const WORKSPACE_PASSWORD = "901902";

export type Item = {
  id: string;
  group: string;
  name: string;
  url: string;
  path: string;
  hash: string;
  size: number;
  reused?: boolean;
};

export type SavedImage = {
  id: string;
  file_name: string;
  public_url: string;
  storage_path: string;
  position: number;
  size_bytes: number;
  content_hash: string | null;
};

export type SavedGroup = {
  id: string;
  sku: string;
  created_at: string;
  images: SavedImage[];
};

export async function ensureSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.user.id;
  const signIn = await supabase.auth.signInWithPassword({ email: WORKSPACE_EMAIL, password: WORKSPACE_PASSWORD });
  if (signIn.data.session) return signIn.data.session.user.id;
  await supabase.auth.signUp({ email: WORKSPACE_EMAIL, password: WORKSPACE_PASSWORD });
  const retry = await supabase.auth.signInWithPassword({ email: WORKSPACE_EMAIL, password: WORKSPACE_PASSWORD });
  if (!retry.data.session) throw new Error("Storage session unavailable");
  return retry.data.session.user.id;
}

export async function sha256(file: File) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function fetchSavedGroups(): Promise<SavedGroup[]> {
  await ensureSession();
  const { data, error } = await supabase
    .from("products")
    .select("id, sku, created_at, product_images(id, file_name, public_url, storage_path, position, size_bytes, content_hash)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((p) => ({
    id: p.id,
    sku: p.sku,
    created_at: p.created_at,
    images: [...((p as unknown as { product_images: SavedImage[] }).product_images ?? [])].sort(
      (a, b) => a.position - b.position,
    ),
  }));
}

export async function fetchHashIndex(): Promise<Map<string, { url: string; sku: string }>> {
  await ensureSession();
  const { data } = await supabase
    .from("product_images")
    .select("content_hash, public_url, products(sku)")
    .not("content_hash", "is", null);
  const map = new Map<string, { url: string; sku: string }>();
  for (const row of (data ?? []) as unknown as { content_hash: string; public_url: string; products: { sku: string } | null }[]) {
    if (!map.has(row.content_hash)) map.set(row.content_hash, { url: row.public_url, sku: row.products?.sku ?? "" });
  }
  return map;
}

export async function saveGroups(groups: { name: string; items: Item[] }[]) {
  const userId = await ensureSession();
  for (const g of groups) {
    const { data: existing } = await supabase.from("products").select("id").eq("sku", g.name).maybeSingle();
    let productId = existing?.id;
    if (!productId) {
      const { data, error } = await supabase.from("products").insert({ sku: g.name, user_id: userId }).select("id").single();
      if (error) throw error;
      productId = data.id;
    }
    const { data: current } = await supabase.from("product_images").select("content_hash, position").eq("product_id", productId);
    const have = new Set((current ?? []).map((c) => c.content_hash));
    let pos = (current ?? []).reduce((m, c) => Math.max(m, c.position + 1), 0);
    const rows = g.items
      .filter((i) => !have.has(i.hash))
      .map((i) => ({
        product_id: productId!,
        user_id: userId,
        file_name: i.name,
        public_url: i.url,
        storage_path: i.path,
        content_hash: i.hash,
        size_bytes: i.size,
        position: pos++,
        is_main: false,
      }));
    if (rows.length) {
      const { error } = await supabase.from("product_images").insert(rows);
      if (error) throw error;
    }
  }
}

export function tabRow(urls: string[]) {
  return urls.join("\t");
}

export function buildMatrix(groups: { name: string; urls: string[] }[]) {
  const max = groups.reduce((m, g) => Math.max(m, g.urls.length), 0);
  const header = ["Group / Folder", ...Array.from({ length: max }, (_, i) => `IMAGE ${i + 1}`)];
  const rows = groups.map((g) => [g.name, ...Array.from({ length: max }, (_, i) => g.urls[i] ?? "")]);
  return [header, ...rows];
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadXlsx(groups: { name: string; urls: string[] }[], filename = "image-urls.xlsx") {
  const ws = XLSX.utils.aoa_to_sheet(buildMatrix(groups));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Images");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  download(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
}

export function downloadCsv(groups: { name: string; urls: string[] }[], filename = "image-urls.csv") {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const csv = buildMatrix(groups)
    .map((r) => r.map(esc).join(","))
    .join("\n");
  download(new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);
}
