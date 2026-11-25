import type { EventEnvelope } from "../envelope";

/** The creation fields a profile may set. Null means the profile leaves it to the create form. */
export interface ProfileCreationFields {
  provider: "azure" | "docker" | "fake" | null;
  region: string | null;
  size: string | null;
  image: string | null;
}

/**
 * Which creation fields the profile locks. A locked field is fixed for every machine on the
 * profile. An unlocked one is only a starting value the create form fills in. Added
 * 2026-11; events recorded before then have no lock fields, and every field they set was fixed.
 */
export interface ProfileCreationFieldLocks {
  providerLocked?: boolean;
  regionLocked?: boolean;
  sizeLocked?: boolean;
  imageLocked?: boolean;
}

/**
 * Profile events. A profile is a named set of settings machines link to
 * (org → profile → machine). `machineId` is always null: a profile change
 * reaches every machine on it, and `profileId` in the payload says which.
 */
export type ProfileEvent =
  | (EventEnvelope & {
      type: "profile.created";
      payload: {
        profileId: string;
        name: string;
        description: string | null;
        /** The profile it extends, when created extending one. Added 2026-11. */
        baseProfileId?: string | null;
      } & ProfileCreationFields &
        ProfileCreationFieldLocks;
    })
  | (EventEnvelope & {
      type: "profile.updated";
      /**
       * Name, description, creation fields or their locks. Each side holds only the fields
       * that changed. Keys: `name`, `description`, `provider`, `region`, `size`, `image`,
       * `providerLocked`, `regionLocked`, `sizeLocked`, `imageLocked`.
       */
      payload: {
        profileId: string;
        previous: Record<string, unknown>;
        current: Record<string, unknown>;
      };
    })
  | (EventEnvelope & {
      type: "profile.setting_changed";
      /**
       * A setting or package changed on the profile. A package edit has key
       * `package:<name>`, and stores the lock flag as `pinned`, like
       * `org.setting_changed`.
       */
      payload: {
        profileId: string;
        key: string;
        previous: unknown;
        current: unknown;
      };
    })
  | (EventEnvelope & {
      type: "profile.archived";
      payload: { profileId: string; name: string };
    })
  | (EventEnvelope & {
      type: "profile.base_changed";
      /**
       * The profile now extends another, a different one, or none. Its machines resolve
       * through the new base from then on. Null means none.
       */
      payload: {
        profileId: string;
        previousBaseProfileId: string | null;
        baseProfileId: string | null;
      };
    });
