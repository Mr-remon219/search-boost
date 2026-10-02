# Security policy

SearchBoost accepts untrusted public URLs, search results and document bytes. Its network/content protections and private persistence are security boundaries; fixture success is not a penetration-test or sandbox guarantee.

## Reporting

Please use [GitHub private vulnerability reporting](https://github.com/Mr-remon219/search-boost/security/advisories/new) **if the repository owner has enabled it**. Do not post credentials, private URLs or working exploit details in a public issue. If private reporting is unavailable, open an issue asking for a private contact without disclosing the vulnerability. The repository configuration has not been asserted enabled by this document.

Include the exact package version/commit, OS/Node/host versions, affected component, minimal reproduction, impact and any proposed mitigation. Do not test against real users or live paid services without authorization. Never include access tokens or personal configuration.

## Maintenance policy

The active development branch/package line is maintained on a best-effort basis; no response-time SLA or historical-version support is implied. Security fixes require review, relevant regression evidence and the actual package gate before an explicitly authorized release. CI does not publish automatically.

The exact dependency lock is audited at moderate severity and above. Audit/tool/network failures are not passing security results. Exceptions require a separately reviewed advisory/version-specific rationale, reachability evidence, compensating controls, owner and expiry; there are no blanket ignored advisories. Review pinned action versions monthly and immediately on relevant security notices. See [the CI/CD engineering standard](docs/ci-cd-standard.md) for permissions, artifact retention and verification limits.
