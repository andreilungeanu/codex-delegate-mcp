# Releases

- A release is its own commit: version bump, manifest pins, and CHANGELOG.md together.
- Never start a release without confirming the version with the user first.
- `npm test` covers version sync across package.json, src/version.js, and host manifests —
  bump them together or that test fails.
