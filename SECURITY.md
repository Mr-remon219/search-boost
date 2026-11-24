# Security policy

SearchBoost accepts untrusted public URLs, search results and document bytes. Its network/content protections and private persistence are security boundaries; fixture success is not a penetration-test or sandbox guarantee.

## Reporting

Please use [GitHub private vulnerability reporting](https://github.com/Mr-remon219/search-boost/security/advisories/new) **if the repository owner has enabled it**. Do not post credentials, private URLs or working exploit details in a public issue. If private reporting is unavailable, open an issue asking for a private contact without disclosing the vulnerability. The repository configuration has not been asserted enabled by this document.

Include the exact package version/commit, OS/Node/host versions, affected component, minimal reproduction, impact and any proposed mitigation. Do not test against real users or live paid services without authorization. Never include access tokens or personal configuration.

## Maintenance policy

The active development branch/package line is maintained on a best-effort basis; no response-time SLA or historical-version support is implied. Security fixes require review, relevant regression evidence and the actual package gate before an explicitly authorized release. CI does not publish automatically.

The exact dependency lock is audited at moderate severity and above. Audit/tool/network failures are not passing security results. Exceptions require a separately reviewed advisory/version-specific rationale, reachability evidence, compensating controls, owner and expiry; there are no blanket ignored advisories. Review pinned action versions monthly and immediately on relevant security notices. See [the CI/CD engineering standard](https://github.com/Mr-remon219/search-boost/blob/5836d0998ad7397ac0192741cfd48af95d8468c5/docs/ci-cd-standard.md) for permissions, artifact retention and verification limits.

## Network and configuration boundaries

Page URL checks reject local hostnames and private/loopback/link-local literals on every hop. Direct page requests validate all DNS answers and pin the connection to that snapshot, including proxy-to-direct fallback and curl. Explicit trusted-TUN mode delegates synthetic-address routing to the local TUN. An HTTP(S) page proxy is refused unless SEARCH_BOOST_TRUSTED_PROXY=1 explicitly delegates remote DNS and destination ACLs. Local pre-resolution cannot prove a proxy's eventual destination. Direct fallback for pages and service APIs is independently disabled unless SEARCH_BOOST_PROXY_DIRECT_FALLBACK=1; enabling it may expose the local egress IP. These are separate opt-ins. System-invisible TUN routing cannot be detected reliably and is not a physical public-only guarantee. API/judgment service endpoints are user-authorized configuration, not arbitrary page URLs.

Workspace key/endpoint files are not discovered automatically. `SEARCH_BOOST_KEYS_FILE` explicitly trusts the selected file, including custom destinations; environment API keys can be sent to those destinations. Review any selected file and use only trusted configuration.
