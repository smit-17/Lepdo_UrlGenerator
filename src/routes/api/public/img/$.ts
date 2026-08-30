import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

export const Route = createFileRoute("/api/public/img/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const path = (params as Record<string, string>)["_splat"];
        if (!path) return new Response("Not found", { status: 404 });

        const url = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
        const key =
          process.env["SUPABASE_SERVICE_ROLE_KEY"] ||
          process.env["SUPABASE_PUBLISHABLE_KEY"] ||
          process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];

        if (!url || !key) {
          return new Response("Image service not configured", { status: 500 });
        }

        const client = createClient(url, key, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            fetch: (input, init) => {
              const headers = new Headers(init?.headers);
              if (key.startsWith("sb_") && headers.get("Authorization") === `Bearer ${key}`) {
                headers.delete("Authorization");
              }
              headers.set("apikey", key);
              return fetch(input, { ...init, headers });
            },
          },
        });

        const { data, error } = await client.storage.from("product-images").download(path);
        if (error || !data) return new Response("Not found", { status: 404 });

        const buf = await data.arrayBuffer();
        return new Response(buf, {
          headers: {
            "content-type": data.type || "image/jpeg",
            "cache-control": "public, max-age=31536000, immutable",
            "access-control-allow-origin": "*",
          },
        });
      },
    },
  },
});
