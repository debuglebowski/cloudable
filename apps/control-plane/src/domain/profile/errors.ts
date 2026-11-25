import { Schema } from "effect";

/** The profile does not exist, or belongs to another org. */
export class ProfileNotFoundError extends Schema.TaggedError<ProfileNotFoundError>(
  "ProfileNotFoundError",
)("ProfileNotFoundError", {
  profileId: Schema.String,
}) {}

/**
 * The edit cannot be made as asked: an archived profile, a creation field
 * changed while machines use the profile, a name already taken, or a value
 * the field does not accept. `message` says which, in words a person can act on.
 */
export class ProfileEditError extends Schema.TaggedError<ProfileEditError>("ProfileEditError")(
  "ProfileEditError",
  {
    code: Schema.Literal(
      "profile_archived",
      "profile_in_use",
      "profile_name_taken",
      "invalid_profile_field",
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
