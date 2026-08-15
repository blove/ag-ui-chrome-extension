# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/blove/ag-ui-chrome-extension/security/advisories/new).
It is private between you and the maintainers until we publish an advisory.

Please include what you were doing, what happened, and — if you have one — a minimal reproduction.
A captured `.agui.jsonl` is often the fastest way to show us; **run it through redacted export
first** unless the content itself is the point.

We aim to acknowledge within three working days. This is a small project, so please allow reasonable
time for a fix before public disclosure. We will credit you in the advisory unless you ask us not
to.

## What counts as a vulnerability here

This extension sits on the wire where prompts and completions flow, so its threat model is mostly
about **containment** — data escaping, or a page reaching something it should not. Reports in these
areas are especially welcome:

- **Any network egress.** The extension is designed to make no outbound request of any kind. A path
  that causes one — including an inadvertent resource load — is a serious bug, not a minor one.
- **Capture on an origin the user never enabled**, or an origin grant that persists or widens beyond
  what was granted.
- **Crossing the MAIN/ISOLATED world boundary.** `src/relay/` is a security boundary: it is the only
  thing standing between page-controlled `postMessage` data and extension privilege. A page
  convincing the relay to accept forged or malformed messages, or reaching `chrome.*` through it, is
  in scope.
- **Redaction failures.** A redacted export that still contains message text, tool arguments, tool
  results, reasoning, or state values is a leak of exactly the data redaction exists to remove.
- **Headers or cookies being captured, stored, or exported.** Only `content-type` should ever be
  read.
- Anything that lets a captured stream's *content* influence execution rather than being treated as
  data.

## Not vulnerabilities

- **Unredacted export containing real data.** That is the documented purpose of the unredacted
  option, and it is labelled as such.
- **The extension seeing stream content on an origin you enabled.** That is what a debugger does.
- Findings against `packages/harness`, which is a private test harness that ships in nothing.
- Vulnerabilities in Chrome itself — please report those to Google.

## Supported versions

Pre-1.0: only the latest release on `main` is supported. There are no backports.
