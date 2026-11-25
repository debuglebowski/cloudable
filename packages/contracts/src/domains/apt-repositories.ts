// Approved apt repositories: package sources outside Ubuntu's own that an org has
// decided to trust. Adding or removing one is an approved, recorded decision
// (`apt_repository` approval). A repository installs nothing by itself; packages
// from it are ordinary apt manifest entries. See docs/inheritance.md.

/** The poll `settings` key carrying `AptRepositoryConfig[]`. Absent means none. */
export const APT_REPOSITORIES_POLL_KEY = "aptRepositories";

/**
 * One approved repository, as the agent writes it. The agent names its files
 * `cloudable-<id>.sources` and `cloudable-<id>.asc`, and owns only files with
 * that prefix.
 */
export interface AptRepositoryConfig {
  /** Stable id (a UUID). Names the files on the machine. */
  readonly id: string;
  /** `https://` only. */
  readonly url: string;
  /** e.g. `nodistro`, `noble`. */
  readonly suite: string;
  /** e.g. `["main"]`. */
  readonly components: readonly string[];
  /** The repository's public signing key, ASCII-armored. Public, not a secret. */
  readonly signingKey: string;
  /** Upper-case hex fingerprint of `signingKey`'s primary key. */
  readonly fingerprint: string;
}

/**
 * One apt source the agent found on the machine, from `/etc/apt/sources.list`
 * or a file in `/etc/apt/sources.list.d`. The control plane decides which are
 * allowed; the agent only reports.
 */
export interface AptSourceReport {
  /** The file it was found in, an absolute path. */
  readonly file: string;
  /** The repository URI as written, e.g. `https://deb.nodesource.com/node_24.x`. */
  readonly uri: string;
}

/** Wire shape of `GET /api/v1/organisation/apt-repositories`. */
export interface AptRepository {
  id: string;
  name: string;
  url: string;
  suite: string;
  components: string[];
  fingerprint: string;
  /** Who asked for it and who approved it are on its approval and events. */
  addedAt: string;
  /** Set once removed. A removed repository stays on record. */
  removedAt: string | null;
}

export interface AptRepositoryRequest {
  name: string;
  url: string;
  suite: string;
  components: string[];
  signingKey: string;
  /** Why the org should trust it. Shown to the approver. */
  reason: string;
}

/** What adding or removing a repository returns: the approval it waits on. */
export interface AptRepositoryChangeResponse {
  approvalId: string;
  status: "pending" | "approved" | "rejected" | "expired";
}

/** Matches an apt suite or component name: letters, digits, `.`, `_`, `-`, `/`. */
export const APT_SUITE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
export const APT_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Hosts whose apt sources need no approval: Ubuntu's own archives. Anything else
 * on a machine that Cloudable did not put there counts as drift.
 */
export const UBUNTU_APT_HOST_PATTERN =
  /^([a-z0-9-]+\.)*(archive\.ubuntu\.com|security\.ubuntu\.com|ports\.ubuntu\.com|esm\.ubuntu\.com|azure\.archive\.ubuntu\.com)$/;
