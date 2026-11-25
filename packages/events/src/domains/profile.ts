import type { EventEnvelope } from "../envelope";

/** The creation fields a profile may set. Null means the profile leaves it to the create form. */
export interface ProfileCreationFields {
  provider: "azure" | "docker" | "fake" | null;
  region: string | null;
  size: string | null;
  image: string | null;
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
      } & ProfileCreationFields;
    })
  | (EventEnvelope & {
      type: "profile.updated";
      /** Name, description or creation fields. Each side holds only the fields that changed. */
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
    });
