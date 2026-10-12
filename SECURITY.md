# Security

Cloudable running in Cloudable's own tenant is privileged internal infrastructure — same tier as
CI, not the same tier as a wiki (`docs/spec.md` §26).

## Vulnerability scanning

The control-plane container image is scanned with [Trivy](https://github.com/aquasecurity/trivy)
(`.github/workflows/trivy-scan.yml`) on every push/PR touching the image, and again weekly when the
pinned base image is rebuilt (`.github/workflows/rebuild-base-image.yml`) — so a CVE disclosed
against the base image is caught even in a week with no application code changes. This is
explicitly Trivy, not Microsoft Defender for Containers, per `docs/spec.md` §26.

The image also carries the Trivy scanner that machines download when an org turns on
vulnerability scanning (`docs/vulnerability-scanning.md`). Its version and the SHA-256 of each
release tarball are pinned in the `Dockerfile`, and the weekly rebuild never changes them. A
finding against that binary is fixed by bumping the pin, after checking the release's Sigstore
signature as the `Dockerfile` describes, not by editing the hashes alone.
`.github/workflows/trivy-pin-check.yml` checks that signature whenever the pin changes.

Dependency updates (`bun.lock`, GitHub Actions) are proposed weekly by Dependabot
(`.github/dependabot.yml`).

## Remediation SLA

Scanning existing is not the control — findings being closed is. Placeholder SLA, pending a real
policy owner:

| Severity | Remediate within |
| :------- | :---------------- |
| Critical | 7 days |
| High     | 30 days |
| Medium   | 90 days |
| Low      | best effort |

## Reporting a vulnerability

This is a private, pre-release repository. Report issues to the maintainer directly rather than
opening a public issue.
