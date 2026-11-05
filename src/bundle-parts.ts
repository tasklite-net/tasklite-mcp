// A build folder too big for one deploy request, packed as several zips for
// POST .../deployments/parts. The hosting takes each part up to the size of
// one deploy and puts the site live with the part marked final, so nothing is
// served until every part is in.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join as joinPath, relative } from "node:path";
import AdmZip from "adm-zip";

type Entry = { rel: string; abs: string; size: number };

function walk(root: string, dir: string, out: Entry[]): void {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const abs = joinPath(dir, d.name);
    if (d.isDirectory()) walk(root, abs, out);
    else if (d.isFile())
      out.push({
        rel: relative(root, abs).split("\\").join("/"),
        abs,
        size: statSync(abs).size,
      });
  }
}

/**
 * The folder's files in zips of at most maxBytes each, index.html in the last
 * one. Files are grouped by their size on disk, which a zip never exceeds by
 * more than its headers, so a part is filled to 90% of the limit. One file
 * bigger than that cannot go in any part and is refused by name.
 */
export function packParts(
  root: string,
  maxBytes: number,
): { count: number; part: (i: number) => Buffer } {
  const files: Entry[] = [];
  walk(root, root, files);
  const budget = Math.floor(maxBytes * 0.9);
  const tooBig = files.find((f) => f.size > budget);
  if (tooBig) {
    throw new Error(
      `${tooBig.rel} is ${Math.round(tooBig.size / 1024 / 1024)}MB, over the ${Math.round(budget / 1024 / 1024)}MB one file of a deploy may be. Upload it as an attachment and link to it instead.`,
    );
  }
  // index.html last, so the part that completes the site also carries its home page.
  files.sort((a, b) =>
    a.rel === "index.html" ? 1 : b.rel === "index.html" ? -1 : 0,
  );
  const groups: Entry[][] = [];
  let cur: Entry[] = [];
  let used = 0;
  for (const f of files) {
    if (cur.length && used + f.size > budget) {
      groups.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(f);
    used += f.size;
  }
  if (cur.length) groups.push(cur);
  // Zipped one at a time when sent, so a 300 MB site is never all in memory.
  return {
    count: groups.length,
    part: (i) => {
      const zip = new AdmZip();
      for (const f of groups[i]) zip.addFile(f.rel, readFileSync(f.abs));
      const buf = zip.toBuffer();
      if (buf.length > maxBytes) {
        throw new Error(
          `Part ${i + 1} came out ${Math.round(buf.length / 1024 / 1024)}MB zipped, over the ${Math.round(maxBytes / 1024 / 1024)}MB limit.`,
        );
      }
      return buf;
    },
  };
}
