# Releases

Maintainers should create releases from a clean checkout after `npm run verify`
passes. Each distributor is responsible for validating dependency versions,
license obligations, protected-media behavior, installer lifecycle, code
signing, and its own update mechanism.

Do not publish local release directories, diagnostic data, signing material,
deployment configuration, or credentials with a source release.
