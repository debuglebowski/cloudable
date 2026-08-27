import { mkdir } from "node:fs/promises";
import { EVENT_TYPES } from "../src/catalogue";
import { EVENT_METADATA } from "../src/metadata";

const DOCS_DIR = new URL("../../../docs/", import.meta.url);
const OUTPUT_PATH = new URL("events.md", DOCS_DIR);

function domainOf(type: string): string {
  const prefix = type.split(".")[0] ?? type;
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

function groupByDomain(types: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const type of types) {
    const domain = domainOf(type);
    const bucket = groups.get(domain);
    if (bucket) {
      bucket.push(type);
    } else {
      groups.set(domain, [type]);
    }
  }
  return groups;
}

function renderTable(types: string[]): string {
  const header = "| Type | Tier | Description |\n| :--- | :--- | :--- |";
  const rows = types.map((type) => {
    const meta = EVENT_METADATA[type as keyof typeof EVENT_METADATA];
    return `| \`${type}\` | ${meta.tier} | ${meta.description} |`;
  });
  return [header, ...rows].join("\n");
}

async function main() {
  await mkdir(DOCS_DIR, { recursive: true });

  const groups = groupByDomain(EVENT_TYPES);
  const sections = [...groups.entries()].map(
    ([domain, types]) => `## ${domain}\n\n${renderTable(types)}`,
  );

  const content = [
    "# Event Catalogue",
    "",
    "Generated from `packages/events`. Do not hand-edit — run `bun run gen-docs` in `packages/events` to regenerate.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");

  await Bun.write(OUTPUT_PATH, content);
  console.log(`Wrote ${OUTPUT_PATH.pathname}`);
}

await main();
