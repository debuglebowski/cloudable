import { Schema } from "effect";

/** The profile does not exist, or belongs to another org. */
export class ProfileNotFoundError extends Schema.TaggedError<ProfileNotFoundError>(
  "ProfileNotFoundError",
)("ProfileNotFoundError", {
  profileId: Schema.String,
}) {}

/**
 * The edit cannot be made as asked: an archived profile, a locked creation
 * field a machine on the profile does not have, a name already taken, a value
 * the field does not accept, a base it cannot extend, or archiving a profile
 * others extend. `message` says which, in words a person can act on.
 */
export class ProfileEditError extends Schema.TaggedError<ProfileEditError>("ProfileEditError")(
  "ProfileEditError",
  {
    code: Schema.Literal(
      "profile_archived",
      "profile_in_use",
      "profile_name_taken",
      "invalid_profile_field",
      "invalid_base_profile",
      "profile_is_base",
    ),
    message: Schema.String,
  },
) {}

/** An unexpected failure reading or writing profiles, or publishing their events. */
export class ProfileWriteError extends Schema.TaggedError<ProfileWriteError>("ProfileWriteError")(
  "ProfileWriteError",
  {
    message: Schema.String,
  },
) {}
