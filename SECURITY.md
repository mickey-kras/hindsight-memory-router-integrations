# Security policy

Report vulnerabilities through a private GitHub security advisory for this repository.

## Dependency licenses

Dependency review blocks high and critical vulnerabilities in runtime, development,
and unknown scopes. License compatibility is reviewed manually; CI does not certify it.

- Separately executed CI tools (including SonarSource's scanner) do not need a
  license exception for each version. Review actual changes to their license or usage.
- Before adding or changing dependencies shipped in a binary, package, or container,
  review the applicable terms, linking/bundling, notices, and source/relinking duties.
- GPL, AGPL, LGPL, SSPL, custom, and unknown terms require context, not an automatic ban.
  Record the decision and required notices in the PR; update third-party notices as needed.
- Existing dependencies are not proof of approval. Review any unrecorded shipped
  dependency before relying on its licensing. Disable auto-merge when manual review is needed.

The repository's own license does not replace dependency licenses.
