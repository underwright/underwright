import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
let build_time: string | null = null;
try {
  const stamp = JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8"));
  if (typeof stamp.build_time === "string" && Number.isFinite(Date.parse(stamp.build_time))) build_time = stamp.build_time;
} catch (error: any) {
  if (error.code !== "ENOENT") throw error;
}

export const BUILD_INFO = Object.freeze({ version, build_time });
