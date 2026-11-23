import { BUILD_ID, BUILD_TIME } from "@/lib/version";

// Which build the site is serving right now. An open copy of the app compares this with the
// build it was loaded from (lib/version.ts) and reloads when they differ.
export function GET() {
  return Response.json({ build: BUILD_ID, built: BUILD_TIME }, { headers: { "Cache-Control": "no-store" } });
}
