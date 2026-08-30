import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Copy, UploadCloud, Trash2, Download, Save, RefreshCw, Pencil, FileSpreadsheet } from "lucide-react";
import {
  BUCKET,
  ensureSession,
  fetchHashIndex,
  fetchSavedGroups,
  saveGroups,
  sha256,
  tabRow,
  downloadCsv,
  downloadXlsx,
  type Item,
  type SavedGroup,
} from "@/lib/imgstore";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Image URL Generator — Lepdo" },
      { name: "description", content: "Upload images or folders, generate permanent public image URLs, save them, and copy horizontally into Alibaba Excel sheets." },
      { property: "og:title", content: "Image URL Generator — Lepdo" },
      { property: "og:description", content: "Generate permanent image URLs and copy them horizontally for bulk Excel product listing." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Page,
});

const ACCEPT = /\.(jpe?g|png|webp)$/i;
const PAGE_SIZE = 20;

function relPath(file: File) {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || "";
}
function groupOf(file: File) {
  const parts = relPath(file).split("/").filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2]!;
  return file.name.replace(/\.[^.]+$/, "");
}

async function copyText(text: string, label: string) {
  await navigator.clipboard.writeText(text);
  toast.success(`${label} copied`);
}

function Page() {
  const [tab, setTab] = useState<"generated" | "saved">("generated");
  const [items, setItems] = useState<Item[]>([]);
  const [failed, setFailed] = useState<File[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const singleRef = useRef<HTMLInputElement>(null);
  const multiRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async (files: File[]) => {
    const valid = files.filter((f) => ACCEPT.test(f.name));
    if (!valid.length) return;
    setProgress({ done: 0, total: valid.length });
    const fails: File[] = [];
    try {
      const userId = await ensureSession();
      const hashIndex = await fetchHashIndex();
      const base = window.location.origin;
      const results: Item[] = new Array(valid.length);
      let done = 0;
      let reusedCount = 0;
      const queue = valid.map((f, i) => ({ f, i }));
      const worker = async () => {
        for (;;) {
          const job = queue.shift();
          if (!job) break;
          const { f, i } = job;
          const group = groupOf(f);
          try {
            const hash = await sha256(f);
            const existing = hashIndex.get(hash);
            if (existing) {
              reusedCount += 1;
              results[i] = { id: `${hash}-${i}`, group, name: f.name, url: existing.url, path: "", hash, size: f.size, reused: true };
            } else {
              const path = `${userId}/${crypto.randomUUID()}/${f.name}`;
              const { error } = await supabase.storage.from(BUCKET).upload(path, f, {
                cacheControl: "31536000",
                contentType: f.type || "image/jpeg",
                upsert: false,
              });
              if (error) throw error;
              const url = `${base}/api/public/img/${path}`;
              hashIndex.set(hash, { url, sku: group });
              results[i] = { id: `${hash}-${i}`, group, name: f.name, url, path, hash, size: f.size };
            }
          } catch {
            fails.push(f);
          }
          done += 1;
          setProgress({ done, total: valid.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, valid.length) }, worker));
      const ok = results.filter(Boolean);
      setItems((prev) => [...prev, ...ok]);
      setFailed(fails);
      toast.success(`${ok.length} URLs ready${reusedCount ? ` · ${reusedCount} reused from Saved Library` : ""}`);
      if (fails.length) toast.error(`${fails.length} failed — use Retry`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setProgress(null);
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const entries = Array.from(e.dataTransfer.items)
      .map((i) => i.webkitGetAsEntry?.())
      .filter(Boolean) as FileSystemEntry[];
    if (!entries.length) return void run(Array.from(e.dataTransfer.files));
    const collected: File[] = [];
    const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
        Object.defineProperty(file, "webkitRelativePath", { value: `${prefix}${file.name}` });
        collected.push(file);
        return;
      }
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const readBatch = () => new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      let batch = await readBatch();
      while (batch.length) {
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
        batch = await readBatch();
      }
    };
    for (const entry of entries) await walk(entry, "");
    await run(collected);
  };

  const groups = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const i of items) {
      const list = map.get(i.group) ?? [];
      list.push(i);
      map.set(i.group, list);
    }
    return [...map].map(([name, list]) => ({ name, items: list }));
  }, [items]);

  const selectedItems = items.filter((i) => selected.has(i.id));
  const activeItems = selectedItems.length ? selectedItems : items;
  const activeGroups = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const i of activeItems) {
      const list = map.get(i.group) ?? [];
      list.push(i);
      map.set(i.group, list);
    }
    return [...map].map(([name, list]) => ({ name, items: list }));
  }, [activeItems]);

  const exportGroups = activeGroups.map((g) => ({ name: g.name, urls: g.items.map((i) => i.url) }));

  const save = async (gs: { name: string; items: Item[] }[]) => {
    try {
      await saveGroups(gs);
      toast.success("Saved to library");
      window.dispatchEvent(new Event("saved-library-refresh"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <div className="mx-auto min-h-screen w-full max-w-5xl px-4 py-8">
      <h1 className="mb-4 text-2xl font-semibold">
        Image URL <span className="text-gold">Generator</span>
      </h1>

      <div className="mb-6 flex gap-1 border-b">
        {(["generated", "saved"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize transition-colors ${
              tab === t ? "border-gold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "generated" ? "Generated" : "Saved Images"}
          </button>
        ))}
      </div>

      {tab === "generated" ? (
        <>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
              dragging ? "border-gold bg-gold/5" : "border-border bg-card"
            }`}
          >
            <UploadCloud className="h-8 w-8 text-gold" />
            <p className="mt-2 font-medium">Drag &amp; drop images or folders here</p>
            <p className="text-xs text-muted-foreground">JPG, JPEG, PNG, WEBP</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button size="sm" variant="outline" onClick={() => singleRef.current?.click()}>Single Image</Button>
              <Button size="sm" variant="outline" onClick={() => multiRef.current?.click()}>Multiple Images</Button>
              <Button size="sm" variant="outline" onClick={() => folderRef.current?.click()}>Single Folder</Button>
              <Button size="sm" variant="outline" onClick={() => folderRef.current?.click()}>Multiple Folders</Button>
            </div>
            <input ref={singleRef} type="file" accept="image/*" hidden onChange={(e) => run(Array.from(e.target.files ?? []))} />
            <input ref={multiRef} type="file" accept="image/*" multiple hidden onChange={(e) => run(Array.from(e.target.files ?? []))} />
            <input
              ref={folderRef}
              type="file"
              multiple
              hidden
              // @ts-expect-error non-standard folder picker attributes
              webkitdirectory="true"
              directory="true"
              onChange={(e) => run(Array.from(e.target.files ?? []))}
            />
          </div>

          {progress && (
            <div className="mt-4">
              <Progress value={(progress.done / Math.max(progress.total, 1)) * 100} />
              <p className="mt-1 text-xs text-muted-foreground">Uploading {progress.done}/{progress.total}</p>
            </div>
          )}

          {failed.length > 0 && (
            <div className="mt-4 flex items-center justify-between rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm">
              <span>{failed.length} upload(s) failed</span>
              <Button size="sm" variant="outline" onClick={() => { const f = failed; setFailed([]); void run(f); }}>
                <RefreshCw className="h-4 w-4" /> Retry
              </Button>
            </div>
          )}

          {items.length > 0 && (
            <div className="mt-6 space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={selected.size > 0 && selected.size === items.length}
                    onCheckedChange={(v) => setSelected(v ? new Set(items.map((i) => i.id)) : new Set())}
                  />
                  Select All
                </label>
                <span className="text-xs text-muted-foreground">
                  {selected.size ? `${selected.size} selected` : `${items.length} images · ${groups.length} groups`}
                </span>
                <div className="flex-1" />
                <Button size="sm" onClick={() => copyText(tabRow(activeItems.map((i) => i.url)), "Excel row")}>
                  <Copy className="h-4 w-4" /> Copy for Excel →
                </Button>
                <Button size="sm" variant="outline" onClick={() => copyText(activeItems.map((i) => i.url).join("\n"), "URLs")}>
                  Copy URLs
                </Button>
                <Button size="sm" variant="outline" onClick={() => downloadXlsx(exportGroups)}>
                  <FileSpreadsheet className="h-4 w-4" /> Download Excel
                </Button>
                <Button size="sm" variant="outline" onClick={() => downloadCsv(exportGroups)}>
                  <Download className="h-4 w-4" /> Download CSV
                </Button>
                <Button size="sm" variant="outline" onClick={() => save(activeGroups)}>
                  <Save className="h-4 w-4" /> {selected.size ? "Save Selected" : "Save All"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (selected.size) {
                      setItems((prev) => prev.filter((i) => !selected.has(i.id)));
                      setSelected(new Set());
                    } else setItems([]);
                  }}
                >
                  <Trash2 className="h-4 w-4" /> {selected.size ? "Delete Selected" : "Clear All"}
                </Button>
              </div>

              {groups.map((g) => (
                <div key={g.name} className="rounded-lg border bg-card px-4 pb-2">
                  <div className="flex flex-wrap items-center gap-2 border-b py-2">
                    <Checkbox
                      checked={g.items.every((i) => selected.has(i.id))}
                      onCheckedChange={(v) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          for (const i of g.items) (v ? next.add(i.id) : next.delete(i.id));
                          return next;
                        })
                      }
                    />
                    <span className="font-medium">📁 {g.name}</span>
                    <span className="text-xs text-muted-foreground">{g.items.length} images</span>
                    <div className="flex-1" />
                    <Button size="sm" variant="ghost" onClick={() => copyText(tabRow(g.items.map((i) => i.url)), `${g.name} row`)}>
                      <Copy className="h-4 w-4" /> Copy Row for Excel →
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => save([g])}>
                      <Save className="h-4 w-4" /> Save
                    </Button>
                  </div>
                  {g.items.map((i) => (
                    <div key={i.id} className="flex items-center gap-3 border-b py-2 text-sm last:border-0">
                      <Checkbox checked={selected.has(i.id)} onCheckedChange={() => toggle(i.id)} />
                      <img src={i.url} alt={i.name} loading="lazy" className="h-10 w-10 shrink-0 rounded object-cover" />
                      <span className="w-40 shrink-0 truncate font-medium">{i.name}</span>
                      {i.reused && <span className="shrink-0 rounded bg-gold/15 px-2 py-0.5 text-xs text-gold">Already in Library</span>}
                      <a href={i.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-muted-foreground hover:underline">
                        {i.url}
                      </a>
                      <Button size="sm" variant="ghost" onClick={() => copyText(i.url, i.name)}>
                        <Copy className="h-4 w-4" /> Copy
                      </Button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <SavedLibrary />
      )}
    </div>
  );
}

function SavedLibrary() {
  const [groups, setGroups] = useState<SavedGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"new" | "old" | "az">("new");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    try {
      setGroups(await fetchSavedGroups());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load library");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const h = () => void load();
    window.addEventListener("saved-library-refresh", h);
    return () => window.removeEventListener("saved-library-refresh", h);
  }, []);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = groups.filter(
      (g) => !term || g.sku.toLowerCase().includes(term) || g.images.some((i) => i.file_name.toLowerCase().includes(term)),
    );
    return [...list].sort((a, b) =>
      sort === "az" ? a.sku.localeCompare(b.sku) : sort === "old" ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at),
    );
  }, [groups, q, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const view = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selectedGroups = filtered.filter((g) => selected.has(g.id));
  const active = selectedGroups.length ? selectedGroups : filtered;
  const exportGroups = active.map((g) => ({ name: g.sku, urls: g.images.map((i) => i.public_url) }));

  const rename = async (g: SavedGroup) => {
    const name = window.prompt("Rename group", g.sku)?.trim();
    if (!name || name === g.sku) return;
    const { error } = await supabase.from("products").update({ sku: name }).eq("id", g.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    setGroups((prev) => prev.map((p) => (p.id === g.id ? { ...p, sku: name } : p)));
    toast.success("Renamed");
  };

  const removeGroups = async (ids: string[]) => {
    const { error } = await supabase.from("products").delete().in("id", ids);
    if (error) {
      toast.error(error.message);
      return;
    }
    setGroups((prev) => prev.filter((p) => !ids.includes(p.id)));
    setSelected(new Set());
    toast.success("Deleted");
  };

  const removeImage = async (groupId: string, imageId: string) => {
    const { error } = await supabase.from("product_images").delete().eq("id", imageId);
    if (error) {
      toast.error(error.message);
      return;
    }
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, images: g.images.filter((i) => i.id !== imageId) } : g)));
    toast.success("Image removed");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search saved folders or image names…" className="max-w-xs" />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="new">Newest</option>
          <option value="old">Oldest</option>
          <option value="az">A–Z</option>
        </select>
        <span className="text-xs text-muted-foreground">
          {selected.size ? `${selected.size} selected` : `${filtered.length} groups`}
        </span>
        <div className="flex-1" />
        <Button size="sm" onClick={() => copyText(tabRow(active.flatMap((g) => g.images.map((i) => i.public_url))), "Excel row")}>
          <Copy className="h-4 w-4" /> Copy for Excel →
        </Button>
        <Button size="sm" variant="outline" onClick={() => copyText(active.flatMap((g) => g.images.map((i) => i.public_url)).join("\n"), "URLs")}>
          Copy URLs
        </Button>
        <Button size="sm" variant="outline" onClick={() => downloadXlsx(exportGroups, "saved-image-urls.xlsx")}>
          <FileSpreadsheet className="h-4 w-4" /> Download Excel
        </Button>
        <Button size="sm" variant="outline" onClick={() => downloadCsv(exportGroups, "saved-image-urls.csv")}>
          <Download className="h-4 w-4" /> Download CSV
        </Button>
        {selected.size > 0 && (
          <Button size="sm" variant="ghost" onClick={() => removeGroups([...selected])}>
            <Trash2 className="h-4 w-4" /> Delete Selected
          </Button>
        )}
      </div>

      {loading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading library…</p>
      ) : view.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No saved images yet.</p>
      ) : (
        view.map((g) => (
          <div key={g.id} className="rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox
                checked={selected.has(g.id)}
                onCheckedChange={(v) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(g.id);
                    else next.delete(g.id);
                    return next;
                  })
                }
              />
              <span className="font-medium">📁 {g.sku}</span>
              <span className="text-xs text-muted-foreground">
                {g.images.length} images · Saved {new Date(g.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
              </span>
              <div className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => copyText(tabRow(g.images.map((i) => i.public_url)), `${g.sku} row`)}>
                <Copy className="h-4 w-4" /> Copy for Excel →
              </Button>
              <Button size="sm" variant="ghost" onClick={() => copyText(g.images.map((i) => i.public_url).join("\n"), g.sku)}>
                Copy URLs
              </Button>
              <Button size="sm" variant="ghost" onClick={() => downloadXlsx([{ name: g.sku, urls: g.images.map((i) => i.public_url) }], `${g.sku}.xlsx`)}>
                <Download className="h-4 w-4" /> Download
              </Button>
              <Button size="sm" variant="ghost" onClick={() => rename(g)}>
                <Pencil className="h-4 w-4" /> Rename
              </Button>
              <Button size="sm" variant="ghost" onClick={() => removeGroups([g.id])}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {g.images.map((i) => (
                <div key={i.id} className="group relative">
                  <img
                    src={i.public_url}
                    alt={i.file_name}
                    title={i.file_name}
                    loading="lazy"
                    className="h-16 w-16 rounded border object-cover"
                  />
                  <div className="mt-1 flex justify-center gap-1">
                    <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => copyText(i.public_url, i.file_name)}>
                      Copy
                    </button>
                    <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => removeImage(g.id, i.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-xs text-muted-foreground">Page {page} of {pages}</span>
          <Button size="sm" variant="outline" disabled={page === pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}
