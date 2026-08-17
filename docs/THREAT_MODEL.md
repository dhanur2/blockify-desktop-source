# Threat model

The app treats remote web content as untrusted. Its baseline protections are
Node integration disabled, context isolation enabled, sandboxing enabled,
strict navigation and popup allowlists, narrow IPC validation, and a dedicated
persistent session for Spotify.

The request filter accepts only HTTPS media requests associated with the Spotify
player and only uses bounded, validated detected content identifiers. Local
protocol responses use fixed paths, restrictive headers, and range validation.

These controls reduce risk; they do not make an externally hosted web player or
third-party service API immutable. Test against current releases before
distribution and treat changes to page-world interception as security-sensitive.
