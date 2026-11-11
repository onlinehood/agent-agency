import fs from "node:fs";

/** Application version from package.json (works from src/ under tsx and from dist/ after build). */
function read(): string {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const APP_VERSION = read();
