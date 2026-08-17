# Contributing

Contributions must be compatible with the PolyForm Noncommercial License 1.0.0
and must not contain credentials, private keys, user data, signed binaries,
update endpoints, personal or infrastructure data, or third-party assets
without documented redistribution rights.

Before opening a pull request, run:

```powershell
npm run verify
```

Keep security-sensitive changes small and explain their threat model in the
pull request. Do not weaken Electron sandboxing, context isolation, navigation
allowlists, or request validation without a concrete security review.
