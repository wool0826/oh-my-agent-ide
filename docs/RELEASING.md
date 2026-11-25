# Releasing

Installers are built by `.github/workflows/release.yml` on GitHub's runners: the Windows installer on Windows, the macOS dmg on an Apple silicon Mac. A pushed tag makes a **draft** release with both files and generated notes. Nothing is public until you publish the draft, and the app's update check only sees published releases.

## Make a release

1. **Bump the version** on a branch and merge it like any change:
   ```sh
   npm version 0.7.0 --no-git-tag-version   # changes package.json and package-lock.json
   ```
2. **Tag the merged commit** on `main` and push the tag:
   ```sh
   git fetch origin
   git tag v0.7.0 origin/main
   git push origin v0.7.0
   ```
   The tag must be `v` + the `version` in package.json at that commit. If it is not, the workflow's first job fails and nothing is built. Delete a wrong tag with `git push origin :refs/tags/v0.7.0` and `git tag -d v0.7.0`.
3. **Wait for the Release workflow** (Actions → Release, about 15 minutes). It builds both installers and attaches them to a draft release named after the tag.
4. **Check the draft** on the Releases page: both files are there (`OhMyAgentIDE-Setup-0.7.0.exe`, `OhMyAgentIDE-0.7.0-arm64.dmg`), install at least one, and edit the generated notes (known issues, what was not tried on a Mac).
5. **Publish** the draft. Running apps see it within six hours (or at their next launch).

Re-running the workflow for the same tag replaces the files on the draft and keeps its notes.

### Dry run

Actions → Release → Run workflow builds both installers and keeps them as workflow artifacts (`installer-win`, `installer-mac`, 14 days) without making a release. A pull request that changes `release.yml` does the same. Both use the signing secrets when they exist, so a dry run is also how to try new secrets before a tag.

### Local fallback

If Actions is not available, build on your own machine and attach the files to a draft for the pushed tag:

```sh
npm run dist:win            # or dist:mac on a Mac
npm run release             # scripts/release.mjs: a draft for v<version>, or adds to the draft if it exists
```

Run it on a Windows PC and again on a Mac to get both files onto one draft.

A local build is signed only if the signing variables below are set in your shell (`WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` on Windows; `CSC_LINK`, `CSC_KEY_PASSWORD` and the `APPLE_*` notarization variables on a Mac). On a Mac without them, run `npm run dist:mac -- -c.mac.identity=- -c.mac.hardenedRuntime=false` so the app gets the same ad-hoc signature CI gives it.

## What is built

| | Windows | macOS |
|---|---|---|
| Runner | `windows-latest` | `macos-latest` (Apple silicon) |
| File | `OhMyAgentIDE-Setup-<version>.exe` (NSIS) | `OhMyAgentIDE-<version>-arm64.dmg` |
| Without secrets | Unsigned. SmartScreen shows "Windows protected your PC" → More info → Run anyway. | Ad-hoc signed, not notarized. macOS blocks the first launch: System Settings → Privacy & Security → Open Anyway, or `xattr -dr com.apple.quarantine "/Applications/Oh My Agent IDE.app"`. |
| With secrets | Signed with your certificate. | Signed with your Developer ID and notarized. |

Intel Macs are not covered: the agent SDK installs its binary for the build machine's architecture only, so an x64 dmg needs its own Intel runner.

## Signing secrets

Add each one under the repository's Settings → Secrets and variables → Actions → New repository secret, or with `gh`:

```sh
gh secret set WIN_CSC_LINK < cert.pfx.b64       # from a file
gh secret set WIN_CSC_KEY_PASSWORD              # prompts for the value
```

Each platform is signed only when its certificate secret exists. A missing secret is not an error; that platform is built unsigned. Secrets are not given to workflows run from forks.

