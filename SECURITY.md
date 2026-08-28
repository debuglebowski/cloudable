# Security

Cloudable running in Cloudable's own tenant is privileged internal infrastructure — same tier as
CI, not the same tier as a wiki (`docs/spec.md` §26).

## Vulnerability scanning

The control-plane container image is scanned with [Trivy](https://github.com/aquasecurity/trivy)
(`.github/workflows/trivy-scan.yml`) on every push/PR touching the image, and again weekly when the
pinned base image is rebuilt (`.github/workflows/rebuild-base-image.yml`) — so a CVE disclosed
against the base image is caught even in a week with no application code changes. This is
explicitly Trivy, not Microsoft Defender for Containers, per `docs/spec.md` §26.

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
