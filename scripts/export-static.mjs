import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const source = path.resolve("docs");
const destination = path.resolve("dist");

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
console.log(`Exported ${source} to ${destination}`);
