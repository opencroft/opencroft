// When a person last closed the sponsorship thank-you, stored on their user
// record so a browser they have not used before still knows it was seen.
//
// Safe to import from client code: plain data, no server runtime.

/**
 * The user-record field, in Better Auth's additional-field shape. The server
 * declares it (adding input and validation) and the client infers
 * `user.sponsorPromptSeenAt` from it, so both sides read one declaration. Null
 * until the thank-you is first closed.
 */
export const sponsorPromptUserField = {
  sponsorPromptSeenAt: { type: 'date', required: false },
} as const
