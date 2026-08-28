import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

function truncateFingerprint(fingerprint: string): string {
  if (fingerprint.length <= 20) return fingerprint;
  return `${fingerprint.slice(0, 13)}…${fingerprint.slice(-6)}`;
}

/** Truncated, copyable SSH certificate fingerprint — the full value is always available via copy or the title tooltip. */
export function FingerprintCell({ fingerprint }: { fingerprint: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(fingerprint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — nothing to fall back to.
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-xs" title={fingerprint}>
        {truncateFingerprint(fingerprint)}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={handleCopy}
        aria-label="Copy fingerprint"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}