| Secret | Platform | What it holds |
|---|---|---|
| `WIN_CSC_LINK` | Windows | The code signing certificate with its private key (.pfx), base64 encoded. |
| `WIN_CSC_KEY_PASSWORD` | Windows | The .pfx password. |
| `MAC_CSC_LINK` | macOS | The "Developer ID Application" certificate with its private key (.p12), base64 encoded. |
| `MAC_CSC_KEY_PASSWORD` | macOS | The .p12 password. |
| `APPLE_TEAM_ID` | macOS | Your 10-character Apple Team ID. |
| `APPLE_ID` | macOS notarization, option A | The Apple Account email of the developer account. |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS notarization, option A | An app-specific password for that Apple Account. |
| `APPLE_API_KEY` | macOS notarization, option B | An App Store Connect API key (.p8), base64 encoded. |
| `APPLE_API_KEY_ID` | macOS notarization, option B | That key's Key ID. |
| `APPLE_API_ISSUER` | macOS notarization, option B | The Issuer ID shown above the keys list. |

Set option A or option B for notarization, not both (A is used when both are complete). Without either, a signed dmg is built but not notarized, and the workflow log has a warning.

To base64 encode a file:

```powershell
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) | Out-File -Encoding ascii cert.pfx.b64
```
```sh
# macOS / Linux / Git Bash
base64 < cert.pfx | tr -d '\n' > cert.pfx.b64
```

Delete the .b64 files, and keep the .pfx, .p12 and .p8 files somewhere safe outside the repository.

### Windows certificate

1. **Buy a code signing certificate** (OV, for an individual or a company) from a certificate authority such as Sectigo, DigiCert, SSL.com or Certum. Expect identity checks that take days.
2. **The catch: a .pfx file may not be on offer.** Since June 2023 certificate authorities must keep code signing keys on hardware (a USB token or their cloud HSM), so a newly bought certificate usually cannot be exported as a .pfx. The `WIN_CSC_LINK` hook works for a certificate you hold as a .pfx. For a token or cloud signing account (SSL.com eSigner, DigiCert KeyLocker, Azure Artifact Signing and the like), the signing step in `release.yml` must change to that service's tool; ask for that as a separate change once you have chosen one.
3. **If you do have a .pfx:** base64 encode it into `WIN_CSC_LINK` and put its password into `WIN_CSC_KEY_PASSWORD`.
4. **SmartScreen:** a signed installer still shows the warning until the certificate earns reputation through downloads. Signing makes the publisher name show and the warning go away over time; it does not remove it on the first day.

### macOS Developer ID and notarization

1. **Join the Apple Developer Program** (developer.apple.com/programs, paid yearly) as an individual or organization. Only the account holder can create Developer ID certificates.
2. **Team ID:** developer.apple.com/account → Membership details → Team ID. Put it in `APPLE_TEAM_ID`.
3. **Developer ID Application certificate (.p12).**
   - *On a Mac:* Xcode → Settings → Accounts → your team → Manage Certificates → + → Developer ID Application. Then Keychain Access → login → My Certificates → right-click "Developer ID Application: …" → Export → .p12 with a password.
   - *Without a Mac* (OpenSSL, for example in Git Bash):
     ```sh
     openssl genrsa -out devid.key 2048
     openssl req -new -key devid.key -out devid.csr -subj "/emailAddress=YOU@EXAMPLE.COM/CN=YOUR NAME/C=KR"
     ```
     Upload `devid.csr` at developer.apple.com/account/resources/certificates → + → Developer ID Application (G2 Sub-CA), download the `.cer`, then:
     ```sh
     openssl x509 -inform der -in developerID_application.cer -out devid.pem
     openssl pkcs12 -export -inkey devid.key -in devid.pem -out devid.p12 \
       -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1
     ```
     (The older encryption options keep macOS's `security import` able to read the file.)
   - Base64 encode the .p12 into `MAC_CSC_LINK` and put its password into `MAC_CSC_KEY_PASSWORD`.
4. **Notarization, option A (app-specific password):** account.apple.com → Sign-In and Security → App-Specific Passwords → generate one. Put the Apple Account email in `APPLE_ID` and the generated password in `APPLE_APP_SPECIFIC_PASSWORD`.
5. **Notarization, option B (API key):** appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect API → Team Keys → generate a key with the Developer role. Download the .p8 (possible only once), base64 encode it into `APPLE_API_KEY`, and put the Key ID into `APPLE_API_KEY_ID` and the Issuer ID into `APPLE_API_ISSUER`.

**Not yet tried:** no build has been signed or notarized so far. A signed build turns on the hardened runtime, and the agent SDK's bundled binary may need extra entitlements under it. Run a dry run after adding the secrets and start the dmg on a Mac before publishing the first signed release.
