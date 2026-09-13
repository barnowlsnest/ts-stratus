import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned to a commit rather than a branch: the schema this client is typed
// against must not change underneath it when upstream pushes to main.
const REPO = "barnowlsnest/stratus";
const REF = "7989fea3a0e80a5c6da0fbf3f9a490268c0d0f30";
const SOURCE_PATH = "proto/stratus/v1/stratus.proto";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(projectRoot, SOURCE_PATH);
const url = `https://raw.githubusercontent.com/${REPO}/${REF}/${SOURCE_PATH}`;

const response = await fetch(url);
if (!response.ok) {
    console.error(`sync-proto: ${response.status} ${response.statusText}`);
    console.error(`sync-proto: ${url}`);
    process.exit(1);
}

const body = await response.text();
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, body, "utf8");

console.log(`synced  ${SOURCE_PATH}`);
console.log(`  repo   ${REPO}`);
console.log(`  ref    ${REF}`);
console.log(`  bytes  ${String(body.length)}`);
console.log(`  sha256 ${createHash("sha256").update(body).digest("hex")}`);
