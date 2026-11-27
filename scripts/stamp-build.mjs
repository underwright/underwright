import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = process.argv[2] ?? fileURLToPath(new URL("../dist/", import.meta.url));
writeFileSync(resolve(directory, "build-info.json"), JSON.stringify({ build_time: new Date().toISOString() }) + "\n");
